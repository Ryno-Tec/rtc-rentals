// The tenant (or landlord) asks how a Capitec Pay approval went; the answer comes from Ozow.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { refreshMandate } from '../_shared/autopay.js';
import { cors, json, fail } from '../_shared/http.js';

const env = (k: string) => Deno.env.get(k) ?? '';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return fail(405, 'Use POST');
  const asUser = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
  const admin = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
  const { mandate_id } = await req.json().catch(() => ({}));
  // Visible to the caller only if row-level security allows it (their own lease, or their account)
  const { data: mine } = await asUser.from('payment_mandates').select('id').eq('id', mandate_id).maybeSingle();
  if (!mine) return fail(404, 'Not found');
  const { data: m } = await admin.from('payment_mandates').select('*').eq('id', mandate_id).single();
  try { return json(200, { status: await refreshMandate(admin, m) }); }
  catch { return json(200, { status: m.status }); }
});
