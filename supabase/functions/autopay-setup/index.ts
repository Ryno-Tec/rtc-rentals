// Tenant: set up automatic rent with Capitec Pay (through the landlord's own Ozow account).
// Returns Ozow's consent page; the tenant approves in the Capitec app within 3 minutes.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { createSubscription, subscriptionBody, newReference, OzowError } from '../_shared/ozow.js';
import { ozowFor, saDate } from '../_shared/autopay.js';
import { cors, json, fail } from '../_shared/http.js';

const env = (k: string) => Deno.env.get(k) ?? '';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return fail(405, 'Use POST');
  const url = env('SUPABASE_URL');
  const asUser = createClient(url, env('SUPABASE_ANON_KEY'), { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
  const admin = createClient(url, env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
  const { data: { user } } = await asUser.auth.getUser();
  if (!user) return fail(401, 'Sign in again.');
  const body = await req.json().catch(() => ({}));
  const max = Number(body.max_amount);

  // The tenant's own live lease (row-level security decides what they can see)
  const { data: lease } = await asUser.from('leases').select('id, landlord_id, monthly_rent, start_date, escalation_type, escalation_pct, escalation_amount, unit:units(label), tenant:tenants(full_name, user_id)')
    .in('status', ['signed', 'active']).eq('id', body.lease_id).maybeSingle();
  if (!lease || lease.tenant?.user_id !== user.id) return fail(404, 'Lease not found.');
  const { data: opts } = await asUser.rpc('tenant_autopay_options');
  if (!opts?.[0]?.ozow_capitec) return fail(409, 'Your landlord hasn’t switched on automatic payments.');
  const { data: rent } = await admin.rpc('lease_rent', { p_lease: lease.id, p_month: saDate().slice(0, 7) + '-01' });
  const current = Number(rent) || Number(lease.monthly_rent);
  if (!(max >= current) || max > 100000) return fail(400, `Choose a maximum of at least your rent (R ${current.toFixed(2)}).`);
  const { data: live } = await admin.from('payment_mandates').select('id').eq('lease_id', lease.id).in('status', ['pending', 'active']).maybeSingle();
  if (live) return fail(409, 'Automatic payments are already set up or waiting for approval.');

  const o = await ozowFor(admin, lease.landlord_id).catch(() => null);
  if (!o?.enabled) return fail(409, 'Your landlord’s Ozow connection isn’t working right now.');
  const reference = 'AP' + newReference().slice(3);
  const { data: m, error } = await admin.from('payment_mandates').insert({ landlord_id: lease.landlord_id, lease_id: lease.id, provider: 'ozow_capitec',
    max_amount: Math.ceil(max), reference, is_test: o.isTest, created_by: user.id }).select('id').single();
  if (error) return fail(409, 'Automatic payments are already set up or waiting for approval.');
  try {
    const surname = (lease.tenant.full_name || '').trim().split(/\s+/).pop() || 'RENT';
    const sub = await createSubscription({ base: o.base, token: o.token, body: subscriptionBody({
      siteCode: o.siteCode, amount: current, maxAmount: max, reference, bankRef: `${lease.unit?.label || ''}${surname}`,
      description: `Rent ${lease.unit?.label || ''}`, firstPaymentDate: saDate() }) });
    await admin.from('payment_mandates').update({ external_id: sub.id, last_detail: { status: sub.status } }).eq('id', m.id);
    return json(200, { mandate_id: m.id, redirectUrl: sub.redirectUrl });
  } catch (e) {
    await admin.from('payment_mandates').update({ status: 'failed', last_detail: { error: String((e as Error).message) } }).eq('id', m.id);
    return fail(502, e instanceof OzowError && e.status === 403
      ? 'Automatic payments aren’t enabled on your landlord’s Ozow account yet.' : 'Ozow didn’t accept the request. Try again in a minute.');
  }
});
