import { api, LEASE_STATUS } from './data.js';
import { mountShell, esc, money, icon, toast, openModal, formData } from './shell.js';
import { currentRent, nextEscalation, monthLabel, eftReference, ordinal as ord } from './ledger.js';

await mountShell('tenants.html');
const list = document.getElementById('list');
document.getElementById('add-tenancy').innerHTML = `${icon.plus}Add tenant`;

let tenancies = [], properties = [];
const fmtDate = d => d ? new Date(d.slice(0, 10) + 'T00:00:00').toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
const live = l => ['active', 'signed'].includes(l.status);
const leaseBadge = l => `<span class="badge ${live(l) ? 's-occupied' : l.status === 'ended' || l.status === 'cancelled' ? 'plain tag' : 's-notice'}">${esc(LEASE_STATUS[l.status])}</span>`;

function render() {
  if (!tenancies.length) {
    list.innerHTML = `<div class="card empty"><h2>No tenants yet</h2>
      <p>Add your tenant and the terms of their lease. If they’ve rented from you for a while, use the date the lease started; you can mark earlier months as paid on the Rent page.</p>
      <button class="btn" type="button" data-action="add">${icon.plus}Add tenant</button></div>`;
    return;
  }
  const rows = tenancies.map(l => {
    const t = l.tenant || {}, u = l.unit || {};
    const esc_ = nextEscalation(l);
    return `<article class="card prop">
      <div class="prop-head">
        <div class="meta">
          <h2>${esc(t.full_name || 'Tenant')} ${leaseBadge(l)}</h2>
          <div class="addr">${esc(u.label || '')}${u.property ? ' · ' + esc(u.property.name) : ''}</div>
          <div class="stats">
            <span><b class="num">${money(currentRent(l))}</b> a month${Number(l.escalation_pct) ? ` · +${Number(l.escalation_pct)}% a year` : ''}</span>
            <span>Due on the <b class="num">${ord(l.rent_due_day)}</b></span>
            <span>Since <b>${fmtDate(l.start_date)}</b>${l.end_date ? ` · until <b>${fmtDate(l.end_date)}</b>` : ' · month to month'}</span>
          </div>
        </div>
        <div class="prop-actions">
          <a class="btn btn-sm btn-ghost" href="rent.html#l-${l.id}">${icon.cash}Rent</a>
          <button class="btn btn-ghost btn-icon" type="button" data-action="edit" data-id="${l.id}" aria-label="Edit ${esc(t.full_name)}">${icon.edit}</button>
        </div>
      </div>
      <div class="table-wrap"><table><tbody>
        <tr><th scope="row">Phone</th><td>${t.phone ? `<a href="tel:${esc(t.phone.replace(/\s/g, ''))}">${esc(t.phone)}</a>` : '<span class="muted">—</span>'}</td>
            <th scope="row" class="hide-sm">Email</th><td class="hide-sm">${t.email ? `<a href="mailto:${esc(t.email)}">${esc(t.email)}</a>` : '<span class="muted">—</span>'}</td></tr>
        <tr><th scope="row">Deposit held</th><td class="num">${money(l.deposit)}</td>
            <th scope="row" class="hide-sm">EFT reference</th><td class="hide-sm"><code>${esc(eftReference(u.label, t.full_name))}</code></td></tr>
        ${esc_ && live(l) ? `<tr><th scope="row">Next increase</th><td colspan="3">${esc(monthLabel(esc_))}, to ${money(Math.round(currentRent(l) * (1 + Number(l.escalation_pct) / 100)))}</td></tr>` : ''}
      </tbody></table></div>
    </article>`;
  }).join('');
  list.innerHTML = rows;
}

async function refresh() {
  try { [tenancies, properties] = await Promise.all([api.tenancies(), api.properties()]); render(); }
  catch (e) { list.innerHTML = `<div class="form-error">Couldn’t load tenants: ${esc(e.message)}</div>`; }
}

function unitOptions(selected) {
  const taken = new Set(tenancies.filter(l => live(l) && l.unit?.id !== selected).map(l => l.unit?.id));
  return properties.map(p => p.units.length ? `<optgroup label="${esc(p.name)}">${p.units.map(u =>
    `<option value="${u.id}" data-rent="${u.monthly_rent}" data-deposit="${u.deposit}" ${u.id === selected ? 'selected' : ''} ${taken.has(u.id) ? 'disabled' : ''}>${esc(u.label)}${taken.has(u.id) ? ' (let)' : ''}</option>`).join('')}</optgroup>` : '').join('');
}

