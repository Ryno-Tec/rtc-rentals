-- Removes the test tenancy used for the live test checklist: the tenant "Test Tenant", the unit
-- "Test unit" and everything recorded on them (payments, lease documents and signatures,
-- inspections, faults, messages, invites), the team member "Test Handyman", and the login links.
-- Real records are not touched: it stops if a name matches more than one record.
-- Run in the Supabase SQL Editor. Then delete the two test logins under Authentication > Users.
do $$
declare v_unit uuid; v_tenant uuid; n int;
begin
  select count(*) into n from public.tenants where full_name = 'Test Tenant';
  if n > 1 then raise exception 'More than one "Test Tenant": nothing removed'; end if;
  select count(*) into n from public.units where label = 'Test unit';
  if n > 1 then raise exception 'More than one "Test unit": nothing removed'; end if;
  select id into v_tenant from public.tenants where full_name = 'Test Tenant';
  select id into v_unit from public.units where label = 'Test unit';

  delete from public.payments where lease_id in (select id from public.leases where tenant_id = v_tenant or unit_id = v_unit);
  delete from public.leases where tenant_id = v_tenant or unit_id = v_unit;   -- lease documents, signatures and inspections go with it
  delete from public.maintenance_requests where unit_id = v_unit;            -- and their updates
  delete from public.tenants where id = v_tenant;                            -- and invites and messages
  delete from public.units where id = v_unit;
  delete from public.maintenance_staff where full_name = 'Test Handyman';    -- and their login links
  raise notice 'Test data removed';
end $$;
