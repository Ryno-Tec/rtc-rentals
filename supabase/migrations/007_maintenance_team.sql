-- 007: maintenance team
-- The owner adds the people who fix things (a handyman, caretaker, plumber or a company) and
-- assigns logged faults to them. Each team member can be invited to their own login, where
-- they see only the jobs assigned to them: the address, the fault, the tenant's name and phone
-- for access, and the progress log. They move a job along (on the way, in progress, done) and
-- add notes; the tenant and the owner see every step.

-- A maintenance account is neither a landlord nor a tenant.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_landlord uuid;
begin
  if coalesce(new.raw_user_meta_data->>'role', 'landlord') in ('tenant', 'staff') then
    return new;
  end if;
  insert into public.landlords (user_id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', ''))
  returning id into v_landlord;
  insert into public.subscriptions (landlord_id) values (v_landlord);
  return new;
end $$;

create table public.maintenance_staff (
  id           uuid primary key default gen_random_uuid(),
  landlord_id  uuid not null default public.get_landlord_id() references public.landlords(id) on delete cascade,
  full_name    text not null check (length(trim(full_name)) between 2 and 120),
  trade        text check (trade is null or length(trade) <= 80),
  phone        text check (phone is null or length(phone) <= 30),
  email        text check (email is null or length(email) <= 200),
  is_employee  boolean not null default false,       -- works for the owner (staff contract) vs. an outside contractor
  contract     jsonb,                                 -- the owner's staff-contract details, for reprinting
  active       boolean not null default true,
  user_id      uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index maintenance_staff_landlord_idx on public.maintenance_staff(landlord_id);
create unique index maintenance_staff_user_landlord on public.maintenance_staff(user_id, landlord_id) where user_id is not null;
create trigger maintenance_staff_updated_at before update on public.maintenance_staff
  for each row execute function public.set_updated_at();

alter table public.maintenance_requests
  add column assigned_to   uuid references public.maintenance_staff(id) on delete set null,
  add column assigned_name text,                     -- shown to the tenant: who is coming
  add column scheduled_for date;

alter table public.maintenance_updates
  add column author text not null default 'landlord' check (author in ('landlord', 'staff', 'tenant')),
  add column status public.maintenance_status;       -- the status this update moved the job to, if any

-- Keep the assignee's name on the request, and the status in step with assigning.
-- Runs as the caller (not security definer) so it can tell the owner from a tenant.
create or replace function public.maintenance_assign_fill()
returns trigger language plpgsql set search_path = public as $$
begin
  -- Only the owner assigns work (a tenant logging a fault can't pick who does it).
  if current_user in ('anon', 'authenticated') and public.get_landlord_id() is distinct from new.landlord_id then
    if tg_op = 'INSERT' then new.assigned_to := null; new.scheduled_for := null;
    else new.assigned_to := old.assigned_to; new.scheduled_for := old.scheduled_for; end if;
  end if;
  if tg_op = 'INSERT' or new.assigned_to is distinct from old.assigned_to then
    if new.assigned_to is null then
      new.assigned_name := null;
      if new.status = 'assigned' then new.status := 'open'; end if;
    else
      select full_name into new.assigned_name from public.maintenance_staff
        where id = new.assigned_to and landlord_id = new.landlord_id and active;
      if not found then raise exception 'That team member isn''t on your maintenance team' using errcode = '23503'; end if;
      if new.status = 'open' then new.status := 'assigned'; end if;
    end if;
  end if;
  if new.status in ('resolved', 'closed') and new.resolved_at is null then new.resolved_at := now(); end if;
  if new.status not in ('resolved', 'closed') then new.resolved_at := null; end if;
  return new;
end $$;
-- Named to run after maintenance_fill_landlord (triggers fire in name order).
create trigger maintenance_z_assign before insert or update on public.maintenance_requests
  for each row execute function public.maintenance_assign_fill();

-- ----------------------------------------------------------------------------
-- Access
-- ----------------------------------------------------------------------------
alter table public.maintenance_staff enable row level security;
create policy maintenance_staff_owner on public.maintenance_staff for all to authenticated
  using (landlord_id = public.get_landlord_id()) with check (landlord_id = public.get_landlord_id());

-- From the browser a login can only be removed, never attached: that happens in accept_staff_invite().
create or replace function public.maintenance_staff_guard()
returns trigger language plpgsql as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' and new.user_id is not null then
      raise exception 'A team member gets a login by accepting an invite' using errcode = '42501'; end if;
    if tg_op = 'UPDATE' and new.user_id is not null and new.user_id is distinct from old.user_id then
      raise exception 'A team member gets a login by accepting an invite' using errcode = '42501'; end if;
  end if;
  return new;
end $$;
create trigger maintenance_staff_guard before insert or update on public.maintenance_staff
  for each row execute function public.maintenance_staff_guard();
create policy maintenance_staff_self_read on public.maintenance_staff for select to authenticated
  using (user_id = auth.uid());

-- The team-member rows of the signed-in person (one per owner they work for).
create or replace function public.staff_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select id from public.maintenance_staff where user_id = auth.uid() and active
$$;

-- Staff read jobs and their logs through staff_jobs() below, not the tables: the tables hold
-- the owner's cost and notes they don't need. No direct table policies for staff.

-- Jobs assigned to the signed-in team member, with what they need to do the work.
create or replace function public.staff_jobs()
returns table (id uuid, title text, description text, category text, priority public.maintenance_priority,
  status public.maintenance_status, scheduled_for date, created_at timestamptz, updated_at timestamptz,
  unit_label text, property_name text, address text, tenant_name text, tenant_phone text,
  owner_name text, owner_phone text, updates jsonb)
language sql stable security definer set search_path = public as $$
  select r.id, r.title, r.description, r.category, r.priority, r.status, r.scheduled_for, r.created_at, r.updated_at,
         u.label, p.name,
         concat_ws(', ', nullif(u.label, ''), p.street_address, p.suburb, p.city),
         t.full_name, t.phone, l.full_name, l.phone,
         coalesce((select jsonb_agg(jsonb_build_object('body', m.body, 'author', m.author, 'status', m.status, 'created_at', m.created_at)
                                    order by m.created_at)
                   from public.maintenance_updates m where m.request_id = r.id), '[]'::jsonb)
  from public.maintenance_requests r
  join public.units u on u.id = r.unit_id
  join public.properties p on p.id = u.property_id
  join public.landlords l on l.id = r.landlord_id
  left join lateral (select te.full_name, te.phone from public.leases le join public.tenants te on te.id = le.tenant_id
                     where le.unit_id = r.unit_id and le.status in ('active', 'signed') order by le.start_date desc limit 1) t on true
  where r.assigned_to in (select public.staff_ids())
  order by (r.status in ('resolved', 'closed')), r.scheduled_for nulls last, r.created_at desc
$$;

-- Team member: move a job along and/or add a note. They can't close a job or touch cost.
create or replace function public.staff_update_job(p_request uuid, p_status public.maintenance_status, p_note text)
returns void language plpgsql security definer set search_path = public as $$
declare v_req public.maintenance_requests; v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
  select * into v_req from public.maintenance_requests
    where id = p_request and assigned_to in (select public.staff_ids()) for update;
  if not found then raise exception 'Job not found' using errcode = 'P0002'; end if;
  if v_req.status = 'closed' then raise exception 'The owner has closed this job' using errcode = 'P0001'; end if;
  if p_status is not null and p_status not in ('assigned', 'in_progress', 'resolved') then
    raise exception 'Only the owner can close a job' using errcode = '42501'; end if;
  if p_status is null and v_note is null then raise exception 'Add a note or choose a status' using errcode = '22023'; end if;
  if v_note is not null and length(v_note) > 2000 then raise exception 'Keep the note under 2000 characters' using errcode = '22001'; end if;
  if p_status is not null and p_status <> v_req.status then
    update public.maintenance_requests set status = p_status where id = p_request;
  end if;
  insert into public.maintenance_updates (landlord_id, request_id, body, author, status)
  values (v_req.landlord_id, p_request,
          coalesce(v_note, case p_status when 'in_progress' then 'Work has started.' when 'resolved' then 'Work is done.' else 'Job accepted.' end),
          'staff', case when p_status is distinct from v_req.status then p_status end);
end $$;

-- ----------------------------------------------------------------------------
-- Team invites: same pattern as tenant invites (005). Only a hash of the token is stored.
-- ----------------------------------------------------------------------------
create table public.staff_invites (
  id          uuid primary key default gen_random_uuid(),
  landlord_id uuid not null default public.get_landlord_id() references public.landlords(id) on delete cascade,
  staff_id    uuid not null references public.maintenance_staff(id) on delete cascade,
  token_hash  text not null unique,
  expires_at  timestamptz not null default now() + interval '14 days',
  accepted_at timestamptz,
  created_at  timestamptz not null default now()
);
create index staff_invites_staff_idx on public.staff_invites(staff_id);
alter table public.staff_invites enable row level security;
create policy staff_invites_owner_read on public.staff_invites for select to authenticated
  using (landlord_id = public.get_landlord_id());
create policy staff_invites_owner_delete on public.staff_invites for delete to authenticated
  using (landlord_id = public.get_landlord_id());
revoke insert, update on public.staff_invites from anon, authenticated;

create or replace function public.create_staff_invite(p_staff uuid)
returns text language plpgsql security definer set search_path = public as $$
declare v_landlord uuid := public.get_landlord_id(); v_token text; v_user uuid;
begin
  if v_landlord is null then raise exception 'Only an owner can invite a team member' using errcode = '42501'; end if;
  select user_id into v_user from public.maintenance_staff where id = p_staff and landlord_id = v_landlord and active;
  if not found then raise exception 'Team member not found' using errcode = 'P0002'; end if;
  if v_user is not null then raise exception 'This team member already has a login' using errcode = 'P0001'; end if;
  delete from public.staff_invites where staff_id = p_staff and accepted_at is null;
  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into public.staff_invites (landlord_id, staff_id, token_hash) values (v_landlord, p_staff, public.invite_hash(v_token));
  return v_token;
end $$;

create or replace function public.staff_invite_preview(p_token text)
returns table (valid boolean, staff_name text, staff_email text, owner_name text)
language sql stable security definer set search_path = public as $$
  select (i.accepted_at is null and i.expires_at > now() and s.user_id is null and s.active), s.full_name, s.email, l.full_name
  from public.staff_invites i
  join public.maintenance_staff s on s.id = i.staff_id
  join public.landlords l on l.id = i.landlord_id
  where i.token_hash = public.invite_hash(p_token)
$$;

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
  if exists (select 1 from public.landlords where user_id = v_uid) then
    raise exception 'This is an owner account. Register with a different email' using errcode = 'P0001'; end if;
  if exists (select 1 from public.tenants where user_id = v_uid) then
    raise exception 'This is a tenant account. Register with a different email' using errcode = 'P0001'; end if;
  if exists (select 1 from public.maintenance_staff where user_id = v_uid and landlord_id = v_inv.landlord_id) then
    raise exception 'This account is already on this owner''s team' using errcode = 'P0001'; end if;
  update public.maintenance_staff set user_id = v_uid where id = v_inv.staff_id;
  update public.staff_invites set accepted_at = now() where id = v_inv.id;
  return v_inv.staff_id;
end $$;

-- Owner: a team member's login stops working for this owner when they're removed or deactivated.
revoke all on function public.staff_ids(), public.staff_jobs(), public.staff_update_job(uuid, public.maintenance_status, text),
  public.create_staff_invite(uuid), public.accept_staff_invite(text), public.staff_invite_preview(text) from public;
grant execute on function public.staff_ids(), public.staff_jobs(), public.staff_update_job(uuid, public.maintenance_status, text),
  public.create_staff_invite(uuid), public.accept_staff_invite(text) to authenticated;
grant execute on function public.staff_invite_preview(text) to anon, authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.maintenance_requests;
  end if;
exception when duplicate_object then null;
end $$;
