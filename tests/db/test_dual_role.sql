-- One login as owner and tenant. Thabo (...0a) owns Mabaso Street rooms; he rents a flat from
-- Anele (...0b). On the owner side he must see only his own records; on the tenant side only his flat.
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on

reset role;
select set_config('test.thabo', '00000000-0000-0000-0000-00000000000a', false);
select set_config('test.anele', '00000000-0000-0000-0000-00000000000b', false);

-- Before: counts Thabo sees as an owner
select set_config('request.jwt.claim.sub', current_setting('test.thabo'), false);
set role authenticated;
-- His own invite can't be accepted by himself
insert into public.tenants (full_name) values ('Own Invite Test');
select set_config('test.props', (select count(*)::text from public.properties), false);
select set_config('test.tenants', (select count(*)::text from public.tenants), false);
select set_config('test.leases', (select count(*)::text from public.leases), false);
select set_config('test.pays', (select count(*)::text from public.payments), false);
select set_config('test.own', public.create_tenant_invite((select id from public.tenants where full_name = 'Own Invite Test')), false);
do $$ begin
  begin perform public.accept_tenant_invite(current_setting('test.own')); raise exception 'expected: own invite refused';
  exception when sqlstate 'P0001' then null; end;
end $$;

-- Anele lets a flat to Thabo and invites him
reset role;
select set_config('request.jwt.claim.sub', current_setting('test.anele'), false);
set role authenticated;
insert into public.properties (name, street_address, city, province, postal_code, property_type)
  values ('Anele flats', '9 Long Street', 'Cape Town', 'WC', '8001', 'flat');
insert into public.units (property_id, label, monthly_rent) select id, 'Flat 2', 6000 from public.properties where name = 'Anele flats';
insert into public.tenants (full_name, email) values ('Thabo M (tenant)', 'thabo@example.co.za');
insert into public.leases (unit_id, tenant_id, status, start_date, monthly_rent)
  select (select id from public.units where label = 'Flat 2'), (select id from public.tenants where full_name = 'Thabo M (tenant)'), 'active', current_date, 6000;
insert into public.payments (lease_id, period_month, amount_due, amount_paid, status)
  select id, date_trunc('month', current_date), 6000, 6000, 'paid' from public.leases where monthly_rent = 6000;
select set_config('test.tok', public.create_tenant_invite((select id from public.tenants where full_name = 'Thabo M (tenant)')), false);

-- Thabo accepts on his owner login: linked, owner account kept, now on the tenant side
reset role;
select set_config('request.jwt.claim.sub', current_setting('test.thabo'), false);
set role authenticated;
select public.accept_tenant_invite(current_setting('test.tok'));
do $$ declare r record; begin
  select * into r from public.my_roles();
  assert r.owner and r.tenant and r.side = 'tenant', 'both roles, tenant side';
  assert public.get_landlord_id() is null, 'no owner powers on the tenant side';
  assert (select count(*) from public.tenants) = 1, 'tenant side: only his own tenant record';
  assert (select count(*) from public.properties) = 1 and (select name from public.properties) = 'Anele flats', 'tenant side: only the flat he rents';
  assert (select count(*) from public.leases) = 1 and (select count(*) from public.payments) = 1, 'tenant side: his lease and payment';
  assert exists (select 1 from public.landlords where email = 'anele@example.co.za'), 'tenant side: sees his landlord';
  begin
    insert into public.properties (name, street_address, city, province) values ('Sneaky', '1 St', 'Pta', 'GP');
    raise exception 'expected: no owner writes on the tenant side';
  exception when others then if sqlerrm like 'expected:%' then raise; end if; end;
end $$;

-- Switch to the owner side: exactly what he saw before, nothing of Anele's
select public.set_my_side('owner');
do $$ begin
  assert public.get_landlord_id() is not null, 'owner powers back';
  assert (select count(*) from public.properties)::text = current_setting('test.props'), 'owner side: only his properties';
  assert (select count(*) from public.tenants)::text = current_setting('test.tenants'), 'owner side: only his tenants';
  assert (select count(*) from public.leases)::text = current_setting('test.leases'), 'owner side: only his leases';
  assert (select count(*) from public.payments)::text = current_setting('test.pays'), 'owner side: only his payments';
  assert not exists (select 1 from public.properties where name = 'Anele flats'), 'Anele''s flat is not among his properties';
end $$;

-- People with one role can't switch
reset role;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', false);
set role authenticated;
do $$ begin
  begin perform public.set_my_side('owner'); raise exception 'expected: single role refused';
  exception when sqlstate 'P0001' then null; end;
  assert (select count(*) from public.tenants) = 1, 'single-role tenant unchanged';
end $$;

-- Put Thabo back on the owner side for the tests that follow
reset role;
select set_config('request.jwt.claim.sub', current_setting('test.thabo'), false);
set role authenticated;
select public.set_my_side('owner');
reset role;
\echo 'All owner-and-tenant tests passed'
