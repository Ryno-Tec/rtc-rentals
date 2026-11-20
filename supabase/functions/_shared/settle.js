// Works out who an online payment belongs to, asks Ozow how it went, checks it matches what was
// asked for, and records the result. Anything odd is written to payment_events (alerts).
// Used by ozow-notify, ozow-check (the browser on return) and ozow-reconcile (scheduled).
import { ozowBase, getToken, paymentOutcome, mismatches, classicOutcome } from './ozow.js';

const env = k => globalThis.Deno?.env.get(k) ?? '';
const EXPIRY_MINUTES = 70;      // payments are created to expire after 60 minutes

export async function logEvent(admin, kind, op, detail = {}, alert = true) {
  try {
    await admin.from('payment_events').insert({ kind, alert, reference: op?.reference ?? null, landlord_id: op?.landlord_id ?? null, detail });
  } catch { /* logging must never break a payment */ }
}

// method 'one' = One API (Client ID + Client Secret); 'classic' = Private Key + API Key.
export async function credentialsFor(admin, kind, landlordId) {
  if (kind === 'invoice') {
    const base = { siteCode: env('RTC_OZOW_SITE_CODE'), isTest: env('RTC_OZOW_IS_TEST') === 'true', enabled: true };
    if (!base.siteCode) return null;
    if (env('RTC_OZOW_CLIENT_ID') && env('RTC_OZOW_CLIENT_SECRET'))
      return { ...base, method: 'one', clientId: env('RTC_OZOW_CLIENT_ID'), clientSecret: env('RTC_OZOW_CLIENT_SECRET') };
    if (env('RTC_OZOW_PRIVATE_KEY') && env('RTC_OZOW_API_KEY'))
      return { ...base, method: 'classic', privateKey: env('RTC_OZOW_PRIVATE_KEY'), apiKey: env('RTC_OZOW_API_KEY') };
    return null;
  }
  const [{ data: a }, { data: s }] = await Promise.all([
    admin.from('ozow_accounts').select('site_code, is_test, enabled, method').eq('landlord_id', landlordId).maybeSingle(),
    admin.from('ozow_secrets').select('client_id, client_secret, private_key, api_key').eq('landlord_id', landlordId).maybeSingle(),
  ]);
  if (!a || !s) return null;
  const c = { siteCode: a.site_code, isTest: a.is_test, enabled: a.enabled, method: a.method || 'one' };
  if (c.method === 'classic') return s.private_key && s.api_key ? { ...c, privateKey: s.private_key, apiKey: s.api_key } : null;
  return s.client_id && s.client_secret ? { ...c, clientId: s.client_id, clientSecret: s.client_secret } : null;
}

async function outcomeFor(admin, op) {
  const c = await credentialsFor(admin, op.kind, op.landlord_id);
  if (!c) { await logEvent(admin, 'credentials', op, { note: 'Ozow connection missing; cannot check this payment' }); return { c: null, out: null }; }
  if (c.method === 'classic')
    return { c, out: await classicOutcome({ apiKey: c.apiKey, siteCode: c.siteCode, reference: op.reference, isTest: c.isTest, transactionId: op.ozow_transaction_id ?? null }) };
  const base = ozowBase(c.isTest);
  const token = await getToken({ base, clientId: c.clientId, clientSecret: c.clientSecret });
  return { c, out: await paymentOutcome({ base, token, paymentId: op.ozow_payment_id, since: op.created_at }) };
}

// Returns the payment's status after checking with Ozow.
export async function settle(admin, op) {
  if (op.status === 'complete' || !op.ozow_payment_id) return op.status;
  let c, out;
  try { ({ c, out } = await outcomeFor(admin, op)); }
  catch (e) { await logEvent(admin, 'check_failed', op, { error: String(e?.message || e) }); throw e; }
  if (!c) return op.status;
  if (!out || !out.status) {
    // Nothing finished at Ozow. Once the payment has expired, close it so it stops being re-checked.
    if (!out && Date.now() - new Date(op.created_at).getTime() > EXPIRY_MINUTES * 60000 && ['started', 'pending'].includes(op.status)) {
      await admin.from('online_payments').update({ status: 'abandoned' }).eq('id', op.id).in('status', ['started', 'pending']);
      await logEvent(admin, 'expired', op, { note: 'Payer never finished at Ozow' }, false);
      return 'abandoned';
    }
    return op.status;
  }
  let status = out.status;
  if (status === 'Complete') {
    const bad = mismatches(out, op, c.siteCode);
    if (bad.length) { await logEvent(admin, 'mismatch', op, { problems: bad, transaction: out.raw }); status = 'PendingInvestigation'; }
  }
  const { data, error } = await admin.rpc('complete_online_payment', {
    p_reference: op.reference, p_status: status, p_transaction_id: out.transactionId,
    p_amount: out.amount, p_is_test: c.isTest, p_raw: out.raw,
  });
  if (error) { await logEvent(admin, 'check_failed', op, { error: error.message }); throw error; }
  return data;
}

// Full reconciliation: a payment we hold as complete must be Successful at Ozow, for the same amount.
export async function verifyComplete(admin, op) {
  if (op.status !== 'complete' || !op.ozow_payment_id) return true;
  const { c, out } = await outcomeFor(admin, op);
  if (!c) return false;
  const fine = out?.status === 'Complete' && !mismatches(out, op, c.siteCode).length;
  if (!fine) await logEvent(admin, 'reconcile_mismatch', op, out
    ? { ozow: out.raw ?? null, problems: out.status === 'Complete' ? mismatches(out, op, c.siteCode) : [`Ozow status: ${out.status ?? 'unknown'}`], note: 'Recorded as paid here, but Ozow’s record differs' }
    : { ozow: null, note: 'Recorded as paid here, but Ozow returned no record for this reference or transaction ID' });
  return fine;
}
