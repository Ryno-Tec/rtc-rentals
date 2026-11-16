// Agency: the owners whose properties you manage, your team's logins, and monthly owner statements.
import { api } from './data.js';
import { maintApi } from './maint-data.js';
import { taxApi } from './tax-data.js';
import { agencyApi as ag, ownerStatement } from './agency-data.js';
import { mountShell, esc, icon, toast, openModal, formData, confirmDialog } from './shell.js';
import { printPage } from './lease-ui.js';

await mountShell('agency.html');
const view = document.getElementById('view');
const rand = n => { const v = Number(n) || 0, [w, c] = Math.abs(v).toFixed(2).split('.'); return `${v < 0 ? '−' : ''}R ${w.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')},${c}`; };
const day = s => new Date(String(s).slice(0, 10) + 'T12:00').toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' });
const monthLong = m => new Date(m + '-01T12:00').toLocaleDateString('en-ZA', { month: 'long', year: 'numeric' });
const TABS = { owners: 'Owners', statements: 'Owner statements', team: 'Team' };
const ROLE = { admin: 'Admin: everything, incl. billing and the team', agent: 'Agent: properties, tenants, rent, repairs' };
let owners = [], payouts = [], team = { members: [], isAdmin: false }, properties = [], tenancies = [], payments = [], expenses = [], repairs = [];
const lastMonth = (() => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return d.toISOString().slice(0, 7); })();
let stOwner = '', stMonth = lastMonth;
const tab = () => (location.hash.slice(1) in TABS ? location.hash.slice(1) : 'owners');

function ownersTab() {
  if (!owners.length) return `<div class="card empty"><h2>No owners yet</h2>
    <p>Add each owner you manage properties for, with your management fee. Then choose the owner on each property.</p>
    <button class="btn" type="button" data-action="owner">${icon.plus}Add owner</button></div>`;
  return `<section class="card"><div class="card-head"><h2>Owners you manage for</h2><button class="btn btn-sm" type="button" data-action="owner">${icon.plus}Add owner</button></div>
    <div class="table-wrap"><table class="t-table"><thead><tr><th>Owner</th><th>Properties</th><th class="right">Management fee</th><th class="hide-sm">Pay out to</th><th></th></tr></thead><tbody>
    ${owners.map(o => { const ps = properties.filter(p => p.owner_id === o.id);
      return `<tr><td><div class="unit-label">${esc(o.full_name)}</div><div class="unit-sub">${esc([o.email, o.phone].filter(Boolean).join(' · '))}</div></td>
        <td>${ps.length ? ps.map(p => esc(p.name)).join(', ') : '<span class="muted">None yet: choose this owner on a property</span>'}</td>
        <td class="right num">${Number(o.fee_pct)}%${Number(o.fee_fixed) ? ` + ${rand(o.fee_fixed)}` : ''}${o.fee_vat ? ' + VAT' : ''}</td>
        <td class="hide-sm">${esc(o.payout_note || '—')}</td>
        <td class="actions"><button class="btn btn-ghost btn-sm" type="button" data-action="statement" data-id="${o.id}">Statement</button>
          <button class="btn btn-ghost btn-icon" type="button" data-action="owner" data-id="${o.id}" aria-label="Edit ${esc(o.full_name)}">${icon.edit}</button></td></tr>`; }).join('')}
    </tbody></table></div></section>`;
}

