// Owner: switch on online rent (their own Ozow account), and see / pay Ryno-Tec's invoices.
import { isDemo } from './data.js';
import { billingApi as api, feeFor } from './billing-data.js';
import { mountShell, esc, icon, toast, openModal, formData, confirmDialog } from './shell.js';
import { ozowReturn } from './ozow-client.js';

await mountShell('billing.html');
const view = document.getElementById('view');
const rand = n => { const v = Number(n) || 0, [w, c] = Math.abs(v).toFixed(2).split('.'); return `R ${w.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')},${c}`; };
const day = s => new Date(String(s).slice(0, 10) + 'T12:00').toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' });
const month = s => new Date(String(s).slice(0, 10) + 'T12:00').toLocaleDateString('en-ZA', { month: 'long', year: 'numeric' });
const pct = n => `${Number(n).toLocaleString('en-ZA', { maximumFractionDigits: 2 })}%`;
// Where owners pay Ryno-Tec's invoice by EFT if they prefer.
const RTC_BANK = { name: 'Ryno-Tec Consulting (Pty) Ltd', bank: 'Nedbank', account: '1351461826', branch: '198765' };
let d;

function ozowCard() {
  const o = d.ozow;
  const state = !o ? ['muted', 'Not connected'] : !o.enabled ? ['soon', 'Switched off'] : o.is_test ? ['info', 'Test mode'] : ['ok', 'Live'];
  return `
    <section class="card" aria-labelledby="oz-h">
      <div class="card-head"><h2 id="oz-h">Online rent payments</h2><span class="pill pill-${state[0]}" id="oz-state">${state[1]}</span></div>
      <div class="card-pad">
        <p style="margin-top:0">Tenants pay rent from their bank app through <b>Ozow</b>, straight into <b>your own</b> Ozow merchant account.
          Ryno-Tec never holds your rent. Payments show as paid here automatically, with a receipt for the tenant.</p>
        ${o ? `<dl class="kv">
            <div><dt>Site Code</dt><dd><code class="ref">${esc(o.site_code)}</code></dd></div>
            <div><dt>Private Key</dt><dd>Saved, ends in <code>${esc(o.key_hint || '····')}</code>. It can’t be viewed again.</dd></div>
            <div><dt>Mode</dt><dd>${o.is_test ? 'Test: no real money moves. Switch to live once Ozow approves your account.' : 'Live payments'}</dd></div>
          </dl>
          <div class="btn-row" style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn" type="button" data-action="ozow">Edit connection</button>
            <button class="btn btn-ghost" type="button" data-action="toggle">${o.enabled ? 'Switch off' : 'Switch on'}</button>
            <button class="btn btn-ghost" type="button" data-action="disconnect">Disconnect</button>
          </div>`
        : `<ol class="steps-list" style="padding-left:18px;margin:10px 0 14px;line-height:1.6">
            <li>Open a business account at <a href="https://ozow.com" target="_blank" rel="noopener">ozow.com</a> and finish their checks.</li>
            <li>In the Ozow merchant dashboard, open <b>Merchant details → Site settings</b> and copy your <b>Site Code</b>, <b>Private Key</b> and <b>API Key</b>.</li>
            <li>Paste them here. Start in test mode, pay one month as a test, then switch to live.</li>
          </ol>
          <button class="btn" type="button" data-action="ozow">${icon.plus}Connect Ozow</button>`}
        <p class="hint" style="margin:14px 0 0">Ozow charges you its own fee per payment (about 1.5%), taken from your Ozow payout.</p>
      </div>
    </section>`;
}

function planCard() {
  const s = d.settings, plan = d.plan, unbilled = d.fees.reduce((t, f) => t + Number(f.amount), 0);
  return `
    <section class="card" aria-labelledby="plan-h">
      <div class="card-head"><h2 id="plan-h">Your plan</h2><span class="pill pill-info">${esc(plan.display_name)}</span></div>
      <div class="card-pad">
        <dl class="kv">
          <div><dt>Subscription</dt><dd>${plan.price_zar == null ? 'Custom pricing' : `${rand(plan.price_zar)} a month`}</dd></div>
          <div><dt>Units included</dt><dd>${plan.max_units == null ? 'By agreement' : `Up to ${plan.max_units}`}</dd></div>
          <div><dt>Online rent fee</dt><dd>${pct(s.collection_fee_pct)} of each rent paid in the app, at most ${rand(s.collection_fee_max)} a payment
            <div class="muted" style="font-size:12.5px">e.g. ${rand(5000)} rent → ${rand(feeFor(5000, s))}; ${rand(20000)} rent → ${rand(feeFor(20000, s))}. EFT and cash payments are free.</div></dd></div>
          <div><dt>Fees so far</dt><dd id="unbilled">${rand(unbilled)} <span class="muted">on ${d.fees.length} ${d.fees.length === 1 ? 'payment' : 'payments'}, billed on your next invoice</span></dd></div>
        </dl>
        <p class="hint" style="margin:14px 0 0">To change plan, email <a href="mailto:rentals@ryno-tec.co.za">rentals@ryno-tec.co.za</a>.</p>
      </div>
    </section>`;
}

