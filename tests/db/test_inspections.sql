-- Inspection tests. Runs after test_invites.sql. Lerato (c1) rents Room 1 from landlord A (Thabo).
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on

reset role;
select set_config('test.landlord_a', (select user_id::text from public.landlords where email = 'thabo@example.co.za'), false);
select set_config('test.landlord_a_id', (select id::text from public.landlords where email = 'thabo@example.co.za'), false);
select set_config('test.lease', (select l.id::text from public.leases l join public.tenants t on t.id = l.tenant_id where t.full_name = 'Lerato N' limit 1), false);

-- ---- The tenant starts a move-in check ----
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', false); set role authenticated;
insert into public.inspections (lease_id, kind, landlord_signed_at, tenant_signed_at)
values (current_setting('test.lease')::uuid, 'move_in', now(), now());
select set_config('test.insp', (select id::text from public.inspections), false);
do $$ begin
  assert (select started_by from public.inspections) = 'tenant', 'records who started it';
  assert (select landlord_id::text from public.inspections) = current_setting('test.landlord_a_id'), 'landlord filled in from the lease';
  assert (select landlord_signed_at is null and tenant_signed_at is null from public.inspections), 'confirmations can''t be set on insert';
end $$;
insert into public.inspection_items (inspection_id, room, item, condition, landlord_note, tenant_note, sort) values
  (current_setting('test.insp')::uuid, 'Kitchen', 'Stove', 'good', 'forged', 'Works', 1),
  (current_setting('test.insp')::uuid, 'Kitchen', 'Sink and taps', null, null, null, 2);
do $$ begin
  assert (select count(*) from public.inspection_items) = 2, 'tenant sees the items';
  assert (select landlord_note is null and created_by = 'tenant' from public.inspection_items where item = 'Stove'), 'tenant can''t write the landlord''s note';
  begin perform public.confirm_inspection(current_setting('test.insp')::uuid, 'Lerato Nkosi'); raise exception 'expected: items left';
  exception when sqlstate 'P0001' then null; end;
  update public.inspections set tenant_signed_at = now();          -- no policy lets a tenant update: nothing happens
  assert (select tenant_signed_at is null from public.inspections), 'still not confirmed';
end $$;
update public.inspection_items set condition = 'fair', tenant_note = 'Tap drips' where item = 'Sink and taps';
insert into public.inspection_photos (inspection_id, item_id, path)
select i.inspection_id, i.id, current_setting('test.landlord_a_id') || '/' || i.inspection_id || '/a.jpg' from public.inspection_items i where item = 'Stove';
do $$ begin
  begin insert into public.inspection_photos (inspection_id, path) values (current_setting('test.insp')::uuid, 'elsewhere/x.jpg');
    raise exception 'expected: wrong folder';
  exception when insufficient_privilege then null; end;
  begin perform public.confirm_inspection(current_setting('test.insp')::uuid, ''); raise exception 'expected: name needed';
  exception when sqlstate 'P0001' then null; end;
  perform public.confirm_inspection(current_setting('test.insp')::uuid, 'Lerato Nkosi');
  assert (select tenant_signed_name from public.inspections) = 'Lerato Nkosi', 'tenant confirmed';
end $$;
-- storage: tenant may file under this inspection only
insert into storage.objects (bucket_id, name) values ('inspections', current_setting('test.landlord_a_id') || '/' || current_setting('test.insp') || '/a.jpg');
do $$ begin
  begin insert into storage.objects (bucket_id, name) values ('inspections', current_setting('test.landlord_a_id') || '/' || gen_random_uuid() || '/b.jpg');
    raise exception 'expected: storage refused';
  exception when insufficient_privilege then null; end;
  assert (select count(*) from storage.objects) = 1, 'tenant reads own inspection photo';
end $$;

-- ---- Another tenant (Sipho, no lease) sees nothing and can't add ----
reset role; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', false); set role authenticated;
do $$ begin
  assert (select count(*) from public.inspections) = 0 and (select count(*) from public.inspection_items) = 0
     and (select count(*) from public.inspection_photos) = 0 and (select count(*) from storage.objects) = 0, 'other tenant sees nothing';
  begin insert into public.inspection_items (inspection_id, room, item) values (current_setting('test.insp')::uuid, 'X', 'Y');
    raise exception 'expected: refused';
  exception when insufficient_privilege then null; end;
  begin perform public.confirm_inspection(current_setting('test.insp')::uuid, 'Sipho D'); raise exception 'expected: not found';
  exception when sqlstate 'P0002' then null; end;
