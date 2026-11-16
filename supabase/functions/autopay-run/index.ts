// Scheduled (hourly, GitHub Actions). Brings consents up to date, collects rent that is due on
// active mandates, records results, and passes tenant cancellations on to Ozow.
// Safe to expose: throttled in the database, only acts on what the database says is due, and
// returns counts only.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { chargeSubscription, newReference } from '../_shared/ozow.js';
import { debicheckBatch, uploadBatch, uploadReport, actionDate } from '../_shared/netcash.js';
import { ozowFor, refreshMandate, settleOzowCollection, cancelAtOzow, saDate } from '../_shared/autopay.js';
import { logEvent } from '../_shared/settle.js';
import { json } from '../_shared/http.js';

const env = (k: string) => Deno.env.get(k) ?? '';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'Use POST' });
  const admin = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
  const { data: claimed } = await admin.rpc('claim_job', { p_name: 'autopay', p_minutes: 20 });
  if (!claimed) return json(200, { skipped: true });
  const out = { consents: 0, cancelled: 0, started: 0, settled: 0, submitted: 0, failed: 0, errors: 0 };
  const safe = async (fn: () => Promise<unknown>, ref: Record<string, unknown>) => {
    try { await fn(); } catch (e) { out.errors++; await logEvent(admin, 'check_failed', ref, { error: String((e as Error).message), from: 'autopay' }); }
  };

  // 1. Pending Capitec consents
  const { data: pending } = await admin.from('payment_mandates').select('*').eq('status', 'pending').eq('provider', 'ozow_capitec');
  for (const m of pending ?? []) await safe(async () => { if ((await refreshMandate(admin, m)) !== 'pending') out.consents++; }, { reference: m.reference, landlord_id: m.landlord_id });

  // 2. Stops made in the app, passed on to Ozow
  const { data: stops } = await admin.from('payment_mandates').select('*').eq('status', 'cancelled').eq('provider', 'ozow_capitec').eq('provider_cancelled', false);
  for (const m of stops ?? []) await safe(async () => { if (await cancelAtOzow(admin, m)) out.cancelled++; }, { reference: m.reference, landlord_id: m.landlord_id });

  // 3. Results of collections already started
  const { data: open } = await admin.from('mandate_collections').select('*, mandate:payment_mandates(*)').in('status', ['pending', 'submitted']);
  const netcashOpen = new Map<string, any[]>();
  for (const c of open ?? []) {
    if (c.mandate.provider === 'ozow_capitec') await safe(async () => { const s = await settleOzowCollection(admin, c, c.mandate); if (s === 'successful') out.settled++; if (s === 'failed') out.failed++; }, { reference: c.reference, landlord_id: c.landlord_id });
    else if (c.last_detail?.fileToken && !c.last_detail?.reportChecked) (netcashOpen.get(c.landlord_id) ?? netcashOpen.set(c.landlord_id, []).get(c.landlord_id)!).push(c);
  }
  for (const [landlordId, cs] of netcashOpen) await safe(async () => {
    const { data: sec } = await admin.from('netcash_secrets').select('service_key').eq('landlord_id', landlordId).maybeSingle();
    if (!sec) return;
    const token = cs[0].last_detail.fileToken;
    const rep = await uploadReport({ serviceKey: sec.service_key, token });
    if (!rep) return;                                                       // not processed yet
    for (const c of cs) {
      const err = rep.errors.find((l: string) => l.includes(c.mandate.reference) || l.includes(c.reference));
      const failed = rep.result === 'unsuccessful' || !!err;
      await admin.from('mandate_collections').update({ status: failed ? 'failed' : 'submitted',
        last_detail: { ...c.last_detail, reportChecked: true, report: rep.result, error: err || null } }).eq('id', c.id);
      if (failed) { out.failed++; await logEvent(admin, 'autopay', { reference: c.reference, landlord_id: landlordId }, { note: 'Netcash rejected the debit order', line: err || rep.result }); }
    }
  }, { landlord_id: landlordId });

  // 4. New collections that are due today
  const { data: due } = await admin.rpc('collections_due', { p_today: saDate() });
  const netcashNew = new Map<string, any[]>();
  for (const d of due ?? []) {
    const { data: m } = await admin.from('payment_mandates').select('*').eq('id', d.mandate_id).single();
    const amount = Math.min(Number(d.amount), Number(m.max_amount));
    if (d.over_limit) await logEvent(admin, 'autopay', { reference: m.reference, landlord_id: m.landlord_id },
      { note: `Rent owed (R ${d.amount}) is more than the tenant's approved maximum (R ${m.max_amount}); collecting the maximum` }, false);
    const reference = 'AC' + newReference().slice(3);
    if (m.provider === 'ozow_capitec') await safe(async () => {
      const { data: op } = await admin.from('online_payments').insert({ kind: 'rent', landlord_id: m.landlord_id, payment_id: d.payment_id, amount, reference, is_test: m.is_test }).select('id').single();
      const { data: c } = await admin.from('mandate_collections').insert({ landlord_id: m.landlord_id, mandate_id: m.id, payment_id: d.payment_id, online_payment_id: op.id,
        period_month: d.period_month, attempt: d.attempt, amount, reference }).select('id').single();
      const o = await ozowFor(admin, m.landlord_id);
      if (!o?.enabled) { await admin.from('mandate_collections').update({ status: 'failed', last_detail: { error: 'Ozow not connected' } }).eq('id', c.id); out.failed++; return; }
      try {
        const r = await chargeSubscription({ base: o.base, token: o.token, id: m.external_id, amount, reference });
        await admin.from('mandate_collections').update({ external_id: r.id || r.transactionId || null, last_detail: r }).eq('id', c.id);
        out.started++;
      } catch (e) {
        await admin.from('mandate_collections').update({ status: 'failed', last_detail: { error: String((e as Error).message) } }).eq('id', c.id);
        await admin.from('online_payments').update({ status: 'error' }).eq('id', op.id);
        out.failed++;
        await logEvent(admin, 'autopay', { reference, landlord_id: m.landlord_id }, { note: 'Ozow refused the automatic collection', error: String((e as Error).message) });
      }
    }, { reference, landlord_id: m.landlord_id });
    else (netcashNew.get(m.landlord_id) ?? netcashNew.set(m.landlord_id, []).get(m.landlord_id)!).push({ d, m, amount, reference });
  }
  // DebiCheck: one batch per landlord. Results are confirmed when the money reaches the landlord's
  // Netcash statement; the landlord marks the month paid (rejections show up here automatically).
  for (const [landlordId, items] of netcashNew) await safe(async () => {
    const [{ data: sec }, { data: set }] = await Promise.all([
      admin.from('netcash_secrets').select('service_key').eq('landlord_id', landlordId).maybeSingle(),
      admin.from('autopay_settings').select('netcash').eq('landlord_id', landlordId).maybeSingle()]);
    if (!sec || !set?.netcash) return;
    const rows = [];
    for (const it of items) {
      const { data: c } = await admin.from('mandate_collections').insert({ landlord_id: landlordId, mandate_id: it.m.id, payment_id: it.d.payment_id,
        period_month: it.d.period_month, attempt: it.d.attempt, amount: it.amount, reference: it.reference }).select('id').single();
      rows.push({ id: c.id, accountRef: it.m.reference, mandateRef: it.m.external_id, amount: it.amount, ourRef: it.reference });
    }
    const date = actionDate(new Date());
    const file = debicheckBatch({ serviceKey: sec.service_key, batchName: `RTC Rentals rent ${saDate()}`, date, rows });
    try {
      const fileToken = await uploadBatch({ serviceKey: sec.service_key, file });
      for (const r of rows) await admin.from('mandate_collections').update({ status: 'submitted', last_detail: { fileToken, actionDate: date.toISOString().slice(0, 10) } }).eq('id', r.id);
      out.submitted += rows.length;
    } catch (e) {
      for (const r of rows) await admin.from('mandate_collections').update({ status: 'failed', last_detail: { error: String((e as Error).message) } }).eq('id', r.id);
      out.failed += rows.length;
      await logEvent(admin, 'autopay', { landlord_id: landlordId }, { note: 'Netcash batch upload failed', error: String((e as Error).message) });
    }
  }, { landlord_id: landlordId });

  return json(200, out);
});
