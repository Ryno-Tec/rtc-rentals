-- 011: rent paid online through each landlord's own Ozow account, and Ryno-Tec's billing.
--
-- Money: a tenant pays rent from their bank through Ozow straight into the LANDLORD's Ozow
-- account. Ryno-Tec never holds rent. Ryno-Tec earns a monthly subscription (by plan) plus a
-- small collection fee on rent paid through the app, billed to the landlord once a month on an
-- invoice the landlord pays (through Ryno-Tec's own Ozow account).
--
-- Secrets: a landlord's Ozow private key and API key are written through save_ozow_account()
-- and can never be read back by anyone in the browser; only the server functions (service role)
-- read them to sign payments and check Ozow's notifications.

-- ----------------------------------------------------------------------------
-- The landlord's Ozow connection
-- ----------------------------------------------------------------------------
create table public.ozow_accounts (
  landlord_id uuid primary key references public.landlords(id) on delete cascade,
  site_code   text not null check (length(site_code) between 3 and 50),
  is_test     boolean not null default true,
  enabled     boolean not null default true,
  key_hint    text,                                   -- last 4 characters of the private key, to recognise it
  updated_at  timestamptz not null default now()
);
alter table public.ozow_accounts enable row level security;
create policy ozow_accounts_owner_read on public.ozow_accounts for select to authenticated
  using (landlord_id = public.get_landlord_id());
revoke insert, update, delete on public.ozow_accounts from anon, authenticated;

create table public.ozow_secrets (
  landlord_id uuid primary key references public.landlords(id) on delete cascade,
  private_key text not null,
  api_key     text
);
alter table public.ozow_secrets enable row level security;           -- no policies: nobody reads it from the browser
revoke all on public.ozow_secrets from anon, authenticated;

create or replace function public.save_ozow_account(p_site_code text, p_private_key text, p_api_key text, p_is_test boolean, p_enabled boolean default true)
returns void language plpgsql security definer set search_path = public as $$
declare v_landlord uuid := public.get_landlord_id(); v_key text := nullif(trim(coalesce(p_private_key, '')), '');
begin
  if v_landlord is null then raise exception 'Only an owner can connect Ozow' using errcode = '42501'; end if;
  if coalesce(trim(p_site_code), '') !~ '^[A-Za-z0-9-]{3,50}$' then raise exception 'Enter the Site Code from your Ozow dashboard' using errcode = '22023'; end if;
  if v_key is null and not exists (select 1 from public.ozow_secrets where landlord_id = v_landlord) then
    raise exception 'Enter the Private Key from your Ozow dashboard' using errcode = '22023'; end if;
  if v_key is not null and length(v_key) < 16 then raise exception 'That Private Key looks too short' using errcode = '22023'; end if;
  insert into public.ozow_accounts (landlord_id, site_code, is_test, enabled, key_hint, updated_at)
  values (v_landlord, trim(p_site_code), coalesce(p_is_test, true), coalesce(p_enabled, true), right(v_key, 4), now())
  on conflict (landlord_id) do update set site_code = excluded.site_code, is_test = excluded.is_test, enabled = excluded.enabled,
    key_hint = coalesce(excluded.key_hint, ozow_accounts.key_hint), updated_at = now();
  if v_key is not null then
    insert into public.ozow_secrets (landlord_id, private_key, api_key) values (v_landlord, v_key, nullif(trim(coalesce(p_api_key, '')), ''))
    on conflict (landlord_id) do update set private_key = excluded.private_key, api_key = coalesce(excluded.api_key, ozow_secrets.api_key);
  elsif nullif(trim(coalesce(p_api_key, '')), '') is not null then
    update public.ozow_secrets set api_key = trim(p_api_key) where landlord_id = v_landlord;
  end if;
end $$;

create or replace function public.remove_ozow_account()
returns void language plpgsql security definer set search_path = public as $$
declare v_landlord uuid := public.get_landlord_id();
begin
  if v_landlord is null then raise exception 'Only an owner can do this' using errcode = '42501'; end if;
  delete from public.ozow_secrets where landlord_id = v_landlord;
  delete from public.ozow_accounts where landlord_id = v_landlord;
end $$;

-- Tenant: can I pay my landlord online?
create or replace function public.tenant_can_pay_online()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.ozow_accounts a
                 where a.enabled and a.landlord_id in (select public.tenant_landlord_ids()))
$$;

