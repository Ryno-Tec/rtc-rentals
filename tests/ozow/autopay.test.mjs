// Capitec Pay recurring (Ozow) and Netcash DebiCheck helpers. Run: node tests/ozow/autopay.test.mjs
import assert from 'node:assert/strict';
import { subscriptionBody, createSubscription, getSubscription, chargeSubscription, subscriptionTransactions, getToken } from '../../supabase/functions/_shared/ozow.js';
import { debicheckBatch, actionDate, uploadBatch, uploadReport } from '../../supabase/functions/_shared/netcash.js';

// Consent request: whole-rand band, Capitec, monthly, short description, clean references
const b = subscriptionBody({ siteCode: 'ABC-ABC-001', amount: 9000, maxAmount: 9500.4, reference: 'APX 1', bankRef: 'Oak Nandi!', description: 'Rent Unit 12 Oak Street long', firstPaymentDate: '2026-12-01' });
assert.equal(b.paymentMethod, 'capitec'); assert.equal(b.frequency, 'Monthly'); assert.equal(b.occurrences, 120);
assert.deepEqual(b.amountConstraints, { min: 1, max: 9501 });
assert.equal(b.amount.value, 9000); assert.ok(b.description.length <= 20); assert.equal(b.merchantReference, 'APX1');
assert.match(b.bankReference, /^[A-Z0-9]{1,20}$/);
assert.equal(subscriptionBody({ siteCode: 's', amount: 200000, maxAmount: 999999, reference: 'r', firstPaymentDate: 'x' }).amountConstraints.max, 100000, 'capped at R100 000');

// Scope is part of the cached token
let scopes = [];
const tf = async (u, o) => { scopes.push(new URLSearchParams(o.body).get('scope')); return { ok: true, status: 200, json: async () => ({ access_token: 't-' + scopes.length, expires_in: 14400 }) }; };
await getToken({ base: 'S', clientId: 'c', clientSecret: 's', scope: 'subscriptions', fetchImpl: tf });
await getToken({ base: 'S', clientId: 'c', clientSecret: 's', scope: 'payments', fetchImpl: tf });
assert.deepEqual(scopes, ['subscriptions', 'payments']);

const fake = (status, body) => async (url, opts = {}) => ({ ok: status < 400, status, json: async () => ({ ...body, _url: url, _method: opts.method, _body: opts.body }) });
const s = await createSubscription({ base: 'B', token: 't', body: b, fetchImpl: fake(200, { subscriptionId: 'sub-1', status: 'PendingAuthorization', redirectUrl: 'https://pay/x' }) });
assert.deepEqual(s, { id: 'sub-1', status: 'PendingAuthorization', redirectUrl: 'https://pay/x' });
assert.equal((await getSubscription({ base: 'B', token: 't', id: 'sub-1', fetchImpl: fake(200, { status: 'Active' }) })).mapped, 'active');
assert.equal((await getSubscription({ base: 'B', token: 't', id: 'sub-1', fetchImpl: fake(200, { status: 'Canceled' }) })).mapped, 'cancelled');
const ch = await chargeSubscription({ base: 'B', token: 't', id: 'sub-1', amount: '9000', reference: 'AC1', fetchImpl: fake(200, { id: 'tx' }) });
assert.match(ch._url, /\/v1\/subscriptions\/sub-1\/transactions$/); assert.equal(ch._method, 'POST');
assert.deepEqual(JSON.parse(ch._body), { amount: { currency: 'ZAR', value: 9000 }, merchantReference: 'AC1' });
await assert.rejects(chargeSubscription({ base: 'B', token: 't', id: 's', amount: 1, reference: 'r', fetchImpl: fake(400, { title: 'Amount outside constraints' }) }), /outside constraints/);
assert.equal((await subscriptionTransactions({ base: 'B', token: 't', id: 's', fetchImpl: fake(200, { results: [{ merchantReference: 'AC1', status: 'Successful' }] }) }))[0].status, 'Successful');

// DebiCheck batch: header, key, one line per debit in cents, footer with count, total and 9999
const file = debicheckBatch({ serviceKey: 'KEY', batchName: 'Rent\tNov', date: new Date('2026-11-17T00:00:00Z'),
  rows: [{ accountRef: 'OAKNANDI', mandateRef: 'DC-77', amount: 9500, ourRef: 'AC1' }, { accountRef: 'FLAT2', mandateRef: 'DC-78', amount: '4500.50', ourRef: 'AC2' }] });
const lines = file.split('\r\n').map(l => l.split('\t'));
assert.deepEqual(lines[0].slice(0, 6), ['H', 'KEY', '1', 'DebiCheck', 'Rent Nov', '20261117']);
assert.deepEqual(lines[1], ['K', '101', '162', '232', '249', '301']);
assert.deepEqual(lines[2], ['T', 'OAKNANDI', '950000', '3', 'DC-77', 'AC1']);
assert.deepEqual(lines[3], ['T', 'FLAT2', '450050', '3', 'DC-78', 'AC2']);
assert.deepEqual(lines[4], ['F', '2', '1400050', '9999']);
assert.throws(() => debicheckBatch({ serviceKey: 'K', batchName: 'x', date: new Date(), rows: [] }));
// Friday -> Monday
assert.equal(actionDate(new Date('2026-11-20T10:00:00Z')).toISOString().slice(0, 10), '2026-11-23');

const soapOk = text => async () => ({ ok: true, status: 200, text: async () => text });
assert.equal(await uploadBatch({ serviceKey: 'K', file, fetchImpl: soapOk('<s><BatchFileUploadResult>2000.1.2</BatchFileUploadResult></s>') }), '2000.1.2');
await assert.rejects(uploadBatch({ serviceKey: 'K', file, fetchImpl: soapOk('<s><BatchFileUploadResult>100</BatchFileUploadResult></s>') }), /service key/);
const rep = await uploadReport({ serviceKey: 'K', token: 't', fetchImpl: soapOk('<s><RequestFileUploadReportResult>###BEGIN\nSUCCESSFUL WITH ERRORS\nLine 3: OAKNANDI mandate not found\n###END</RequestFileUploadReportResult></s>') });
assert.equal(rep.result, 'errors'); assert.match(rep.errors[0], /OAKNANDI/);
assert.equal(await uploadReport({ serviceKey: 'K', token: 't', fetchImpl: soapOk('<s><RequestFileUploadReportResult>FILE NOT READY</RequestFileUploadReportResult></s>') }), null);
console.log('Auto-pay helper tests passed');
