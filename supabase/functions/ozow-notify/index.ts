// Ozow's notification that a payment finished. Public (Ozow calls it), so nothing is trusted until
// Ozow's signature checks out with the right private key; then the rent month (or invoice) is marked
// paid and Ryno-Tec's collection fee is recorded. Repeated notifications change nothing.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { verifyResponse } from '../_shared/ozow.js';

const env = (k: string) => Deno.env.get(k) ?? '';
const ok = (text = 'OK', status = 200) => new Response(text, { status, headers: { 'Content-Type': 'text/plain' } });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return ok('Use POST', 405);
  const params: Record<string, string> = {};
  try {
    const type = req.headers.get('content-type') ?? '';
    if (type.includes('application/json')) Object.assign(params, await req.json());
    else for (const [k, v] of (await req.formData()).entries()) params[k] = String(v);
  } catch { return ok('Unreadable body', 400); }
  const reference = params.TransactionReference;
  if (!reference) return ok('Missing reference', 400);

  const admin = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
  const { data: op } = await admin.from('online_payments').select('id, kind, landlord_id').eq('reference', reference).maybeSingle();
  if (!op) return ok('Unknown reference', 404);

  let siteCode = '', privateKey = '';
  if (op.kind === 'invoice') { siteCode = env('RTC_OZOW_SITE_CODE'); privateKey = env('RTC_OZOW_PRIVATE_KEY'); }
  else {
    const [{ data: acct }, { data: secret }] = await Promise.all([
      admin.from('ozow_accounts').select('site_code').eq('landlord_id', op.landlord_id).maybeSingle(),
      admin.from('ozow_secrets').select('private_key').eq('landlord_id', op.landlord_id).maybeSingle(),
    ]);
    siteCode = acct?.site_code ?? ''; privateKey = secret?.private_key ?? '';
  }
  if (!privateKey || (params.SiteCode ?? '').toLowerCase() !== siteCode.toLowerCase()) return ok('Wrong site', 400);
  if (!(await verifyResponse(params, privateKey))) return ok('Bad signature', 400);

  const { Hash: _h, ...raw } = params;
  const { error } = await admin.rpc('complete_online_payment', {
    p_reference: reference, p_status: params.Status, p_transaction_id: params.TransactionId ?? null,
    p_amount: Number(params.Amount), p_is_test: String(params.IsTest).toLowerCase() === 'true', p_raw: raw,
  });
  if (error) return ok('Not recorded', 500);   // Ozow retries
  return ok();
});