function invoicesCard() {
  const inv = d.invoices;
  return `
    <section class="card" aria-labelledby="inv-h" style="grid-column:1/-1">
      <div class="card-head"><h2 id="inv-h">Invoices from Ryno-Tec</h2></div>
      ${inv.length ? `<div class="table-wrap"><table class="t-table">
        <thead><tr><th>Invoice</th><th class="right hide-sm">Plan</th><th class="right hide-sm">Fees</th><th class="right">Total</th><th>Status</th><th></th></tr></thead>
        <tbody>${inv.map(i => {
          const late = i.status === 'open' && i.due_date < new Date().toISOString().slice(0, 10);
          const st = i.status === 'paid' ? ['ok', 'Paid'] : i.status === 'void' ? ['muted', 'Cancelled'] : late ? ['late', 'Overdue'] : ['soon', `Due ${day(i.due_date)}`];
          return `<tr>
            <td><div class="unit-label">${esc(i.number)}</div><div class="unit-sub">${month(i.period_month)}</div></td>
            <td class="right hide-sm num">${rand(i.subscription_amount)}</td>
            <td class="right hide-sm num">${rand(i.collection_fees)}</td>
            <td class="right num"><b>${rand(i.total)}</b></td>
            <td><span class="pill pill-${st[0]}">${st[1]}</span></td>
            <td class="actions">${i.status === 'open' ? `<button class="btn btn-sm" type="button" data-action="pay" data-id="${i.id}">Pay now</button>` : ''}</td>
          </tr>`;
        }).join('')}</tbody></table></div>
        <p class="hint card-pad" style="margin:0">Or pay by EFT: ${RTC_BANK.name}, ${RTC_BANK.bank}, account ${RTC_BANK.account}, branch ${RTC_BANK.branch}. Use the invoice number as the reference.</p>`
      : `<p class="card-pad muted" style="margin:0">No invoices yet. Your first one comes on the 1st of next month.</p>`}
    </section>`;
}

function render() {
  view.innerHTML = `<div class="billing-grid">${ozowCard()}${planCard()}${invoicesCard()}</div>`;
}

async function refresh() {
  try { d = await api.overview(); render(); }
  catch (ex) { view.innerHTML = `<div class="card card-pad"><p class="muted">${esc(ex.message)}</p></div>`; }
}

function connectForm() {
  const o = d.ozow;
  openModal({
    title: o ? 'Edit Ozow connection' : 'Connect Ozow', submitLabel: 'Save',
    body: `
      <div class="field"><label for="oz-site">Site Code</label><input id="oz-site" name="site_code" required maxlength="50" autocomplete="off" value="${esc(o?.site_code || '')}" placeholder="e.g. ABC-ABC-001"></div>
      <div class="field"><label for="oz-key">Private Key${o ? ' <span class="muted">(leave empty to keep the saved one)</span>' : ''}</label>
        <input id="oz-key" name="private_key" type="password" autocomplete="off" spellcheck="false" ${o ? '' : 'required'}></div>
      <div class="field"><label for="oz-api">API Key <span class="muted">(optional)</span></label>
        <input id="oz-api" name="api_key" type="password" autocomplete="off" spellcheck="false"></div>
      <label class="check"><input type="checkbox" name="is_test" ${!o || o.is_test ? 'checked' : ''}> Test mode (no real money moves)</label>
      <p class="hint" style="margin:12px 0 0">The keys are stored on the server and only used to sign payments. Nobody, including you, can view them here again.</p>`,
    async onSubmit(form) {
      const v = formData(form);
      await api.saveOzow({ ...v, enabled: o ? o.enabled : true });
      toast(v.is_test ? 'Ozow connected in test mode' : 'Ozow connected. Tenants can pay online.');
      await refresh();
    },
  });
}

view.addEventListener('click', async e => {
  const a = e.target.closest('[data-action]');
  if (!a) return;
  const { action, id } = a.dataset;
  try {
    if (action === 'ozow') connectForm();
    if (action === 'toggle') {
      await api.saveOzow({ site_code: d.ozow.site_code, is_test: d.ozow.is_test, enabled: !d.ozow.enabled });
      toast(d.ozow.enabled ? 'Online payments switched off' : 'Online payments switched on'); await refresh();
    }
    if (action === 'disconnect' && await confirmDialog('Disconnect Ozow?', 'Your saved keys are deleted. Tenants go back to paying by EFT.', 'Disconnect')) {
      await api.removeOzow(); toast('Ozow disconnected'); await refresh();
    }
    if (action === 'pay') {
      const inv = d.invoices.find(i => i.id === id);
      openModal({
        title: `Pay ${inv.number}`, submitLabel: `Pay ${rand(inv.total)} with Ozow`,
        body: `<dl class="kv"><div><dt>Amount</dt><dd class="num"><b>${rand(inv.total)}</b></dd></div><div><dt>To</dt><dd>Ryno-Tec Consulting (Pty) Ltd</dd></div>
          <div><dt>For</dt><dd>${month(inv.period_month)}</dd></div></dl>${isDemo() ? '<p class="muted"><b>In the demo nothing is charged.</b></p>' : ''}`,
        async onSubmit(form) {
          const r = await api.payInvoice(id);
          if (r?.redirecting) { form.querySelector('[type=submit]').textContent = 'Opening Ozow…'; return false; }
          toast('Invoice paid. Thank you!'); await refresh();
        },
      });
    }
  } catch (ex) { toast(ex.message, 'error'); }
});

const back = ozowReturn();
await refresh();
if (back === 'success') {
  toast('Thank you! The payment is being confirmed.');
  setTimeout(refresh, 5000); setTimeout(refresh, 12000);
} else if (back === 'cancelled') toast('Payment cancelled. Nothing was charged.');
else if (back === 'error') toast('The bank couldn’t complete the payment. Try again or pay by EFT.', 'error');