end $$;

-- ---- The landlord reviews, changes one thing (tenant must confirm again), then both confirm ----
reset role; select set_config('request.jwt.claim.sub', current_setting('test.landlord_a'), false); set role authenticated;
do $$ begin
  assert (select count(*) from public.inspection_items) = 2 and (select count(*) from storage.objects) = 1, 'landlord sees items and files';
  update public.inspection_items set tenant_note = 'forged', landlord_note = 'Agreed, plumber booked' where item = 'Sink and taps';
  assert (select tenant_note from public.inspection_items where item = 'Sink and taps') = 'Tap drips', 'landlord can''t rewrite the tenant''s note';
  assert (select tenant_signed_at is null from public.inspections), 'a landlord change removes the tenant''s confirmation';
  begin delete from public.inspection_photos; raise exception 'expected: not your photo';
  exception when insufficient_privilege then null; end;
  perform public.confirm_inspection(current_setting('test.insp')::uuid, 'Thabo Mabaso');
  assert (select landlord_signed_at is not null from public.inspections), 'landlord confirmed';
  update public.inspection_items set landlord_note = landlord_note where item = 'Stove';
  assert (select landlord_signed_at is not null from public.inspections), 'saving without a change keeps confirmations';
end $$;
reset role; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', false); set role authenticated;
do $$ begin
  begin delete from public.inspection_items where item = 'Stove' and false; exception when others then null; end;
  perform public.confirm_inspection(current_setting('test.insp')::uuid, 'Lerato Nkosi');
  assert (select landlord_signed_at is not null and tenant_signed_at is not null from public.inspections), 'both confirmed';
  begin update public.inspection_items set condition = 'poor'; raise exception 'expected: locked';
  exception when sqlstate 'P0001' then if sqlerrm like 'expected%' then raise; end if; end;
  begin insert into public.inspection_photos (inspection_id, path) values (current_setting('test.insp')::uuid, current_setting('test.landlord_a_id') || '/' || current_setting('test.insp') || '/late.jpg');
    raise exception 'expected: locked';
  exception when sqlstate 'P0001' then if sqlerrm like 'expected%' then raise; end if; end;
  begin insert into storage.objects (bucket_id, name) values ('inspections', current_setting('test.landlord_a_id') || '/' || current_setting('test.insp') || '/late.jpg');
    raise exception 'expected: storage locked';
  exception when insufficient_privilege then null; end;
end $$;
reset role; select set_config('request.jwt.claim.sub', current_setting('test.landlord_a'), false); set role authenticated;
do $$ begin
  begin delete from public.inspections; raise exception 'expected: locked';
  exception when sqlstate 'P0001' then if sqlerrm like 'expected%' then raise; end if; end;
  assert (select count(*) from public.inspections) = 1, 'a confirmed inspection can''t be deleted';
end $$;

-- An unconfirmed one can be deleted by the landlord, items and all; a tenant can't remove landlord items
insert into public.inspections (lease_id, kind) values (current_setting('test.lease')::uuid, 'routine');
select set_config('test.insp2', (select id::text from public.inspections where kind = 'routine'), false);
insert into public.inspection_items (inspection_id, room, item) values (current_setting('test.insp2')::uuid, 'Lounge', 'Walls');
reset role; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', false); set role authenticated;
do $$ begin
  begin delete from public.inspection_items where room = 'Lounge'; raise exception 'expected: landlord item';
  exception when insufficient_privilege then null; end;
  delete from public.inspections where kind = 'routine';
  assert (select count(*) from public.inspections) = 2, 'tenant can''t delete an inspection';
end $$;
reset role; select set_config('request.jwt.claim.sub', current_setting('test.landlord_a'), false); set role authenticated;
delete from public.inspections where kind = 'routine';
do $$ begin
  assert (select count(*) from public.inspections) = 1 and (select count(*) from public.inspection_items) = 2, 'draft inspection deleted with its items';
end $$;
reset role;
\echo All inspection tests passed
