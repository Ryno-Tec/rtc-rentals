-- Lease document and signature tests. Runs after test_inspections.sql.
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on

reset role;
select set_config('test.landlord_a', (select user_id::text from public.landlords where email = 'thabo@example.co.za'), false);
select set_config('test.lease', (select l.id::text from public.leases l join public.tenants t on t.id = l.tenant_id where t.full_name = 'Lerato N' limit 1), false);
select set_config('test.sig', 'data:image/png;base64,' || repeat('iVBORw0KGgo', 30), false);
select set_config('request.jwt.claim.sub', current_setting('test.landlord_a'), false); set role authenticated;

insert into public.lease_documents (lease_id, body, witnesses_per_party, status, body_hash)
values (current_setting('test.lease')::uuid,
  '{"parties":{"landlord":{"name":"Thabo Mabaso"},"tenant":{"name":"Lerato Nkosi"}},"premises":{"address":"Room 1, 12 Mabaso Street"},"sections":[{"heading":"Rent","clauses":["R 3 200 a month"]}]}',
  1, 'signed', 'forged');
select set_config('test.doc', (select id::text from public.lease_documents), false);
do $$ begin
  assert (select status = 'draft' and body_hash is null from public.lease_documents), 'a new lease is always a draft';
  begin insert into public.lease_documents (lease_id, body) values (current_setting('test.lease')::uuid, '{}');
    raise exception 'expected: one open document per lease';
  exception when unique_violation then null; end;
  begin update public.lease_documents set status = 'signed'; raise exception 'expected: status protected';
  exception when insufficient_privilege then null; end;
  begin perform public.sign_lease_document(current_setting('test.doc')::uuid, 'Thabo Mabaso', current_setting('test.sig')); raise exception 'expected: not sent yet';
  exception when sqlstate 'P0001' then if sqlerrm like 'expected%' then raise; end if; end;
end $$;

-- The tenant can't see a draft
reset role; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', false); set role authenticated;
do $$ begin
  assert (select count(*) from public.lease_documents) = 0, 'drafts are private to the landlord';
  begin perform public.send_lease_document(current_setting('test.doc')::uuid); raise exception 'expected: tenant can''t send';
  exception when sqlstate 'P0002' then null; end;
end $$;

-- Send it
reset role; select set_config('request.jwt.claim.sub', current_setting('test.landlord_a'), false); set role authenticated;
select public.send_lease_document(current_setting('test.doc')::uuid);
do $$ begin
  assert (select status = 'sent' and length(body_hash) = 64 from public.lease_documents), 'sent, with a fingerprint';
  begin update public.lease_documents set body = '{"sections":[]}'; raise exception 'expected: text locked';
  exception when sqlstate 'P0001' then if sqlerrm like 'expected%' then raise; end if; end;
  begin delete from public.lease_documents; raise exception 'expected: can''t delete a sent lease';
  exception when sqlstate 'P0001' then if sqlerrm like 'expected%' then raise; end if; end;
  begin insert into public.lease_signatures (landlord_id, document_id, role, signer_name, signature, method, body_hash)
    values (public.get_landlord_id(), current_setting('test.doc')::uuid, 'tenant', 'Forged Tenant', current_setting('test.sig'), 'account', 'x');
    raise exception 'expected: no direct signatures';
  exception when insufficient_privilege then null; end;
  begin perform public.create_lease_witness_link(current_setting('test.doc')::uuid); raise exception 'expected: sign first';
  exception when sqlstate 'P0001' then if sqlerrm like 'expected%' then raise; end if; end;
  begin perform public.sign_lease_document(current_setting('test.doc')::uuid, 'Thabo Mabaso', 'not-an-image'); raise exception 'expected: bad signature';
  exception when sqlstate 'P0001' then if sqlerrm like 'expected%' then raise; end if; end;
  perform public.sign_lease_document(current_setting('test.doc')::uuid, 'Thabo Mabaso', current_setting('test.sig'));
  begin perform public.sign_lease_document(current_setting('test.doc')::uuid, 'Thabo Mabaso', current_setting('test.sig')); raise exception 'expected: already signed';
  exception when sqlstate 'P0001' then if sqlerrm like 'expected%' then raise; end if; end;
  begin perform public.add_lease_witness(current_setting('test.doc')::uuid, 'thabo mabaso', current_setting('test.sig')); raise exception 'expected: can''t witness yourself';
  exception when sqlstate 'P0001' then if sqlerrm like 'expected%' then raise; end if; end;
  perform public.add_lease_witness(current_setting('test.doc')::uuid, 'Zanele Dube', current_setting('test.sig'));
  begin perform public.add_lease_witness(current_setting('test.doc')::uuid, 'One Too Many', current_setting('test.sig')); raise exception 'expected: enough witnesses';
  exception when sqlstate 'P0001' then if sqlerrm like 'expected%' then raise; end if; end;
  assert (select status from public.lease_documents) = 'sent', 'still waiting for the tenant';
