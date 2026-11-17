// Ozow original API (Private Key + API Key): signing, payment request, status check. Run: node tests/ozow/classic.test.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { signRequest, verifyResponse, classicFields, classicCreate, classicOutcome, mismatches, sha512Hex, OzowError } from '../../supabase/functions/_shared/ozow.js';

const sha = s => createHash('sha512').update(s).digest('hex');
const KEY = 'MyPrivateKey12345';
const fake = reply => { const calls = []; const f = async (url, opts = {}) => { calls.push({ url, opts }); const r = reply(url, opts); return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body }; }; f.calls = calls; return f; };

// Request hash: Ozow's documented sample, fields in order + private key, lower-cased, SHA-512
const sample = { SiteCode: 'TSTSTE0001', CountryCode: 'ZA', CurrencyCode: 'ZAR', Amount: '25.00', TransactionReference: '123',
  BankReference: 'ABC123', CancelUrl: 'http://demo.ozow.com/cancel.aspx', ErrorUrl: 'http://demo.ozow.com/error.aspx',
  SuccessUrl: 'http://demo.ozow.com/success.aspx', NotifyUrl: 'http://demo.ozow.com/notify.aspx', IsTest: 'false' };
assert.equal(await signRequest(sample, KEY), sha(('TSTSTE0001ZAZAR25.00123ABC123http://demo.ozow.com/cancel.aspxhttp://demo.ozow.com/error.aspx'
  + 'http://demo.ozow.com/success.aspxhttp://demo.ozow.com/notify.aspxfalse' + KEY).toLowerCase()));
assert.equal(await sha512Hex('abc'), sha('abc'));

const fields = await classicFields({ siteCode: 'TSTSTE0001', privateKey: KEY, amount: 60, reference: 'RTCABC', bankRef: 'Unit 4/B Nkosi',
  cancelUrl: 'https://x/r', errorUrl: 'https://x/r', successUrl: 'https://x/r', notifyUrl: 'https://x/n', isTest: true });
assert.equal(fields.Amount, '60.00'); assert.equal(fields.IsTest, 'true'); assert.equal(fields.BankReference, 'UNIT4BNKOSI');
assert.equal(fields.HashCheck, await signRequest(fields, KEY));
assert.ok(!JSON.stringify(fields).includes(KEY), 'private key never sent');

// PostPaymentRequest: ApiKey header, JSON body, camelCase or PascalCase reply
let f = fake(() => ({ body: { paymentRequestId: 'pr-1', url: 'https://pay.ozow.com/abc', errorMessage: null } }));
assert.deepEqual(await classicCreate({ apiKey: 'API-KEY', fields, fetchImpl: f }), { id: 'pr-1', redirectUrl: 'https://pay.ozow.com/abc' });
assert.equal(f.calls[0].url, 'https://api.ozow.com/PostPaymentRequest');
assert.equal(f.calls[0].opts.headers.ApiKey, 'API-KEY');
assert.equal(JSON.parse(f.calls[0].opts.body).HashCheck, fields.HashCheck);
f = fake(() => ({ body: { PaymentRequestId: 'pr-2', Url: 'https://pay.ozow.com/x' } }));
assert.equal((await classicCreate({ apiKey: 'k', fields, fetchImpl: f })).redirectUrl, 'https://pay.ozow.com/x');
f = fake(() => ({ body: { errorMessage: 'Invalid hash check' } }));
await assert.rejects(classicCreate({ apiKey: 'k', fields, fetchImpl: f }), e => e instanceof OzowError && e.status === 400 && /Invalid hash/.test(e.message));
f = fake(() => ({ status: 401, body: {} }));
await assert.rejects(classicCreate({ apiKey: 'k', fields, fetchImpl: f }), e => e.status === 401);

// GetTransactionByReference: Complete wins over a later cancelled attempt; IsTest passed through
const tx = (status, created, amount = 60) => ({ TransactionId: 'tx-' + status, SiteCode: 'TSTSTE0001', TransactionReference: 'RTCABC',
  CurrencyCode: 'ZAR', Amount: amount, Status: status, StatusMessage: '', CreatedDate: created });
f = fake(() => ({ body: [tx('Complete', '2026-11-17T10:00:00'), tx('Cancelled', '2026-11-17T11:00:00')] }));
let out = await classicOutcome({ apiKey: 'k', siteCode: 'TSTSTE0001', reference: 'RTCABC', isTest: true, fetchImpl: f });
assert.equal(out.status, 'Complete'); assert.equal(out.transactionId, 'tx-Complete');
const u = new URL(f.calls[0].url);
assert.equal(u.pathname, '/GetTransactionByReference'); assert.equal(u.searchParams.get('IsTest'), 'true');
assert.equal(u.searchParams.get('transactionReference'), 'RTCABC'); assert.equal(f.calls[0].opts.headers.ApiKey, 'k');
assert.deepEqual(mismatches(out, { reference: 'RTCABC', amount: 60 }, 'TSTSTE0001'), []);
assert.ok(mismatches(out, { reference: 'RTCABC', amount: 65 }, 'TSTSTE0001').length, 'amount difference caught');
assert.ok(mismatches({ ...out, siteCode: 'OTHER' }, { reference: 'RTCABC', amount: 60 }, 'TSTSTE0001').length, 'site difference caught');
// camelCase replies, latest attempt when nothing completed, nothing yet, unknown status
f = fake(() => ({ body: [{ status: 'Cancelled', createdDate: '1', amount: 60, transactionReference: 'RTCABC' }, { status: 'Error', createdDate: '2', amount: 60 }] }));
assert.equal((await classicOutcome({ apiKey: 'k', siteCode: 's', reference: 'RTCABC', fetchImpl: f })).status, 'Error');
f = fake(() => ({ body: [] }));
assert.equal(await classicOutcome({ apiKey: 'k', siteCode: 's', reference: 'r', fetchImpl: f }), null);
f = fake(() => ({ body: [{ Status: 'Refunded' }] }));
assert.equal((await classicOutcome({ apiKey: 'k', siteCode: 's', reference: 'r', fetchImpl: f })).status, null);
f = fake(() => ({ status: 500, body: {} }));
await assert.rejects(classicOutcome({ apiKey: 'k', siteCode: 's', reference: 'r', fetchImpl: f }), OzowError);

// Notification signature: fields 1–13 + private key
const resp = { SiteCode: 'TSTSTE0001', TransactionId: 'tx-1', TransactionReference: 'RTCABC', Amount: '60.00', Status: 'Complete',
  Optional1: '', Optional2: '', Optional3: '', Optional4: '', Optional5: '', CurrencyCode: 'ZAR', IsTest: 'true', StatusMessage: 'Paid', BankName: 'Capitec' };
resp.Hash = sha(('TSTSTE0001tx-1RTCABC60.00CompleteZARtruePaid' + KEY).toLowerCase());
assert.ok(await verifyResponse(resp, KEY));
assert.ok(await verifyResponse({ ...resp, Hash: resp.Hash.toUpperCase() }, KEY));
assert.ok(!(await verifyResponse({ ...resp, Amount: '1.00' }, KEY)));
assert.ok(!(await verifyResponse(resp, 'otherkey')));
assert.ok(!(await verifyResponse({ ...resp, Hash: '' }, KEY)));
console.log('Ozow classic tests passed');
