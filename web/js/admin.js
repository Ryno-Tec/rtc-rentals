// Ryno-Tec admin dashboard: every landlord, income, invoices, payment alerts and platform settings.
// The database refuses all of this unless the signed-in user is in platform_admins.
import { isDemo, client, TIERS, DataError } from './data.js';
import { mountShell, esc, toast, openModal, formData, confirmDialog } from './shell.js';

await mountShell('admin.html');
const view = document.getElementById('view');
const rand = n => { const v = Number(n) || 0, [w, c] = Math.abs(v).toFixed(2).split('.'); return `R ${w.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')},${c}`; };
const day = s => s ? new Date(String(s).slice(0, 10) + 'T12:00').toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
const month = s => new Date(String(s).slice(0, 10) + 'T12:00').toLocaleDateString('en-ZA', { month: 'short', year: 'numeric' });
const TABS = { overview: 'Overview', landlords: 'Landlords', invoices: 'Invoices', alerts: 'Payment alerts', settings: 'Settings' };
const EVENT = { unknown_reference: 'Unknown payment reference', check_failed: 'Check with Ozow failed', mismatch: 'Payment didn’t match',
  credentials: 'Ozow connection missing', reconcile_mismatch: 'Reconciliation difference', expired: 'Payer didn’t finish' };
let o, landlords = [], invoices = [], events = [], invFilter = 'open';

async function rpc(name, args) {
  const sb = await client();
  const { data, error } = await sb.rpc(name, args);
  if (error) throw new DataError(error.code === '42501' ? 'This page is for Ryno-Tec admins only.' : error.message);
  return data;
}
const tab = () => (location.hash.slice(1) in TABS ? location.hash.slice(1) : 'overview');

function overview() {
  const k = (label, value, sub = '') => `<div class="card card-pad kpi"><div class="label">${label}</div><div class="value num">${value}</div>${sub ? `<div class="muted" style="font-size:12.5px">${sub}</div>` : ''}</div>`;
  const tiers = Object.entries(TIERS).map(([t, v]) => `${v.display_name} ${o.by_tier?.[t] || 0}`).join(' · ');
  return `<div class="admin-kpis">
    ${k('Monthly subscriptions', rand(o.mrr), 'if every plan is billed in full')}
    ${k('Collection fees this month', rand(o.fees_this_month), `on ${rand(o.online_rent_this_month)} rent paid online (${o.online_rent_count})`)}
    ${k('Paid to Ryno-Tec this month', rand(o.paid_this_month))}
    ${k('Open invoices', rand(o.open_invoices), o.overdue_count ? `<span style="color:var(--red)">${rand(o.overdue_invoices)} overdue (${o.overdue_count})</span>` : 'none overdue')}
    ${k('Landlords', o.landlords, `${o.new_this_month} new this month · ${tiers}`)}
    ${k('Units', o.units, `${o.properties} properties`)}
    ${k('Tenants', o.tenants, `${o.tenants_on_app} use the app`)}
    ${k('Online payments switched on', o.ozow_connected, 'landlords with Ozow connected')}
    ${o.extra ? k('Automatic payments', o.extra.autopay_active, `${rand(o.extra.autopay_collected_month)} collected this month`) : ''}
    ${o.extra ? k('Agencies', o.extra.team_members, `team logins · ${o.extra.owners_managed} owners managed`) : ''}
    ${k('Payment alerts (7 days)', o.alerts_7d, o.alerts_7d ? '<a href="#alerts">Look at them</a>' : 'all clear')}
  </div>`;
}

function landlordsTab() {
  return `<section class="card"><div class="table-wrap"><table class="t-table">
    <thead><tr><th>Landlord</th><th>Plan</th><th class="right">Units</th><th class="right hide-sm">Tenants</th><th class="hide-sm">Ozow</th><th class="right">Owes</th><th class="hide-sm">Joined</th><th class="hide-sm">Last sign-in</th><th></th></tr></thead>
    <tbody>${landlords.map(l => `<tr>
      <td><div class="unit-label">${esc(l.full_name || '—')}</div><div class="unit-sub">${esc(l.email || '')}${l.phone ? ' · ' + esc(l.phone) : ''}</div></td>
      <td>${esc(TIERS[l.tier]?.display_name || l.tier)}${l.custom_price != null ? ` <span class="muted">(${rand(l.custom_price)})</span>` : ''}</td>
      <td class="right num">${l.units}</td><td class="right num hide-sm">${l.tenants}</td>
      <td class="hide-sm">${l.ozow ? '<span class="pill pill-ok">On</span>' : '<span class="muted">—</span>'}</td>
      <td class="right num">${Number(l.open_amount) ? `<span style="color:${l.overdue ? 'var(--red)' : 'inherit'}">${rand(l.open_amount)}</span>` : '—'}</td>
      <td class="hide-sm">${day(l.created_at)}</td><td class="hide-sm">${day(l.last_sign_in)}</td>
      <td class="actions"><button class="btn btn-ghost btn-sm" type="button" data-action="plan" data-id="${l.id}">Plan</button></td></tr>`).join('')}
    </tbody></table></div></section>`;
}

