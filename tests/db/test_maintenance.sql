-- Maintenance team tests. Runs after the others: landlord A (Thabo, ...0a) has Lerato (...c1)
-- on Room 1 with a logged request "Window latch broken"; landlord B is Anele (...0b).
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on

reset role;
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000e1', 'bongani@example.co.za', '{"role":"staff"}'),
  ('00000000-0000-0000-0000-0000000000e2', 'other@example.co.za', '{"role":"staff"}');
do $$ begin
  assert (select count(*) from public.landlords where email like 'bongani%' or email like 'other%') = 0,
    'staff sign-ups must not create owner accounts';
end $$;

-- ---- Owner A builds a team and assigns the tenant's fault ----
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
set role authenticated;
insert into public.maintenance_staff (full_name, trade, phone, is_employee) values ('Bongani Z', 'Handyman', '0730000000', true);
select set_config('test.bongani', (select id::text from public.maintenance_staff where full_name = 'Bongani Z'), false);
select set_config('test.job', (select id::text from public.maintenance_requests where title = 'Window latch broken'), false);
update public.maintenance_requests set assigned_to = current_setting('test.bongani')::uuid, scheduled_for = current_date + 1
  where id = current_setting('test.job')::uuid;
do $$ begin
  assert (select status from public.maintenance_requests where id = current_setting('test.job')::uuid) = 'assigned', 'assigning moves open to assigned';
  assert (select assigned_name from public.maintenance_requests where id = current_setting('test.job')::uuid) = 'Bongani Z', 'name copied for the tenant';
  begin
    update public.maintenance_staff set user_id = '00000000-0000-0000-0000-0000000000e2' where id = current_setting('test.bongani')::uuid;
    raise exception 'expected: owner cannot attach a login directly';
  exception when insufficient_privilege then null; end;
end $$;
select set_config('test.token', public.create_staff_invite(current_setting('test.bongani')::uuid), false);
do $$ begin
  assert (select valid from public.staff_invite_preview(current_setting('test.token'))), 'invite preview valid';
  assert (select owner_name from public.staff_invite_preview(current_setting('test.token'))) is not null, 'preview names the owner';
end $$;

-- Owner B can't assign A's team member to B's work, or see A's team
reset role;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
set role authenticated;
do $$ begin
  assert (select count(*) from public.maintenance_staff) = 0, 'owner B sees no one on A''s team';
  begin perform public.create_staff_invite(current_setting('test.bongani')::uuid); raise exception 'expected: not found';
  exception when sqlstate 'P0002' then null; end;
end $$;

-- ---- The tenant can't accept a staff invite, and can't assign work ----
reset role;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', false);
set role authenticated;
do $$ begin
  begin perform public.accept_staff_invite(current_setting('test.token')); raise exception 'expected: tenant refused';
  exception when sqlstate 'P0001' then null; end;
  assert (select count(*) from public.staff_jobs()) = 0, 'a tenant has no jobs';
end $$;
insert into public.maintenance_requests (unit_id, title, assigned_to)
  values ((select id from public.units where label = 'Room 1'), 'Geyser dripping', current_setting('test.bongani')::uuid);
do $$ begin
  assert (select assigned_to from public.maintenance_requests where title = 'Geyser dripping') is null, 'tenant cannot assign';
  assert (select status from public.maintenance_requests where title = 'Geyser dripping') = 'open', 'still open';
  assert (select assigned_name from public.maintenance_requests where title = 'Window latch broken') = 'Bongani Z', 'tenant sees who is coming';
end $$;

-- ---- Bongani accepts and works the job ----
reset role;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', false);
set role authenticated;
do $$ begin
  assert (select count(*) from public.staff_jobs()) = 0, 'no jobs before accepting';
end $$;
select public.accept_staff_invite(current_setting('test.token'));
do $$ declare j record; begin
  assert (select count(*) from public.staff_jobs()) = 1, 'sees the one assigned job, not the unassigned geyser';
  select * into j from public.staff_jobs();
  assert j.title = 'Window latch broken' and j.tenant_name = 'Lerato N' and j.tenant_phone = '0710000000', 'job has access details';
  assert j.address like 'Room 1%', 'job has the address';
  assert (select count(*) from public.maintenance_requests) = 0, 'no direct table access (owner cost stays private)';
  assert (select count(*) from public.maintenance_staff) = 1, 'sees own team record';
  assert (select count(*) from public.tenants) = 0 and (select count(*) from public.units) = 0, 'no other owner data';
end $$;
select public.staff_update_job(current_setting('test.job')::uuid, 'in_progress', 'On site, replacing the latch');
select public.staff_update_job(current_setting('test.job')::uuid, null, 'Waiting for a part');
select public.staff_update_job(current_setting('test.job')::uuid, 'resolved', null);
do $$ begin
  assert (select status from public.staff_jobs()) = 'resolved', 'job resolved';
  assert (select count(*) from jsonb_array_elements((select updates from public.staff_jobs())) e where e->>'author' = 'staff') = 3, 'three staff log entries';
  begin perform public.staff_update_job(current_setting('test.job')::uuid, 'closed', null); raise exception 'expected: staff cannot close';
  exception when insufficient_privilege then null; end;
  begin perform public.staff_update_job((select id from public.maintenance_requests limit 1), null, 'x'); exception when others then null; end;
  begin perform public.staff_update_job(gen_random_uuid(), 'in_progress', null); raise exception 'expected: not found';
  exception when sqlstate 'P0002' then null; end;
  begin perform public.accept_staff_invite(current_setting('test.token')); exception when others then raise exception 'second accept by same account should be a no-op'; end;
end $$;

-- Another staff account can't use the spent invite or see the job
reset role;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e2', false);
set role authenticated;
do $$ begin
  begin perform public.accept_staff_invite(current_setting('test.token')); raise exception 'expected: used';
  exception when sqlstate 'P0001' then null; end;
  assert (select count(*) from public.staff_jobs()) = 0, 'stranger sees no jobs';
end $$;

-- ---- Tenant follows the progress ----
reset role;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', false);
set role authenticated;
do $$ begin
  assert (select status from public.maintenance_requests where id = current_setting('test.job')::uuid) = 'resolved', 'tenant sees resolved';
  assert (select resolved_at from public.maintenance_requests where id = current_setting('test.job')::uuid) is not null, 'resolved time set';
  assert (select count(*) from public.maintenance_updates where request_id = current_setting('test.job')::uuid and author = 'staff') = 3,
    'tenant sees the staff updates';
end $$;

-- ---- Owner closes; deactivating the member cuts their access ----
reset role;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
set role authenticated;
update public.maintenance_requests set status = 'closed', cost = 180 where id = current_setting('test.job')::uuid;
update public.maintenance_staff set active = false where id = current_setting('test.bongani')::uuid;
reset role;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', false);
set role authenticated;
do $$ begin
  assert (select count(*) from public.staff_jobs()) = 0, 'deactivated member sees no jobs';
end $$;

reset role;
\echo 'All maintenance team tests passed'
