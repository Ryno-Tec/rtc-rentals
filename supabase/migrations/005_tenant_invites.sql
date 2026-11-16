-- 005: tenant invites (the owner's registration request)
-- The owner creates an invite for a tenant record. The tenant opens the link, registers
-- (or signs in) and accepts; that links their account to the tenant record, so the lease
-- the owner attached shows in their app. Only a hash of the token is stored.

create table public.tenant_invites (
  id          uuid primary key default gen_random_uuid(),
  landlord_id uuid not null default public.get_landlord_id() references public.landlords(id) on delete cascade,
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  token_hash  text not null unique,
  expires_at  timestamptz not null default now() + interval '14 days',
  accepted_at timestamptz,
  created_at  timestamptz not null default now()
);
create index tenant_invites_tenant_idx on public.tenant_invites(tenant_id);
alter table public.tenant_invites enable row level security;
-- Owners can see and cancel their own invites. Creating and accepting go through the functions below.
create policy tenant_invites_owner_read on public.tenant_invites for select to authenticated
  using (landlord_id = public.get_landlord_id());
create policy tenant_invites_owner_delete on public.tenant_invites for delete to authenticated
  using (landlord_id = public.get_landlord_id());
revoke insert, update on public.tenant_invites from anon, authenticated;

create or replace function public.invite_hash(p_token text)
returns text language sql immutable as $$ select encode(sha256(convert_to(p_token, 'UTF8')), 'hex') $$;

-- Owner: make a fresh invite for one of their tenants. Returns the token once; older unused invites stop working.
create or replace function public.create_tenant_invite(p_tenant uuid)
returns text language plpgsql security definer set search_path = public as $$
declare v_landlord uuid := public.get_landlord_id(); v_token text; v_user uuid;
begin
  if v_landlord is null then raise exception 'Only a landlord can invite a tenant' using errcode = '42501'; end if;
  select user_id into v_user from public.tenants where id = p_tenant and landlord_id = v_landlord;
  if not found then raise exception 'Tenant not found' using errcode = 'P0002'; end if;
  if v_user is not null then raise exception 'This tenant already has app access' using errcode = 'P0001'; end if;
  delete from public.tenant_invites where tenant_id = p_tenant and accepted_at is null;
  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into public.tenant_invites (landlord_id, tenant_id, token_hash) values (v_landlord, p_tenant, public.invite_hash(v_token));
  return v_token;
end $$;

-- Anyone holding the link: what the invite is for, so the tenant knows it is genuine before registering.
create or replace function public.invite_preview(p_token text)
returns table (valid boolean, tenant_name text, tenant_email text, landlord_name text, unit_label text, property_name text)
language sql stable security definer set search_path = public as $$
  select (i.accepted_at is null and i.expires_at > now() and t.user_id is null),
         t.full_name, t.email, l.full_name, u.label, p.name
  from public.tenant_invites i
  join public.tenants t on t.id = i.tenant_id
  join public.landlords l on l.id = i.landlord_id
  left join lateral (select le.unit_id from public.leases le where le.tenant_id = t.id
                     order by (le.status in ('active', 'signed')) desc, le.start_date desc limit 1) le on true
  left join public.units u on u.id = le.unit_id
  left join public.properties p on p.id = u.property_id
  where i.token_hash = public.invite_hash(p_token)
$$;

-- Signed-in tenant: accept the invite and link this account to the tenant record.
create or replace function public.accept_tenant_invite(p_token text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_inv public.tenant_invites; v_uid uuid := auth.uid(); v_linked uuid;
begin
  if v_uid is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  select * into v_inv from public.tenant_invites where token_hash = public.invite_hash(p_token) for update;
  if not found then raise exception 'This invite link is not valid' using errcode = 'P0002'; end if;
  select user_id into v_linked from public.tenants where id = v_inv.tenant_id;
  if v_linked = v_uid then return v_inv.tenant_id; end if;          -- already accepted by this account
  if v_inv.accepted_at is not null or v_linked is not null then
    raise exception 'This invite has already been used' using errcode = 'P0001'; end if;
  if v_inv.expires_at <= now() then
    raise exception 'This invite has expired. Ask your landlord for a new one' using errcode = 'P0001'; end if;
  if exists (select 1 from public.landlords where user_id = v_uid) then
    raise exception 'This is a landlord account. Register as a tenant with a different email' using errcode = 'P0001'; end if;
  if exists (select 1 from public.tenants where user_id = v_uid and landlord_id = v_inv.landlord_id) then
    raise exception 'This account is already linked to another tenant record with this landlord' using errcode = 'P0001'; end if;
  update public.tenants set user_id = v_uid, popia_consent_at = coalesce(popia_consent_at, now()) where id = v_inv.tenant_id;
  update public.tenant_invites set accepted_at = now() where id = v_inv.id;
  return v_inv.tenant_id;
end $$;

revoke all on function public.create_tenant_invite(uuid), public.accept_tenant_invite(text), public.invite_preview(text) from public;
grant execute on function public.create_tenant_invite(uuid), public.accept_tenant_invite(text) to authenticated;
grant execute on function public.invite_preview(text) to anon, authenticated;
