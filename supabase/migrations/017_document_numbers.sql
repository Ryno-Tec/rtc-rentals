-- 017: Readable document numbers for tracking and audit.
--   receipts:   RTC-RCT-2026-000001  (one per rent month, given when money is first recorded against it)
--   lease docs: RTC-LSE-2026-000001  (one per lease document; a renewal or new version gets a new number)
-- Numbers run per year, never repeat, and can't be changed from the app. Existing rows get numbers
-- in date order. Safe to run more than once.

create table if not exists public.doc_counters (
  kind text not null,
  year integer not null,
  last integer not null default 0,
  primary key (kind, year)
);
alter table public.doc_counters enable row level security;            -- no policies: server-side only
revoke all on public.doc_counters from public, anon, authenticated;

create or replace function public.next_doc_no(p_kind text, p_at timestamptz)
returns text language plpgsql security definer set search_path = public as $$
declare v_year integer := extract(year from coalesce(p_at, now()) at time zone 'Africa/Johannesburg')::int; v_n integer;
begin
  insert into public.doc_counters (kind, year, last) values (p_kind, v_year, 1)
  on conflict (kind, year) do update set last = doc_counters.last + 1
  returning last into v_n;
  return 'RTC-' || p_kind || '-' || v_year || '-' || lpad(v_n::text, 6, '0');
end $$;
revoke all on function public.next_doc_no(text, timestamptz) from public, anon, authenticated;

-- Receipts
alter table public.payments add column if not exists receipt_no text;
create unique index if not exists payments_receipt_no on public.payments(receipt_no) where receipt_no is not null;

create or replace function public.payments_receipt_no()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and old.receipt_no is not null then
    new.receipt_no := old.receipt_no;                                    -- a number, once given, never changes
  elsif new.receipt_no is not null and current_user not in ('authenticated', 'anon') then
    null;                                                                -- numbered by this migration's catch-up
  elsif coalesce(new.amount_paid, 0) > 0 then
    new.receipt_no := public.next_doc_no('RCT', coalesce(new.paid_at, now()));
  else
    new.receipt_no := null;
  end if;
  return new;
end $$;
drop trigger if exists payments_receipt_no on public.payments;
create trigger payments_receipt_no before insert or update on public.payments
  for each row execute function public.payments_receipt_no();

-- Lease documents
alter table public.lease_documents add column if not exists doc_no text;
create unique index if not exists lease_documents_doc_no on public.lease_documents(doc_no) where doc_no is not null;

create or replace function public.lease_documents_doc_no()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and old.doc_no is not null then new.doc_no := old.doc_no;
  elsif new.doc_no is not null and current_user not in ('authenticated', 'anon') then null;   -- catch-up below
  elsif tg_op = 'UPDATE' then new.doc_no := public.next_doc_no('LSE', old.created_at);
  else new.doc_no := public.next_doc_no('LSE', coalesce(new.created_at, now())); end if;
  return new;
end $$;
drop trigger if exists lease_documents_doc_no on public.lease_documents;
create trigger lease_documents_doc_no before insert or update on public.lease_documents
  for each row execute function public.lease_documents_doc_no();

-- Number what already exists, oldest first. (Runs as the database owner, so the signed-lease guard allows it.)
do $$
declare r record;
begin
  for r in select id, coalesce(paid_at, updated_at, created_at) as at from public.payments
           where receipt_no is null and amount_paid > 0 order by coalesce(paid_at, updated_at, created_at), id loop
    update public.payments set receipt_no = public.next_doc_no('RCT', r.at) where id = r.id;
  end loop;
  for r in select id, created_at from public.lease_documents where doc_no is null order by created_at, id loop
    update public.lease_documents set doc_no = public.next_doc_no('LSE', r.created_at) where id = r.id;
  end loop;
end $$;

notify pgrst, 'reload schema';