function statementsTab() {
  if (!owners.length) return `<div class="card empty"><h2>No owners yet</h2><p>Add owners on the Owners tab first.</p></div>`;
  const o = owners.find(x => x.id === stOwner) || owners[0]; stOwner = o.id;
  const st = ownerStatement({ owner: o, month: stMonth, properties, tenancies, payments, expenses, repairs, payouts });
  const pays = payouts.filter(p => p.owner_id === o.id && String(p.period_month).slice(0, 7) === stMonth);
  return `<div class="admin-bar no-print"><div style="display:flex;gap:8px;flex-wrap:wrap">
      <select id="st-owner" aria-label="Owner">${owners.map(x => `<option value="${x.id}" ${x.id === o.id ? 'selected' : ''}>${esc(x.full_name)}</option>`).join('')}</select>
      <input id="st-month" type="month" value="${stMonth}" aria-label="Month"></div>
      <div style="display:flex;gap:8px"><button class="btn btn-ghost btn-sm" type="button" data-action="print">Print or save as PDF</button>
      <button class="btn btn-sm" type="button" data-action="payout">Record payout</button></div></div>
    <section class="card card-pad statement" id="statement">
      <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap"><div><h2 style="margin:0">Owner statement</h2>
        <div class="muted">${esc(o.full_name)} · ${monthLong(stMonth)}</div></div>
        <div class="muted" style="text-align:right">${st.properties.map(p => esc(p.name)).join('<br>') || 'No properties'}</div></div>
      <div class="table-wrap" style="margin-top:14px"><table class="t-table"><thead><tr><th>Date</th><th>Details</th><th class="right">In</th><th class="right">Out</th></tr></thead><tbody>
        ${st.lines.map(l => `<tr><td>${day(l.date)}</td><td>${esc(l.text)}</td><td class="right num">${l.kind === 'in' ? rand(l.amount) : ''}</td><td class="right num">${l.kind === 'out' ? rand(l.amount) : ''}</td></tr>`).join('')
          || '<tr><td colspan="4" class="muted">Nothing received or spent this month.</td></tr>'}
        <tr><td></td><td>Management fee (${Number(o.fee_pct)}%${Number(o.fee_fixed) ? ` + ${rand(o.fee_fixed)}` : ''})</td><td></td><td class="right num">${rand(st.fee)}</td></tr>
        ${o.fee_vat ? `<tr><td></td><td>VAT on fee (15%)</td><td></td><td class="right num">${rand(st.vat)}</td></tr>` : ''}
      </tbody></table></div>
      <dl class="kv statement-sum">
        <div><dt>Rent received</dt><dd class="num">${rand(st.rent)}</dd></div>
        <div><dt>Costs and fees</dt><dd class="num">${rand(st.costs + st.fee + st.vat)}</dd></div>
        <div><dt><b>Due to owner</b></dt><dd class="num"><b>${rand(st.due)}</b></dd></div>
        <div><dt>Paid to owner</dt><dd class="num">${rand(st.paid)}${pays.length ? ` <span class="muted">(${pays.map(p => `${day(p.paid_on)}${p.reference ? ', ' + esc(p.reference) : ''}`).join('; ')})</span>` : ''}</dd></div>
        <div><dt><b>Still to pay</b></dt><dd class="num"><b>${rand(st.balance)}</b></dd></div>
      </dl>
      ${pays.length ? `<p class="no-print" style="margin:10px 0 0">${pays.map(p => `<button class="btn btn-ghost btn-sm" type="button" data-action="del-payout" data-id="${p.id}">Remove payout of ${rand(p.amount)}</button>`).join(' ')}</p>` : ''}
      <p class="hint" style="margin:12px 0 0">Rent is counted in the month it was received. Repairs with a cost and expenses on the owner’s properties are deducted. Keep the trust account reconciliation as your official record.</p>
    </section>`;
}

function teamTab() {
  const { members, isAdmin } = team;
  return `<section class="card"><div class="card-head"><h2>Your team</h2>${isAdmin ? `<button class="btn btn-sm" type="button" data-action="member">${icon.plus}Add person</button>` : ''}</div>
    ${members.length ? `<div class="table-wrap"><table class="t-table"><thead><tr><th>Name</th><th>Role</th><th>Login</th><th></th></tr></thead><tbody>
      ${members.map(m => `<tr><td><div class="unit-label">${esc(m.full_name)}</div><div class="unit-sub">${esc(m.email)}</div></td>
        <td>${m.role === 'admin' ? 'Admin' : 'Agent'}</td>
        <td>${!m.active ? '<span class="pill pill-muted">Switched off</span>' : m.user_id ? '<span class="pill pill-ok">Uses the app</span>' : '<span class="pill pill-soon">No login yet</span>'}</td>
        <td class="actions">${isAdmin ? `${m.active && !m.user_id ? `<button class="btn btn-sm" type="button" data-action="invite" data-id="${m.id}">Invite link</button>` : ''}
          <button class="btn btn-ghost btn-icon" type="button" data-action="member" data-id="${m.id}" aria-label="Edit ${esc(m.full_name)}">${icon.edit}</button>` : ''}</td></tr>`).join('')}
    </tbody></table></div>` : `<p class="card-pad muted" style="margin:0">Add the agents in your office so each has their own login. They see and work on the same properties, tenants and rent as you.</p>`}
    <div class="card-pad"><dl class="kv">${Object.entries(ROLE).map(([k, v]) => `<div><dt>${k === 'admin' ? 'Admin' : 'Agent'}</dt><dd>${esc(v.split(': ')[1])}</dd></div>`).join('')}</dl>
    <p class="hint" style="margin:12px 0 0">Switching someone off stops their access straight away. Each person signs in with their own email, so every change can be traced to them.</p></div></section>`;
}

