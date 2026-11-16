-- 008: profile photos, tax-year expenses, and social sign-in for invited people

-- ----------------------------------------------------------------------------
-- Profile photos
--   Tenants and maintenance people must add one (the owner knows who they're dealing with);
--   owners may. Files are private: <auth user id>/<file> in the profile-photos bucket.
-- ----------------------------------------------------------------------------
alter table public.landlords         add column if not exists photo_path text;
alter table public.tenants           add column if not exists photo_path text;
alter table public.maintenance_staff add column if not exists photo_path text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('profile-photos', 'profile-photos', false, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

-- Each person manages the files in their own folder.
create policy profile_photos_own on storage.objects for all to authenticated
  using (bucket_id = 'profile-photos' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'profile-photos' and (storage.foldername(name))[1] = auth.uid()::text);

-- People whose photos the signed-in person may see: an owner sees their tenants and team; a
-- tenant or team member sees their owner.
create or replace function public.visible_photo_folders()
returns setof text language sql stable security definer set search_path = public as $$
  select user_id::text from public.tenants where landlord_id = public.get_landlord_id() and user_id is not null
  union
  select user_id::text from public.maintenance_staff where landlord_id = public.get_landlord_id() and user_id is not null
  union
  select l.user_id::text from public.landlords l
   where l.id in (select landlord_id from public.tenants where user_id = auth.uid())
      or l.id in (select landlord_id from public.maintenance_staff where user_id = auth.uid() and active)
$$;
create policy profile_photos_related_read on storage.objects for select to authenticated
  using (bucket_id = 'profile-photos' and (storage.foldername(name))[1] in (select public.visible_photo_folders()));

-- Save the signed-in person's photo on every record that is theirs (owner, tenant, team member).
create or replace function public.set_my_photo(p_path text)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  if p_path is not null and p_path not like v_uid::text || '/%' then
    raise exception 'That photo isn''t in your folder' using errcode = '42501'; end if;
  update public.landlords set photo_path = p_path where user_id = v_uid;
  update public.tenants set photo_path = p_path where user_id = v_uid;
  update public.maintenance_staff set photo_path = p_path where user_id = v_uid;
end $$;

-- ----------------------------------------------------------------------------
-- Expenses, for the tax-year rental schedule (ITR12). Repairs with a cost on a maintenance
-- job are counted from there; this table holds everything else.
-- ----------------------------------------------------------------------------
create table public.expenses (
  id          uuid primary key default gen_random_uuid(),
  landlord_id uuid not null default public.get_landlord_id() references public.landlords(id) on delete cascade,
  property_id uuid not null,
  spent_on    date not null,
  category    text not null check (category in ('rates', 'levies', 'insurance', 'bond_interest', 'repairs', 'agent_fees',
                'advertising', 'utilities', 'legal_accounting', 'garden_security', 'other')),
  description text check (description is null or length(description) <= 200),
  amount      numeric(12,2) not null check (amount > 0),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  foreign key (property_id, landlord_id) references public.properties(id, landlord_id) on delete cascade
);
create index expenses_landlord_date_idx on public.expenses(landlord_id, spent_on);
create trigger expenses_updated_at before update on public.expenses for each row execute function public.set_updated_at();
alter table public.expenses enable row level security;
create policy expenses_owner on public.expenses for all to authenticated
  using (landlord_id = public.get_landlord_id()) with check (landlord_id = public.get_landlord_id());

-- ----------------------------------------------------------------------------
-- Social sign-in (Google, Apple, Microsoft) from an invite link
--   A new sign-in through Google or Apple carries no role, so the sign-up trigger opens an empty
--   owner account for it. When that person then accepts a tenant or team invite, the empty owner
--   account (no properties, tenants or team, created in the last day) is removed so the invite
--   can link. An owner account with anything in it is never removed.
-- ----------------------------------------------------------------------------
create or replace function public.release_empty_owner_account(p_uid uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_l public.landlords;
begin
  select * into v_l from public.landlords where user_id = p_uid;
  if not found then return true; end if;
  if v_l.created_at < now() - interval '1 day'
     or exists (select 1 from public.properties where landlord_id = v_l.id)
     or exists (select 1 from public.tenants where landlord_id = v_l.id)
     or exists (select 1 from public.maintenance_staff where landlord_id = v_l.id) then
    return false;
  end if;
  delete from public.landlords where id = v_l.id;      -- its subscription row goes with it
  return true;
end $$;

create or replace function public.accept_tenant_invite(p_token text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_inv public.tenant_invites; v_uid uuid := auth.uid(); v_linked uuid;
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
  if not public.release_empty_owner_account(v_uid) then
    raise exception 'This is a landlord account. Register as a tenant with a different email' using errcode = 'P0001'; end if;
  if exists (select 1 from public.tenants where user_id = v_uid and landlord_id = v_inv.landlord_id) then
    raise exception 'This account is already linked to another tenant record with this landlord' using errcode = 'P0001'; end if;
  update public.tenants set user_id = v_uid, popia_consent_at = coalesce(popia_consent_at, now()) where id = v_inv.tenant_id;
  update public.tenant_invites set accepted_at = now() where id = v_inv.id;
  return v_inv.tenant_id;
end $$;

create or replace function public.accept_staff_invite(p_token text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_inv public.staff_invites; v_uid uuid := auth.uid(); v_linked uuid;
begin
  if v_uid is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  select * into v_inv from public.staff_invites where token_hash = public.invite_hash(p_token) for update;
  if not found then raise exception 'This invite link is not valid' using errcode = 'P0002'; end if;
  select user_id into v_linked from public.maintenance_staff where id = v_inv.staff_id;
  if v_linked = v_uid then return v_inv.staff_id; end if;
  if v_inv.accepted_at is not null or v_linked is not null then
    raise exception 'This invite has already been used' using errcode = 'P0001'; end if;
  if v_inv.expires_at <= now() then
    raise exception 'This invite has expired. Ask the owner for a new one' using errcode = 'P0001'; end if;
  if not public.release_empty_owner_account(v_uid) then
    raise exception 'This is an owner account. Register with a different email' using errcode = 'P0001'; end if;
  if exists (select 1 from public.tenants where user_id = v_uid) then
    raise exception 'This is a tenant account. Register with a different email' using errcode = 'P0001'; end if;
  if exists (select 1 from public.maintenance_staff where user_id = v_uid and landlord_id = v_inv.landlord_id) then
    raise exception 'This account is already on this owner''s team' using errcode = 'P0001'; end if;
  update public.maintenance_staff set user_id = v_uid where id = v_inv.staff_id;
  update public.staff_invites set accepted_at = now() where id = v_inv.id;
  return v_inv.staff_id;
end $$;

revoke all on function public.visible_photo_folders(), public.set_my_photo(text), public.release_empty_owner_account(uuid) from public;
grant execute on function public.visible_photo_folders(), public.set_my_photo(text) to authenticated;
grant execute on function public.accept_tenant_invite(text), public.accept_staff_invite(text) to authenticated;
