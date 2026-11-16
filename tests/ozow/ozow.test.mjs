// Ozow One API client: token caching, payment body, outcome mapping. Run: node tests/ozow/ozow.test.mjs
import assert from 'node:assert/strict';
import { ozowBase, bankReference, newReference, getToken, paymentBody, createPayment, paymentOutcome, mismatches, OzowError } from '../../supabase/functions/_shared/ozow.js';

const calls = [];
const fake = routes => async (url, opts = {}) => {
  calls.push({ url, opts });
  for (const [match, reply] of routes) if (url.includes(match)) {
    const r = typeof reply === 'function' ? reply(url, opts) : reply;
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body };
  }
  throw new Error('unexpected ' + url);
};

assert.equal(ozowBase(false), 'https://one.ozow.com');
assert.equal(ozowBase(true), 'https://stagingone.ozow.com');
assert.equal(bankReference('Room 1-Nkosi!'), 'ROOM1NKOSI');
assert.ok(bankReference('x'.repeat(40)).length <= 20);
assert.match(newReference(), /^RTC[0-9A-F]{20}$/);
assert.notEqual(newReference(), newReference());

// Token: form-encoded client credentials, reused until near expiry
let t = 0;
const tokenFetch = fake([['/v1/token', (u, o) => {
  const f = new URLSearchParams(o.body);
  assert.equal(f.get('grant_type'), 'client_credentials'); assert.equal(f.get('scope'), 'payments');
  assert.equal(o.headers['Content-Type'], 'application/x-www-form-urlencoded');
  return { body: { access_token: 'tok' + (++t), expires_in: 14400 } };
}]]);
let now = 1_000_000;
assert.equal(await getToken({ base: 'B', clientId: 'c', clientSecret: 's', fetchImpl: tokenFetch, now: () => now }), 'tok1');
assert.equal(await getToken({ base: 'B', clientId: 'c', clientSecret: 's', fetchImpl: tokenFetch, now: () => now }), 'tok1', 'cached');
now += 14400 * 1000;
assert.equal(await getToken({ base: 'B', clientId: 'c', clientSecret: 's', fetchImpl: tokenFetch, now: () => now }), 'tok2', 'refreshed');
await assert.rejects(getToken({ base: 'B', clientId: 'bad', clientSecret: 's', fetchImpl: fake([['/v1/token', { status: 401, body: {} }]]) }),
  e => e instanceof OzowError && e.status === 401);

// Payment body
const b = paymentBody({ siteCode: 'ABC-ABC-001', amount: '4500', reference: 'RTCX', bankRef: 'Room 1 Nkosi', returnUrl: 'https://r', notifyUrl: 'https://n', now: new Date('2026-11-16T10:00:00Z') });
assert.deepEqual(b.amount, { currency: 'ZAR', value: 4500 });
assert.equal(typeof b.amount.value, 'number');
assert.equal(b.expireAt, '2026-11-16T11:00:00Z');
assert.equal(b.beneficiaryReference, 'ROOM1NKOSI');
assert.equal(b.region, 'ZA');

// Create
const created = await createPayment({ base: 'B', token: 'tok', body: b, fetchImpl: fake([['/v1/payments', (u, o) => {
  assert.equal(o.headers.Authorization, 'Bearer tok'); assert.equal(o.headers['Idempotency-Key'], 'RTCX');
  return { body: { id: 'pay-1', status: 'Created', redirectUrl: 'https://pay.ozow.com/x' } };
}]]) });
assert.deepEqual(created, { id: 'pay-1', redirectUrl: 'https://pay.ozow.com/x' });
await assert.rejects(createPayment({ base: 'B', token: 'tok', body: b, fetchImpl: fake([['/v1/payments', { status: 400, body: { title: 'Invalid siteCode' } }]]) }), /Invalid siteCode/);

// Outcome
const tx = list => fake([['/transactions', (u) => { assert.match(u, /fromDate=2026-11-15&toDate=2026-11-17/); return { body: { results: list } }; }]]);
const since = '2026-11-16T09:00:00Z', at = new Date('2026-11-16T10:00:00Z');
assert.equal(await paymentOutcome({ base: 'B', token: 't', paymentId: 'p', since, now: at, fetchImpl: tx([]) }), null, 'not finished');
let o = await paymentOutcome({ base: 'B', token: 't', paymentId: 'p', since, now: at, fetchImpl: tx([
  { id: 't1', status: 'Incomplete', amount: { value: 4500 }, createdDate: '2026-11-16T09:10:00Z' },
  { id: 't2', status: 'Successful', amount: { value: 4500 }, createdDate: '2026-11-16T09:05:00Z' }]) });
assert.deepEqual([o.status, o.transactionId, o.amount], ['Complete', 't2', 4500], 'a successful attempt wins');
o = await paymentOutcome({ base: 'B', token: 't', paymentId: 'p', since, now: at, fetchImpl: tx([
  { id: 't1', status: 'Error', amount: { value: 1 }, createdDate: '2026-11-16T09:01:00Z' },
  { id: 't3', status: 'incomplete', amount: { value: 1 }, createdDate: '2026-11-16T09:09:00Z' }]) });
assert.equal(o.status, 'Cancelled', 'latest attempt, case-insensitive');
assert.equal((await paymentOutcome({ base: 'B', token: 't', paymentId: 'p', since, now: at, fetchImpl: tx([{ id: 'r', status: 'Refunded', createdDate: 'x' }]) })).status, null, 'refunded: no change');

// Matching what we asked for
const op = { reference: 'RTCX', amount: 4500 };
const good = { currency: 'ZAR', merchantReference: 'RTCX', siteCode: 'ABC-ABC-001', amount: 4500 };
assert.deepEqual(mismatches(good, op, 'abc-abc-001'), []);
assert.equal(mismatches({ ...good, currency: 'USD' }, op, 'ABC-ABC-001').length, 1);
assert.equal(mismatches({ ...good, merchantReference: 'OTHER' }, op, 'ABC-ABC-001').length, 1);
assert.equal(mismatches({ ...good, siteCode: 'XYZ-XYZ-999' }, op, 'ABC-ABC-001').length, 1);
assert.equal(mismatches({ ...good, amount: 4499.99 }, op, 'ABC-ABC-001').length, 1);

console.log('Ozow One API tests passed');
