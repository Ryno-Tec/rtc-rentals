-- Tenant invite tests. Runs after test_tenant.sql (Lerato and Sipho are already linked).
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on

reset role;
select set_config('test.landlord_a', (select user_id::text from public.landlords where email = 'thabo@example.co.za'), false);
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000d1', 'newtenant@example.co.za', '{"role":"tenant"}'),
  ('00000000-0000-0000-0000-0000000000d2', 'stranger@example.co.za', '{"role":"tenant"}');

-- Landlord A adds a tenant and invites them
select set_config('request.jwt.claim.sub', current_setting('test.landlord_a'), false);
set role authenticated;
insert into public.tenants (full_name, email) values ('Naledi M', 'newtenant@example.co.za');
select set_config('test.naledi', (select id::text from public.tenants where full_name = 'Naledi M'), false);
select set_config('test.token1', public.create_tenant_invite(current_setting('test.naledi')::uuid), false);
select set_config('test.token', public.create_tenant_invite(current_setting('test.naledi')::uuid), false);
do $$ begin
  assert length(current_setting('test.token')) = 64, 'token is 64 hex characters';
  assert (select count(*) from public.tenant_invites) = 1, 'a new invite replaces the unused one';
  assert (select token_hash from public.tenant_invites) <> current_setting('test.token'), 'the raw token is not stored';
  assert (select valid from public.invite_preview(current_setting('test.token'))), 'preview: valid';
  assert (select count(*) from public.invite_preview(current_setting('test.token1'))) = 0, 'replaced token no longer works';
  assert (select landlord_name from public.invite_preview(current_setting('test.token'))) is not null, 'preview names the landlord';
  begin
    perform public.create_tenant_invite((select id from public.tenants where full_name = 'Lerato N'));
    raise exception 'expected: already has access';
  exception when sqlstate 'P0001' then null; end;
  begin
    insert into public.tenant_invites (tenant_id, token_hash) values (current_setting('test.naledi')::uuid, 'x');
    raise exception 'expected: direct insert refused';
  exception when insufficient_privilege then null; end;
end $$;

-- A landlord can't accept a tenant invite
do $$ begin
  begin perform public.accept_tenant_invite(current_setting('test.token')); raise exception 'expected: landlord refused';
  exception when sqlstate 'P0001' then null; end;
end $$;

-- Not signed in: preview works, accept doesn't
reset role; select set_config('request.jwt.claim.sub', '', false); set role anon;
do $$ begin
  assert (select tenant_name from public.invite_preview(current_setting('test.token'))) = 'Naledi M', 'anon can preview';
  assert (select count(*) from public.invite_preview('wrong')) = 0, 'wrong token shows nothing';
  begin perform public.accept_tenant_invite(current_setting('test.token')); raise exception 'expected: refused';
  exception when insufficient_privilege then null; end;
end $$;

-- The new tenant accepts
reset role; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', false); set role authenticated;
do $$ begin
  assert (select count(*) from public.tenants) = 0, 'before accepting, sees no tenant record';
  begin perform public.accept_tenant_invite('wrong'); raise exception 'expected: invalid';
  exception when sqlstate 'P0002' then null; end;
  perform public.accept_tenant_invite(current_setting('test.token'));
  assert (select full_name from public.tenants) = 'Naledi M', 'after accepting, sees own tenant record';
  perform public.accept_tenant_invite(current_setting('test.token'));   -- same account again: fine
  assert (select count(*) from public.tenant_invites) = 0, 'tenants cannot read invites';
end $$;

-- Someone else can't reuse the link
reset role; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d2', false); set role authenticated;
do $$ begin
  begin perform public.accept_tenant_invite(current_setting('test.token')); raise exception 'expected: already used';
  exception when sqlstate 'P0001' then null; end;
  assert (select count(*) from public.tenants) = 0, 'stranger linked to nothing';
  assert not (select valid from public.invite_preview(current_setting('test.token'))), 'used invite previews as not valid';
end $$;

-- Expired invites are refused
reset role;
update public.tenants set user_id = null where full_name = 'Naledi M';
update public.tenant_invites set accepted_at = null, expires_at = now() - interval '1 day';
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d2', false); set role authenticated;
do $$ begin
  begin perform public.accept_tenant_invite(current_setting('test.token')); raise exception 'expected: expired';
  exception when sqlstate 'P0001' then null; end;
end $$;
reset role;
\echo All tenant invite tests passed
