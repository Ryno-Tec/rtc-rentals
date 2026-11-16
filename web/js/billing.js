// Owner: switch on online rent (their own Ozow account), and see / pay Ryno-Tec's invoices.
import { isDemo, TIERS } from './data.js';
import { billingApi as api, feeFor } from './billing-data.js';
import { mountShell, esc, icon, toast, openModal, formData, confirmDialog } from './shell.js';
import { ozowReturn, checkOzow, OZOW_RESULT } from './ozow-client.js';

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
  const state = !o ? ['muted', 'Not connected'] : !o.enabled ? ['soon', 'Switched off'] : o.is_test ? ['info', 'Test (Ozow staging)'] : ['ok', 'Live'];
  return `
    <section class="card" aria-labelledby="oz-h">
      <div class="card-head"><h2 id="oz-h">Online rent payments</h2><span class="pill pill-${state[0]}" id="oz-state">${state[1]}</span></div>
      <div class="card-pad">
        <p style="margin-top:0">Tenants pay rent from their bank app through <b>Ozow</b>, straight into <b>your own</b> Ozow merchant account.
          Ryno-Tec never holds your rent. Payments show as paid here automatically, with a receipt for the tenant.</p>
        ${o ? `<dl class="kv">
            <div><dt>Site Code</dt><dd><code class="ref">${esc(o.site_code)}</code></dd></div>
            <div><dt>Client Secret</dt><dd>Saved, ends in <code>${esc(o.key_hint || '····')}</code>. It can’t be viewed again.</dd></div>
            <div><dt>Mode</dt><dd>${o.is_test ? 'Test: Ozow’s staging system, no real money moves.' : 'Live payments'}</dd></div>
          </dl>
          <div class="btn-row" style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn" type="button" data-action="ozow">Edit connection</button>
            <button class="btn btn-ghost" type="button" data-action="toggle">${o.enabled ? 'Switch off' : 'Switch on'}</button>
            <button class="btn btn-ghost" type="button" data-action="disconnect">Disconnect</button>
          </div>`
        : `<ol class="steps-list" style="padding-left:18px;margin:10px 0 14px;line-height:1.6">
            <li>Open a business account at <a href="https://ozow.com" target="_blank" rel="noopener">ozow.com</a> and finish their checks.</li>
            <li>In the Ozow dashboard, copy your <b>Site Code</b> (under <b>Sites</b>), then the <b>Client ID</b> and <b>Client Secret</b> (under <b>One API Clients</b>).</li>
            <li>Paste them here. Your first tenant payment is the real test: start with a small amount if you want to be sure.</li>
          </ol>
          <button class="btn" type="button" data-action="ozow">${icon.plus}Connect Ozow</button>`}
        <p class="hint" style="margin:14px 0 0">Ozow charges you its own fee per payment, taken from your Ozow payout.</p>
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
          <div><dt>Units included</dt><dd>${plan.max_units == null ? 'By agreement' : `Up to ${plan.max_units}`} <span class="muted">· you use ${d.usage.units}</span></dd></div>
          <div><dt>Online rent fee</dt><dd>${pct(s.collection_fee_pct)} of each rent paid in the app, at most ${rand(s.collection_fee_max)} a payment
            <div class="muted" style="font-size:12.5px">e.g. ${rand(5000)} rent → ${rand(feeFor(5000, s))}; ${rand(20000)} rent → ${rand(feeFor(20000, s))}. EFT and cash payments are free.</div></dd></div>
          <div><dt>Fees so far</dt><dd id="unbilled">${rand(unbilled)} <span class="muted">on ${d.fees.length} ${d.fees.length === 1 ? 'payment' : 'payments'}, billed on your next invoice</span></dd></div>
        </dl>
        ${plan.price_zar != null && d.tier !== 'agency' ? `<button class="btn" type="button" data-action="plan" style="margin-top:14px">Change plan</button>`
          : `<p class="hint" style="margin:14px 0 0">Your plan is managed by Ryno-Tec. Email <a href="mailto:rentals@ryno-tec.co.za">rentals@ryno-tec.co.za</a> to change it.</p>`}
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

function planForm() {
  const cur = TIERS[d.tier];
  const opts = Object.entries(TIERS).map(([k, t]) => {
    const custom = t.price_zar == null, here = k === d.tier;
    const tooSmall = !custom && t.max_units != null && (d.usage.units > t.max_units || d.usage.properties > t.max_properties);
    return `<label class="plan-opt ${here ? 'is-current' : ''} ${tooSmall || custom ? 'is-off' : ''}">
      <input type="radio" name="tier" value="${k}" ${here ? 'checked' : ''} ${tooSmall || custom ? 'disabled' : ''}>
      <span class="plan-name">${esc(t.display_name)}${here ? ' <span class="pill pill-info">Current</span>' : ''}</span>
      <span class="plan-price">${custom ? 'Custom' : `${rand(t.price_zar)}/month`}</span>
      <span class="plan-limit muted">${custom ? 'Email rentals@ryno-tec.co.za' : `Up to ${t.max_units} units, ${t.max_properties} properties`}${tooSmall ? ' · too small for your units' : ''}</span>
    </label>`;
  }).join('');
  openModal({
    title: 'Change plan', submitLabel: 'Change plan',
    body: `<div class="plan-opts">${opts}</div>
      <ul class="hint" style="margin:14px 0 0;padding-left:18px;line-height:1.55">
        <li>Upgrades work straight away.</li>
        <li>Each month is billed at the highest plan you had during it, so a change mid-month never lowers that month’s invoice.</li>
        <li>Moving to a smaller plan needs your units to fit it and no overdue invoice.</li></ul>`,
    async onSubmit(form) {
      const tier = form.querySelector('input[name=tier]:checked')?.value;
      if (!tier || tier === d.tier) return;
      await api.changePlan(tier);
      toast(`You’re now on ${TIERS[tier].display_name}${TIERS[tier].price_zar > cur.price_zar ? '' : ' from today'}`);
      await refresh();
    },
  });
}

function connectForm() {
  const o = d.ozow;
  openModal({
    title: o ? 'Edit Ozow connection' : 'Connect Ozow', submitLabel: 'Save',
    body: `
      <div class="field"><label for="oz-site">Site Code <span class="muted">(Ozow dashboard → Sites)</span></label><input id="oz-site" name="site_code" required maxlength="50" autocomplete="off" value="${esc(o?.site_code || '')}" placeholder="e.g. ABC-ABC-001"></div>
      <div class="field"><label for="oz-id">Client ID <span class="muted">(One API Clients)</span>${o ? ' <span class="muted">— leave empty to keep</span>' : ''}</label>
        <input id="oz-id" name="client_id" autocomplete="off" spellcheck="false" ${o ? '' : 'required'}></div>
      <div class="field"><label for="oz-secret">Client Secret${o ? ' <span class="muted">— leave empty to keep</span>' : ''}</label>
        <input id="oz-secret" name="client_secret" type="password" autocomplete="off" spellcheck="false" ${o ? '' : 'required'}></div>
      <label class="check"><input type="checkbox" name="is_test" ${o?.is_test ? 'checked' : ''}> These are Ozow <b>staging</b> (test) credentials</label>
      <p class="hint" style="margin:12px 0 0">Stored on the server and only used to create payments with Ozow. Nobody, including you, can view the secret here again.</p>`,
    async onSubmit(form) {
      const v = formData(form);
      await api.saveOzow({ ...v, enabled: o ? o.enabled : true });
      toast(v.is_test ? 'Ozow connected to staging (test)' : 'Ozow connected. Tenants can pay online.');
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
    if (action === 'plan') planForm();
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

const backRef = ozowReturn();
await refresh();
if (backRef) {
  toast('Checking your payment with Ozow…');
  const [msg, tone] = OZOW_RESULT[await checkOzow(backRef)] || OZOW_RESULT.pending;
  await refresh();
  toast(msg.replace(' from your account', ''), tone || undefined);
}
