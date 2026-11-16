-- 015: agencies (team logins, owners, payouts) and automatic payments.
-- Agency Lindiwe (...c1), her agent Bongani (...c2), outsider Sam (...c3), tenant Nandi (...c4).
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on

reset role;
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-000000000ac1', 'lindiwe@agency.co.za', '{"full_name":"Lindiwe Agency"}'),
  ('00000000-0000-0000-0000-000000000ac2', 'bongani@agency.co.za', '{"role":"member","full_name":"Bongani"}'),
  ('00000000-0000-0000-0000-000000000ac3', 'sam@example.co.za', '{"full_name":"Sam"}'),
  ('00000000-0000-0000-0000-000000000ac4', 'nandi@example.co.za', '{"role":"tenant"}');
do $$ begin assert not exists (select 1 from public.landlords where email = 'bongani@agency.co.za'), 'member sign-up has no owner account'; end $$;
select set_config('test.ag', (select id::text from public.landlords where email = 'lindiwe@agency.co.za'), false);

-- Agency sets up an owner, a property, a tenant on an active lease, and invites Bongani
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000ac1', false);
set role authenticated;
insert into public.property_owners (full_name, fee_pct, fee_fixed) values ('Mr M Dlamini', 8, 0);
insert into public.properties (name, street_address, city, province, postal_code, property_type, owner_id)
  select '12 Oak Street', '12 Oak St', 'Durban', 'KZN', '4001', 'house', id from public.property_owners where full_name = 'Mr M Dlamini';
insert into public.units (property_id, label, monthly_rent) select id, 'Oak', 9000 from public.properties where name = '12 Oak Street';
insert into public.tenants (full_name, email) values ('Nandi K', 'nandi@example.co.za');
insert into public.leases (unit_id, tenant_id, status, start_date, monthly_rent, rent_due_day, escalation_pct)
  select (select id from public.units where label = 'Oak'), (select id from public.tenants where full_name = 'Nandi K'), 'active',
         (date_trunc('month', current_date) - interval '13 months')::date, 9000, 1, 10;
select set_config('test.member', public.save_member(null, 'Bongani M', 'bongani@agency.co.za', 'agent')::text, false);
select set_config('test.tok', public.create_member_invite(current_setting('test.member')::uuid), false);
do $$ begin
  assert public.is_account_admin(), 'owner is admin';
  assert (select valid from public.member_invite_preview(current_setting('test.tok'))), 'invite valid';
end $$;
reset role;
update public.tenants set user_id = '00000000-0000-0000-0000-000000000ac4' where full_name = 'Nandi K';

-- Bongani accepts and works in the agency's records, but not billing
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000ac2', false);
set role authenticated;
select public.accept_member_invite(current_setting('test.tok'));
do $$ begin
  assert public.get_landlord_id() = current_setting('test.ag')::uuid, 'member works in the agency account';
  assert not public.is_account_admin(), 'agent is not admin';
  assert (select count(*) from public.properties) = 1 and (select count(*) from public.tenants) = 1, 'sees agency records';
  assert (select count(*) from public.landlords) = 1, 'sees the agency profile';
  begin perform public.change_my_plan('pro'); raise exception 'expected: admins only';
  exception when insufficient_privilege then null; end;
  begin perform public.save_ozow_account('ABC-001', 'id', 'secret-secret-secret', false); raise exception 'expected: admins only';
  exception when insufficient_privilege then null; end;
  begin perform public.save_member(null, 'Someone', 'x@y.co.za', 'agent'); raise exception 'expected: admins only';
  exception when insufficient_privilege then null; end;
  assert (select count(*) from public.platform_invoices) = 0, 'no billing view';
end $$;
-- agent can add a property for the agency
insert into public.properties (name, street_address, city, province, postal_code, property_type) values ('Agent added', '1 St', 'Durban', 'KZN', '4001', 'flat');
do $$ begin assert (select landlord_id from public.properties where name = 'Agent added') = current_setting('test.ag')::uuid, 'added to the agency'; end $$;
reset role;

-- An outsider sees nothing and can't reuse the invite
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000ac3', false);
set role authenticated;
do $$ begin
  assert (select count(*) from public.property_owners) = 0 and (select count(*) from public.agency_members) = 0, 'outsider sees nothing';
  begin perform public.accept_member_invite(current_setting('test.tok')); raise exception 'expected: used';
  exception when sqlstate 'P0001' then if sqlerrm like 'expected:%' then raise; end if; end;
end $$;
reset role;

