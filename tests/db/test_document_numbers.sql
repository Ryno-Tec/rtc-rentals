-- 017: receipt and lease document numbers.
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
reset role;
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-000000000d71', 'nomsa@numbers.co.za', '{"full_name":"Nomsa Numbers"}');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000d71', false);
set role authenticated;
insert into public.properties (name, street_address, city, province, postal_code, property_type) values ('Num House', '1 Num St', 'Cape Town', 'WC', '8001', 'house');
insert into public.units (property_id, label, monthly_rent) select id, 'N1', 5000 from public.properties where name = 'Num House';
insert into public.tenants (full_name, email) values ('Thabo Num', 'thabo@num.co.za');
insert into public.leases (unit_id, tenant_id, status, start_date, monthly_rent, rent_due_day)
  select (select id from public.units where label = 'N1'), (select id from public.tenants where full_name = 'Thabo Num'), 'active', '2026-01-01', 5000, 1;
insert into public.payments (lease_id, period_month, amount_due) select id, '2026-10-01', 5000 from public.leases where monthly_rent = 5000 and start_date = '2026-01-01';
insert into public.payments (lease_id, period_month, amount_due, amount_paid, paid_at, method, status)
  select id, '2026-11-01', 5000, 5000, '2026-11-02', 'eft', 'paid' from public.leases where monthly_rent = 5000 and start_date = '2026-01-01';
do $$ declare a text; b text; begin
  assert (select receipt_no from public.payments where period_month = '2026-10-01' and amount_due = 5000) is null, 'unpaid month has no receipt';
  select receipt_no into a from public.payments where period_month = '2026-11-01' and amount_due = 5000;
  assert a ~ '^RTC-RCT-2026-[0-9]{6}$', 'receipt number format: ' || coalesce(a, 'null');
  -- paying October later gives the next number; editing never changes or clears a number
  update public.payments set amount_paid = 5000, paid_at = '2026-11-10', status = 'paid' where period_month = '2026-10-01' and amount_due = 5000;
  select receipt_no into b from public.payments where period_month = '2026-10-01' and amount_due = 5000;
  assert b ~ '^RTC-RCT-2026-' and b <> a, 'second receipt gets its own number';
  assert substring(b from 14)::int = substring(a from 14)::int + 1, 'numbers run in order';
  update public.payments set receipt_no = 'RTC-RCT-2026-999999', amount_paid = 0 where period_month = '2026-10-01' and amount_due = 5000;
  assert (select receipt_no from public.payments where period_month = '2026-10-01' and amount_due = 5000) = b, 'number can''t be changed or cleared';
end $$;
-- lease documents
insert into public.lease_documents (lease_id, body) select id, '{"title":"x"}' from public.leases where monthly_rent = 5000 and start_date = '2026-01-01';
do $$ declare d text; begin
  select doc_no into d from public.lease_documents where body->>'title' = 'x';
  assert d ~ '^RTC-LSE-20[0-9]{2}-[0-9]{6}$', 'lease number format: ' || coalesce(d, 'null');
  update public.lease_documents set doc_no = 'RTC-LSE-2000-000001', title = 'Changed' where body->>'title' = 'x';
  assert (select doc_no from public.lease_documents where body->>'title' = 'x') = d, 'lease number fixed';
  begin perform public.next_doc_no('RCT', now()); raise exception 'expected: counters are server-only';
  exception when insufficient_privilege then null; end;
  begin perform count(*) from public.doc_counters; raise exception 'expected: counters hidden';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
select set_config('test.nl', (select id::text from public.landlords where email = 'nomsa@numbers.co.za'), false);
delete from public.lease_documents where landlord_id = current_setting('test.nl')::uuid;
delete from public.payments where landlord_id = current_setting('test.nl')::uuid;
delete from public.leases where landlord_id = current_setting('test.nl')::uuid;
delete from public.tenants where landlord_id = current_setting('test.nl')::uuid;
delete from auth.users where id = '00000000-0000-0000-0000-000000000d71';
\echo 'Document number tests passed'
