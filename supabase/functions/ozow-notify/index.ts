// Ozow's notification that something happened on a payment. Public (Ozow calls it), so the body is
// only used to find the payment (and, for Private Key accounts, to check Ozow's signature): the outcome itself is fetched from Ozow's API with our own
// credentials. Repeated notifications change nothing.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { settle, logEvent, credentialsFor } from '../_shared/settle.js';
import { verifyResponse } from '../_shared/ozow.js';

const env = (k: string) => Deno.env.get(k) ?? '';
const ok = (text = 'OK', status = 200) => new Response(text, { status, headers: { 'Content-Type': 'text/plain' } });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return ok('Use POST', 405);
  const p: Record<string, unknown> = {};
  try {
    const type = req.headers.get('content-type') ?? '';
    if (type.includes('application/json')) Object.assign(p, await req.json());
    else for (const [k, v] of (await req.formData()).entries()) p[k] = String(v);
  } catch { return ok('Unreadable body', 400); }
  const reference = String(p.TransactionReference ?? p.merchantReference ?? (p.data as Record<string, unknown>)?.merchantReference ?? '');
  if (!reference) return ok('Missing reference', 400);

  const admin = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
  const { data: op } = await admin.from('online_payments').select('*').eq('reference', reference).maybeSingle();
  if (!op) { await logEvent(admin, 'unknown_reference', { reference }, { from: 'notify' }); return ok('Unknown reference', 404); }
  // Private Key accounts sign their notifications. A bad signature is logged as an alert; the payment is
  // still checked against Ozow's own record below, which is what decides the outcome either way.
  if (p.Hash) {
    const c = await credentialsFor(admin, op.kind, op.landlord_id).catch(() => null);
    if (c?.method === 'classic' && !(await verifyResponse(p, c.privateKey)))
      await logEvent(admin, 'bad_signature', op, { from: 'notify', note: 'Notification signature did not match the Private Key' });
  }
  try { await settle(admin, op); } catch { return ok('Not recorded', 500); }   // Ozow retries
  return ok();
});