function invoicesTab() {
  const today = new Date().toISOString().slice(0, 10);
  const rows = invoices.filter(i => invFilter === 'all' || (invFilter === 'overdue' ? i.status === 'open' && i.due_date < today : i.status === invFilter));
  const last = new Date(); last.setDate(1); last.setMonth(last.getMonth() - 1);
  return `<div class="admin-bar">
      <div class="seg">${['open', 'overdue', 'paid', 'void', 'all'].map(f => `<button type="button" class="btn btn-sm ${f === invFilter ? '' : 'btn-ghost'}" data-filter="${f}">${f[0].toUpperCase() + f.slice(1)}</button>`).join('')}</div>
      <form id="gen" class="gen"><input type="month" name="month" value="${last.toISOString().slice(0, 7)}" aria-label="Month to invoice"><button class="btn btn-sm" type="submit">Create invoices</button></form>
    </div>
    <section class="card">${rows.length ? `<div class="table-wrap"><table class="t-table">
    <thead><tr><th>Invoice</th><th>Landlord</th><th class="right hide-sm">Plan</th><th class="right hide-sm">Fees</th><th class="right">Total</th><th>Status</th><th></th></tr></thead>
    <tbody>${rows.map(i => {
      const late = i.status === 'open' && i.due_date < today;
      const st = i.status === 'paid' ? ['ok', `Paid ${day(i.paid_at)}`] : i.status === 'void' ? ['muted', 'Cancelled'] : late ? ['late', `Overdue since ${day(i.due_date)}`] : ['soon', `Due ${day(i.due_date)}`];
      return `<tr><td><div class="unit-label">${esc(i.number)}</div><div class="unit-sub">${month(i.period_month)} · ${esc(TIERS[i.tier]?.display_name || i.tier)}</div></td>
        <td>${esc(i.landlord || '')}</td><td class="right num hide-sm">${rand(i.subscription_amount)}</td><td class="right num hide-sm">${rand(i.collection_fees)}</td>
        <td class="right num"><b>${rand(i.total)}</b></td><td><span class="pill pill-${st[0]}">${st[1]}</span></td>
        <td class="actions">${i.status === 'open' ? `<button class="btn btn-sm" type="button" data-action="paid" data-id="${i.id}">Mark paid</button>
          <button class="btn btn-ghost btn-sm" type="button" data-action="void" data-id="${i.id}">Cancel</button>`
          : `<button class="btn btn-ghost btn-sm" type="button" data-action="reopen" data-id="${i.id}">Reopen</button>`}</td></tr>`;
    }).join('')}</tbody></table></div>` : '<p class="card-pad muted" style="margin:0">No invoices here.</p>'}</section>`;
}

function alertsTab() {
  return `<section class="card">${events.length ? `<div class="table-wrap"><table class="t-table">
    <thead><tr><th>When</th><th>What</th><th>Landlord</th><th class="hide-sm">Reference</th><th class="hide-sm">Details</th></tr></thead>
    <tbody>${events.map(e => `<tr>
      <td>${new Date(e.at).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
      <td>${e.alert ? '<span class="pill pill-late">Alert</span> ' : ''}${esc(EVENT[e.kind] || e.kind)}</td>
      <td>${esc(e.landlord || '—')}</td><td class="hide-sm"><code>${esc(e.reference || '')}</code></td>
      <td class="hide-sm"><code class="admin-detail">${esc(JSON.stringify(e.detail || {}).slice(0, 220))}</code></td></tr>`).join('')}
    </tbody></table></div>` : '<p class="card-pad muted" style="margin:0">No payment events yet.</p>'}
    <p class="hint card-pad" style="margin:0">To investigate: find the reference in the Ozow dashboard (Transactions), compare, then fix the rent month by hand if needed.</p></section>`;
}

function settingsTab() {
  const s = o.settings || {};
  return `<section class="card card-pad" style="max-width:560px"><form id="settings">
    <h2 style="margin-top:0">Online rent collection fee</h2>
    <div class="grid-2">
      <div class="field"><label for="s-pct">Fee (% of rent)</label><input id="s-pct" name="pct" type="number" step="0.01" min="0" max="10" value="${s.collection_fee_pct}"></div>
      <div class="field"><label for="s-max">Most per payment (R)</label><input id="s-max" name="max" type="number" step="0.01" min="0" value="${s.collection_fee_max}"></div>
      <div class="field"><label for="s-min">Least per payment (R)</label><input id="s-min" name="min" type="number" step="0.01" min="0" value="${s.collection_fee_min}"></div>
      <div class="field"><label for="s-due">Invoices due after (days)</label><input id="s-due" name="due" type="number" min="0" max="60" value="${s.invoice_due_days}"></div>
    </div>
    <p class="hint">Changes apply to payments from now on; fees already earned stay as they were.</p>
    <button class="btn" type="submit">Save settings</button></form></section>
    <section class="card card-pad" style="max-width:560px;margin-top:18px"><h2 style="margin-top:0">Admins</h2>
    <p class="muted" style="margin:0">Add or remove admins in the Supabase SQL editor:</p>
    <pre class="admin-sql">insert into public.platform_admins (user_id)
  select id from auth.users where email = 'name@example.com';</pre></section>`;
}

