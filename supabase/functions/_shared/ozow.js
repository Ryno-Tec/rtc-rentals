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
  if (!res.ok) throw new OzowError(res.status === 400 || res.status === 401 ? 'Ozow rejected the Client ID or Client Secret.' : `Ozow sign-in failed (${res.status}).`, res.status);
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
