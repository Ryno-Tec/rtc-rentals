-- 011: Ozow per-landlord rent payments, collection fees and Ryno-Tec invoices.
-- Fresh cast: owner Zanele (...e1) lets a cottage to Musa (...e2). Thabo (...0a) is a stranger here.
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on

reset role;
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-000000000a71', 'zanele@example.co.za', '{"full_name":"Zanele P"}'),
  ('00000000-0000-0000-0000-000000000a72', 'musa@example.co.za', '{"role":"tenant"}');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000a71', false);
set role authenticated;
insert into public.properties (name, street_address, city, province, postal_code, property_type)
  values ('Zanele cottages', '4 Oak Road', 'Durban', 'KZN', '4001', 'house');
insert into public.units (property_id, label, monthly_rent) select id, 'Cottage A', 8000 from public.properties where name = 'Zanele cottages';
insert into public.tenants (full_name, email) values ('Musa Z', 'musa@example.co.za');
insert into public.leases (unit_id, tenant_id, status, start_date, monthly_rent)
  select (select id from public.units where label = 'Cottage A'), (select id from public.tenants where full_name = 'Musa Z'), 'active', current_date, 8000;
insert into public.payments (lease_id, period_month, amount_due)
  select l.id, date_trunc('month', current_date), 8000 from public.leases l join public.units u on u.id = l.unit_id where u.label = 'Cottage A';
reset role;
update public.tenants set user_id = '00000000-0000-0000-0000-000000000a72' where full_name = 'Musa Z';
select set_config('test.pay', (select p.id::text from public.payments p join public.leases l on l.id = p.lease_id join public.units u on u.id = l.unit_id where u.label = 'Cottage A'), false);
select set_config('test.zl', (select id::text from public.landlords where email = 'zanele@example.co.za'), false);

-- Tenant: not yet payable online
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000a72', false);
set role authenticated;
do $$ begin assert not public.tenant_can_pay_online(), 'no Ozow yet'; end $$;

-- Owner connects Ozow; bad input is refused; the key can never be read back
reset role;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000a71', false);
set role authenticated;
do $$ begin
  begin perform public.save_ozow_account('ZAN-001', 'client-1', null, true); raise exception 'expected: key required';
  exception when sqlstate '22023' then null; end;
  begin perform public.save_ozow_account('x', 'client-1', 'abcdefghijklmnop1234', true); raise exception 'expected: site code checked';
  exception when sqlstate '22023' then null; end;
  begin perform public.save_ozow_account('ZAN-001', 'client-1', 'short', true); raise exception 'expected: short key refused';
  exception when sqlstate '22023' then null; end;
end $$;
select public.save_ozow_account('ZAN-001', 'client-1', 'clientsecret-abcdefgh-9876', true);
do $$ begin
  assert (select key_hint from public.ozow_accounts) = '9876', 'hint is the last 4';
  begin perform * from public.ozow_secrets; raise exception 'expected: secrets unreadable';
  exception when insufficient_privilege then null; end;
  begin update public.ozow_accounts set site_code = 'HACK'; raise exception 'expected: no direct writes';
  exception when insufficient_privilege then null; end;
end $$;
-- Saving again without a key keeps the stored key
select public.save_ozow_account('ZAN-002', '', '', true);
reset role;
do $$ begin
  assert (select client_secret from public.ozow_secrets where landlord_id = current_setting('test.zl')::uuid) = 'clientsecret-abcdefgh-9876', 'secret kept';
  assert (select client_id from public.ozow_secrets where landlord_id = current_setting('test.zl')::uuid) = 'client-1', 'client id kept';
  assert (select site_code from public.ozow_accounts where landlord_id = current_setting('test.zl')::uuid) = 'ZAN-002', 'site code updated';
end $$;

-- Another owner sees nothing of it and can't call the server-only functions
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
set role authenticated;
do $$ begin
  assert (select count(*) from public.ozow_accounts) = 0, 'stranger sees no Ozow account';
  begin perform public.complete_online_payment('x', 'Complete', 't', 1, false, '{}'); raise exception 'expected: server only';
  exception when insufficient_privilege then null; end;
  begin perform public.generate_platform_invoices(current_date); raise exception 'expected: server only';
  exception when insufficient_privilege then null; end;
end $$;

-- Tenant can now pay online
reset role;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000a72', false);
set role authenticated;
do $$ begin assert public.tenant_can_pay_online(), 'Ozow on'; end $$;

-- Fees: 0.5%, capped at R75
do $$ begin
  assert public.collection_fee(8000) = 40, '0.5% of 8000';
  assert public.collection_fee(30000) = 75, 'capped at 75';
end $$;