function render() {
  const t = tab();
  view.innerHTML = `<nav class="tabs admin-tabs">${Object.entries(TABS).map(([k, v]) => `<a href="#${k}" ${k === t ? 'aria-current="page"' : ''}>${v}${k === 'alerts' && o.alerts_7d ? ` <span class="pill pill-late">${o.alerts_7d}</span>` : ''}</a>`).join('')}</nav>
    ${{ overview, landlords: landlordsTab, invoices: invoicesTab, alerts: alertsTab, settings: settingsTab }[t]()}`;
}

async function refresh() {
  try {
    if (isDemo()) throw new DataError('The admin dashboard works on the live system only.');
    [o, landlords, invoices, events] = await Promise.all([rpc('admin_overview'), rpc('admin_landlords'), rpc('admin_invoices'), rpc('admin_events')]);
    o.extra = await rpc('admin_overview_extra').catch(() => null);
    render();
  } catch (ex) { view.innerHTML = `<div class="card card-pad"><h2>Not available</h2><p class="muted">${esc(ex.message)}</p></div>`; }
}

function planForm(l) {
  openModal({
    title: `Plan for ${l.full_name || l.email}`, submitLabel: 'Save plan',
    body: `<div class="field"><label for="p-tier">Plan</label><select id="p-tier" name="tier">${Object.entries(TIERS).map(([k, t]) => `<option value="${k}" ${k === l.tier ? 'selected' : ''}>${t.display_name}${t.price_zar ? ` (${rand(t.price_zar)})` : ' (custom price)'}</option>`).join('')}</select></div>
      <div class="field"><label for="p-price">Custom monthly price (R) <span class="muted">(Agency, or leave empty)</span></label><input id="p-price" name="price" type="number" step="0.01" min="0" value="${l.custom_price ?? ''}"></div>
      <p class="hint" style="margin:0">Admin changes skip the owner rules (unit limits, overdue invoices). The month is still billed at the highest plan held in it.</p>`,
    async onSubmit(form) {
      const v = formData(form);
      if (v.tier === 'agency' && v.price == null) throw new DataError('Set the Agency price.');
      await rpc('admin_set_plan', { p_landlord: l.id, p_tier: v.tier, p_custom_price: v.price });
      toast('Plan saved'); await refresh();
    },
  });
}

view.addEventListener('click', async e => {
  const f = e.target.closest('[data-filter]');
  if (f) { invFilter = f.dataset.filter; render(); return; }
  const a = e.target.closest('[data-action]');
  if (!a) return;
  const { action, id } = a.dataset;
  try {
    if (action === 'plan') planForm(landlords.find(l => l.id === id));
    if (action === 'paid') { await rpc('admin_set_invoice_status', { p_invoice: id, p_status: 'paid' }); toast('Marked paid'); await refresh(); }
    if (action === 'reopen') { await rpc('admin_set_invoice_status', { p_invoice: id, p_status: 'open' }); toast('Reopened'); await refresh(); }
    if (action === 'void' && await confirmDialog('Cancel this invoice?', 'The owner no longer owes it. You can reopen it later.', 'Cancel invoice')) {
      await rpc('admin_set_invoice_status', { p_invoice: id, p_status: 'void' }); toast('Invoice cancelled'); await refresh();
    }
  } catch (ex) { toast(ex.message, 'error'); }
});
view.addEventListener('submit', async e => {
  e.preventDefault();
  try {
    if (e.target.id === 'settings') {
      const v = formData(e.target);
      await rpc('admin_update_settings', { p_fee_pct: v.pct, p_fee_min: v.min, p_fee_max: v.max, p_due_days: v.due });
      toast('Settings saved'); await refresh();
    }
    if (e.target.id === 'gen') {
      const m = e.target.month.value;
      const n = await rpc('admin_generate_invoices', { p_month: `${m}-01` });
      toast(n ? `${n} invoice${n === 1 ? '' : 's'} created` : 'Nothing new to invoice for that month'); await refresh();
    }
  } catch (ex) { toast(ex.message, 'error'); }
});
window.addEventListener('hashchange', () => o && render());
await refresh();
