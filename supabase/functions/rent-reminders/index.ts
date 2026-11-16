// Scheduled (daily 07:05 SA time). Emails tenants 3 days before rent is due, on the day, and
// 1 and 7 days late. Uses Brevo's transactional email API (secret BREVO_API_KEY); without the key
// nothing is sent. Each reminder is sent once.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { saDate } from '../_shared/autopay.js';
import { SITE_URL, json } from '../_shared/http.js';
import { logEvent } from '../_shared/settle.js';

const env = (k: string) => Deno.env.get(k) ?? '';
const rand = (n: number) => 'R ' + Number(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ' ').replace('.', ',');
const esc = (s: string) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const day = (d: string) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-ZA', { weekday: 'long', day: 'numeric', month: 'long' });

function message(r: any) {
  const when = { before: `is due on ${day(r.due_date)}`, due: 'is due today', late_1: 'was due yesterday', late_7: `was due on ${day(r.due_date)} and is a week late` }[r.kind as string];
  const subject = r.kind.startsWith('late') ? `Rent for ${r.unit_label} is overdue` : `Rent reminder: ${rand(r.amount)} ${r.kind === 'due' ? 'due today' : 'due soon'}`;
  const auto = r.autopay && !r.kind.startsWith('late');
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#222;line-height:1.5;max-width:520px">
<p>Hi ${esc(r.tenant_name.split(' ')[0])},</p>
<p>Your rent of <b>${rand(r.amount)}</b> for <b>${esc(r.unit_label)}</b> ${when}.</p>
${auto ? '<p>You’re on automatic payments, so it will be collected on the due date. Nothing to do.</p>'
  : `<p><a href="${SITE_URL}/tenant.html#payments" style="display:inline-block;background:#ff6b35;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:bold">Pay now</a></p>
<p>Or pay by EFT with reference <b>${esc(r.reference)}</b>. If you’ve already paid, thank you, and please ignore this.</p>`}
<p style="color:#888;font-size:12px">Sent by RTC Rentals for ${esc(r.landlord_name)}. Questions about your rent? Message your landlord in the app.</p></div>`;
  return { subject, html };
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'Use POST' });
  const key = env('BREVO_API_KEY');
  if (!key) return json(200, { skipped: 'BREVO_API_KEY not set' });
  const admin = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
  const { data: claimed } = await admin.rpc('claim_job', { p_name: 'reminders', p_minutes: 600 });
  if (!claimed) return json(200, { skipped: true });
  const { data: due } = await admin.rpc('reminders_due', { p_today: saDate() });
  let sent = 0, failed = 0;
  for (const r of due ?? []) {
    const { subject, html } = message(r);
    const res = await fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST',
      headers: { 'api-key': key, 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sender: { name: 'RTC Rentals', email: 'rentals@ryno-tec.co.za' }, to: [{ email: r.tenant_email, name: r.tenant_name }], subject, htmlContent: html }) });
    if (res.ok) { await admin.from('rent_reminders').insert({ payment_id: r.payment_id, kind: r.kind }); sent++; }
    else { failed++; await logEvent(admin, 'reminder', {}, { status: res.status, kind: r.kind }, false); }
  }
  return json(200, { sent, failed });
});
