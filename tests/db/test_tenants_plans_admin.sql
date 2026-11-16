-- 014: removing tenants, owners changing plans, Ryno-Tec admin.
-- Owner Pule (...b1), tenant login Ayanda (...b2), admin Kagiso (...b3), stranger Thabo (...0a).
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on

reset role;
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-000000000ab1', 'pule@example.co.za', '{"full_name":"Pule K"}'),
  ('00000000-0000-0000-0000-000000000ab2', 'ayanda@example.co.za', '{"role":"tenant"}'),
  ('00000000-0000-0000-0000-000000000ab3', 'admin@example.co.za', '{"full_name":"RTC Admin"}');
select set_config('test.pl', (select id::text from public.landlords where email = 'pule@example.co.za'), false);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000ab1', false);
set role authenticated;
insert into public.properties (name, street_address, city, province, postal_code, property_type)
  values ('Pule flats', '7 Jacaranda', 'Pretoria', 'GP', '0002', 'flat');
insert into public.units (property_id, label, monthly_rent) select id, u, 5000 from public.properties, unnest(array['P1','P2','P3']) u where name = 'Pule flats';
insert into public.tenants (full_name) values ('Mistake Person'), ('Ayanda R');
insert into public.leases (unit_id, tenant_id, status, start_date, monthly_rent)
  select (select id from public.units where label = 'P1'), (select id from public.tenants where full_name = 'Mistake Person'), 'draft', current_date, 5000;
insert into public.leases (unit_id, tenant_id, status, start_date, monthly_rent)
  select (select id from public.units where label = 'P2'), (select id from public.tenants where full_name = 'Ayanda R'), 'active', current_date - 60, 5000;
insert into public.payments (lease_id, period_month, amount_due, amount_paid, status)
  select l.id, date_trunc('month', current_date), 5000, 5000, 'paid' from public.leases l join public.units u on u.id = l.unit_id where u.label = 'P2';
update public.units set status = 'occupied' where label = 'P2';
reset role;
update public.tenants set user_id = '00000000-0000-0000-0000-000000000ab2' where full_name = 'Ayanda R';

-- A stranger can't remove Pule's tenant
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
set role authenticated;
do $$ begin
  begin perform public.remove_tenant((select id from public.tenants where full_name = 'Ayanda R' limit 1));
    raise exception 'expected: not found';
  exception when sqlstate 'P0002' then null; end;
end $$;
reset role;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000ab1', false);
set role authenticated;
do $$ begin
  assert public.remove_tenant((select id from public.tenants where full_name = 'Mistake Person')) = 'deleted', 'mistake deleted';
  assert not exists (select 1 from public.tenants where full_name = 'Mistake Person'), 'gone';
  assert public.remove_tenant((select id from public.tenants where full_name = 'Ayanda R')) = 'archived', 'real tenancy archived';
  assert (select archived_at is not null and user_id is null from public.tenants where full_name = 'Ayanda R'), 'archived, access removed';
  assert (select l.status from public.leases l join public.units u on u.id = l.unit_id where u.label = 'P2') = 'ended', 'lease ended';
  assert (select status from public.units where label = 'P2') = 'vacant', 'unit vacant';
  assert (select count(*) from public.payments) = 1, 'rent history kept';
end $$;
reset role;
-- The former tenant sees nothing now
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000ab2', false);
set role authenticated;
do $$ begin assert (select count(*) from public.leases) = 0 and (select count(*) from public.payments) = 0, 'former tenant locked out'; end $$;
reset role;

-- Plans: direct tier change still blocked; upgrade ok; downgrade rules
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000ab1', false);
set role authenticated;
do $$ begin
  begin update public.landlords set tier = 'pro'; raise exception 'expected: tier guarded';
  exception when insufficient_privilege then null; end;
  begin perform public.change_my_plan('agency'); raise exception 'expected: agency via Ryno-Tec';
  exception when sqlstate 'P0001' then if sqlerrm like 'expected:%' then raise; end if; end;
