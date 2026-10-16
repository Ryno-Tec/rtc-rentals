-- Tenant portal access tests. Runs after test_schema.sql, which leaves landlord A
-- with Lerato on an active lease in Room 1 and Sipho with no lease.
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on

reset role;
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000c1', 'lerato@example.co.za', '{"role":"tenant"}'),
  ('00000000-0000-0000-0000-0000000000c2', 'sipho@example.co.za', '{"role":"tenant"}');
do $$ begin
  assert (select count(*) from public.landlords where email like '%lerato%' or email like '%sipho%') = 0,
    'tenant sign-ups must not create landlord accounts';
end $$;
update public.tenants set user_id = '00000000-0000-0000-0000-0000000000c1' where full_name = 'Lerato N';
update public.tenants set user_id = '00000000-0000-0000-0000-0000000000c2' where full_name = 'Sipho D';
select set_config('test.room2', (select id::text from public.units where label = 'Room 2'), false);
select set_config('test.room1', (select id::text from public.units where label = 'Room 1'), false);

-- ---- Lerato (active lease on Room 1) ----
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', false);
set role authenticated;

do $$ begin
  assert (select count(*) from public.tenants) = 1, 'tenant sees only own tenant record';
  assert (select count(*) from public.leases) = 1, 'tenant sees own lease';
  assert (select count(*) from public.units) = 1, 'tenant sees only own unit';
  assert (select label from public.units) = 'Room 1', 'the right unit';
  assert (select count(*) from public.properties) = 1, 'tenant sees own property';
  assert (select count(*) from public.landlords) = 1, 'tenant sees own landlord';
  assert (select email from public.landlords) = 'thabo@example.co.za', 'landlord contact visible';
end $$;

-- Log a maintenance request: landlord is filled in automatically
insert into public.maintenance_requests (unit_id, title, category, priority)
values (current_setting('test.room1')::uuid, 'Window latch broken', 'Doors & windows', 'medium');
do $$ begin
  assert (select count(*) from public.maintenance_requests) = 1, 'tenant sees own request';
end $$;

-- Can't log one for someone else's unit
do $$ begin
  begin
    insert into public.maintenance_requests (unit_id, title) values (current_setting('test.room2')::uuid, 'Not mine');
    raise exception 'expected RLS violation';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Can't set landlord-only fields
do $$ begin
  begin
    insert into public.maintenance_requests (unit_id, title, status) values (current_setting('test.room1')::uuid, 'Sneaky', 'resolved');
    raise exception 'expected RLS violation';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Can't change a request after logging it (no update policy for tenants)
update public.maintenance_requests set status = 'closed';
reset role;
do $$ begin
  assert (select status from public.maintenance_requests where title = 'Window latch broken') = 'open', 'tenant must not change status';
end $$;

-- Messages: tenant can send as themselves, landlord filled in
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', false);
set role authenticated;
insert into public.messages (tenant_id, sender, body)
select id, 'tenant', 'Hi, I logged the window latch.' from public.tenants;
do $$ begin
  begin
    insert into public.messages (tenant_id, sender, body) select id, 'landlord', 'Forged' from public.tenants;
    raise exception 'expected RLS violation';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Landlord replies with a progress update the tenant can read
reset role;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
set role authenticated;
insert into public.maintenance_updates (request_id, body)
select id, 'Sipho will come on Saturday.' from public.maintenance_requests;
do $$ begin
  assert (select count(*) from public.messages) = 1, 'landlord sees tenant message';
  assert (select count(*) from public.maintenance_requests) = 1, 'landlord sees tenant request';
end $$;

reset role;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', false);
set role authenticated;
do $$ begin
  assert (select count(*) from public.maintenance_updates) = 1, 'tenant sees the update';
end $$;

-- ---- Sipho (tenant record, no lease) ----
reset role;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', false);
set role authenticated;
do $$ begin
  assert (select count(*) from public.units) = 0, 'no lease, no unit';
  assert (select count(*) from public.properties) = 0, 'no lease, no property';
  assert (select count(*) from public.maintenance_requests) = 0, 'cannot see other tenant''s requests';
  assert (select count(*) from public.messages) = 0, 'cannot see other tenant''s messages';
  assert (select count(*) from public.maintenance_updates) = 0, 'cannot see other tenant''s updates';
  assert (select count(*) from public.leases) = 0, 'cannot see other leases';
end $$;

-- ---- Landlord B sees none of it ----
reset role;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
set role authenticated;
do $$ begin
  assert (select count(*) from public.maintenance_requests) = 0, 'B sees no requests';
  assert (select count(*) from public.maintenance_updates) = 0, 'B sees no updates';
  assert (select count(*) from public.messages) = 0, 'B sees no messages';
end $$;

reset role;
\echo 'All tenant portal tests passed'