-- ----------------------------------------------------------------------------
-- Ryno-Tec's billing: settings, fees, invoices
-- ----------------------------------------------------------------------------
create table public.platform_settings (
  id                 boolean primary key default true check (id),
  collection_fee_pct numeric(5,3) not null default 0.5 check (collection_fee_pct between 0 and 10),
  collection_fee_min numeric(10,2) not null default 0 check (collection_fee_min >= 0),
  collection_fee_max numeric(10,2) not null default 75 check (collection_fee_max >= 0),
  invoice_due_days   integer not null default 7,
  updated_at         timestamptz not null default now()
);
insert into public.platform_settings default values;
alter table public.platform_settings enable row level security;
create policy platform_settings_read on public.platform_settings for select to authenticated using (true);
revoke insert, update, delete on public.platform_settings from anon, authenticated;

create table public.platform_invoices (
  id                  uuid primary key default gen_random_uuid(),
  number              text not null unique,
  landlord_id         uuid not null references public.landlords(id) on delete cascade,
  period_month        date not null check (extract(day from period_month) = 1),
  tier                public.subscription_tier not null,
  subscription_amount numeric(12,2) not null default 0,
  collection_fees     numeric(12,2) not null default 0,
  total               numeric(12,2) not null default 0,
  status              text not null default 'open' check (status in ('open', 'paid', 'void')),
  due_date            date not null,
  paid_at             timestamptz,
  created_at          timestamptz not null default now(),
  unique (landlord_id, period_month)
);
alter table public.platform_invoices enable row level security;
create policy platform_invoices_owner_read on public.platform_invoices for select to authenticated
  using (landlord_id = public.get_landlord_id());
revoke insert, update, delete on public.platform_invoices from anon, authenticated;

-- ----------------------------------------------------------------------------
-- Payments made online (rent to a landlord, or an invoice to Ryno-Tec)
-- ----------------------------------------------------------------------------
create table public.online_payments (
  id                 uuid primary key default gen_random_uuid(),
  kind               text not null check (kind in ('rent', 'invoice')),
  landlord_id        uuid not null references public.landlords(id) on delete cascade,
  payment_id         uuid references public.payments(id) on delete set null,
  invoice_id         uuid references public.platform_invoices(id) on delete set null,
  amount             numeric(12,2) not null check (amount > 0),
  reference          text not null unique,         -- Ozow TransactionReference
  status             text not null default 'started'
                     check (status in ('started', 'complete', 'cancelled', 'error', 'abandoned', 'pending', 'pending_investigation')),
  is_test            boolean not null default false,
  ozow_transaction_id text,
  started_by         uuid,
  created_at         timestamptz not null default now(),
  completed_at       timestamptz,
  last_notification  jsonb,
  check ((kind = 'rent' and invoice_id is null) or (kind = 'invoice' and payment_id is null))
);
create index online_payments_payment_idx on public.online_payments(payment_id);
alter table public.online_payments enable row level security;
create policy online_payments_owner_read on public.online_payments for select to authenticated
  using (landlord_id = public.get_landlord_id());
create policy online_payments_tenant_read on public.online_payments for select to authenticated
  using (kind = 'rent' and payment_id in (select id from public.payments where lease_id in (select public.tenant_lease_ids())));
revoke insert, update, delete on public.online_payments from anon, authenticated;

create table public.platform_fees (
  id                uuid primary key default gen_random_uuid(),
  landlord_id       uuid not null references public.landlords(id) on delete cascade,
  online_payment_id uuid not null unique references public.online_payments(id) on delete cascade,
  rent_amount       numeric(12,2) not null,
  rate_pct          numeric(5,3) not null,
  amount            numeric(12,2) not null,
  period_month      date not null,
  invoice_id        uuid references public.platform_invoices(id) on delete set null,
  created_at        timestamptz not null default now()
);
alter table public.platform_fees enable row level security;
create policy platform_fees_owner_read on public.platform_fees for select to authenticated
  using (landlord_id = public.get_landlord_id());
revoke insert, update, delete on public.platform_fees from anon, authenticated;

-- The collection fee on one rent payment, by the current settings.
create or replace function public.collection_fee(p_amount numeric)
returns numeric language sql stable set search_path = public as $$
  select round(least(s.collection_fee_max, greatest(s.collection_fee_min, p_amount * s.collection_fee_pct / 100)), 2)
  from public.platform_settings s
$$;

-- Called only by the ozow-notify server function, after it has checked Ozow's signature.
-- Safe to call more than once for the same payment (Ozow may repeat notifications).
create or replace function public.complete_online_payment(p_reference text, p_status text, p_transaction_id text,
  p_amount numeric, p_is_test boolean, p_raw jsonb)