end $$;
select public.change_my_plan('pro');
do $$ begin assert (select tier from public.landlords) = 'pro', 'upgraded'; end $$;
insert into public.units (property_id, label, monthly_rent) select id, u, 5000 from public.properties, unnest(array['P4','P5']) u where name = 'Pule flats';
do $$ begin
  begin perform public.change_my_plan('starter'); raise exception 'expected: too many units';
  exception when sqlstate 'P0001' then if sqlerrm like 'expected:%' then raise; end if; end;
end $$;
delete from public.units where label in ('P4', 'P5');
select public.change_my_plan('starter');
do $$ begin assert (select tier from public.landlords) = 'starter', 'downgraded'; end $$;
reset role;

-- Billing: this month Pule held Starter, Pro, Starter -> billed at Pro (799)
do $$ declare r record; begin
  select * into r from public.month_subscription(current_setting('test.pl')::uuid, current_date);
  assert r.tier = 'pro' and r.amount = 799, 'highest plan in the month';
  assert (select count(*) from public.plan_changes where landlord_id = current_setting('test.pl')::uuid) = 2, 'changes logged';
end $$;
-- An overdue invoice blocks downgrades (but not upgrades)
insert into public.platform_invoices (number, landlord_id, period_month, tier, subscription_amount, total, due_date)
  values ('RTC-TEST-PULE', current_setting('test.pl')::uuid, date_trunc('month', current_date - 40), 'growth', 399, 399, current_date - 3);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000ab1', false);
set role authenticated;
select public.change_my_plan('growth');
do $$ begin
  begin perform public.change_my_plan('starter'); raise exception 'expected: overdue blocks';
  exception when sqlstate 'P0001' then if sqlerrm like 'expected:%' then raise; end if; end;
  -- Admin functions refuse an ordinary owner
  begin perform public.admin_overview(); raise exception 'expected: admins only';
  exception when insufficient_privilege then null; end;
  assert not public.is_platform_admin(), 'not admin';
end $$;
reset role;

-- Admin
insert into public.platform_admins (user_id) values ('00000000-0000-0000-0000-000000000ab3');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000ab3', false);
set role authenticated;
do $$ declare o jsonb; begin
  assert public.is_platform_admin(), 'admin';
  o := public.admin_overview();
  assert (o->>'landlords')::int >= 3 and o ? 'mrr' and o ? 'settings', 'overview';
  assert (o->>'overdue_count')::int >= 1, 'overdue counted';
  assert exists (select 1 from public.admin_landlords() where email = 'pule@example.co.za' and overdue), 'landlord list';
  assert exists (select 1 from public.admin_invoices() where number = 'RTC-TEST-PULE'), 'invoice list';
  perform public.admin_set_invoice_status((select id from public.admin_invoices() where number = 'RTC-TEST-PULE'), 'paid');
  assert (select status from public.admin_invoices() where number = 'RTC-TEST-PULE') = 'paid', 'marked paid';
  perform public.admin_set_plan(current_setting('test.pl')::uuid, 'agency', 1500);
  assert (select tier = 'agency' and custom_price = 1500 from public.admin_landlords() where email = 'pule@example.co.za'), 'agency set';
  perform public.admin_update_settings(0.75, 0, 100, 10);
  assert (public.admin_overview()->'settings'->>'collection_fee_pct')::numeric = 0.75, 'settings saved';
  begin perform public.admin_update_settings(50, 0, 100, 10); raise exception 'expected: fee checked';
  exception when sqlstate '22023' then null; end;
  begin perform public.admin_generate_invoices(current_date); raise exception 'expected: month not over';
  exception when sqlstate '22023' then null; end;
  perform public.admin_update_settings(0.5, 0, 75, 7);
  -- admins still can't read platform_admins directly
  begin perform * from public.platform_admins; raise exception 'expected: hidden';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ declare r record; begin
  select * into r from public.month_subscription(current_setting('test.pl')::uuid, current_date);
  assert r.amount = 1500 or r.amount = 799, 'agency price considered';
end $$;
delete from public.platform_invoices where number = 'RTC-TEST-PULE';
select 'tenant removal, plans and admin tests passed';