function render() {
  const t = tab();
  view.innerHTML = `<nav class="tabs admin-tabs no-print">${Object.entries(TABS).map(([k, v]) => `<a href="#${k}" ${k === t ? 'aria-current="page"' : ''}>${v}</a>`).join('')}</nav>
    ${{ owners: ownersTab, statements: statementsTab, team: teamTab }[t]()}`;
}

async function refresh() {
  try {
    [owners, payouts, team, properties, tenancies, expenses, repairs] = await Promise.all([ag.owners(), ag.payouts(), ag.team(),
      api.properties(), api.tenancies(), taxApi.expenses().catch(() => []), maintApi.requests().catch(() => [])]);
    payments = await api.payments(tenancies.map(l => l.id));
    render();
  } catch (e) { view.innerHTML = `<div class="card card-pad"><h2>Not available yet</h2><p class="muted">${esc(e.message)}</p></div>`; }
}

function ownerForm(o = {}) {
  openModal({ title: o.id ? `Edit ${o.full_name}` : 'Add owner', submitLabel: o.id ? 'Save' : 'Add owner',
    body: `<div class="field"><label for="o-name">Owner’s name</label><input id="o-name" name="full_name" required value="${esc(o.full_name || '')}"></div>
      <div class="grid-2"><div class="field"><label for="o-email">Email</label><input id="o-email" name="email" type="email" value="${esc(o.email || '')}"></div>
        <div class="field"><label for="o-phone">Phone</label><input id="o-phone" name="phone" value="${esc(o.phone || '')}"></div></div>
      <div class="grid-2"><div class="field"><label for="o-pct">Management fee (% of rent received)</label><input id="o-pct" name="fee_pct" type="number" min="0" max="50" step="0.01" value="${o.fee_pct ?? 8}"></div>
        <div class="field"><label for="o-fix">Plus a fixed fee per month (R)</label><input id="o-fix" name="fee_fixed" type="number" min="0" step="0.01" value="${o.fee_fixed ?? 0}"></div></div>
      <label class="check"><input type="checkbox" name="fee_vat" ${o.fee_vat ? 'checked' : ''}> Add VAT (15%) to the fee (only if your agency is VAT-registered)</label>
      <div class="field" style="margin-top:12px"><label for="o-pay">Pay out to <span class="muted">(bank and last 4 digits only)</span></label><input id="o-pay" name="payout_note" value="${esc(o.payout_note || '')}" placeholder="e.g. FNB …1234"></div>
      ${o.id ? '<p style="margin:12px 0 0"><button type="button" class="btn btn-danger btn-sm" id="o-del">Remove owner</button></p>' : ''}`,
    async onSubmit(form) { await ag.saveOwner({ ...formData(form), id: o.id }); toast(o.id ? 'Saved' : 'Owner added'); await refresh(); } });
  document.getElementById('o-del')?.addEventListener('click', async () => {
    document.querySelector('.modal-backdrop')?.remove();
    if (await confirmDialog(`Remove ${o.full_name}?`, 'Their properties stay; they just no longer show an owner. Past payouts are removed.', 'Remove')) { await ag.deleteOwner(o.id); toast('Removed'); await refresh(); }
  });
}

