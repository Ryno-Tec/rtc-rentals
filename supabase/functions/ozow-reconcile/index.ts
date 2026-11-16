// Scheduled reconciliation with Ozow (GitHub Actions calls it hourly, and once a day with full=true).
//   hourly: payments still open (started / pending) are re-checked, so a lost notification can't
//           leave a tenant's payment hanging; expired ones are closed.
//   daily:  every payment recorded as complete in the last 35 days is checked against Ozow.
// Safe to expose: it only re-reads Ozow, is throttled in the database, and returns counts only.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { settle, verifyComplete } from '../_shared/settle.js';
import { json } from '../_shared/http.js';

const env = (k: string) => Deno.env.get(k) ?? '';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'Use POST' });
  const { full = false } = await req.json().catch(() => ({}));
  const admin = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
  const started = new Date().toISOString();
  const { data: claimed } = await admin.rpc('claim_reconcile', { p_full: Boolean(full), p_minutes: full ? 600 : 20 });
  if (!claimed) return json(200, { skipped: true });

  let checked = 0, failed = 0;
  const since = new Date(Date.now() - (full ? 35 : 7) * 864e5).toISOString();
  const statuses = full ? ['complete'] : ['started', 'pending'];
  const { data: ops } = await admin.from('online_payments').select('*')
    .in('status', statuses).not('ozow_payment_id', 'is', null).gte('created_at', since).limit(500);
  for (const op of ops ?? []) {
    checked++;
    try { full ? await verifyComplete(admin, op) : await settle(admin, op); } catch { failed++; }
  }
  const { count } = await admin.from('payment_events').select('id', { count: 'exact', head: true }).eq('alert', true).gte('at', started);
  return json(200, { full: Boolean(full), checked, failed, alerts: count ?? 0 });
});
