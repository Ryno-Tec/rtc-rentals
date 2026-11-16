// Ozow's notification that something happened on a payment. Public (Ozow calls it), so the body is
// only used to find the payment: the outcome itself is fetched from Ozow's API with our own
// credentials. Repeated notifications change nothing.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { settle } from '../_shared/settle.js';

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
  if (!op) return ok('Unknown reference', 404);
  try { await settle(admin, op); } catch { return ok('Not recorded', 500); }   // Ozow retries
  return ok();
});
