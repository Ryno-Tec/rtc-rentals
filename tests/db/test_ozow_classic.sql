-- 016: Ozow Private Key + API Key connections alongside One API. Owner Thabo (...0c61), tenant (...0c62).
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on

reset role;
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-000000000c61', 'thabo@classic.co.za', '{"full_name":"Thabo Classic"}'),
  ('00000000-0000-0000-0000-000000000c62', 'lerato@classic.co.za', '{"role":"tenant"}');
select set_config('test.cl', (select id::text from public.landlords where email = 'thabo@classic.co.za'), false);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000c61', false);
set role authenticated;
do $$ begin
  begin perform public.save_ozow_classic('ABC-001', 'privatekey-abcdefgh-1234', null, false); raise exception 'expected: both keys required';
  exception when sqlstate '22023' then null; end;
  begin perform public.save_ozow_classic('ABC-001', 'short', 'apikey-abcdefgh-123456', false); raise exception 'expected: short key refused';
  exception when sqlstate '22023' then null; end;
  begin perform public.save_ozow_classic('ABC-001', 'samekey-abcdefgh-123456', 'samekey-abcdefgh-123456', false); raise exception 'expected: same key refused';
  exception when sqlstate '22023' then null; end;
  begin perform public.save_ozow_classic('x', 'privatekey-abcdefgh-1234', 'apikey-abcdefgh-123456', false); raise exception 'expected: site code';
  exception when sqlstate '22023' then null; end;
end $$;
select public.save_ozow_classic('ABC-001', 'privatekey-abcdefgh-1234', 'apikey-abcdefgh-123456', false);
do $$ begin
  assert (select method from public.ozow_accounts) = 'classic', 'saved as classic';
  assert (select key_hint from public.ozow_accounts) = '1234', 'hint is the private key ending';
  begin perform count(*) from public.ozow_secrets; raise exception 'expected: secrets unreadable';
  exception when insufficient_privilege then null; end;
  -- Capitec recurring is One API only
  begin perform public.save_autopay_settings(true, false, null, true); raise exception 'expected: classic cannot do Capitec recurring';
  exception when sqlstate '22023' then null; end;
end $$;
-- Edit without re-entering keys keeps them; switching off works
select public.save_ozow_classic('ABC-002', '', '', true, false);
reset role;
do $$ begin
  assert (select private_key from public.ozow_secrets where landlord_id = current_setting('test.cl')::uuid) = 'privatekey-abcdefgh-1234', 'key kept';
  assert (select api_key from public.ozow_secrets where landlord_id = current_setting('test.cl')::uuid) = 'apikey-abcdefgh-123456', 'api key kept';
  assert (select site_code || is_test::text || enabled::text from public.ozow_accounts where landlord_id = current_setting('test.cl')::uuid) = 'ABC-002truefalse';
end $$;

-- Switching to One API needs the new keys, and wipes the classic ones
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000c61', false);
set role authenticated;
do $$ begin
  begin perform public.save_ozow_account('ABC-002', '', '', false); raise exception 'expected: One API keys needed when switching';
  exception when sqlstate '22023' then null; end;
end $$;
select public.save_ozow_account('ABC-002', 'client-1', 'clientsecret-abcdefgh-9876', false);
select public.save_autopay_settings(true, false, null, true);
reset role;
do $$ begin
  assert (select method from public.ozow_accounts where landlord_id = current_setting('test.cl')::uuid) = 'one';
  assert (select private_key is null and api_key is null and client_id = 'client-1' from public.ozow_secrets where landlord_id = current_setting('test.cl')::uuid), 'classic keys wiped';
end $$;

-- And back to classic: needs both keys again, wipes the client secret, turns Capitec recurring off
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000c61', false);
set role authenticated;
do $$ begin
  begin perform public.save_ozow_classic('ABC-002', '', '', false); raise exception 'expected: classic keys needed when switching';
  exception when sqlstate '22023' then null; end;
end $$;
select public.save_ozow_classic('ABC-002', 'privatekey-new-abcdefgh', 'apikey-new-abcdefgh-99', false);
reset role;
do $$ begin
  assert (select client_id is null and client_secret is null and private_key = 'privatekey-new-abcdefgh' from public.ozow_secrets where landlord_id = current_setting('test.cl')::uuid), 'one keys wiped';
  assert not (select ozow_capitec from public.autopay_settings where landlord_id = current_setting('test.cl')::uuid), 'Capitec recurring switched off';
  insert into public.payment_events (kind, detail) values ('bad_signature', '{}');
end $$;

-- Anonymous callers can't use it
set role anon;
do $$ begin
  begin perform public.save_ozow_classic('ABC-001', 'privatekey-abcdefgh-1234', 'apikey-abcdefgh-123456', false); raise exception 'expected: anon refused';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
delete from public.payment_events where kind = 'bad_signature';
delete from auth.users where id in ('00000000-0000-0000-0000-000000000c61', '00000000-0000-0000-0000-000000000c62');
\echo 'Ozow classic tests passed'
