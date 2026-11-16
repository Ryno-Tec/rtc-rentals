-- Profile photos, expenses and social sign-in invites. Runs after test_maintenance.sql.
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on

reset role;
-- Lerato (...c1) is Thabo's tenant; Anele (...0b) is another owner.
select set_config('test.lerato', '00000000-0000-0000-0000-0000000000c1', false);

-- ---- Tenant saves her photo; only her folder ----
select set_config('request.jwt.claim.sub', current_setting('test.lerato'), false);
set role authenticated;
insert into storage.objects (bucket_id, name) values ('profile-photos', current_setting('test.lerato') || '/me.jpg');
select public.set_my_photo(current_setting('test.lerato') || '/me.jpg');
do $$ begin
  assert (select photo_path from public.tenants where user_id = current_setting('test.lerato')::uuid) like '%/me.jpg', 'photo saved on tenant record';
  begin perform public.set_my_photo('00000000-0000-0000-0000-00000000000a/x.jpg'); raise exception 'expected: other folder refused';
  exception when insufficient_privilege then null; end;
  begin insert into storage.objects (bucket_id, name) values ('profile-photos', '00000000-0000-0000-0000-00000000000a/x.jpg');
    raise exception 'expected: upload to another folder refused';
  exception when insufficient_privilege then null; end;
end $$;

-- ---- Her owner sees it; another owner doesn't ----
reset role;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
set role authenticated;
do $$ begin
  assert (select count(*) from storage.objects where bucket_id = 'profile-photos') = 1, 'owner sees tenant photo';
end $$;
reset role;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
set role authenticated;
do $$ begin
  assert (select count(*) from storage.objects where bucket_id = 'profile-photos') = 0, 'other owner sees nothing';
end $$;

-- ---- Expenses: owner only, on their own property ----
reset role;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
set role authenticated;
insert into public.expenses (property_id, spent_on, category, amount)
  select property_id, '2026-04-10', 'rates', 850 from public.units where label = 'Room 1';
do $$ begin
  assert (select count(*) from public.expenses) = 1, 'expense saved';
  begin insert into public.expenses (property_id, spent_on, category, amount)
          select property_id, '2026-04-10', 'rates', -5 from public.units where label = 'Room 1';
    raise exception 'expected: negative refused';
  exception when check_violation then null; end;
end $$;
reset role;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
set role authenticated;
do $$ begin
  assert (select count(*) from public.expenses) = 0, 'other owner sees no expenses';
  begin insert into public.expenses (property_id, spent_on, category, amount)
          values ((select id from public.properties limit 1), '2026-04-10', 'rates', 5);
    raise exception 'expected: not their property';
  exception when others then null; end;
end $$;
reset role;
select set_config('request.jwt.claim.sub', current_setting('test.lerato'), false);
set role authenticated;
do $$ begin
  assert (select count(*) from public.expenses) = 0, 'tenant sees no expenses';
end $$;

-- ---- Google/Apple sign-in from an invite: the empty owner account is released ----
reset role;
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000f1', 'google.tenant@example.com', '{"full_name":"Google Tenant"}');  -- no role, like Google
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
set role authenticated;
insert into public.tenants (full_name, email) values ('Zanele G', 'google.tenant@example.com');
select set_config('test.tok', public.create_tenant_invite((select id from public.tenants where full_name = 'Zanele G')), false);
reset role;
do $$ begin
  assert (select count(*) from public.landlords where user_id = '00000000-0000-0000-0000-0000000000f1') = 1, 'Google sign-up opened an owner account';
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', false);
set role authenticated;
select public.accept_tenant_invite(current_setting('test.tok'));
reset role;
do $$ begin
  assert (select count(*) from public.landlords where user_id = '00000000-0000-0000-0000-0000000000f1') = 0, 'empty owner account removed';
  assert (select user_id from public.tenants where full_name = 'Zanele G') = '00000000-0000-0000-0000-0000000000f1', 'tenant linked';
end $$;

-- A real owner account (with properties) is never released
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
set role authenticated;
insert into public.tenants (full_name) values ('Owner Test');
select set_config('test.tok2', public.create_tenant_invite((select id from public.tenants where full_name = 'Owner Test')), false);
do $$ begin
  begin perform public.accept_tenant_invite(current_setting('test.tok2')); raise exception 'expected: owner refused';
  exception when sqlstate 'P0001' then null; end;
  assert (select count(*) from public.properties) > 0, 'owner data intact';
end $$;

reset role;
\echo 'All photo, expense and social sign-in tests passed'

-- ---- 009: the yearly increase as a fixed amount ----
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
set role authenticated;
update public.leases set escalation_type = 'amount', escalation_amount = 250, escalation_pct = 0
  where tenant_id = (select id from public.tenants where full_name = 'Lerato N');
do $$ begin
  assert (select escalation_amount from public.leases where tenant_id = (select id from public.tenants where full_name = 'Lerato N')) = 250, 'amount saved';
  begin update public.leases set escalation_type = 'rand'; raise exception 'expected: bad type refused';
  exception when check_violation then null; end;
  begin update public.leases set escalation_amount = -1; raise exception 'expected: negative refused';
  exception when check_violation then null; end;
end $$;
reset role;
\echo 'Fixed-amount increase tests passed'