-- The server starts a payment (service role), Ozow notifies
reset role;
insert into public.online_payments (kind, landlord_id, payment_id, amount, reference, is_test, started_by)
  values ('rent', current_setting('test.zl')::uuid, current_setting('test.pay')::uuid, 8000, 'RTCTEST1', false, '00000000-0000-0000-0000-000000000a72'),
         ('rent', current_setting('test.zl')::uuid, current_setting('test.pay')::uuid, 8000, 'RTCTEST2', true, '00000000-0000-0000-0000-000000000a72'),
         ('rent', current_setting('test.zl')::uuid, current_setting('test.pay')::uuid, 8000, 'RTCTEST3', false, '00000000-0000-0000-0000-000000000a72');
set role service_role;
do $$ begin
  assert public.complete_online_payment('RTCTEST2', 'Complete', 'oz-2', 8000, true, '{}') = 'complete', 'test payment completes';
  assert public.complete_online_payment('RTCTEST3', 'Complete', 'oz-3', 7000, false, '{}') = 'pending_investigation', 'wrong amount flagged';
  assert public.complete_online_payment('NOPE', 'Complete', 'x', 1, false, '{}') = 'unknown', 'unknown ref';
  assert public.complete_online_payment('RTCTEST1', 'Cancelled', null, 8000, false, '{}') = 'cancelled', 'cancelled';
end $$;
reset role;
do $$ begin
  assert (select amount_paid from public.payments where id = current_setting('test.pay')::uuid) = 0, 'test/flagged/cancelled payments leave the ledger alone';
end $$;
-- Ozow retries after a cancel... then the tenant tries again and pays
update public.online_payments set status = 'started' where reference = 'RTCTEST1';
set role service_role;
do $$ begin
  assert public.complete_online_payment('RTCTEST1', 'Complete', 'oz-1', 8000, false, '{"Status":"Complete"}') = 'complete', 'paid';
  assert public.complete_online_payment('RTCTEST1', 'Complete', 'oz-1', 8000, false, '{}') = 'already', 'repeat is harmless';
end $$;
reset role;
do $$ declare p record; begin
  select * into p from public.payments where id = current_setting('test.pay')::uuid;
  assert p.amount_paid = 8000 and p.status = 'paid' and p.method = 'ozow' and p.provider_ref = 'oz-1', 'rent marked paid once';
  assert (select count(*) from public.platform_fees where landlord_id = current_setting('test.zl')::uuid) = 1, 'one fee';
  assert (select amount from public.platform_fees where landlord_id = current_setting('test.zl')::uuid) = 40, 'fee R40';
end $$;

-- Tenant sees their own online payments; owner sees fee
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000a72', false);
set role authenticated;
do $$ begin
  assert (select count(*) from public.online_payments) = 3, 'tenant sees own attempts';
  assert (select count(*) from public.platform_fees) = 0, 'tenant sees no fees';
end $$;

-- Monthly invoice: plan + fees; running twice makes no duplicate
reset role;
set role service_role;
select public.generate_platform_invoices(current_date);
select public.generate_platform_invoices(current_date);
reset role;
do $$ declare i record; begin
  select * into i from public.platform_invoices where landlord_id = current_setting('test.zl')::uuid;
  assert i.collection_fees = 40 and i.total = i.subscription_amount + 40, 'invoice total';
  assert (select count(*) from public.platform_invoices where landlord_id = current_setting('test.zl')::uuid) = 1, 'one invoice';
  assert (select count(*) from public.platform_fees where invoice_id is null and landlord_id = current_setting('test.zl')::uuid) = 0, 'fees billed';
  -- Owner pays the invoice through Ryno-Tec's Ozow
  insert into public.online_payments (kind, landlord_id, invoice_id, amount, reference)
    values ('invoice', i.landlord_id, i.id, i.total, 'RTCINV1');
  set local role service_role;
  perform public.complete_online_payment('RTCINV1', 'Complete', 'oz-inv', i.total, false, '{}');
  reset role;
  assert (select status from public.platform_invoices where id = i.id) = 'paid', 'invoice paid';
end $$;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000a71', false);
set role authenticated;
do $$ begin
  assert (select count(*) from public.platform_invoices) = 1, 'owner sees own invoice';
  assert (select count(*) from public.platform_fees) = 1, 'owner sees own fees';
end $$;
select public.remove_ozow_account();
do $$ begin assert (select count(*) from public.ozow_accounts) = 0, 'disconnected'; end $$;
reset role;
do $$ begin assert (select count(*) from public.ozow_secrets where landlord_id = current_setting('test.zl')::uuid) = 0, 'key gone'; end $$;
select 'payments tests passed';
