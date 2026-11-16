// Node tests for the Ozow signing logic: node tests/ozow/ozow.test.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { signRequest, verifyResponse, paymentRequest, bankReference, sha512Hex } from '../../supabase/functions/_shared/ozow.js';

const sha = s => createHash('sha512').update(s).digest('hex');
const KEY = 'MyPrivateKey12345';

// Request hash = SHA-512 of the lower-cased concatenation in Ozow's documented order (their sample's fields).
const sample = { SiteCode: 'TSTSTE0001', CountryCode: 'ZA', CurrencyCode: 'ZAR', Amount: '25.00', TransactionReference: '123',
  BankReference: 'ABC123', CancelUrl: 'http://demo.ozow.com/cancel.aspx', ErrorUrl: 'http://demo.ozow.com/error.aspx',
  SuccessUrl: 'http://demo.ozow.com/success.aspx', NotifyUrl: 'http://demo.ozow.com/notify.aspx', IsTest: 'false' };
const expected = sha(('TSTSTE0001ZAZAR25.00123ABC123http://demo.ozow.com/cancel.aspxhttp://demo.ozow.com/error.aspx'
  + 'http://demo.ozow.com/success.aspxhttp://demo.ozow.com/notify.aspxfalse' + KEY).toLowerCase());
assert.equal(await signRequest(sample, KEY), expected, 'request hash in documented order');
assert.equal(await sha512Hex('abc'), sha('abc'), 'sha512 matches node');

// Built request: amount with 2 decimals, signed, bank reference cleaned
const req = await paymentRequest({ siteCode: 'TSTSTE0001', privateKey: KEY, amount: 6000, reference: 'RTCABC', bankRef: 'Unit 4/B — Nkosi!!',
  cancelUrl: 'https://x/c', errorUrl: 'https://x/e', successUrl: 'https://x/s', notifyUrl: 'https://x/n', isTest: true });
assert.equal(req.Amount, '6000.00');
assert.equal(req.IsTest, 'true');
assert.equal(req.BankReference, 'Unit 4B  Nkosi');
assert.equal(req.HashCheck, await signRequest(req, KEY));
assert.equal(bankReference('A'.repeat(30)).length, 20);

// Response: fields 1–13 in order, then the key; Hash/SubStatus/BankName etc. ignored
const resp = { SiteCode: 'TSTSTE0001', TransactionId: 'tx-1', TransactionReference: 'RTCABC', Amount: '6000.00', Status: 'Complete',
  Optional1: '', Optional2: '', Optional3: '', Optional4: '', Optional5: '', CurrencyCode: 'ZAR', IsTest: 'true', StatusMessage: 'Paid',
  SubStatus: 'x', BankName: 'Capitec' };
resp.Hash = sha(('TSTSTE0001tx-1RTCABC6000.00CompleteZARtruePaid' + KEY).toLowerCase());
assert.ok(await verifyResponse(resp, KEY), 'valid notification accepted');
assert.ok(await verifyResponse({ ...resp, Hash: resp.Hash.toUpperCase() }, KEY), 'case-insensitive');
assert.ok(!(await verifyResponse({ ...resp, Amount: '1.00' }, KEY)), 'changed amount rejected');
assert.ok(!(await verifyResponse(resp, 'otherkey')), 'wrong key rejected');
assert.ok(!(await verifyResponse({ ...resp, Hash: '' }, KEY)), 'missing hash rejected');
// leading zeros trimmed on both sides
const zeroKey = (() => { for (let i = 0; i < 5000; i++) { const k = 'k' + i; if (sha(('TSTSTE0001tx-1RTCABC6000.00CompleteZARtruePaid' + k).toLowerCase()).startsWith('0')) return k; } })();
if (zeroKey) {
  const h = sha(('TSTSTE0001tx-1RTCABC6000.00CompleteZARtruePaid' + zeroKey).toLowerCase());
  assert.ok(await verifyResponse({ ...resp, Hash: h.replace(/^0+/, '') }, zeroKey), 'leading zeros dropped by Ozow still match');
}
console.log('Ozow signing tests passed');
