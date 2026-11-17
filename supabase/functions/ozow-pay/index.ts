// Starts an Ozow payment (One API) and returns Ozow's payment page address for the browser.
//   { payment_id }  a tenant paying a month's rent to their landlord's own Ozow account
//   { invoice_id }  an owner paying Ryno-Tec's invoice to Ryno-Tec's Ozow account
// The Client Secrets never leave the server.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { ozowBase, getToken, paymentBody, createPayment, newReference, OzowError, classicFields, classicCreate } from '../_shared/ozow.js';
import { credentialsFor } from '../_shared/settle.js';
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

    let kind: 'rent' | 'invoice' = 'rent', landlordId = '', amount = 0, bankRef = '', page = 'tenant.html';
    let paymentId: string | null = null, invoiceId: string | null = null;
    let creds: Awaited<ReturnType<typeof credentialsFor>> = null;

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
      creds = await credentialsFor(admin, 'rent', p.landlord_id);
      if (!creds?.enabled) return fail(409, 'Your landlord hasn’t switched on online payments yet. Pay by EFT with your reference.');
      kind = 'rent'; landlordId = p.landlord_id; paymentId = p.id;
      const surname = (lease.tenant.full_name || '').trim().split(/\s+/).pop() || 'RENT';
      bankRef = `${lease.unit?.label || ''}${surname}`;
      page = 'tenant.html';
    } else if (body.invoice_id) {
      const { data: inv } = await asUser.from('platform_invoices').select('id, landlord_id, number, total, status').eq('id', body.invoice_id).maybeSingle();
      if (!inv) return fail(404, 'That invoice was not found.');
      if (inv.status !== 'open') return fail(409, 'This invoice is already paid.');
      creds = await credentialsFor(admin, 'invoice', inv.landlord_id);
      if (!creds) return fail(503, 'Paying invoices online isn’t switched on yet. Pay by EFT using the invoice number as the reference.');
      kind = 'invoice'; landlordId = inv.landlord_id; invoiceId = inv.id; amount = Number(inv.total);
      bankRef = inv.number; page = 'billing.html';
    } else {
      return fail(400, 'Say what to pay.');
    }

    const reference = newReference();
    const { data: op, error } = await admin.from('online_payments').insert({
      kind, landlord_id: landlordId, payment_id: paymentId, invoice_id: invoiceId, amount, reference, is_test: creds!.isTest, started_by: user.id,
    }).select('id').single();
    if (error) return fail(500, 'Couldn’t start the payment. Try again.');

    const returnUrl = `${SITE_URL}/${page}?ozow=back&ref=${reference}${kind === 'rent' ? '#payments' : ''}`;
    const notifyUrl = `${url}/functions/v1/ozow-notify`;
    try {
      let pay: { id: string; redirectUrl: string };
      if (creds!.method === 'classic') {
        // Private Key + API Key: signed request created server-side; Ozow returns the payment page address.
        const fields = await classicFields({ siteCode: creds!.siteCode, privateKey: creds!.privateKey, amount, reference, bankRef,
          cancelUrl: returnUrl, errorUrl: returnUrl, successUrl: returnUrl, notifyUrl, isTest: creds!.isTest });
        pay = await classicCreate({ apiKey: creds!.apiKey, fields });
      } else {
        const base = ozowBase(creds!.isTest);
        const token = await getToken({ base, clientId: creds!.clientId, clientSecret: creds!.clientSecret });
        pay = await createPayment({ base, token, body: paymentBody({ siteCode: creds!.siteCode, amount, reference, bankRef, returnUrl, notifyUrl }) });
      }
      await admin.from('online_payments').update({ ozow_payment_id: pay.id }).eq('id', op.id);
      return json(200, { redirectUrl: pay.redirectUrl, reference, is_test: creds!.isTest });
    } catch (e) {
      await admin.from('online_payments').update({ status: 'error', last_notification: { error: String((e as Error).message) } }).eq('id', op.id);
      const who = kind === 'rent' ? 'Your landlord’s Ozow connection' : 'Online invoice payment';
      return fail(502, e instanceof OzowError && (e.status === 400 || e.status === 401)
        ? `${who} isn’t working right now. Pay by EFT for now.` : 'Ozow didn’t answer. Try again in a minute.');
    }
  } catch (_e) {
    return fail(500, 'Something went wrong starting the payment. Try again.');
  }
});