function memberForm(m = {}) {
  openModal({ title: m.id ? `Edit ${m.full_name}` : 'Add a person to your team', submitLabel: m.id ? 'Save' : 'Add',
    body: `<div class="field"><label for="m-name">Name</label><input id="m-name" name="full_name" required value="${esc(m.full_name || '')}"></div>
      <div class="field"><label for="m-email">Work email</label><input id="m-email" name="email" type="email" required value="${esc(m.email || '')}"></div>
      <div class="field"><label for="m-role">Role</label><select id="m-role" name="role">${Object.entries(ROLE).map(([k, v]) => `<option value="${k}" ${k === (m.role || 'agent') ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></div>
      ${m.id ? `<label class="check"><input type="checkbox" name="active" ${m.active !== false ? 'checked' : ''}> Has access</label>
        <p style="margin:12px 0 0"><button type="button" class="btn btn-danger btn-sm" id="m-del">Remove from team</button></p>` : ''}`,
    async onSubmit(form) {
      const v = formData(form);
      const id = await ag.saveMember({ ...v, id: m.id, active: m.id ? v.active : true });
      toast(m.id ? 'Saved' : 'Added. Send them their invite link.'); await refresh();
      if (!m.id) invite(id);
    } });
  document.getElementById('m-del')?.addEventListener('click', async () => {
    document.querySelector('.modal-backdrop')?.remove();
    if (await confirmDialog(`Remove ${m.full_name}?`, 'Their login stops working for your account straight away.', 'Remove')) { await ag.removeMember(m.id); toast('Removed'); await refresh(); }
  });
}

async function invite(id) {
  const m = team.members.find(x => x.id === id);
  const link = await ag.inviteMember(id);
  openModal({ title: `Invite ${m?.full_name || 'your team member'}`, submitLabel: 'Done', cancel: false,
    body: `<p style="margin-top:0">Send this link to ${esc(m?.email || 'them')} by email or WhatsApp. It works once and lasts 14 days. They create their own login (or use Google or Microsoft) and then see your agency’s properties.</p>
      <div class="field"><input id="inv-link" readonly value="${esc(link)}"></div><button type="button" class="btn btn-ghost btn-sm" id="inv-copy">Copy link</button>`,
    async onSubmit() {} });
  document.getElementById('inv-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(link); toast('Link copied'); } catch { document.getElementById('inv-link').select(); }
  });
}

function payoutForm() {
  const o = owners.find(x => x.id === stOwner);
  const st = ownerStatement({ owner: o, month: stMonth, properties, tenancies, payments, expenses, repairs, payouts });
  openModal({ title: `Payout to ${o.full_name}`, submitLabel: 'Record payout',
    body: `<p class="muted" style="margin-top:0">For ${monthLong(stMonth)}. Still to pay: <b>${rand(st.balance)}</b>.</p>
      <div class="grid-2"><div class="field"><label for="p-amt">Amount paid (R)</label><input id="p-amt" name="amount" type="number" min="0" step="0.01" value="${Math.max(0, st.balance)}"></div>
        <div class="field"><label for="p-date">Date paid</label><input id="p-date" name="paid_on" type="date" value="${new Date().toISOString().slice(0, 10)}"></div></div>
      <div class="field"><label for="p-ref">EFT reference</label><input id="p-ref" name="reference" maxlength="60"></div>`,
    async onSubmit(form) { await ag.addPayout({ ...formData(form), owner_id: o.id, period_month: stMonth + '-01' }); toast('Payout recorded'); await refresh(); } });
}

view.addEventListener('click', async e => {
  const a = e.target.closest('[data-action]');
  if (!a) return;
  const { action, id } = a.dataset;
  try {
    if (action === 'owner') ownerForm(owners.find(o => o.id === id));
    if (action === 'statement') { stOwner = id; location.hash = 'statements'; }
    if (action === 'member') memberForm(team.members.find(m => m.id === id));
    if (action === 'invite') await invite(id);
    if (action === 'payout') payoutForm();
    if (action === 'print') printPage();
    if (action === 'del-payout' && await confirmDialog('Remove this payout?', 'It is taken off the statement.', 'Remove')) { await ag.deletePayout(id); await refresh(); }
  } catch (ex) { toast(ex.message, 'error'); }
});
view.addEventListener('change', e => {
  if (e.target.id === 'st-owner') { stOwner = e.target.value; render(); }
  if (e.target.id === 'st-month' && e.target.value) { stMonth = e.target.value; render(); }
});
window.addEventListener('hashchange', () => render());
await refresh();