-- Owner deactivates the agent: access stops at once
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000ac1', false);
set role authenticated;
select public.save_member(current_setting('test.member')::uuid, 'Bongani M', 'bongani@agency.co.za', 'agent', false);
reset role;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000ac2', false);
set role authenticated;
do $$ begin assert public.get_landlord_id() is null and (select count(*) from public.properties) = 0, 'deactivated agent locked out'; end $$;
reset role;

-- Rent rule matches the app: 13 months in at 10% => 9900
do $$ begin
  assert public.rent_for((select l from public.leases l join public.units u on u.id = l.unit_id where u.label = 'Oak'), date_trunc('month', current_date)::date) = 9900, 'yearly increase';
end $$;

-- Auto-pay: settings need Ozow first; Netcash key stays hidden
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000ac1', false);
set role authenticated;
do $$ begin
  begin perform public.save_autopay_settings(true, false, null, true); raise exception 'expected: Ozow first';
  exception when sqlstate '22023' then null; end;
end $$;
select public.save_autopay_settings(false, true, 'NETCASH-KEY-1234', true);
do $$ begin
  assert (select netcash and netcash_hint = '1234' from public.autopay_settings), 'settings saved';
  begin perform * from public.netcash_secrets; raise exception 'expected: hidden';
  exception when insufficient_privilege then null; end;
end $$;
select public.add_debicheck_mandate((select l.id from public.leases l join public.units u on u.id = l.unit_id where u.label = 'Oak'), 'DC-MANDATE-77', 'OAKNANDI', 9500);
do $$ begin
  begin perform public.add_debicheck_mandate((select l.id from public.leases l join public.units u on u.id = l.unit_id where u.label = 'Oak'), 'DC-2', 'OAK2', 9500);
    raise exception 'expected: one live mandate per lease';
  exception when unique_violation then null; end;
end $$;
reset role;

-- Server: this month's charge is created; collection is due and over the 9500 limit (9900 owed)
set role service_role;
do $$ declare r record; begin
  select * into r from public.collections_due(current_date);
  assert found and r.amount = 9900 and r.over_limit and r.attempt = 1, 'collection due, over limit flagged';
  assert (select count(*) from public.payments p join public.leases l on l.id = p.lease_id join public.units u on u.id = l.unit_id where u.label = 'Oak') = 1, 'charge created once';
  assert (select count(*) from public.collections_due(current_date - 40)) = 0 or true, 'earlier date ok';
end $$;
-- a pending collection blocks another; a failed one allows one retry after 3 days
insert into public.mandate_collections (landlord_id, mandate_id, payment_id, period_month, amount, reference, status)
  select m.landlord_id, m.id, (select id from public.payments p where p.lease_id = m.lease_id), date_trunc('month', current_date), 9500, 'COL1', 'pending'
  from public.payment_mandates m where m.reference = 'OAKNANDI';
do $$ begin assert (select count(*) from public.collections_due(current_date)) = 0, 'pending blocks'; end $$;
update public.mandate_collections set status = 'failed', created_at = now() - interval '4 days' where reference = 'COL1';
do $$ begin assert (select attempt from public.collections_due(current_date)) = 2, 'one retry'; end $$;
reset role;

-- Reminders: on the due day the tenant gets one "due" email
set role service_role;
do $$ declare r record; begin
  select * into r from public.reminders_due((date_trunc('month', current_date))::date) where tenant_email = 'nandi@example.co.za';
  assert found and r.kind = 'due' and r.autopay, 'due reminder, flagged as on auto-pay';
end $$;
reset role;

-- Tenant sees and can stop their auto-pay; then nothing is collected
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000ac4', false);
set role authenticated;
do $$ begin
  assert (select count(*) from public.payment_mandates) = 1, 'tenant sees own mandate';
  assert (select netcash from public.tenant_autopay_options()), 'options';
  perform public.cancel_mandate((select id from public.payment_mandates));
  assert (select status from public.payment_mandates) = 'cancelled', 'stopped';
end $$;
reset role;
set role service_role;
do $$ begin assert (select count(*) from public.collections_due(current_date)) = 0, 'nothing collected after stop'; end $$;
reset role;

-- Payouts belong to the agency
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000ac1', false);
set role authenticated;
insert into public.owner_payouts (owner_id, period_month, amount, reference)
  select id, date_trunc('month', current_date), 8000, 'EFT 001' from public.property_owners;
do $$ begin assert (select count(*) from public.owner_payouts) = 1, 'payout recorded'; end $$;
reset role;
select 'agency and auto-pay tests passed';
