// Ozow One API (https://hub.ozow.com). Plain JS so Node can unit-test it and Deno can run it.
//   token:   POST {base}/v1/token  (client_credentials, scope=payments), valid ~4 hours
//   create:  POST {base}/v1/payments  -> { id, status: 'Created', redirectUrl }
//   confirm: GET  {base}/v1/payments/{id}/transactions?fromDate&toDate -> results[].status
// Test mode means Ozow's staging environment, with staging credentials from Ozow support.
export const OZOW_LIVE = 'https://one.ozow.com';
export const OZOW_STAGING = 'https://stagingone.ozow.com';
export const ozowBase = isTest => (isTest ? OZOW_STAGING : OZOW_LIVE);

// beneficiaryReference: letters and digits only, at most 20 (a site prefix counts too, so keep it short).
export const bankReference = s => String(s || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 15) || 'RENT';

export function newReference() {
  const b = new Uint8Array(10);
  crypto.getRandomValues(b);
  return 'RTC' + [...b].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
}

// Ozow transaction status -> the status words complete_online_payment() understands.
export const TX_STATUS = { successful: 'Complete', incomplete: 'Cancelled', error: 'Error', pending: 'Pending' };

const tokens = new Map();   // per client, reused while valid
export async function getToken({ base, clientId, clientSecret, scope = 'payments', fetchImpl = fetch, now = Date.now }) {
  const key = `${base}|${clientId}|${scope}`;
  const hit = tokens.get(key);
  if (hit && hit.until > now()) return hit.token;
  const res = await fetchImpl(`${base}/v1/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, scope, grant_type: 'client_credentials' }).toString(),
  });
  if (!res.ok) {
    // Keep Ozow's own explanation (never contains our secret) so the owner and Ryno-Tec can see why.
    const why = (await (res.text ? res.text() : Promise.resolve('')).catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
    throw new OzowError((res.status === 400 || res.status === 401 ? 'Ozow rejected the Client ID or Client Secret.' : `Ozow sign-in failed (${res.status}).`) + (why ? ` Ozow said: ${why}` : ''), res.status);
  }
  const j = await res.json();
  const ttl = Math.max(60, Number(j.expires_in) || 3600) - 60;
  tokens.set(key, { token: j.access_token, until: now() + ttl * 1000 });
  return j.access_token;
}

export class OzowError extends Error { constructor(m, status) { super(m); this.status = status; } }

export function paymentBody({ siteCode, amount, reference, bankRef, returnUrl, notifyUrl, minutes = 60, now = new Date() }) {
  const body = {
    siteCode,
    region: 'ZA',
    amount: { currency: 'ZAR', value: Math.round(Number(amount) * 100) / 100 },
    merchantReference: reference,
    beneficiaryReference: bankReference(bankRef),
    expireAt: new Date(now.getTime() + minutes * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    returnUrl,
  };
  if (notifyUrl) body.notifyUrl = notifyUrl;
  return body;
}

export async function createPayment({ base, token, body, fetchImpl = fetch }) {
  const res = await fetchImpl(`${base}/v1/payments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': body.merchantReference },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.redirectUrl) throw new OzowError(j.detail || j.title || j.message || `Ozow couldn’t create the payment (${res.status}).`, res.status);
  return { id: j.id, redirectUrl: j.redirectUrl };
}

const ymd = d => d.toISOString().slice(0, 10);
// The outcome Ozow holds for a payment: a successful transaction wins, otherwise the latest attempt.
export async function paymentOutcome({ base, token, paymentId, since, fetchImpl = fetch, now = new Date() }) {
  const from = new Date(new Date(since).getTime() - 864e5), to = new Date(now.getTime() + 864e5);
  const url = `${base}/v1/payments/${encodeURIComponent(paymentId)}/transactions?fromDate=${ymd(from)}&toDate=${ymd(to)}&limit=50`;
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new OzowError(`Ozow status check failed (${res.status}).`, res.status);
  const list = (await res.json()).results || [];
  if (!list.length) return null;                                   // payer hasn't finished yet
  const ok = list.find(t => String(t.status).toLowerCase() === 'successful');
  const t = ok || [...list].sort((a, b) => String(b.createdDate).localeCompare(String(a.createdDate)))[0];
  const status = TX_STATUS[String(t.status).toLowerCase()];
  if (!status) return { status: null, raw: t };                    // e.g. Refunded: leave as is
  return { status, transactionId: t.id, amount: Number(t.amount?.value), currency: t.amount?.currency ?? null,
    merchantReference: t.merchantReference ?? null, siteCode: t.siteCode ?? null, reason: t.reason || null, raw: t };
}

// Does Ozow's transaction match what we asked for? Returns the problems found (empty = fine).
export function mismatches(out, op, siteCode) {
  const bad = [];
  if (String(out.currency || '').toUpperCase() !== 'ZAR') bad.push(`currency ${out.currency}`);
  if (out.merchantReference !== op.reference) bad.push(`reference ${out.merchantReference}`);
  if (siteCode && out.siteCode && String(out.siteCode).toLowerCase() !== String(siteCode).toLowerCase()) bad.push(`site ${out.siteCode}`);
  if (Math.round(Number(out.amount) * 100) !== Math.round(Number(op.amount) * 100)) bad.push(`amount ${out.amount} (expected ${op.amount})`);
  return bad;
}

// ---------------------------------------------------------------------------------------------
// Recurring payments (Beta): Capitec Pay variable recurring payments. Needs the `subscriptions`
// scope and recurring payments switched on for the merchant by Ozow.
//   POST /v1/subscriptions                       consent request -> { subscriptionId, status, redirectUrl }
//   GET  /v1/subscriptions/{id}                  status: PendingAuthorization | Active | Canceled | Completed | Expired | Failed
//   POST /v1/subscriptions/{id}/transactions     merchant-initiated collection within the authorised band
//   GET  /v1/subscriptions/{id}/transactions     collections: Pending | Successful | Failed
//   POST /v1/subscriptions/{id}/cancel           final; also cancels the consent at Capitec
// ---------------------------------------------------------------------------------------------
export const SUB_STATUS = { pendingauthorization: 'pending', active: 'active', canceled: 'cancelled', cancelled: 'cancelled',
  completed: 'completed', expired: 'expired', failed: 'failed' };

export function subscriptionBody({ siteCode, amount, maxAmount, reference, bankRef, description, firstPaymentDate }) {
  const max = Math.min(100000, Math.ceil(Number(maxAmount)));
  return {
    siteCode,
    paymentMethod: 'capitec',
    amount: { currency: 'ZAR', value: Math.min(Math.round(Number(amount) * 100) / 100, max) },
    amountConstraints: { min: 1, max },
    description: String(description || 'Rent').replace(/[^A-Za-z0-9 .-]/g, '').slice(0, 20) || 'Rent',
    merchantReference: String(reference).replace(/\s/g, '').slice(0, 50),
    bankReference: bankReference(bankRef),
    frequency: 'Monthly',
    firstPaymentDate,
    occurrences: 120,
  };
}

async function call(fetchImpl, url, token, method = 'GET', body) {
  const res = await fetchImpl(url, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': body.merchantReference || '' } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new OzowError(j.detail || j.title || j.message || `Ozow answered ${res.status}.`, res.status);
  return j;
}
export const createSubscription = ({ base, token, body, fetchImpl = fetch }) =>
  call(fetchImpl, `${base}/v1/subscriptions`, token, 'POST', body).then(j => ({ id: j.subscriptionId || j.id, status: j.status, redirectUrl: j.redirectUrl }));
export const getSubscription = ({ base, token, id, fetchImpl = fetch }) =>
  call(fetchImpl, `${base}/v1/subscriptions/${encodeURIComponent(id)}`, token).then(j => ({ ...j, mapped: SUB_STATUS[String(j.status || '').toLowerCase()] || null }));
export const chargeSubscription = ({ base, token, id, amount, reference, fetchImpl = fetch }) =>
  call(fetchImpl, `${base}/v1/subscriptions/${encodeURIComponent(id)}/transactions`, token, 'POST',
    { amount: { currency: 'ZAR', value: Math.round(Number(amount) * 100) / 100 }, merchantReference: reference });
export const subscriptionTransactions = ({ base, token, id, fetchImpl = fetch }) =>
  call(fetchImpl, `${base}/v1/subscriptions/${encodeURIComponent(id)}/transactions`, token).then(j => j.results || j.value || (Array.isArray(j) ? j : []));
export const cancelSubscription = ({ base, token, id, fetchImpl = fetch }) =>
  call(fetchImpl, `${base}/v1/subscriptions/${encodeURIComponent(id)}/cancel`, token, 'POST', { merchantReference: '' });

// ---------------------------------------------------------------------------------------------
// Ozow's original API, for merchants given a Private Key + API Key instead of One API clients.
//   create:  POST {api}/PostPaymentRequest   ApiKey header, JSON fields + HashCheck -> { paymentRequestId, url, errorMessage }
//   confirm: GET  {api}/GetTransactionByReference?siteCode&transactionReference&IsTest -> Transaction[]
//   notify:  form post signed with Hash (checked here, but the outcome is still fetched from Ozow)
// HashCheck: the sent fields in Ozow's order, then the Private Key, lower-cased, SHA-512 hex.
// ---------------------------------------------------------------------------------------------
export const CLASSIC_API = 'https://api.ozow.com';

const REQUEST_ORDER = ['SiteCode', 'CountryCode', 'CurrencyCode', 'Amount', 'TransactionReference', 'BankReference',
  'Optional1', 'Optional2', 'Optional3', 'Optional4', 'Optional5', 'Customer',
  'CancelUrl', 'ErrorUrl', 'SuccessUrl', 'NotifyUrl', 'IsTest'];
const RESPONSE_ORDER = ['SiteCode', 'TransactionId', 'TransactionReference', 'Amount', 'Status',
  'Optional1', 'Optional2', 'Optional3', 'Optional4', 'Optional5', 'CurrencyCode', 'IsTest', 'StatusMessage'];

export async function sha512Hex(text) {
  const buf = await crypto.subtle.digest('SHA-512', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const present = v => v !== undefined && v !== null && v !== '';

export async function signRequest(fields, privateKey) {
  const joined = REQUEST_ORDER.filter(k => present(fields[k])).map(k => String(fields[k])).join('') + privateKey;
  return sha512Hex(joined.toLowerCase());
}

/** True when a notification carries Ozow's valid signature for this Private Key (constant-time compare). */
export async function verifyResponse(params, privateKey) {
  if (!params || !params.Hash || !privateKey) return false;
  const joined = RESPONSE_ORDER.map(k => (params[k] ?? '')).join('') + privateKey;
  const mine = (await sha512Hex(joined.toLowerCase())).replace(/^0+/, '');
  const theirs = String(params.Hash).toLowerCase().replace(/^0+/, '');
  if (mine.length !== theirs.length) return false;
  let diff = 0;
  for (let i = 0; i < mine.length; i++) diff |= mine.charCodeAt(i) ^ theirs.charCodeAt(i);
  return diff === 0;
}

export async function classicFields({ siteCode, privateKey, amount, reference, bankRef, cancelUrl, errorUrl, successUrl, notifyUrl, isTest }) {
  const fields = {
    SiteCode: siteCode, CountryCode: 'ZA', CurrencyCode: 'ZAR', Amount: Number(amount).toFixed(2),
    TransactionReference: reference, BankReference: bankReference(bankRef),
    CancelUrl: cancelUrl, ErrorUrl: errorUrl, SuccessUrl: successUrl, NotifyUrl: notifyUrl,
    IsTest: isTest ? 'true' : 'false',
  };
  fields.HashCheck = await signRequest(fields, privateKey);
  return fields;
}

const pick = (o, k) => o?.[k] ?? o?.[k[0].toLowerCase() + k.slice(1)];

export async function classicCreate({ apiKey, fields, fetchImpl = fetch }) {
  const res = await fetchImpl(`${CLASSIC_API}/PostPaymentRequest`, {
    method: 'POST',
    headers: { ApiKey: apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(fields),
  });
  const j = await res.json().catch(() => ({}));
  const url = pick(j, 'Url') ?? j.URL, err = pick(j, 'ErrorMessage');
  if (!res.ok || !url) throw new OzowError(err || `Ozow couldn’t create the payment (${res.status}).`, res.status === 401 || res.status === 403 ? 401 : res.ok ? 400 : res.status);
  return { id: pick(j, 'PaymentRequestId') || fields.TransactionReference, redirectUrl: url };
}

// The outcome Ozow holds for our reference: a Complete transaction wins, otherwise the latest attempt.
// Ozow's by-reference lookup can come back empty for an older, settled payment, so when we already hold
// Ozow's transaction ID we fall back to GetTransaction before concluding Ozow has no record.
async function classicGet(fetchImpl, apiKey, path, params) {
  const res = await fetchImpl(`${CLASSIC_API}/${path}?${new URLSearchParams(params)}`, { headers: { ApiKey: apiKey, Accept: 'application/json' } });
  if (res.status === 404) return [];
  if (!res.ok) throw new OzowError(`Ozow status check failed (${res.status}).`, res.status);
  const raw = await res.json().catch(() => []);
  return (Array.isArray(raw) ? raw : raw ? [raw] : []).filter(t => t && typeof t === 'object' && Object.keys(t).length);
}

export async function classicOutcome({ apiKey, siteCode, reference, isTest, transactionId = null, fetchImpl = fetch }) {
  const IsTest = isTest ? 'true' : 'false';
  let list = await classicGet(fetchImpl, apiKey, 'GetTransactionByReference', { siteCode, transactionReference: reference, IsTest });
  if (!list.length && transactionId)
    list = await classicGet(fetchImpl, apiKey, 'GetTransaction', { siteCode, transactionId, IsTest });
  if (!list.length) return null;
  const st = t => String(pick(t, 'Status') || '');
  const ok = list.find(t => st(t).toLowerCase() === 'complete');
  const t = ok || [...list].sort((a, b) => String(pick(b, 'CreatedDate')).localeCompare(String(pick(a, 'CreatedDate'))))[0];
  const known = ['complete', 'cancelled', 'error', 'abandoned', 'pending', 'pendinginvestigation'];
  if (!known.includes(st(t).toLowerCase())) return { status: null, raw: t };
  return { status: st(t), transactionId: pick(t, 'TransactionId') ?? null, amount: Number(pick(t, 'Amount')),
    currency: pick(t, 'CurrencyCode') ?? null, merchantReference: pick(t, 'TransactionReference') ?? null,
    siteCode: pick(t, 'SiteCode') ?? null, reason: pick(t, 'StatusMessage') || null, raw: t };
}
