-- ============================================================================
-- RTC Rentals — initial schema
-- Ryno-Tec Consulting (Pty) Ltd
--
-- Multi-tenant model: every row belongs to exactly one landlord account.
-- Row-level security (RLS) on every table means a signed-in landlord can only
-- ever see and change their own rows, even if the browser code is tampered with.
--
-- Run in the Supabase SQL editor, or with `supabase db push`.
-- ============================================================================

create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- Enum types
-- ----------------------------------------------------------------------------
create type public.subscription_tier as enum ('starter', 'growth', 'pro', 'agency');
create type public.property_type     as enum ('house', 'apartment_block', 'townhouse', 'flat', 'backyard_rooms', 'student_accommodation', 'commercial', 'other');
create type public.unit_status       as enum ('vacant', 'occupied', 'notice', 'maintenance');
create type public.lease_status      as enum ('draft', 'sent', 'signed', 'active', 'ended', 'cancelled');
create type public.payment_status    as enum ('pending', 'paid', 'partial', 'late', 'failed', 'refunded');
create type public.payment_method    as enum ('eft', 'ozow', 'card', 'debicheck', 'cash', 'other');
create type public.maintenance_status   as enum ('open', 'assigned', 'in_progress', 'resolved', 'closed');
create type public.maintenance_priority as enum ('low', 'medium', 'high', 'urgent');
create type public.inspection_kind   as enum ('move_in', 'move_out', 'routine');
create type public.sa_province       as enum ('EC', 'FS', 'GP', 'KZN', 'LP', 'MP', 'NC', 'NW', 'WC');

-- ----------------------------------------------------------------------------
-- Subscription tiers (reference data, readable by everyone signed in)
-- ----------------------------------------------------------------------------
create table public.tier_limits (
  tier            public.subscription_tier primary key,
  display_name    text    not null,
  price_zar       numeric(10,2),          -- null = custom pricing
  max_units       integer,                -- null = unlimited
  max_properties  integer,                -- null = unlimited
  credit_checks_included integer not null default 0,
  esignatures_included   integer not null default 0
);

insert into public.tier_limits (tier, display_name, price_zar, max_units, max_properties, credit_checks_included, esignatures_included) values
  ('starter', 'Starter', 149.00,  3,   3, 0, 0),
  ('growth',  'Growth',  399.00, 10,  10, 2, 2),
  ('pro',     'Pro',     799.00, 25,  25, 5, 5),
  ('agency',  'Agency',  null,  null, null, 0, 0);

