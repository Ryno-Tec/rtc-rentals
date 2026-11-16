// Shared by the auto-pay server functions.
import { ozowBase, getToken, getSubscription, subscriptionTransactions, cancelSubscription } from './ozow.js';
import { credentialsFor, logEvent } from './settle.js';

export const saDate = (d = new Date()) => new Date(d.getTime() + 2 * 3600e3).toISOString().slice(0, 10);   // Africa/Johannesburg

export async function ozowFor(admin, landlordId) {
  const c = await credentialsFor(admin, 'rent', landlordId);
  if (!c) return null;
  const base = ozowBase(c.isTest);
  return { ...c, base, token: await getToken({ base, clientId: c.clientId, clientSecret: c.clientSecret, scope: 'subscriptions' }) };
}

// Bring a pending Ozow consent up to date. Returns the mandate's status.
export async function refreshMandate(admin, m) {
  if (m.provider !== 'ozow_capitec' || m.status !== 'pending' || !m.external_id) return m.status;
  const o = await ozowFor(admin, m.landlord_id);
  if (!o) return m.status;
  const s = await getSubscription({ base: o.base, token: o.token, id: m.external_id });
  if (!s.mapped || s.mapped === 'pending') {
    if (Date.now() - new Date(m.created_at).getTime() > 15 * 60e3) {           // approval window is 3 minutes
      await admin.from('payment_mandates').update({ status: 'expired', last_detail: s }).eq('id', m.id).eq('status', 'pending');
      return 'expired';
    }
    return 'pending';
  }
  await admin.from('payment_mandates').update({ status: s.mapped, last_detail: s,
    ...(s.mapped === 'active' ? { activated_at: new Date().toISOString() } : {}),
    ...(s.mapped === 'cancelled' ? { cancelled_at: new Date().toISOString(), provider_cancelled: true } : {}) }).eq('id', m.id).eq('status', 'pending');
  return s.mapped;
}

// A collection Ozow has finished: record it on the rent ledger through the same checked path as Pay now.
export async function settleOzowCollection(admin, c, m) {
  const o = await ozowFor(admin, m.landlord_id);
  if (!o) return c.status;
  const list = await subscriptionTransactions({ base: o.base, token: o.token, id: m.external_id });
  const t = list.find(x => x.merchantReference === c.reference);
  if (!t) return c.status;
  const st = String(t.status || '').toLowerCase();
  if (st === 'pending') return 'pending';
  const ok = st === 'successful';
  const amt = Number(t.amount?.value ?? t.amount);
  if (ok && Math.round(amt * 100) !== Math.round(Number(c.amount) * 100)) {
    await logEvent(admin, 'mismatch', { reference: c.reference, landlord_id: m.landlord_id }, { problems: [`amount ${amt} (expected ${c.amount})`], transaction: t });
  }
  await admin.rpc('complete_online_payment', { p_reference: c.reference, p_status: ok ? 'Complete' : 'Error', p_transaction_id: t.id || null,
    p_amount: amt, p_is_test: o.isTest, p_raw: t });
  const status = ok ? 'successful' : 'failed';
  await admin.from('mandate_collections').update({ status, external_id: t.id || null, completed_at: new Date().toISOString(), last_detail: t }).eq('id', c.id);
  if (!ok) await logEvent(admin, 'autopay', { reference: c.reference, landlord_id: m.landlord_id }, { note: 'Automatic collection failed', reason: t.reason || null }, false);
  return status;
}

export async function cancelAtOzow(admin, m) {
  const o = await ozowFor(admin, m.landlord_id);
  if (!o || !m.external_id) return false;
  try { await cancelSubscription({ base: o.base, token: o.token, id: m.external_id }); }
  catch (e) { if (!/cancel|404/i.test(String(e.message)) && e.status !== 404) throw e; }
  await admin.from('payment_mandates').update({ provider_cancelled: true }).eq('id', m.id);
  return true;
}
