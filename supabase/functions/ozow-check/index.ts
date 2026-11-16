// The browser asks this after coming back from Ozow: "how did my payment go?" The answer comes
// from Ozow's API, never from the address bar. Only the person who started the payment can ask.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { settle } from '../_shared/settle.js';
import { cors, json, fail } from '../_shared/http.js';

const env = (k: string) => Deno.env.get(k) ?? '';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return fail(405, 'Use POST');
  const asUser = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
  const { data: { user } } = await asUser.auth.getUser();
  if (!user) return fail(401, 'Sign in again.');
  const { reference } = await req.json().catch(() => ({}));
  if (!reference) return fail(400, 'Missing reference');
  const admin = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
  const { data: op } = await admin.from('online_payments').select('*').eq('reference', reference).maybeSingle();
  if (!op || op.started_by !== user.id) return fail(404, 'Payment not found');
  try { return json(200, { status: await settle(admin, op) }); }
  catch { return json(200, { status: op.status, pending: true }); }
});
