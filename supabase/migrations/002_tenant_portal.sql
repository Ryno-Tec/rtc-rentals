-- ============================================================================
-- RTC Rentals — tenant portal access
--
-- A tenant signs in with their own account (tenants.user_id). They can read
-- their own lease, unit, property, landlord contact details and payments,
-- log maintenance requests for their unit, and message their landlord.
-- They can never see other tenants, other units, or change what the landlord set.
-- ============================================================================

-- Tenant accounts are signed up with role = 'tenant' (from their invite link) and
-- must not get a landlord account and trial. Everyone else is a landlord.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_landlord uuid;
begin
  if coalesce(new.raw_user_meta_data->>'role', 'landlord') = 'tenant' then
    return new;
  end if;
  insert into public.landlords (user_id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', ''))
  returning id into v_landlord;

  insert into public.subscriptions (landlord_id) values (v_landlord);
  return new;
end $$;

-- Maintenance: a category for triage, and a progress log the tenant can follow.
alter table public.maintenance_requests add column category text;

create table public.maintenance_updates (
  id          uuid primary key default gen_random_uuid(),
  landlord_id uuid not null default public.get_landlord_id() references public.landlords(id) on delete cascade,
  request_id  uuid not null references public.maintenance_requests(id) on delete cascade,
  body        text not null check (length(body) between 1 and 2000),
  created_at  timestamptz not null default now()
);
create index maintenance_updates_request_idx on public.maintenance_updates(request_id, created_at);
alter table public.maintenance_updates enable row level security;
create policy maintenance_updates_owner on public.maintenance_updates for all to authenticated
  using (landlord_id = public.get_landlord_id()) with check (landlord_id = public.get_landlord_id());

-- ----------------------------------------------------------------------------
-- Helpers (SECURITY DEFINER so policies don't recurse through each other)
-- ----------------------------------------------------------------------------
-- Units the signed-in tenant currently rents (signed or active lease).
create or replace function public.tenant_unit_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select l.unit_id from public.leases l join public.tenants t on t.id = l.tenant_id
  where t.user_id = auth.uid() and l.status in ('signed', 'active')
$$;

-- Landlords the signed-in tenant rents from.
create or replace function public.tenant_landlord_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select t.landlord_id from public.tenants t where t.user_id = auth.uid()
$$;

-- Rows a tenant creates have no landlord in their session, so fill it in
-- from the unit or tenant record. The composite foreign keys then guarantee it matches.
create or replace function public.fill_landlord_from_unit()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.landlord_id is null then
    select landlord_id into new.landlord_id from public.units where id = new.unit_id;
  end if;
  return new;
end $$;

create or replace function public.fill_landlord_from_tenant()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.landlord_id is null then
    select landlord_id into new.landlord_id from public.tenants where id = new.tenant_id;
  end if;
  return new;
end $$;

create trigger maintenance_fill_landlord before insert on public.maintenance_requests
  for each row execute function public.fill_landlord_from_unit();
create trigger messages_fill_landlord before insert on public.messages
  for each row execute function public.fill_landlord_from_tenant();

-- ----------------------------------------------------------------------------
-- Tenant read access
-- ----------------------------------------------------------------------------
create policy units_tenant_read on public.units for select to authenticated
  using (id in (select public.tenant_unit_ids()));

create policy properties_tenant_read on public.properties for select to authenticated
  using (id in (select property_id from public.units where id in (select public.tenant_unit_ids())));

create policy landlords_tenant_read on public.landlords for select to authenticated
  using (id in (select public.tenant_landlord_ids()));

create policy maintenance_tenant_read on public.maintenance_requests for select to authenticated
  using (unit_id in (select public.tenant_unit_ids()));

create policy maintenance_updates_tenant_read on public.maintenance_updates for select to authenticated
  using (request_id in (select id from public.maintenance_requests where unit_id in (select public.tenant_unit_ids())));

-- Tenants can log a new request for their own unit. Status, contractor and cost stay the landlord's.
create policy maintenance_tenant_create on public.maintenance_requests for insert to authenticated
  with check (unit_id in (select public.tenant_unit_ids())
              and status = 'open' and contractor is null and cost is null and resolved_at is null);

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.maintenance_updates;
  end if;
end $$;
