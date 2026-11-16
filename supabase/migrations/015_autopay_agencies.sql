-- 015 (safe to run again): automatic rent payments, rent reminders, and agencies (team logins, property owners,
-- management fees, owner statements and payouts).
--
-- Automatic payments never route money through Ryno-Tec: each landlord (or agency) uses their own
-- Ozow account (Capitec Pay recurring) or their own Netcash debit-order account (DebiCheck).
-- A tenant authorises a maximum amount once; each month the server collects only that month's
-- outstanding rent, never more than the authorised maximum, never before the due date, and at
-- most twice per month. Either side can stop it at any time; stopping takes effect immediately.

-- ============================================================================
-- Agencies: team members share the agency's records through get_landlord_id()
-- ============================================================================
create table if not exists public.agency_members (
  id          uuid primary key default gen_random_uuid(),
  landlord_id uuid not null default public.get_landlord_id() references public.landlords(id) on delete cascade,
  user_id     uuid unique references auth.users(id) on delete set null,
  full_name   text not null check (length(trim(full_name)) between 2 and 120),
  email       text not null check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  role        text not null default 'agent' check (role in ('agent', 'admin')),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
create unique index if not exists agency_members_email_idx on public.agency_members(landlord_id, lower(email));
alter table public.agency_members enable row level security;

create table if not exists public.member_invites (
  id          uuid primary key default gen_random_uuid(),
  landlord_id uuid not null references public.landlords(id) on delete cascade,
  member_id   uuid not null references public.agency_members(id) on delete cascade,
  token_hash  text not null unique,
  expires_at  timestamptz not null default now() + interval '14 days',
  accepted_at timestamptz,
  created_at  timestamptz not null default now()
);
alter table public.member_invites enable row level security;
revoke all on public.member_invites from anon, authenticated;

-- The account the signed-in person works in: their own owner account, or the agency they work for.
create or replace function public.get_landlord_id()
returns uuid language sql stable security definer set search_path = public as $$
  select coalesce(
    (select id from public.landlords where user_id = auth.uid()),
    (select landlord_id from public.agency_members where user_id = auth.uid() and active))
  where coalesce(public.active_side(), 'owner') = 'owner'
$$;

-- The account holder, or a team member with the admin role: billing, Ozow, plans and the team.
create or replace function public.is_account_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select public.get_landlord_id() is not null and (
    exists (select 1 from public.landlords where user_id = auth.uid() and id = public.get_landlord_id())
    or exists (select 1 from public.agency_members where user_id = auth.uid() and active and role = 'admin'
               and landlord_id = public.get_landlord_id()))
$$;
grant execute on function public.is_account_admin() to authenticated;

drop policy if exists agency_members_read on public.agency_members;
create policy agency_members_read on public.agency_members for select to authenticated
  using (landlord_id = public.get_landlord_id());
revoke insert, update, delete on public.agency_members from anon, authenticated;
drop policy if exists landlords_member_read on public.landlords;
create policy landlords_member_read on public.landlords for select to authenticated
  using (id = public.get_landlord_id());

-- Billing and payment set-up are for account admins only
drop policy if exists ozow_accounts_owner_read on public.ozow_accounts;
create policy ozow_accounts_owner_read on public.ozow_accounts for select to authenticated
  using (landlord_id = public.get_landlord_id() and public.is_account_admin());
drop policy if exists platform_invoices_owner_read on public.platform_invoices;
create policy platform_invoices_owner_read on public.platform_invoices for select to authenticated
  using (landlord_id = public.get_landlord_id() and public.is_account_admin());
drop policy if exists platform_fees_owner_read on public.platform_fees;
create policy platform_fees_owner_read on public.platform_fees for select to authenticated
  using (landlord_id = public.get_landlord_id() and public.is_account_admin());

-- Sign-ups through a team invite don't get an owner account of their own.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_landlord uuid;
begin
  if coalesce(new.raw_user_meta_data->>'role', 'landlord') in ('tenant', 'staff', 'member') then
    return new;
  end if;
  insert into public.landlords (user_id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', ''))
  returning id into v_landlord;
  insert into public.subscriptions (landlord_id) values (v_landlord);
  return new;
end $$;

create or replace function public.save_member(p_id uuid, p_name text, p_email text, p_role text, p_active boolean default true)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_landlord uuid := public.get_landlord_id(); v_id uuid;
begin
  if not public.is_account_admin() then raise exception 'Only the account owner or an admin can manage the team' using errcode = '42501'; end if;
  if p_role not in ('agent', 'admin') then raise exception 'Choose agent or admin' using errcode = '22023'; end if;
  if p_id is null then
    insert into public.agency_members (landlord_id, full_name, email, role) values (v_landlord, trim(p_name), lower(trim(p_email)), p_role) returning id into v_id;
  else
    update public.agency_members set full_name = trim(p_name), email = lower(trim(p_email)), role = p_role, active = coalesce(p_active, true)
     where id = p_id and landlord_id = v_landlord returning id into v_id;
    if v_id is null then raise exception 'Team member not found' using errcode = 'P0002'; end if;
    if not coalesce(p_active, true) then delete from public.member_invites where member_id = p_id and accepted_at is null; end if;
  end if;
  return v_id;
end $$;

create or replace function public.remove_member(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_account_admin() then raise exception 'Only the account owner or an admin can manage the team' using errcode = '42501'; end if;
  if exists (select 1 from public.agency_members where id = p_id and user_id = auth.uid()) then
    raise exception 'You can’t remove yourself' using errcode = 'P0001'; end if;
  delete from public.agency_members where id = p_id and landlord_id = public.get_landlord_id();
end $$;

create or replace function public.create_member_invite(p_member uuid)
returns text language plpgsql security definer set search_path = public as $$
declare v_landlord uuid := public.get_landlord_id(); v_token text; v_m public.agency_members;
begin
  if not public.is_account_admin() then raise exception 'Only the account owner or an admin can invite' using errcode = '42501'; end if;
  select * into v_m from public.agency_members where id = p_member and landlord_id = v_landlord and active;
  if not found then raise exception 'Team member not found' using errcode = 'P0002'; end if;
  if v_m.user_id is not null then raise exception 'This person already has a login' using errcode = 'P0001'; end if;
  delete from public.member_invites where member_id = p_member and accepted_at is null;
  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into public.member_invites (landlord_id, member_id, token_hash) values (v_landlord, p_member, public.invite_hash(v_token));
  return v_token;
end $$;

create or replace function public.member_invite_preview(p_token text)
returns table (valid boolean, member_name text, member_email text, agency_name text, role text)
language sql stable security definer set search_path = public as $$
  select (i.accepted_at is null and i.expires_at > now() and m.user_id is null and m.active),
         m.full_name, m.email, coalesce(nullif(l.company_name, ''), l.full_name), m.role
  from public.member_invites i join public.agency_members m on m.id = i.member_id join public.landlords l on l.id = i.landlord_id
  where i.token_hash = public.invite_hash(p_token)
$$;

create or replace function public.accept_member_invite(p_token text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_inv public.member_invites; v_uid uuid := auth.uid(); v_m public.agency_members;
begin
  if v_uid is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  select * into v_inv from public.member_invites where token_hash = public.invite_hash(p_token) for update;
  if not found then raise exception 'This invite link is not valid' using errcode = 'P0002'; end if;
  select * into v_m from public.agency_members where id = v_inv.member_id for update;
  if v_m.user_id = v_uid then return v_m.landlord_id; end if;
  if v_inv.accepted_at is not null or v_m.user_id is not null or not v_m.active then
    raise exception 'This invite has already been used' using errcode = 'P0001'; end if;
  if v_inv.expires_at < now() then raise exception 'This invite has expired. Ask for a new link.' using errcode = 'P0001'; end if;
  if exists (select 1 from public.agency_members where user_id = v_uid) then
    raise exception 'This login already belongs to a team. Use a different email.' using errcode = 'P0001'; end if;
  if exists (select 1 from public.landlords where user_id = v_uid and id = v_m.landlord_id) then
    raise exception 'That’s your own account' using errcode = 'P0001'; end if;
  if not public.release_empty_owner_account(v_uid) then
    raise exception 'This login already has its own properties. Sign up with a different email for the team.' using errcode = 'P0001'; end if;
  update public.agency_members set user_id = v_uid where id = v_m.id;
  update public.member_invites set accepted_at = now() where id = v_inv.id;
  return v_m.landlord_id;
end $$;

-- Plan and Ozow changes: account admins only (replaces the owner-only checks)
create or replace function public.require_account_admin()
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_account_admin() then raise exception 'Only the account owner or an admin can do this' using errcode = '42501'; end if;
end $$;

-- ============================================================================
-- Property owners (an agency's clients), management fees, statements and payouts
-- ============================================================================
create table if not exists public.property_owners (
  id          uuid primary key default gen_random_uuid(),
  landlord_id uuid not null default public.get_landlord_id() references public.landlords(id) on delete cascade,
  full_name   text not null check (length(trim(full_name)) between 2 and 160),
  email       text,
  phone       text,
  fee_pct     numeric(5,2) not null default 0 check (fee_pct between 0 and 50),
  fee_fixed   numeric(12,2) not null default 0 check (fee_fixed >= 0),
  fee_vat     boolean not null default false,
  payout_note text,                                      -- e.g. "FNB ...1234, ref 12 Oak St" (no full account numbers)
  notes       text,
  created_at  timestamptz not null default now(),
  unique (id, landlord_id)
);
alter table public.property_owners enable row level security;
drop policy if exists property_owners_all on public.property_owners;
create policy property_owners_all on public.property_owners for all to authenticated
  using (landlord_id = public.get_landlord_id()) with check (landlord_id = public.get_landlord_id());

alter table public.properties add column if not exists owner_id uuid;
alter table public.properties drop constraint if exists properties_owner_fk;
alter table public.properties add constraint properties_owner_fk foreign key (owner_id, landlord_id)
  references public.property_owners(id, landlord_id) on delete set null (owner_id);

create table if not exists public.owner_payouts (
  id           uuid primary key default gen_random_uuid(),
  landlord_id  uuid not null default public.get_landlord_id() references public.landlords(id) on delete cascade,
  owner_id     uuid not null,
  period_month date not null check (extract(day from period_month) = 1),
  amount       numeric(12,2) not null check (amount >= 0),
  paid_on      date not null default current_date,
  reference    text,
  notes        text,
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now(),
  foreign key (owner_id, landlord_id) references public.property_owners(id, landlord_id) on delete cascade
);
alter table public.owner_payouts enable row level security;
drop policy if exists owner_payouts_all on public.owner_payouts;
create policy owner_payouts_all on public.owner_payouts for all to authenticated
  using (landlord_id = public.get_landlord_id()) with check (landlord_id = public.get_landlord_id());

-- ============================================================================
-- Automatic payments
-- ============================================================================
create table if not exists public.autopay_settings (
  landlord_id   uuid primary key references public.landlords(id) on delete cascade,
  ozow_capitec  boolean not null default false,       -- Capitec Pay recurring, through the landlord's Ozow account
  netcash       boolean not null default false,       -- DebiCheck through the landlord's Netcash account
  netcash_hint  text,
  reminders     boolean not null default true,        -- email reminders to tenants
  updated_at    timestamptz not null default now()
);
alter table public.autopay_settings enable row level security;
drop policy if exists autopay_settings_read on public.autopay_settings;
create policy autopay_settings_read on public.autopay_settings for select to authenticated
  using (landlord_id = public.get_landlord_id());
revoke insert, update, delete on public.autopay_settings from anon, authenticated;

create table if not exists public.netcash_secrets (
  landlord_id uuid primary key references public.landlords(id) on delete cascade,
  service_key text not null
);
alter table public.netcash_secrets enable row level security;           -- no policies
revoke all on public.netcash_secrets from anon, authenticated;

create table if not exists public.payment_mandates (
  id               uuid primary key default gen_random_uuid(),
  landlord_id      uuid not null references public.landlords(id) on delete cascade,
  lease_id         uuid not null references public.leases(id) on delete cascade,
  provider         text not null check (provider in ('ozow_capitec', 'netcash_debicheck')),
  status           text not null default 'pending' check (status in ('pending', 'active', 'cancelled', 'expired', 'failed', 'completed')),
  max_amount       numeric(12,2) not null check (max_amount > 0 and max_amount <= 100000),
  reference        text not null unique,               -- our reference (Ozow merchantReference / Netcash account reference)
  external_id      text,                               -- Ozow subscriptionId / DebiCheck mandate reference
  is_test          boolean not null default false,
  created_by       uuid,
  created_at       timestamptz not null default now(),
  activated_at     timestamptz,
  cancelled_at     timestamptz,
  cancelled_by     uuid,
  provider_cancelled boolean not null default false,   -- the cancel has also reached Ozow
  last_detail      jsonb
);
create unique index if not exists payment_mandates_one_live on public.payment_mandates(lease_id) where status in ('pending', 'active');
alter table public.payment_mandates enable row level security;
drop policy if exists payment_mandates_owner_read on public.payment_mandates;
create policy payment_mandates_owner_read on public.payment_mandates for select to authenticated
  using (landlord_id = public.get_landlord_id());
drop policy if exists payment_mandates_tenant_read on public.payment_mandates;
create policy payment_mandates_tenant_read on public.payment_mandates for select to authenticated
  using (lease_id in (select public.tenant_lease_ids()));
revoke insert, update, delete on public.payment_mandates from anon, authenticated;

create table if not exists public.mandate_collections (
  id                uuid primary key default gen_random_uuid(),
  landlord_id       uuid not null references public.landlords(id) on delete cascade,
  mandate_id        uuid not null references public.payment_mandates(id) on delete cascade,
  payment_id        uuid references public.payments(id) on delete set null,
  online_payment_id uuid references public.online_payments(id) on delete set null,
  period_month      date not null,
  attempt           smallint not null default 1 check (attempt between 1 and 2),
  amount            numeric(12,2) not null check (amount > 0),
  reference         text not null unique,
  status            text not null default 'pending' check (status in ('pending', 'submitted', 'successful', 'failed')),
  external_id       text,
  created_at        timestamptz not null default now(),
  completed_at      timestamptz,
  last_detail       jsonb,
  unique (mandate_id, period_month, attempt)
);
alter table public.mandate_collections enable row level security;
drop policy if exists mandate_collections_owner_read on public.mandate_collections;
create policy mandate_collections_owner_read on public.mandate_collections for select to authenticated
  using (landlord_id = public.get_landlord_id());
drop policy if exists mandate_collections_tenant_read on public.mandate_collections;
create policy mandate_collections_tenant_read on public.mandate_collections for select to authenticated
  using (mandate_id in (select id from public.payment_mandates where lease_id in (select public.tenant_lease_ids())));
revoke insert, update, delete on public.mandate_collections from anon, authenticated;

create table if not exists public.rent_reminders (
  payment_id uuid not null references public.payments(id) on delete cascade,
  kind       text not null check (kind in ('before', 'due', 'late_1', 'late_7')),
  sent_at    timestamptz not null default now(),
  primary key (payment_id, kind)
);
alter table public.rent_reminders enable row level security;
revoke all on public.rent_reminders from anon, authenticated;

create table if not exists public.job_runs (name text primary key, last_run timestamptz);
alter table public.job_runs enable row level security;
revoke all on public.job_runs from anon, authenticated;

create or replace function public.claim_job(p_name text, p_minutes integer)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_ok boolean;
begin
  insert into public.job_runs (name, last_run) values (p_name, now())
  on conflict (name) do update set last_run = now()
    where job_runs.last_run < now() - make_interval(mins => p_minutes)
  returning true into v_ok;
  return coalesce(v_ok, false);
end $$;

-- Owner / admin: switch automatic payments and reminders on or off
create or replace function public.save_autopay_settings(p_ozow_capitec boolean, p_netcash boolean, p_netcash_service_key text, p_reminders boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v_landlord uuid := public.get_landlord_id(); v_key text := nullif(trim(coalesce(p_netcash_service_key, '')), '');
begin
  perform public.require_account_admin();
  if coalesce(p_ozow_capitec, false) and not exists (select 1 from public.ozow_accounts where landlord_id = v_landlord and enabled) then
    raise exception 'Connect Ozow first (Online rent payments)' using errcode = '22023'; end if;
  if v_key is not null and v_key !~ '^[A-Za-z0-9-]{8,64}$' then raise exception 'That Netcash service key doesn’t look right' using errcode = '22023'; end if;
  if coalesce(p_netcash, false) and v_key is null and not exists (select 1 from public.netcash_secrets where landlord_id = v_landlord) then
    raise exception 'Enter your Netcash debit order service key' using errcode = '22023'; end if;
  insert into public.autopay_settings (landlord_id, ozow_capitec, netcash, netcash_hint, reminders, updated_at)
  values (v_landlord, coalesce(p_ozow_capitec, false), coalesce(p_netcash, false), right(v_key, 4), coalesce(p_reminders, true), now())
  on conflict (landlord_id) do update set ozow_capitec = excluded.ozow_capitec, netcash = excluded.netcash,
    netcash_hint = coalesce(excluded.netcash_hint, autopay_settings.netcash_hint), reminders = excluded.reminders, updated_at = now();
  if v_key is not null then
    insert into public.netcash_secrets (landlord_id, service_key) values (v_landlord, v_key)
    on conflict (landlord_id) do update set service_key = excluded.service_key;
  end if;
end $$;

-- Tenant: which automatic options does my landlord offer?
create or replace function public.tenant_autopay_options()
returns table (ozow_capitec boolean, netcash boolean)
language sql stable security definer set search_path = public as $$
  select coalesce(bool_or(s.ozow_capitec and a.enabled), false), coalesce(bool_or(s.netcash), false)
  from public.autopay_settings s left join public.ozow_accounts a on a.landlord_id = s.landlord_id
  where s.landlord_id in (select public.tenant_landlord_ids())
$$;

-- Owner / admin: record a DebiCheck mandate the tenant approved through the landlord's Netcash account
create or replace function public.add_debicheck_mandate(p_lease uuid, p_mandate_ref text, p_account_ref text, p_max numeric)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_landlord uuid := public.get_landlord_id(); v_id uuid;
begin
  if v_landlord is null then raise exception 'Only the landlord can add a debit order' using errcode = '42501'; end if;
  if not exists (select 1 from public.autopay_settings where landlord_id = v_landlord and netcash) then
    raise exception 'Switch on DebiCheck (Netcash) first' using errcode = '22023'; end if;
  if not exists (select 1 from public.leases where id = p_lease and landlord_id = v_landlord and status in ('signed', 'active')) then
    raise exception 'Choose an active lease' using errcode = 'P0002'; end if;
  if coalesce(trim(p_mandate_ref), '') !~ '^[A-Za-z0-9-]{4,50}$' then raise exception 'Enter the DebiCheck mandate reference from Netcash' using errcode = '22023'; end if;
  if coalesce(trim(p_account_ref), '') !~ '^[A-Za-z0-9-]{2,22}$' then raise exception 'Enter the Netcash account reference (up to 22 letters or numbers)' using errcode = '22023'; end if;
  if p_max is null or p_max <= 0 or p_max > 100000 then raise exception 'Enter the maximum the tenant approved' using errcode = '22023'; end if;
  insert into public.payment_mandates (landlord_id, lease_id, provider, status, max_amount, reference, external_id, created_by, activated_at)
  values (v_landlord, p_lease, 'netcash_debicheck', 'active', round(p_max, 2), trim(p_account_ref), trim(p_mandate_ref), auth.uid(), now())
  returning id into v_id;
  return v_id;
end $$;

-- Tenant or landlord: stop automatic payments now. Collections stop at once; the server then also
-- cancels the consent at Ozow (the tenant can also cancel it in the Capitec app).
create or replace function public.cancel_mandate(p_mandate uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_m public.payment_mandates;
begin
  select * into v_m from public.payment_mandates where id = p_mandate for update;
  if not found or not (v_m.landlord_id = public.get_landlord_id() or v_m.lease_id in (select public.tenant_lease_ids())) then
    raise exception 'Not found' using errcode = 'P0002'; end if;
  if v_m.status not in ('pending', 'active') then return; end if;
  update public.payment_mandates set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(),
    provider_cancelled = (provider <> 'ozow_capitec') where id = p_mandate;
end $$;

-- The rent for a lease in a month, with the yearly increase (same rule as the app's ledger.js)
create or replace function public.rent_for(p_lease public.leases, p_month date)
returns numeric language sql immutable as $$
  select round(case when p_lease.escalation_type = 'amount'
    then p_lease.monthly_rent + p_lease.escalation_amount * greatest(0, floor(((extract(year from p_month) - extract(year from p_lease.start_date)) * 12
          + extract(month from p_month) - extract(month from p_lease.start_date)) / 12))
    else p_lease.monthly_rent * power(1 + p_lease.escalation_pct / 100.0, greatest(0, floor(((extract(year from p_month) - extract(year from p_lease.start_date)) * 12
          + extract(month from p_month) - extract(month from p_lease.start_date)) / 12)))
  end)
$$;

create or replace function public.lease_rent(p_lease uuid, p_month date)
returns numeric language sql stable security definer set search_path = public as $$
  select public.rent_for(l, date_trunc('month', p_month)::date) from public.leases l where l.id = p_lease
$$;
revoke all on function public.lease_rent(uuid, date) from public, anon, authenticated;
grant execute on function public.lease_rent(uuid, date) to service_role;

-- Server: make sure this month's rent charge exists for a live lease (returns its id)
create or replace function public.ensure_rent_charge(p_lease uuid, p_month date)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_l public.leases; v_month date := date_trunc('month', p_month)::date; v_id uuid;
begin
  select * into v_l from public.leases where id = p_lease and status in ('signed', 'active');
  if not found or v_month < date_trunc('month', v_l.start_date) or (v_l.end_date is not null and v_month > v_l.end_date) then return null; end if;
  select id into v_id from public.payments where lease_id = p_lease and period_month = v_month;
  if v_id is null then
    insert into public.payments (lease_id, landlord_id, period_month, amount_due, amount_paid, status)
    values (p_lease, v_l.landlord_id, v_month, public.rent_for(v_l, v_month), 0, 'pending')
    on conflict (lease_id, period_month) do nothing returning id into v_id;
    if v_id is null then select id into v_id from public.payments where lease_id = p_lease and period_month = v_month; end if;
  end if;
  return v_id;
end $$;

-- Server: the collections due now. One row per active mandate whose rent for this month is due
-- (on or after the due day), still outstanding, and not already collected or tried twice.
create or replace function public.collections_due(p_today date default current_date)
returns table (mandate_id uuid, payment_id uuid, period_month date, amount numeric, attempt integer, over_limit boolean)
language plpgsql security definer set search_path = public as $$
declare m record; v_pay uuid; v_p public.payments; v_month date := date_trunc('month', p_today)::date; v_due date; v_att integer; v_last public.mandate_collections;
begin
  for m in select pm.*, l.rent_due_day from public.payment_mandates pm join public.leases l on l.id = pm.lease_id
           where pm.status = 'active' and l.status in ('signed', 'active') loop
    v_due := v_month + (least(m.rent_due_day, extract(day from (v_month + interval '1 month' - interval '1 day'))::int) - 1);
    continue when p_today < v_due;
    v_pay := public.ensure_rent_charge(m.lease_id, v_month);
    continue when v_pay is null;
    select * into v_p from public.payments where id = v_pay;
    continue when v_p.amount_due - v_p.amount_paid <= 0;
    select * into v_last from public.mandate_collections c where c.mandate_id = m.id and c.period_month = v_month order by c.attempt desc limit 1;
    if found then
      continue when v_last.status in ('pending', 'submitted', 'successful');
      continue when v_last.attempt >= 2 or v_last.created_at > now() - interval '3 days';   -- one retry, three days later
      v_att := v_last.attempt + 1;
    else v_att := 1; end if;
    mandate_id := m.id; payment_id := v_pay; period_month := v_month; attempt := v_att;
    amount := round(v_p.amount_due - v_p.amount_paid, 2);
    over_limit := amount > m.max_amount;
    return next;
  end loop;
end $$;

-- Server: the payments that should get a reminder email today
create or replace function public.reminders_due(p_today date default current_date)
returns table (payment_id uuid, kind text, tenant_email text, tenant_name text, landlord_name text, unit_label text,
               amount numeric, due_date date, reference text, autopay boolean)
language sql stable security definer set search_path = public as $$
  with p as (
    select py.id, py.amount_due - py.amount_paid as owed, l.id as lease_id, t.email, t.full_name, t.archived_at,
           coalesce(nullif(ll.company_name, ''), ll.full_name) as lname, u.label,
           (py.period_month + (least(l.rent_due_day, extract(day from (py.period_month + interval '1 month' - interval '1 day'))::int) - 1))::date as due,
           coalesce(s.reminders, true) as on_
    from public.payments py join public.leases l on l.id = py.lease_id join public.tenants t on t.id = l.tenant_id
    join public.units u on u.id = l.unit_id join public.landlords ll on ll.id = py.landlord_id
    left join public.autopay_settings s on s.landlord_id = py.landlord_id
    where py.status in ('pending', 'partial', 'late') and l.status in ('signed', 'active') and not py.opening_balance
  ), k as (
    select p.*, case p_today - p.due when -3 then 'before' when 0 then 'due' when 1 then 'late_1' when 7 then 'late_7' end as kind from p
  )
  select k.id, k.kind, k.email, k.full_name, k.lname, k.label, round(k.owed, 2), k.due,
         upper(regexp_replace(k.label, '[^A-Za-z0-9]', '', 'g') || '-' || regexp_replace(split_part(k.full_name, ' ', -1), '[^A-Za-z0-9]', '', 'g')),
         exists (select 1 from public.payment_mandates m where m.lease_id = k.lease_id and m.status = 'active')
  from k
  where k.kind is not null and k.owed > 0 and k.on_ and k.archived_at is null and coalesce(k.email, '') like '%@%'
    and not exists (select 1 from public.rent_reminders r where r.payment_id = k.id and r.kind = k.kind)
$$;

revoke all on function public.save_member(uuid, text, text, text, boolean), public.remove_member(uuid), public.create_member_invite(uuid),
  public.member_invite_preview(text), public.accept_member_invite(text), public.require_account_admin(), public.claim_job(text, integer),
  public.save_autopay_settings(boolean, boolean, text, boolean), public.tenant_autopay_options(), public.add_debicheck_mandate(uuid, text, text, numeric),
  public.cancel_mandate(uuid), public.ensure_rent_charge(uuid, date), public.collections_due(date), public.reminders_due(date)
  from public, anon, authenticated;
grant execute on function public.save_member(uuid, text, text, text, boolean), public.remove_member(uuid), public.create_member_invite(uuid),
  public.accept_member_invite(text), public.save_autopay_settings(boolean, boolean, text, boolean), public.tenant_autopay_options(),
  public.add_debicheck_mandate(uuid, text, text, numeric), public.cancel_mandate(uuid) to authenticated;
grant execute on function public.member_invite_preview(text) to anon, authenticated;
grant execute on function public.claim_job(text, integer), public.ensure_rent_charge(uuid, date), public.collections_due(date),
  public.reminders_due(date) to service_role;

-- Ozow and plan changes now follow the account-admin rule
create or replace function public.save_ozow_account(p_site_code text, p_client_id text, p_client_secret text, p_is_test boolean, p_enabled boolean default true)
returns void language plpgsql security definer set search_path = public as $$
declare v_landlord uuid := public.get_landlord_id();
        v_id text := nullif(trim(coalesce(p_client_id, '')), '');
        v_secret text := nullif(trim(coalesce(p_client_secret, '')), '');
        v_has boolean;
begin
  perform public.require_account_admin();
  if coalesce(trim(p_site_code), '') !~ '^[A-Za-z0-9-]{3,50}$' then raise exception 'Enter the Site Code from your Ozow dashboard (Sites)' using errcode = '22023'; end if;
  select client_id is not null and client_secret is not null into v_has from public.ozow_secrets where landlord_id = v_landlord;
  if not coalesce(v_has, false) and (v_id is null or v_secret is null) then
    raise exception 'Enter the Client ID and Client Secret from your Ozow dashboard (One API Clients)' using errcode = '22023'; end if;
  if v_secret is not null and length(v_secret) < 16 then raise exception 'That Client Secret looks too short' using errcode = '22023'; end if;
  insert into public.ozow_accounts (landlord_id, site_code, is_test, enabled, key_hint, updated_at)
  values (v_landlord, trim(p_site_code), coalesce(p_is_test, false), coalesce(p_enabled, true), right(v_secret, 4), now())
  on conflict (landlord_id) do update set site_code = excluded.site_code, is_test = excluded.is_test, enabled = excluded.enabled,
    key_hint = coalesce(excluded.key_hint, ozow_accounts.key_hint), updated_at = now();
  insert into public.ozow_secrets (landlord_id, client_id, client_secret) values (v_landlord, v_id, v_secret)
  on conflict (landlord_id) do update set client_id = coalesce(excluded.client_id, ozow_secrets.client_id),
    client_secret = coalesce(excluded.client_secret, ozow_secrets.client_secret);
end $$;

create or replace function public.remove_ozow_account()
returns void language plpgsql security definer set search_path = public as $$
declare v_landlord uuid := public.get_landlord_id();
begin
  perform public.require_account_admin();
  update public.autopay_settings set ozow_capitec = false where landlord_id = v_landlord;
  delete from public.ozow_secrets where landlord_id = v_landlord;
  delete from public.ozow_accounts where landlord_id = v_landlord;
end $$;

create or replace function public.change_my_plan(p_tier public.subscription_tier)
returns void language plpgsql security definer set search_path = public as $$
declare v_landlord uuid := public.get_landlord_id(); v_old public.subscription_tier; v_lim public.tier_limits;
        v_old_price numeric; v_units integer; v_props integer;
begin
  perform public.require_account_admin();
  select tier into v_old from public.landlords where id = v_landlord;
  if v_old = p_tier then return; end if;
  select * into v_lim from public.tier_limits where tier = p_tier;
  if v_lim.price_zar is null then raise exception 'The Agency plan is set up with Ryno-Tec. Email rentals@ryno-tec.co.za.' using errcode = 'P0001'; end if;
  select price_zar into v_old_price from public.tier_limits where tier = v_old;
  if v_old_price is null then raise exception 'Your plan is managed by Ryno-Tec. Email rentals@ryno-tec.co.za to change it.' using errcode = 'P0001'; end if;
  if v_lim.price_zar < v_old_price then
    if exists (select 1 from public.platform_invoices where landlord_id = v_landlord and status = 'open' and due_date < current_date) then
      raise exception 'Please pay your overdue invoice before moving to a smaller plan.' using errcode = 'P0001'; end if;
    select count(*) into v_units from public.units where landlord_id = v_landlord;
    select count(*) into v_props from public.properties where landlord_id = v_landlord;
    if v_lim.max_units is not null and v_units > v_lim.max_units then
      raise exception 'The % plan allows % units and you have %. Remove some units first.', v_lim.display_name, v_lim.max_units, v_units using errcode = 'P0001'; end if;
    if v_lim.max_properties is not null and v_props > v_lim.max_properties then
      raise exception 'The % plan allows % properties and you have %. Remove some first.', v_lim.display_name, v_lim.max_properties, v_props using errcode = 'P0001'; end if;
  end if;
  update public.landlords set tier = p_tier where id = v_landlord;
  insert into public.plan_changes (landlord_id, from_tier, to_tier) values (v_landlord, v_old, p_tier);
end $$;

-- Admin dashboard: team sizes
create or replace function public.admin_overview_extra()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.require_platform_admin();
  return jsonb_build_object(
    'team_members', (select count(*) from public.agency_members where active),
    'owners_managed', (select count(*) from public.property_owners),
    'autopay_active', (select count(*) from public.payment_mandates where status = 'active'),
    'autopay_collected_month', (select coalesce(sum(amount), 0) from public.mandate_collections where status = 'successful' and completed_at >= date_trunc('month', now())));
end $$;
revoke all on function public.admin_overview_extra() from public, anon;
grant execute on function public.admin_overview_extra() to authenticated;

alter table public.payment_events drop constraint if exists payment_events_kind_check;
alter table public.payment_events add constraint payment_events_kind_check
  check (kind in ('unknown_reference', 'check_failed', 'mismatch', 'credentials', 'reconcile_mismatch', 'expired', 'autopay', 'reminder'));

notify pgrst, 'reload schema';
