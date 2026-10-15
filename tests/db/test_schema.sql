-- Behaviour tests for 001_initial_schema.sql. Any failed assertion aborts the run.
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on

-- Two landlords sign up
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-00000000000a', 'thabo@example.co.za', '{"full_name":"Thabo M"}'),
  ('00000000-0000-0000-0000-00000000000b', 'anele@example.co.za', '{"full_name":"Anele K"}');

do $$ begin
  assert (select count(*) from public.landlords) = 2, 'sign-up should create landlord rows';
  assert (select count(*) from public.subscriptions where status = 'trial') = 2, 'sign-up should start a trial';
  assert (select full_name from public.landlords where email = 'thabo@example.co.za') = 'Thabo M', 'name copied from sign-up';
end $$;

-- ---- Landlord A ----
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
set role authenticated;

insert into public.properties (name, street_address, city, province, postal_code, property_type)
values ('Ext 4 rooms', '12 Mabaso St', 'Soweto', 'GP', '1804', 'backyard_rooms');

insert into public.units (property_id, label, monthly_rent, deposit, status)
select id, x.label, x.rent, x.rent, x.status::public.unit_status
from public.properties,
     (values ('Room 1', 3200, 'occupied'), ('Room 2', 3200, 'vacant'), ('Room 3', 3500, 'occupied')) as x(label, rent, status);

do $$ begin
  assert (select count(*) from public.units) = 3, 'A should have 3 units';
  assert (select rent_roll from public.portfolio_summary) = 6700, 'rent roll counts occupied units only';
  assert (select potential_rent from public.portfolio_summary) = 9900, 'potential rent counts all units';
  assert (select vacant_units from public.portfolio_summary) = 1, 'one vacant unit';
end $$;

-- Starter plan allows 3 units: the 4th must be refused
do $$ begin
  begin
    insert into public.units (property_id, label, monthly_rent)
    select id, 'Room 4', 3000 from public.properties limit 1;
    raise exception 'expected tier limit';
  exception when raise_exception then
    assert sqlerrm like 'TIER_LIMIT:%', 'wrong error: ' || sqlerrm;
  end;
end $$;

-- A cannot upgrade their own plan from the browser
do $$ begin
  begin
    update public.landlords set tier = 'pro';
    raise exception 'expected tier protection';
  exception when insufficient_privilege then null;
  end;
end $$;

-- A can update their own profile
update public.landlords set phone = '0821234567';
do $$ begin
  assert (select phone from public.landlords) = '0821234567', 'profile update should work';
end $$;

-- Postal code must be 4 digits
do $$ begin
  begin
    insert into public.properties (name, street_address, city, province, postal_code)
    values ('Bad', '1 Main Rd', 'Durban', 'KZN', '40001');
    raise exception 'expected check violation';
  exception when check_violation then null;
  end;
end $$;

-- ---- Landlord B ----
reset role;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
set role authenticated;

do $$ begin
  assert (select count(*) from public.properties) = 0, 'B must not see A''s properties';
  assert (select count(*) from public.units) = 0, 'B must not see A''s units';
  assert (select count(*) from public.landlords) = 1, 'B sees only own landlord row';
  assert (select units from public.portfolio_summary) = 0, 'B summary is empty';
end $$;

-- B cannot change A's unit (RLS hides it, so zero rows are touched)
update public.units set monthly_rent = 1 where label = 'Room 1';
reset role;
do $$ begin
  assert (select monthly_rent from public.units where label = 'Room 1') = 3200, 'B must not alter A''s data';
end $$;

-- B cannot attach a unit to A's property, even knowing its id
select set_config('test.a_property', (select id::text from public.properties limit 1), false);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
set role authenticated;
do $$ begin
  begin
    insert into public.units (property_id, label, monthly_rent)
    values (current_setting('test.a_property')::uuid, 'Sneaky', 100);
    raise exception 'expected FK violation';
  exception when foreign_key_violation then null;
  end;
end $$;

-- B cannot forge rows as A by sending A's landlord_id
do $$ begin
  begin
    insert into public.properties (landlord_id, name, street_address, city, province)
    select id, 'Forged', '1 Main', 'Pretoria', 'GP' from public.landlords limit 0;  -- B can't even read A's id
    insert into public.properties (landlord_id, name, street_address, city, province)
    values ((select landlord_id from public.subscriptions limit 1), 'Own', '1 Main', 'Pretoria', 'GP');
  end;
  assert (select count(*) from public.properties) = 1, 'B can add own property';
end $$;

reset role;
select set_config('test.a_landlord', (select id::text from public.landlords where email = 'thabo@example.co.za'), false);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
set role authenticated;
do $$ begin
  begin
    insert into public.properties (landlord_id, name, street_address, city, province)
    values (current_setting('test.a_landlord')::uuid, 'Forged', '1 Main', 'Pretoria', 'GP');
    raise exception 'expected RLS violation';
  exception when insufficient_privilege then null;
  end;
end $$;

-- ---- Leases: one active lease per unit ----
reset role;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
set role authenticated;
insert into public.tenants (full_name, phone) values ('Lerato N', '0710000000'), ('Sipho D', '0720000000');
insert into public.leases (unit_id, tenant_id, status, start_date, monthly_rent)
select u.id, t.id, 'active', '2026-11-01', 3200
from public.units u, public.tenants t where u.label = 'Room 1' and t.full_name = 'Lerato N';
do $$ begin
  begin
    insert into public.leases (unit_id, tenant_id, status, start_date, monthly_rent)
    select u.id, t.id, 'active', '2026-11-01', 3200
    from public.units u, public.tenants t where u.label = 'Room 1' and t.full_name = 'Sipho D';
    raise exception 'expected unique violation';
  exception when unique_violation then null;
  end;
end $$;

-- A unit with a lease can't be deleted out from under it
do $$ begin
  begin
    delete from public.units where label = 'Room 1';
    raise exception 'expected FK restrict';
  exception when foreign_key_violation then null;
  end;
end $$;

reset role;
\echo 'All schema tests passed'