end $$;

-- A stranger sees and signs nothing
reset role; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', false); set role authenticated;
do $$ begin
  assert (select count(*) from public.lease_documents) = 0 and (select count(*) from public.lease_signatures) = 0, 'other tenant sees nothing';
  begin perform public.sign_lease_document(current_setting('test.doc')::uuid, 'Sipho Dlamini', current_setting('test.sig')); raise exception 'expected: not found';
  exception when sqlstate 'P0002' then null; end;
end $$;

-- The tenant signs and sends a link to their witness
reset role; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', false); set role authenticated;
do $$ begin
  assert (select count(*) from public.lease_documents) = 1 and (select count(*) from public.lease_signatures) = 2, 'tenant reads the sent lease and its signatures';
  perform public.sign_lease_document(current_setting('test.doc')::uuid, 'Lerato Nkosi', current_setting('test.sig'));
  assert (select status from public.lease_documents) = 'sent', 'tenant''s witness still outstanding';
end $$;
select set_config('test.wtoken', public.create_lease_witness_link(current_setting('test.doc')::uuid), false);
do $$ begin
  assert (select count(*) from public.lease_witness_links) = 0, 'tenants can''t list witness links';
end $$;

reset role; select set_config('request.jwt.claim.sub', '', false); set role anon;
do $$ declare v jsonb := public.lease_witness_preview(current_setting('test.wtoken')); begin
  assert (v ->> 'valid')::boolean and v ->> 'party_name' = 'Lerato Nkosi' and v ->> 'witness_for' = 'tenant', 'witness sees who they are witnessing';
  assert v ->> 'premises' = 'Room 1, 12 Mabaso Street' and not (v ? 'body'), 'witness sees the address, not the lease text';
  assert public.lease_witness_preview('wrong') is null, 'wrong link shows nothing';
  assert (select count(*) from public.lease_documents) = 0, 'no table access without an account';
  begin perform public.lease_witness_sign(current_setting('test.wtoken'), 'Lerato Nkosi', current_setting('test.sig')); raise exception 'expected: party can''t be witness';
  exception when sqlstate 'P0001' then if sqlerrm like 'expected%' then raise; end if; end;
  begin perform public.sign_lease_document(current_setting('test.doc')::uuid, 'Anon', current_setting('test.sig')); raise exception 'expected: refused';
  exception when insufficient_privilege then null; end;
  perform public.lease_witness_sign(current_setting('test.wtoken'), 'Mpho Khumalo', current_setting('test.sig'));
  begin perform public.lease_witness_sign(current_setting('test.wtoken'), 'Again Again', current_setting('test.sig')); raise exception 'expected: used';
  exception when sqlstate 'P0001' then if sqlerrm like 'expected%' then raise; end if; end;
  assert not (public.lease_witness_preview(current_setting('test.wtoken')) ->> 'valid')::boolean, 'used link previews as not valid';
end $$;

reset role; select set_config('request.jwt.claim.sub', current_setting('test.landlord_a'), false); set role authenticated;
do $$ begin
  assert (select status = 'signed' and completed_at is not null from public.lease_documents), 'complete once everyone has signed';
  assert (select count(*) from public.lease_signatures) = 4, 'four signatures on record';
  assert (select count(distinct body_hash) = 1 and min(body_hash) = (select body_hash from public.lease_documents) from public.lease_signatures), 'every signature carries the document fingerprint';
  assert (select count(*) from public.lease_signatures where method = 'link' and witness_for = 'tenant') = 1, 'the linked witness is recorded';
  assert (select signed_at is not null from public.leases where id = current_setting('test.lease')::uuid), 'the lease is marked signed';
  begin perform public.void_lease_document(current_setting('test.doc')::uuid); raise exception 'expected: signed lease can''t be cancelled';
  exception when sqlstate 'P0001' then if sqlerrm like 'expected%' then raise; end if; end;
end $$;

-- A renewal: new draft allowed, can be sent, cancelled, and then replaced
insert into public.lease_documents (lease_id, body) values (current_setting('test.lease')::uuid, '{"sections":[{"heading":"Renewal","clauses":["x"]}]}');
select set_config('test.doc2', (select id::text from public.lease_documents where status = 'draft'), false);
select public.send_lease_document(current_setting('test.doc2')::uuid);
select public.void_lease_document(current_setting('test.doc2')::uuid);
insert into public.lease_documents (lease_id, body) values (current_setting('test.lease')::uuid, '{"sections":[]}');
do $$ begin
  begin perform public.send_lease_document((select id from public.lease_documents where status = 'draft')); raise exception 'expected: no terms';
  exception when sqlstate 'P0001' then if sqlerrm like 'expected%' then raise; end if; end;
  delete from public.lease_documents where status = 'draft';
  assert (select count(*) from public.lease_documents) = 2, 'drafts can be deleted; signed and cancelled ones stay';
end $$;
reset role;
\echo All lease signing tests passed