-- ----------------------------------------------------------------------------
-- Landlords — one row per signed-up account (created automatically on sign-up)
-- ----------------------------------------------------------------------------
create table public.landlords (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null unique references auth.users(id) on delete cascade,
  full_name     text,
  email         text,
  phone         text,
  company_name  text,
  tier          public.subscription_tier not null default 'starter',
  popia_consent_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Helper used by every policy and column default: the landlord row id of the
-- signed-in user. SECURITY DEFINER so it can read landlords without recursing
-- into that table's own policy.
create or replace function public.get_landlord_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.landlords where user_id = auth.uid()
$$;

-- ----------------------------------------------------------------------------
-- Properties and units
-- ----------------------------------------------------------------------------
create table public.properties (
  id            uuid primary key default gen_random_uuid(),
  landlord_id   uuid not null default public.get_landlord_id() references public.landlords(id) on delete cascade,
  name          text not null check (length(trim(name)) > 0),
  property_type public.property_type not null default 'house',
  street_address text not null,
  suburb        text,
  city          text not null,
  province      public.sa_province not null,
  postal_code   text check (postal_code is null or postal_code ~ '^[0-9]{4}$'),
  erf_number    text,
  municipality_account text,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (id, landlord_id)               -- lets units prove they share the landlord
);

create table public.units (
  id            uuid primary key default gen_random_uuid(),
  landlord_id   uuid not null default public.get_landlord_id(),
  property_id   uuid not null,
  label         text not null check (length(trim(label)) > 0),   -- e.g. "Unit 3", "Backroom B"
  bedrooms      smallint not null default 1 check (bedrooms between 0 and 20),
  bathrooms     numeric(3,1) not null default 1 check (bathrooms between 0 and 20),
  size_m2       numeric(8,2) check (size_m2 is null or size_m2 > 0),
  monthly_rent  numeric(12,2) not null check (monthly_rent >= 0),
  deposit       numeric(12,2) not null default 0 check (deposit >= 0),
  status        public.unit_status not null default 'vacant',
  prepaid_meter_number text,
  water_included boolean not null default false,
  electricity_included boolean not null default false,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- Composite FK: a unit can only point at a property owned by the same landlord.
  foreign key (property_id, landlord_id) references public.properties(id, landlord_id) on delete cascade,
  unique (property_id, label),
  unique (id, landlord_id)
);

-- ----------------------------------------------------------------------------
-- Tenants and leases
-- ----------------------------------------------------------------------------
create table public.tenants (
  id            uuid primary key default gen_random_uuid(),
  landlord_id   uuid not null default public.get_landlord_id() references public.landlords(id) on delete cascade,
  user_id       uuid references auth.users(id) on delete set null,  -- set when the tenant gets portal access
  full_name     text not null,
  id_number     text,                    -- SA ID or passport; FICA. Encrypt at rest in Phase 1.
  email         text,
  phone         text,
  employer      text,
  monthly_income numeric(12,2),
  credit_check_ref text,                 -- TPN reference
  popia_consent_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (id, landlord_id)
);

create table public.leases (
  id            uuid primary key default gen_random_uuid(),
  landlord_id   uuid not null default public.get_landlord_id(),
  unit_id       uuid not null,
  tenant_id     uuid not null,
  status        public.lease_status not null default 'draft',
  start_date    date not null,
  end_date      date,
  monthly_rent  numeric(12,2) not null check (monthly_rent >= 0),
  deposit       numeric(12,2) not null default 0 check (deposit >= 0),
  rent_due_day  smallint not null default 1 check (rent_due_day between 1 and 28),
  escalation_pct numeric(5,2) not null default 0 check (escalation_pct between 0 and 100),
  esign_ref     text,                    -- SigniFlow workflow id
  signed_at     timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (end_date is null or end_date > start_date),
  foreign key (unit_id, landlord_id)   references public.units(id, landlord_id)   on delete restrict,
  foreign key (tenant_id, landlord_id) references public.tenants(id, landlord_id) on delete restrict,
  unique (id, landlord_id)
);

-- Only one live lease per unit at a time.
create unique index leases_one_active_per_unit
  on public.leases(unit_id) where status in ('signed', 'active');

-- ----------------------------------------------------------------------------
-- Payments
-- ----------------------------------------------------------------------------
create table public.payments (
  id            uuid primary key default gen_random_uuid(),
  landlord_id   uuid not null default public.get_landlord_id(),
  lease_id      uuid not null,
  period_month  date not null check (extract(day from period_month) = 1),  -- first day of the rent month
  amount_due    numeric(12,2) not null check (amount_due >= 0),
  amount_paid   numeric(12,2) not null default 0 check (amount_paid >= 0),
  status        public.payment_status not null default 'pending',
  method        public.payment_method,
  provider_ref  text unique,             -- Ozow / Peach transaction id (idempotency)
  paid_at       timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  foreign key (lease_id, landlord_id) references public.leases(id, landlord_id) on delete restrict,
  unique (lease_id, period_month)
);

-- ----------------------------------------------------------------------------
-- Maintenance, inspections, documents, messages, notifications, subscriptions
-- ----------------------------------------------------------------------------
create table public.maintenance_requests (
  id            uuid primary key default gen_random_uuid(),
  landlord_id   uuid not null default public.get_landlord_id(),
  unit_id       uuid not null,
  title         text not null,
  description   text,
  priority      public.maintenance_priority not null default 'medium',
  status        public.maintenance_status not null default 'open',
  contractor    text,
  cost          numeric(12,2) check (cost is null or cost >= 0),
  photo_paths   text[] not null default '{}',
  resolved_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  foreign key (unit_id, landlord_id) references public.units(id, landlord_id) on delete cascade
);

create table public.inspections (
  id            uuid primary key default gen_random_uuid(),
  landlord_id   uuid not null default public.get_landlord_id(),
  lease_id      uuid not null,
  kind          public.inspection_kind not null,
  inspected_on  date not null default current_date,
  findings      jsonb not null default '[]',   -- [{room, item, condition, note, photo_path}]
  landlord_signed_at timestamptz,
  tenant_signed_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  foreign key (lease_id, landlord_id) references public.leases(id, landlord_id) on delete cascade
);

create table public.documents (
  id            uuid primary key default gen_random_uuid(),
  landlord_id   uuid not null default public.get_landlord_id() references public.landlords(id) on delete cascade,
  property_id   uuid references public.properties(id) on delete cascade,
  unit_id       uuid references public.units(id) on delete cascade,
  lease_id      uuid references public.leases(id) on delete cascade,
  tenant_id     uuid references public.tenants(id) on delete cascade,
  name          text not null,
  storage_path  text not null,           -- path in the private 'documents' storage bucket
  mime_type     text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table public.messages (
  id            uuid primary key default gen_random_uuid(),
  landlord_id   uuid not null default public.get_landlord_id(),
  tenant_id     uuid not null,
  sender        text not null check (sender in ('landlord', 'tenant')),
  body          text not null check (length(body) between 1 and 5000),
  read_at       timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  foreign key (tenant_id, landlord_id) references public.tenants(id, landlord_id) on delete cascade
);

create table public.notifications (
  id            uuid primary key default gen_random_uuid(),
  landlord_id   uuid not null default public.get_landlord_id() references public.landlords(id) on delete cascade,
  channel       text not null check (channel in ('in_app', 'email', 'sms')),
  title         text not null,
  body          text,
  link          text,
  read_at       timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table public.subscriptions (
  id            uuid primary key default gen_random_uuid(),
  landlord_id   uuid not null unique references public.landlords(id) on delete cascade,
  status        text not null default 'trial' check (status in ('trial', 'active', 'past_due', 'cancelled')),
  trial_ends_at timestamptz default (now() + interval '30 days'),
  payfast_token text,                    -- PayFast recurring billing token
  current_period_end timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- Indexes
-- ----------------------------------------------------------------------------
create index properties_landlord_idx   on public.properties(landlord_id);
create index units_landlord_idx        on public.units(landlord_id);
create index units_property_idx        on public.units(property_id);
create index tenants_landlord_idx      on public.tenants(landlord_id);
create index leases_landlord_idx       on public.leases(landlord_id);
create index leases_unit_idx           on public.leases(unit_id);
create index payments_landlord_period_idx on public.payments(landlord_id, period_month);
create index maintenance_landlord_status_idx on public.maintenance_requests(landlord_id, status);
create index inspections_lease_idx     on public.inspections(lease_id);
create index documents_landlord_idx    on public.documents(landlord_id);
create index messages_tenant_idx       on public.messages(tenant_id, created_at);
create index notifications_landlord_unread_idx on public.notifications(landlord_id) where read_at is null;

-- ----------------------------------------------------------------------------
-- updated_at triggers
-- ----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['landlords','properties','units','tenants','leases','payments',
                           'maintenance_requests','inspections','documents','messages',
                           'notifications','subscriptions']
  loop
    execute format('create trigger %I_updated_at before update on public.%I
                    for each row execute function public.set_updated_at()', t, t);
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- Plan limits: block adding properties/units beyond the landlord's tier.
-- Enforced in the database so the browser can't bypass it.
-- ----------------------------------------------------------------------------
create or replace function public.enforce_tier_limits()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit integer;
  v_count integer;
  v_tier  public.subscription_tier;
begin
  select l.tier into v_tier from public.landlords l where l.id = new.landlord_id;

  if tg_table_name = 'units' then
    select max_units into v_limit from public.tier_limits where tier = v_tier;
    select count(*) into v_count from public.units where landlord_id = new.landlord_id;
  else
    select max_properties into v_limit from public.tier_limits where tier = v_tier;
    select count(*) into v_count from public.properties where landlord_id = new.landlord_id;
  end if;

  if v_limit is not null and v_count >= v_limit then
    raise exception 'TIER_LIMIT: Your % plan allows % %. Upgrade to add more.',
      initcap(v_tier::text), v_limit, tg_table_name
      using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger properties_tier_limit before insert on public.properties
  for each row execute function public.enforce_tier_limits();
create trigger units_tier_limit before insert on public.units
  for each row execute function public.enforce_tier_limits();

-- ----------------------------------------------------------------------------
-- New sign-up → landlord row + 30-day trial subscription
-- ----------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_landlord uuid;
begin
  insert into public.landlords (user_id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', ''))
  returning id into v_landlord;

  insert into public.subscriptions (landlord_id) values (v_landlord);
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ----------------------------------------------------------------------------
-- Portfolio summary view for the dashboard (runs with the caller's RLS)
-- ----------------------------------------------------------------------------
create view public.portfolio_summary with (security_invoker = true) as
select
  count(distinct p.id)                                        as properties,
  count(u.id)                                                 as units,
  count(u.id) filter (where u.status = 'occupied')            as occupied_units,
  count(u.id) filter (where u.status = 'vacant')              as vacant_units,
  coalesce(sum(u.monthly_rent) filter (where u.status in ('occupied','notice')), 0) as rent_roll,
  coalesce(sum(u.monthly_rent), 0)                            as potential_rent
from public.properties p
left join public.units u on u.property_id = p.id;

-- ----------------------------------------------------------------------------
-- Row-level security
-- ----------------------------------------------------------------------------
alter table public.tier_limits          enable row level security;
alter table public.landlords            enable row level security;
alter table public.properties           enable row level security;
alter table public.units                enable row level security;
alter table public.tenants              enable row level security;
alter table public.leases               enable row level security;
alter table public.payments             enable row level security;
alter table public.maintenance_requests enable row level security;
alter table public.inspections          enable row level security;
alter table public.documents            enable row level security;
alter table public.messages             enable row level security;
alter table public.notifications        enable row level security;
alter table public.subscriptions        enable row level security;

create policy tier_limits_read on public.tier_limits
  for select to authenticated using (true);

-- A landlord can read and update their own profile, but not change their own tier.
create policy landlords_self_read on public.landlords
  for select to authenticated using (user_id = auth.uid());
create policy landlords_self_update on public.landlords
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Plan changes come only from the billing webhook (service role), never the browser.
create or replace function public.protect_landlord_tier()
returns trigger language plpgsql as $$
begin
  if current_user in ('authenticated', 'anon')
     and (new.tier is distinct from old.tier or new.user_id is distinct from old.user_id) then
    raise exception 'Plan and account owner can only be changed through billing' using errcode = '42501';
  end if;
  return new;
end $$;

create trigger landlords_protect_tier before update on public.landlords
  for each row execute function public.protect_landlord_tier();

create policy subscriptions_self_read on public.subscriptions
  for select to authenticated using (landlord_id = public.get_landlord_id());
-- No insert/update for subscriptions from the browser: billing webhooks use the service role.

-- Every landlord-owned table: full access to own rows only.
do $$
declare t text;
begin
  foreach t in array array['properties','units','tenants','leases','payments',
                           'maintenance_requests','inspections','documents','messages','notifications']
  loop
    execute format(
      'create policy %I_owner on public.%I for all to authenticated
         using (landlord_id = public.get_landlord_id())
         with check (landlord_id = public.get_landlord_id())', t, t);
  end loop;
end $$;

-- Tenants with portal access (Phase 1): read-only view of their own record,
-- leases, payments, and two-way messages.
create policy tenants_self_read on public.tenants
  for select to authenticated using (user_id = auth.uid());
create policy leases_tenant_read on public.leases
  for select to authenticated using (tenant_id in (select id from public.tenants where user_id = auth.uid()));
create policy payments_tenant_read on public.payments
  for select to authenticated using (lease_id in (
    select l.id from public.leases l join public.tenants t on t.id = l.tenant_id where t.user_id = auth.uid()));
create policy messages_tenant_read on public.messages
  for select to authenticated
  using (tenant_id in (select id from public.tenants where user_id = auth.uid()));
create policy messages_tenant_send on public.messages
  for insert to authenticated
  with check (sender = 'tenant' and tenant_id in (select id from public.tenants where user_id = auth.uid()));

grant usage on schema public to authenticated;
grant select on public.portfolio_summary to authenticated;

-- ----------------------------------------------------------------------------
-- Realtime: dashboard listens for changes on these tables
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.properties, public.units,
      public.payments, public.maintenance_requests, public.messages;
  end if;
end $$;
