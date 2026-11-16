-- 010: one login can be an owner and a tenant (an owner who rents their own home from another
-- owner on the app). The login has an active side, owner or tenant, and every access rule follows
-- it: on the owner side only their own properties and tenants; on the tenant side only the home
-- they rent. The app switches the side when the person switches between "My properties" and
-- "My home". People with one role have no side row and work exactly as before.

create table public.account_sides (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  side       text not null check (side in ('owner', 'tenant')),
  updated_at timestamptz not null default now()
);
alter table public.account_sides enable row level security;   -- no policies: only through the functions below

create or replace function public.active_side()
returns text language sql stable security definer set search_path = public as $$
  select side from public.account_sides where user_id = auth.uid()
$$;

-- The owner account of the signed-in person, only while they are on the owner side.
create or replace function public.get_landlord_id()
returns uuid language sql stable security definer set search_path = public as $$
  select id from public.landlords where user_id = auth.uid() and coalesce(public.active_side(), 'owner') = 'owner'
$$;

-- The tenant records of the signed-in person, only while they are on the tenant side.
create or replace function public.my_tenant_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select id from public.tenants where user_id = auth.uid() and coalesce(public.active_side(), 'tenant') = 'tenant'
$$;

create or replace function public.tenant_unit_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select l.unit_id from public.leases l
  where l.tenant_id in (select public.my_tenant_ids()) and l.status in ('signed', 'active')
$$;
create or replace function public.tenant_landlord_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select t.landlord_id from public.tenants t where t.id in (select public.my_tenant_ids())
$$;
create or replace function public.tenant_lease_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select l.id from public.leases l where l.tenant_id in (select public.my_tenant_ids())
$$;

drop policy tenants_self_read on public.tenants;
create policy tenants_self_read on public.tenants for select to authenticated
  using (id in (select public.my_tenant_ids()));
drop policy leases_tenant_read on public.leases;
create policy leases_tenant_read on public.leases for select to authenticated
  using (tenant_id in (select public.my_tenant_ids()));
drop policy payments_tenant_read on public.payments;
create policy payments_tenant_read on public.payments for select to authenticated
  using (lease_id in (select public.tenant_lease_ids()));
drop policy messages_tenant_read on public.messages;
create policy messages_tenant_read on public.messages for select to authenticated
  using (tenant_id in (select public.my_tenant_ids()));
drop policy messages_tenant_send on public.messages;
create policy messages_tenant_send on public.messages for insert to authenticated
  with check (sender = 'tenant' and tenant_id in (select public.my_tenant_ids()));

-- What the signed-in person is, and which side is active.
create or replace function public.my_roles()
returns table (owner boolean, tenant boolean, side text)
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.landlords where user_id = auth.uid()),
         exists (select 1 from public.tenants where user_id = auth.uid()),
         public.active_side()
$$;

-- Switch sides (only for people who are both).
create or replace function public.set_my_side(p_side text)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  if p_side not in ('owner', 'tenant') then raise exception 'Unknown side' using errcode = '22023'; end if;
  if not (exists (select 1 from public.landlords where user_id = v_uid) and exists (select 1 from public.tenants where user_id = v_uid)) then
    raise exception 'This login is not both an owner and a tenant' using errcode = 'P0001'; end if;
  insert into public.account_sides (user_id, side) values (v_uid, p_side)
  on conflict (user_id) do update set side = excluded.side, updated_at = now();
end $$;

-- Accepting a tenant invite on an owner login now links it (instead of refusing), except for a
-- lease with yourself. The login lands on the tenant side.
create or replace function public.accept_tenant_invite(p_token text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_inv public.tenant_invites; v_uid uuid := auth.uid(); v_linked uuid; v_keep_owner boolean;
begin
  if v_uid is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  select * into v_inv from public.tenant_invites where token_hash = public.invite_hash(p_token) for update;
  if not found then raise exception 'This invite link is not valid' using errcode = 'P0002'; end if;
  select user_id into v_linked from public.tenants where id = v_inv.tenant_id;
  if v_linked = v_uid then return v_inv.tenant_id; end if;
  if v_inv.accepted_at is not null or v_linked is not null then
    raise exception 'This invite has already been used' using errcode = 'P0001'; end if;
  if v_inv.expires_at <= now() then
    raise exception 'This invite has expired. Ask your landlord for a new one' using errcode = 'P0001'; end if;
  if exists (select 1 from public.landlords where user_id = v_uid and id = v_inv.landlord_id) then
    raise exception 'This invite is from your own account. Send it to your tenant instead' using errcode = 'P0001'; end if;
  if exists (select 1 from public.tenants where user_id = v_uid and landlord_id = v_inv.landlord_id) then
    raise exception 'This account is already linked to another tenant record with this landlord' using errcode = 'P0001'; end if;
  v_keep_owner := not public.release_empty_owner_account(v_uid);   -- an empty owner account from a first Google/Apple sign-in goes
  update public.tenants set user_id = v_uid, popia_consent_at = coalesce(popia_consent_at, now()) where id = v_inv.tenant_id;
  update public.tenant_invites set accepted_at = now() where id = v_inv.id;
  if v_keep_owner then
    insert into public.account_sides (user_id, side) values (v_uid, 'tenant')
    on conflict (user_id) do update set side = 'tenant', updated_at = now();
  end if;
  return v_inv.tenant_id;
end $$;

revoke all on function public.active_side(), public.my_tenant_ids(), public.my_roles(), public.set_my_side(text) from public;
grant execute on function public.active_side(), public.my_tenant_ids(), public.my_roles(), public.set_my_side(text) to authenticated;
grant execute on function public.get_landlord_id() to anon, authenticated;
