// Starts an Ozow payment and returns the signed form for the browser to post to Ozow.
//   { payment_id }  a tenant paying a month's rent to their landlord's own Ozow account
//   { invoice_id }  an owner paying Ryno-Tec's invoice to Ryno-Tec's Ozow account
// The private keys never leave the server.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { OZOW_PAY_URL, paymentRequest, newReference } from '../_shared/ozow.js';
import { SITE_URL, cors, json, fail } from '../_shared/http.js';

const env = (k: string) => Deno.env.get(k) ?? '';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return fail(405, 'Use POST');
  try {
    const auth = req.headers.get('Authorization') ?? '';
    const url = env('SUPABASE_URL');
    const asUser = createClient(url, env('SUPABASE_ANON_KEY'), { global: { headers: { Authorization: auth } } });
    const admin = createClient(url, env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
    const { data: { user } } = await asUser.auth.getUser();
    if (!user) return fail(401, 'Sign in again, then try once more.');
    const body = await req.json().catch(() => ({}));

    let kind: 'rent' | 'invoice', landlordId: string, amount: number, siteCode: string, privateKey: string, isTest: boolean;
    let paymentId: string | null = null, invoiceId: string | null = null, bankRef: string, page: string;

    if (body.payment_id) {
      // The tenant's own view decides whether they may see this month at all (row-level security).
      const { data: p } = await asUser.from('payments')
        .select('id, lease_id, landlord_id, amount_due, amount_paid, period_month').eq('id', body.payment_id).maybeSingle();
      if (!p) return fail(404, 'That rent month was not found.');
      const { data: lease } = await admin.from('leases')
        .select('tenant:tenants(user_id, full_name), unit:units(label)').eq('id', p.lease_id).single();
      if (lease?.tenant?.user_id !== user.id) return fail(403, 'Only the tenant on this lease can pay it online.');
      amount = Math.round((Number(p.amount_due) - Number(p.amount_paid)) * 100) / 100;
      if (!(amount > 0)) return fail(409, 'This month is already paid.');
      const [{ data: acct }, { data: secret }] = await Promise.all([
        admin.from('ozow_accounts').select('site_code, is_test, enabled').eq('landlord_id', p.landlord_id).maybeSingle(),
        admin.from('ozow_secrets').select('private_key').eq('landlord_id', p.landlord_id).maybeSingle(),
      ]);
      if (!acct?.enabled || !secret?.private_key) return fail(409, 'Your landlord hasn’t switched on online payments yet. Pay by EFT with your reference.');
      kind = 'rent'; landlordId = p.landlord_id; paymentId = p.id;
      siteCode = acct.site_code; privateKey = secret.private_key; isTest = acct.is_test;
      const surname = (lease.tenant.full_name || '').trim().split(/\s+/).pop() || 'RENT';
      bankRef = `${(lease.unit?.label || '').replace(/[^a-z0-9]/gi, '')}-${surname}`.toUpperCase();
      page = 'tenant.html';
    } else if (body.invoice_id) {
      const { data: inv } = await asUser.from('platform_invoices').select('id, landlord_id, number, total, status').eq('id', body.invoice_id).maybeSingle();
      if (!inv) return fail(404, 'That invoice was not found.');
      if (inv.status !== 'open') return fail(409, 'This invoice is already paid.');
      siteCode = env('RTC_OZOW_SITE_CODE'); privateKey = env('RTC_OZOW_PRIVATE_KEY');
      if (!siteCode || !privateKey) return fail(503, 'Paying invoices online isn’t switched on yet. Pay by EFT using the invoice number as the reference.');
      kind = 'invoice'; landlordId = inv.landlord_id; invoiceId = inv.id; amount = Number(inv.total);
      isTest = env('RTC_OZOW_IS_TEST') !== 'false'; bankRef = inv.number; page = 'billing.html';
    } else {
      return fail(400, 'Say what to pay.');
    }

    const reference = newReference();
    const { error } = await admin.from('online_payments').insert({
      kind, landlord_id: landlordId, payment_id: paymentId, invoice_id: invoiceId, amount, reference, is_test: isTest, started_by: user.id,
    });
    if (error) return fail(500, 'Couldn’t start the payment. Try again.');

    const back = (result: string) => `${SITE_URL}/${page}?ozow=${result}&ref=${reference}${kind === 'rent' ? '#payments' : ''}`;
    const fields = await paymentRequest({
      siteCode, privateKey, amount, reference, bankRef,
      cancelUrl: back('cancelled'), errorUrl: back('error'), successUrl: back('success'),
      notifyUrl: `${url}/functions/v1/ozow-notify`, isTest,
    });
    return json(200, { action: OZOW_PAY_URL, fields, reference, is_test: isTest });
  } catch (_e) {
    return fail(500, 'Something went wrong starting the payment. Try again.');
  }
});
