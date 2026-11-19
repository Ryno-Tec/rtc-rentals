// Totals for Khaphela, Ryno-Tec's monitoring assistant (see 018_ops_health.sql).
// Needs the public anon key AND the x-khaphela-key header matching the KHAPHELA_KEY secret.
// Returns counts and totals only: no names, emails or payment references.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { json, fail } from '../_shared/http.js';

const env = (k: string) => Deno.env.get(k) ?? '';

async function same(a: string, b: string) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([a, b].map(s => crypto.subtle.digest('SHA-256', enc.encode(s))));
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let d = 0; for (let i = 0; i < u.length; i++) d |= u[i] ^ v[i];
  return d === 0;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return fail(405, 'Use POST');
  const key = env('KHAPHELA_KEY');
  if (key.length < 32 || !(await same(req.headers.get('x-khaphela-key') ?? '', key))) return fail(401, 'Not allowed');
  const admin = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
  const { data, error } = await admin.rpc('ops_health');
  if (error) return fail(500, 'Health query failed: ' + error.message);
  return json(200, data);
});