returns text language plpgsql security definer set search_path = public as $$
declare v_op public.online_payments; v_new text; v_pay public.payments; v_fee numeric;
begin
  select * into v_op from public.online_payments where reference = p_reference for update;
  if not found then return 'unknown'; end if;
  if v_op.status = 'complete' then return 'already'; end if;
  v_new := case lower(coalesce(p_status, ''))
    when 'complete' then 'complete' when 'cancelled' then 'cancelled' when 'error' then 'error'
    when 'abandoned' then 'abandoned' when 'pending' then 'pending' when 'pendinginvestigation' then 'pending_investigation'
    else 'error' end;
  if v_new = 'complete' and round(p_amount, 2) <> round(v_op.amount, 2) then v_new := 'pending_investigation'; end if;
  update public.online_payments set status = v_new, ozow_transaction_id = coalesce(p_transaction_id, ozow_transaction_id),
    is_test = coalesce(p_is_test, is_test), last_notification = p_raw,
    completed_at = case when v_new = 'complete' then now() else completed_at end
  where id = v_op.id;
  if v_new <> 'complete' or coalesce(p_is_test, false) then return v_new; end if;   -- test payments move no real money: the ledger is left alone

  if v_op.kind = 'rent' and v_op.payment_id is not null then
    select * into v_pay from public.payments where id = v_op.payment_id for update;
    update public.payments set
      amount_paid = amount_paid + v_op.amount,
      status = case when amount_paid + v_op.amount >= amount_due then 'paid'::public.payment_status else 'partial'::public.payment_status end,
      method = 'ozow', paid_at = now(),
      provider_ref = coalesce(provider_ref, p_transaction_id),
      reference = coalesce(reference, v_op.reference)
    where id = v_op.payment_id;
    v_fee := public.collection_fee(v_op.amount);
    if v_fee > 0 then
      insert into public.platform_fees (landlord_id, online_payment_id, rent_amount, rate_pct, amount, period_month)
      select v_op.landlord_id, v_op.id, v_op.amount, s.collection_fee_pct, v_fee, date_trunc('month', now())::date
      from public.platform_settings s
      on conflict (online_payment_id) do nothing;
    end if;
  elsif v_op.kind = 'invoice' and v_op.invoice_id is not null then
    update public.platform_invoices set status = 'paid', paid_at = now() where id = v_op.invoice_id and status = 'open';
  end if;
  return v_new;
end $$;

-- Monthly invoices: the plan for the month plus the collection fees earned in it. Run on the 1st
-- for the month just ended (see the schedule at the end). Owners on the Agency plan (custom price)
-- are invoiced only their collection fees; invoices of R 0 are not created.
create or replace function public.generate_platform_invoices(p_month date)
returns integer language plpgsql security definer set search_path = public as $$
declare v_month date := date_trunc('month', p_month)::date; r record; v_inv uuid; v_n integer := 0; v_due integer;
begin
  select invoice_due_days into v_due from public.platform_settings;
  for r in
    select l.id, l.tier, coalesce(t.price_zar, 0) as sub,
           coalesce((select sum(f.amount) from public.platform_fees f where f.landlord_id = l.id and f.invoice_id is null
                     and f.period_month <= v_month), 0) as fees
    from public.landlords l join public.tier_limits t on t.tier = l.tier
    where l.created_at < (v_month + interval '1 month')
      and not exists (select 1 from public.platform_invoices i where i.landlord_id = l.id and i.period_month = v_month)
  loop
    continue when r.sub + r.fees <= 0;
    insert into public.platform_invoices (number, landlord_id, period_month, tier, subscription_amount, collection_fees, total, due_date)
    values ('RTC-' || to_char(v_month, 'YYYYMM') || '-' || upper(substr(replace(r.id::text, '-', ''), 1, 6)),
            r.id, v_month, r.tier, r.sub, r.fees, r.sub + r.fees, (v_month + interval '1 month')::date + v_due)
    returning id into v_inv;
    update public.platform_fees set invoice_id = v_inv
      where landlord_id = r.id and invoice_id is null and period_month <= v_month;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

revoke all on function public.save_ozow_account(text, text, text, boolean, boolean), public.remove_ozow_account(),
  public.tenant_can_pay_online(), public.complete_online_payment(text, text, text, numeric, boolean, jsonb),
  public.generate_platform_invoices(date), public.collection_fee(numeric) from public, anon, authenticated;
grant execute on function public.save_ozow_account(text, text, text, boolean, boolean), public.remove_ozow_account(),
  public.tenant_can_pay_online(), public.collection_fee(numeric) to authenticated;
grant execute on function public.complete_online_payment(text, text, text, numeric, boolean, jsonb),
  public.generate_platform_invoices(date) to service_role;

-- Invoices on the 1st of every month at 06:00 South African time, for the month just ended.
-- Needs the pg_cron extension (Supabase: Database > Extensions > pg_cron). Skipped if it is off.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('rtc-monthly-invoices', '0 4 1 * *',
      $job$select public.generate_platform_invoices((date_trunc('month', now()) - interval '1 month')::date)$job$);
  end if;
exception when others then
  raise notice 'Monthly invoice schedule not created (%). Enable pg_cron and run this block again.', sqlerrm;
end $$;
