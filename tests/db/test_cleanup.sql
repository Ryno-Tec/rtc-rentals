-- The remove-test-data script removes only the test tenancy.
\set QUIET on
\set ON_ERROR_STOP on
reset role;
-- Seed a full test tenancy for landlord A as the owner would, then run the script as the SQL editor does.
update public.landlords set tier = 'growth' where user_id = '00000000-0000-0000-0000-00000000000a';
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
set role authenticated;
insert into public.units (property_id, label, monthly_rent) select property_id, 'Test unit', 100 from public.units where label = 'Room 1';
insert into public.tenants (full_name, email) values ('Test Tenant', 't@example.com');
insert into public.leases (unit_id, tenant_id, status, start_date, monthly_rent)
  select (select id from public.units where label='Test unit'), (select id from public.tenants where full_name='Test Tenant'), 'active', current_date, 100;
insert into public.payments (lease_id, period_month, amount_due, amount_paid, status)
  select id, date_trunc('month', current_date), 100, 100, 'paid' from public.leases where monthly_rent = 100;
insert into public.inspections (lease_id, kind, inspected_on) select id, 'move_in', current_date from public.leases where monthly_rent = 100;
insert into public.maintenance_requests (unit_id, title) select id, 'Test tap' from public.units where label='Test unit';
insert into public.maintenance_staff (full_name) values ('Test Handyman');
reset role;
\ir ../../supabase/scripts/remove-test-data.sql
do $$ begin
  assert (select count(*) from public.tenants where full_name = 'Test Tenant') = 0, 'test tenant removed';
  assert (select count(*) from public.units where label = 'Test unit') = 0, 'test unit removed';
  assert (select count(*) from public.maintenance_staff where full_name = 'Test Handyman') = 0, 'test handyman removed';
  assert (select count(*) from public.tenants where full_name = 'Lerato N') = 1, 'real tenant kept';
  assert (select count(*) from public.units where label = 'Room 1') = 1, 'real unit kept';
  assert (select count(*) from public.maintenance_requests where title = 'Window latch broken') = 1, 'real fault kept';
end $$;
\echo 'Test-data clean-up passed'
