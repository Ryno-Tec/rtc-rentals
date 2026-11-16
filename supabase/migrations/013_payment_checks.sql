-- 013: Ozow checklist hardening. A log of payment checks that failed or didn't add up (for alerts
-- and audits), and the bookkeeping for the regular reconciliation against Ozow's records.

create table public.payment_events (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  kind        text not null check (kind in ('unknown_reference', 'check_failed', 'mismatch', 'credentials', 'reconcile_mismatch', 'expired')),
  alert       boolean not null default true,       -- false for routine notes (e.g. a payer who never finished)
  reference   text,
  landlord_id uuid references public.landlords(id) on delete set null,
  detail      jsonb
);
create index payment_events_at_idx on public.payment_events(at desc);
alter table public.payment_events enable row level security;   -- no policies: server functions only
revoke all on public.payment_events from anon, authenticated;

alter table public.platform_settings add column if not exists last_reconcile_at timestamptz;
alter table public.platform_settings add column if not exists last_full_reconcile_at timestamptz;

-- Claims a reconciliation run: true at most once per p_minutes, so the public trigger can't be used
-- to hammer Ozow's API.
create or replace function public.claim_reconcile(p_full boolean, p_minutes integer)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_ok boolean;
begin
  if p_full then
    update public.platform_settings set last_full_reconcile_at = now()
     where coalesce(last_full_reconcile_at, 'epoch') < now() - make_interval(mins => p_minutes) returning true into v_ok;
  else
    update public.platform_settings set last_reconcile_at = now()
     where coalesce(last_reconcile_at, 'epoch') < now() - make_interval(mins => p_minutes) returning true into v_ok;
  end if;
  return coalesce(v_ok, false);
end $$;
revoke all on function public.claim_reconcile(boolean, integer) from public, anon, authenticated;
grant execute on function public.claim_reconcile(boolean, integer) to service_role;