function tenancyForm(l = {}) {
  const t = l.tenant || {};
  if (!properties.some(p => p.units.length)) {
    toast('Add the property and unit first, on Properties & units.', 'error'); return;
  }
  openModal({
    title: l.id ? `Edit ${t.full_name || 'tenant'}` : 'Add tenant',
    submitLabel: l.id ? 'Save changes' : 'Add tenant',
    body: `
      <h3 class="form-section">Tenant</h3>
      <div class="field"><label for="t-name">Full name</label><input id="t-name" name="full_name" required value="${esc(t.full_name)}" autocomplete="off"></div>
      <div class="grid-2">
        <div class="field"><label for="t-phone">Phone</label><input id="t-phone" name="phone" type="tel" value="${esc(t.phone)}"></div>
        <div class="field"><label for="t-email">Email</label><input id="t-email" name="email" type="email" value="${esc(t.email)}"></div>
      </div>
      <div class="grid-2">
        <div class="field"><label for="t-id">ID or passport number <span class="muted">(optional)</span></label><input id="t-id" name="id_number" value="${esc(t.id_number)}" autocomplete="off"></div>
        <div class="field"><label for="t-emp">Employer <span class="muted">(optional)</span></label><input id="t-emp" name="employer" value="${esc(t.employer)}"></div>
      </div>
      <h3 class="form-section">Lease</h3>
      <div class="grid-2">
        <div class="field"><label for="l-unit">Unit</label><select id="l-unit" name="unit_id" required><option value="">Choose…</option>${unitOptions(l.unit?.id)}</select></div>
        <div class="field"><label for="l-status">Status</label><select id="l-status" name="status">${Object.entries(LEASE_STATUS)
          .map(([k, v]) => `<option value="${k}" ${k === (l.status || 'active') ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></div>
      </div>
      <div class="grid-2">
        <div class="field"><label for="l-start">Lease started</label><input id="l-start" name="start_date" type="date" required value="${esc(l.start_date)}"></div>
        <div class="field"><label for="l-end">Lease ends <span class="muted">(blank = month to month)</span></label><input id="l-end" name="end_date" type="date" value="${esc(l.end_date)}"></div>
      </div>
      <div class="grid-2">
        <div class="field"><label for="l-rent">Rent when the lease started</label>
          <div class="input-prefix"><span>R</span><input id="l-rent" name="monthly_rent" type="number" min="0" step="10" required inputmode="decimal" value="${l.monthly_rent ?? ''}"></div>
          <div class="hint">Later increases come from the yearly escalation.</div></div>
        <div class="field"><label for="l-dep">Deposit held</label>
          <div class="input-prefix"><span>R</span><input id="l-dep" name="deposit" type="number" min="0" step="10" inputmode="decimal" value="${l.deposit ?? ''}"></div></div>
      </div>
      <div class="grid-2">
        <div class="field"><label for="l-due">Rent due on day</label><input id="l-due" name="rent_due_day" type="number" min="1" max="31" step="1" value="${l.rent_due_day ?? 1}"></div>
        <div class="field" style="margin-bottom:0"><label for="l-esc">Yearly increase</label>
          <div class="input-prefix"><input id="l-esc" name="escalation_pct" type="number" min="0" max="100" step="0.5" value="${l.escalation_pct ?? 0}" style="padding-right:30px"><span style="left:auto;right:12px">%</span></div>
          <div class="hint">On each lease anniversary.</div></div>
      </div>`,
    async onSubmit(form) {
      const d = formData(form);
      const tenant = { id: t.id, full_name: d.full_name, phone: d.phone, email: d.email, id_number: d.id_number, employer: d.employer };
      const lease = { id: l.id, unit_id: d.unit_id, status: d.status, start_date: d.start_date, end_date: d.end_date,
        monthly_rent: d.monthly_rent, deposit: d.deposit ?? 0, rent_due_day: d.rent_due_day ?? 1, escalation_pct: d.escalation_pct ?? 0 };
      await api.saveTenancy({ tenant, lease });
      toast(l.id ? 'Tenant updated' : 'Tenant added');
      await refresh();
    },
  });
  // Pre-fill rent and deposit from the unit when adding.
  if (!l.id) {
    const unit = document.getElementById('l-unit'), rent = document.getElementById('l-rent'), dep = document.getElementById('l-dep');
    unit.addEventListener('change', () => {
      const o = unit.selectedOptions[0];
      if (o?.dataset.rent && !rent.value) rent.value = o.dataset.rent;
      if (o?.dataset.deposit && !dep.value) dep.value = o.dataset.deposit;
    });
  }
}

document.getElementById('add-tenancy').addEventListener('click', () => tenancyForm());
list.addEventListener('click', e => {
  const b = e.target.closest('button[data-action]');
  if (!b) return;
  if (b.dataset.action === 'add') tenancyForm();
  if (b.dataset.action === 'edit') tenancyForm(tenancies.find(l => l.id === b.dataset.id));
});

await refresh();
if (location.hash === '#new') { history.replaceState(null, '', location.pathname); tenancyForm(); }
api.subscribe(() => refresh());
