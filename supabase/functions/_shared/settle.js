// Works out who an online payment belongs to, asks Ozow how it went, and records the result.
// Used by ozow-notify (Ozow calls it) and ozow-check (the browser asks after coming back).
import { ozowBase, getToken, paymentOutcome } from './ozow.js';

const env = k => globalThis.Deno?.env.get(k) ?? '';

export async function credentialsFor(admin, kind, landlordId) {
  if (kind === 'invoice') {
    const c = { siteCode: env('RTC_OZOW_SITE_CODE'), clientId: env('RTC_OZOW_CLIENT_ID'), clientSecret: env('RTC_OZOW_CLIENT_SECRET'),
      isTest: env('RTC_OZOW_IS_TEST') === 'true', enabled: true };
    return c.siteCode && c.clientId && c.clientSecret ? c : null;
  }
  const [{ data: a }, { data: s }] = await Promise.all([
    admin.from('ozow_accounts').select('site_code, is_test, enabled').eq('landlord_id', landlordId).maybeSingle(),
    admin.from('ozow_secrets').select('client_id, client_secret').eq('landlord_id', landlordId).maybeSingle(),
  ]);
  if (!a || !s?.client_id || !s?.client_secret) return null;
  return { siteCode: a.site_code, clientId: s.client_id, clientSecret: s.client_secret, isTest: a.is_test, enabled: a.enabled };
}

// Returns the payment's status after checking with Ozow.
export async function settle(admin, op) {
  if (op.status === 'complete' || !op.ozow_payment_id) return op.status;
  const c = await credentialsFor(admin, op.kind, op.landlord_id);
  if (!c) return op.status;
  const base = ozowBase(c.isTest);
  const token = await getToken({ base, clientId: c.clientId, clientSecret: c.clientSecret });
  const out = await paymentOutcome({ base, token, paymentId: op.ozow_payment_id, since: op.created_at });
  if (!out) return op.status;
  const { data, error } = await admin.rpc('complete_online_payment', {
    p_reference: op.reference, p_status: out.status, p_transaction_id: out.transactionId,
    p_amount: out.amount, p_is_test: c.isTest, p_raw: out.raw,
  });
  if (error) throw error;
  return data;
}
