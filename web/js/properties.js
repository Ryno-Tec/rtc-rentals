import { api, summarise, PROVINCES, PROPERTY_TYPES, UNIT_STATUS } from './data.js';
import { mountShell, esc, money, pct, icon, toast, openModal, confirmDialog, formData } from './shell.js';

const profile = await mountShell('properties.html');
const list = document.getElementById('list');
const search = document.getElementById('search');
const statusFilter = document.getElementById('status-filter');
document.getElementById('add-property').innerHTML = `${icon.plus}Add property`;

let properties = [];

const options = (map, selected) =>
  Object.entries(map).map(([k, v]) => `<option value="${k}" ${k === selected ? 'selected' : ''}>${esc(v)}</option>`).join('');

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function renderUsage() {
  const lim = profile.limits;
  const used = properties.reduce((n, p) => n + p.units.length, 0);
  const el = document.getElementById('plan-usage');
  if (!lim?.max_units) { el.innerHTML = lim ? `${esc(lim.display_name)} plan · unlimited units` : ''; return; }
  const ratio = Math.min(used / lim.max_units, 1);
  el.innerHTML = `<span><b class="num">${used}</b> of ${lim.max_units} units on ${esc(lim.display_name)}</span>
    <div class="meter" aria-hidden="true"><span style="width:${ratio * 100}%;background:${ratio >= 1 ? 'var(--red)' : 'var(--blue)'}"></span></div>`;
}

function matches(p, u, q, st) {
  if (st && u.status !== st) return false;
  if (!q) return true;
  return [p.name, p.street_address, p.suburb, p.city, u.label].some(v => v?.toLowerCase().includes(q));
}

function render() {
  renderUsage();
  if (!properties.length) {
    list.innerHTML = `<div class="card empty"><h2>No properties yet</h2>
      <p>Add a property, then add each unit or room you rent out.</p>
      <button class="btn" type="button" data-action="add-property">${icon.plus}Add property</button></div>`;
    return;
  }
  const q = search.value.trim().toLowerCase();
  const st = statusFilter.value;
  const filtering = Boolean(q || st);

  const cards = properties.map(p => {
    const propHit = !st && (!q || [p.name, p.street_address, p.suburb, p.city].some(v => v?.toLowerCase().includes(q)));
    const units = propHit ? p.units : p.units.filter(u => matches(p, u, q, st));
    if (filtering && !propHit && !units.length) return '';
    const s = summarise([p]);
    return `
    <article class="card prop" id="p-${p.id}">
      <div class="prop-head">
        <div class="meta">
          <h2>${esc(p.name)} <span class="badge tag plain" style="margin-left:6px;vertical-align:2px">${esc(PROPERTY_TYPES[p.property_type])}</span></h2>
          <div class="addr">${esc([p.street_address, p.suburb, p.city, PROVINCES[p.province], p.postal_code].filter(Boolean).join(', '))}</div>
          <div class="stats"><span><b class="num">${s.units}</b> ${s.units === 1 ? 'unit' : 'units'}</span>
            <span><b class="num">${s.units ? pct(s.occupancy) : '—'}</b> let</span>
            <span><b class="num">${money(s.rentRoll)}</b> rent roll</span></div>
        </div>
        <div class="prop-actions">
          <button class="btn btn-sm" type="button" data-action="add-unit" data-id="${p.id}">${icon.plus}Unit</button>
          <button class="btn btn-ghost btn-icon" type="button" data-action="edit-property" data-id="${p.id}" aria-label="Edit ${esc(p.name)}">${icon.edit}</button>
          <button class="btn btn-ghost btn-icon" type="button" data-action="delete-property" data-id="${p.id}" aria-label="Delete ${esc(p.name)}">${icon.trash}</button>
        </div>
      </div>
      ${units.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Unit</th><th class="hide-sm">Size</th><th class="right">Rent</th><th class="right hide-sm">Deposit</th><th>Status</th><th><span class="hidden">Actions</span></th></tr></thead>
        <tbody>${units.map(u => `
          <tr>
            <td><div class="unit-label">${esc(u.label)}</div>
              <div class="unit-sub">${u.bedrooms} bed · ${Number(u.bathrooms)} bath${u.water_included ? ' · water incl.' : ''}${u.electricity_included ? ' · elec. incl.' : ''}</div></td>
            <td class="hide-sm num">${u.size_m2 ? `${Number(u.size_m2)} m²` : '<span class="muted">—</span>'}</td>
            <td class="right num">${money(u.monthly_rent)}</td>
            <td class="right num hide-sm">${money(u.deposit)}</td>
            <td><select class="badge s-${u.status}" style="border:0;min-height:0;width:auto;padding-right:6px;cursor:pointer"
                  data-action="status" data-id="${u.id}" data-property="${p.id}" aria-label="Status of ${esc(u.label)}">
                  ${options(UNIT_STATUS, u.status)}</select></td>
            <td class="actions">
              <button class="btn btn-ghost btn-icon" type="button" data-action="edit-unit" data-id="${u.id}" data-property="${p.id}" aria-label="Edit ${esc(u.label)}">${icon.edit}</button>
              <button class="btn btn-ghost btn-icon" type="button" data-action="delete-unit" data-id="${u.id}" data-property="${p.id}" aria-label="Delete ${esc(u.label)}">${icon.trash}</button>
            </td>
          </tr>`).join('')}</tbody></table></div>`
      : `<div class="units-empty">${filtering ? 'No units match.' : 'No units yet. Add each unit or room you rent out.'}
          ${filtering ? '' : `<button class="btn btn-ghost btn-sm" type="button" data-action="add-unit" data-id="${p.id}">${icon.plus}Add unit</button>`}</div>`}
    </article>`;
  }).join('');

  list.innerHTML = cards || `<div class="card empty"><h2>Nothing matches</h2><p>Try a different search or status.</p></div>`;
}

async function refresh() {
  try { properties = await api.properties(); render(); }
  catch (e) { list.innerHTML = `<div class="form-error">Couldn’t load properties: ${esc(e.message)}</div>`; }
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------
function propertyForm(p = {}) {
  openModal({
    title: p.id ? 'Edit property' : 'Add property',
    submitLabel: p.id ? 'Save changes' : 'Add property',
    body: `
      <div class="field"><label for="f-name">Property name</label>
        <input id="f-name" name="name" required value="${esc(p.name)}" placeholder="e.g. Mabaso Street rooms">
        <div class="hint">What you call it. Tenants won’t see this.</div></div>
      <div class="field"><label for="f-type">Type</label>
        <select id="f-type" name="property_type">${options(PROPERTY_TYPES, p.property_type || 'house')}</select></div>
      <div class="field"><label for="f-street">Street address</label>
        <input id="f-street" name="street_address" required value="${esc(p.street_address)}" autocomplete="street-address"></div>
      <div class="grid-2">
        <div class="field"><label for="f-suburb">Suburb or township</label><input id="f-suburb" name="suburb" value="${esc(p.suburb)}"></div>
        <div class="field"><label for="f-city">City or town</label><input id="f-city" name="city" required value="${esc(p.city)}"></div>
      </div>
      <div class="grid-2">
        <div class="field"><label for="f-province">Province</label>
          <select id="f-province" name="province" required><option value="">Choose…</option>${options(PROVINCES, p.province)}</select></div>
        <div class="field"><label for="f-postal">Postal code</label>
          <input id="f-postal" name="postal_code" inputmode="numeric" maxlength="4" pattern="[0-9]{4}" value="${esc(p.postal_code)}"></div>
      </div>
      <div class="grid-2">
        <div class="field"><label for="f-erf">Erf number <span class="muted">(optional)</span></label><input id="f-erf" name="erf_number" value="${esc(p.erf_number)}"></div>
        <div class="field"><label for="f-muni">Municipal account <span class="muted">(optional)</span></label><input id="f-muni" name="municipality_account" value="${esc(p.municipality_account)}"></div>
      </div>
      <div class="field" style="margin-bottom:0"><label for="f-notes">Notes</label><textarea id="f-notes" name="notes">${esc(p.notes)}</textarea></div>`,
    async onSubmit(form) {
      const data = formData(form);
      if (!data.name) throw new Error('Give the property a name.');
      if (!data.street_address || !data.city) throw new Error('Street address and city are required.');
      if (!data.province) throw new Error('Choose a province.');
      if (data.postal_code && !/^\d{4}$/.test(data.postal_code)) throw new Error('Postal codes are 4 digits.');
      await api.saveProperty({ ...data, id: p.id });
      toast(p.id ? 'Property updated' : 'Property added');
      await refresh();
    },
  });
}

function unitForm(propertyId, u = {}) {
  const prop = properties.find(p => p.id === propertyId);
  openModal({
    title: u.id ? `Edit ${u.label}` : `Add unit to ${prop?.name ?? 'property'}`,
    submitLabel: u.id ? 'Save changes' : 'Add unit',
    body: `
      <div class="grid-2">
        <div class="field"><label for="u-label">Unit name</label>
          <input id="u-label" name="label" required value="${esc(u.label)}" placeholder="e.g. Room 1, Flat 4, Cottage"></div>
        <div class="field"><label for="u-status">Status</label>
          <select id="u-status" name="status">${options(UNIT_STATUS, u.status || 'vacant')}</select></div>
      </div>
      <div class="grid-3">
        <div class="field"><label for="u-bed">Bedrooms</label><input id="u-bed" name="bedrooms" type="number" min="0" max="20" step="1" value="${u.bedrooms ?? 1}"></div>
        <div class="field"><label for="u-bath">Bathrooms</label><input id="u-bath" name="bathrooms" type="number" min="0" max="20" step="0.5" value="${u.bathrooms ?? 1}"></div>
        <div class="field"><label for="u-size">Size (m²)</label><input id="u-size" name="size_m2" type="number" min="1" step="1" value="${u.size_m2 ?? ''}"></div>
      </div>
      <div class="grid-2">
        <div class="field"><label for="u-rent">Monthly rent</label>
          <div class="input-prefix"><span>R</span><input id="u-rent" name="monthly_rent" type="number" min="0" step="50" required inputmode="decimal" value="${u.monthly_rent ?? ''}"></div></div>
        <div class="field"><label for="u-dep">Deposit</label>
          <div class="input-prefix"><span>R</span><input id="u-dep" name="deposit" type="number" min="0" step="50" inputmode="decimal" value="${u.deposit ?? ''}"></div>
          <div class="hint">Usually one or two months’ rent.</div></div>
      </div>
      <div class="field"><label for="u-meter">Prepaid electricity meter <span class="muted">(optional)</span></label>
        <input id="u-meter" name="prepaid_meter_number" inputmode="numeric" value="${esc(u.prepaid_meter_number)}"></div>
      <div class="field" style="display:flex;gap:20px;flex-wrap:wrap">
        <label class="check"><input type="checkbox" name="water_included" ${u.water_included ? 'checked' : ''}>Water included in rent</label>
        <label class="check"><input type="checkbox" name="electricity_included" ${u.electricity_included ? 'checked' : ''}>Electricity included in rent</label>
      </div>
      <div class="field" style="margin-bottom:0"><label for="u-notes">Notes</label><textarea id="u-notes" name="notes">${esc(u.notes)}</textarea></div>`,
    async onSubmit(form) {
      const data = formData(form);
      if (!data.label) throw new Error('Give the unit a name, like “Room 1” or “Flat 4”.');
      if (data.monthly_rent == null || data.monthly_rent < 0) throw new Error('Enter the monthly rent.');
      if (data.deposit == null) data.deposit = 0;
      if (data.bedrooms == null) data.bedrooms = 0;
      if (data.bathrooms == null) data.bathrooms = 0;
      await api.saveUnit({ ...data, id: u.id, property_id: propertyId });
      toast(u.id ? 'Unit updated' : 'Unit added');
      await refresh();
    },
  });
  // Default the deposit to one month's rent while adding.
  if (!u.id) {
    const rent = document.getElementById('u-rent'), dep = document.getElementById('u-dep');
    rent.addEventListener('input', () => { if (!dep.dataset.touched) dep.value = rent.value; });
    dep.addEventListener('input', () => { dep.dataset.touched = '1'; });
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
const findUnit = (pid, uid) => properties.find(p => p.id === pid)?.units.find(u => u.id === uid);

document.getElementById('add-property').addEventListener('click', () => propertyForm());

list.addEventListener('click', async e => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const { action, id, property } = btn.dataset;
  const p = properties.find(x => x.id === (property || id));
  try {
    if (action === 'add-property') propertyForm();
    if (action === 'edit-property') propertyForm(p);
    if (action === 'add-unit') unitForm(id);
    if (action === 'edit-unit') unitForm(property, findUnit(property, id));
    if (action === 'delete-property') {
      const n = p.units.length;
      if (await confirmDialog(`Delete ${p.name}?`, n
        ? `This also deletes its ${n} ${n === 1 ? 'unit' : 'units'}. This can’t be undone.`
        : 'This can’t be undone.')) {
        await api.deleteProperty(id); toast('Property deleted'); await refresh();
      }
    }
    if (action === 'delete-unit') {
      const u = findUnit(property, id);
      if (await confirmDialog(`Delete ${u.label}?`, `It will be removed from ${p.name}. This can’t be undone.`)) {
        await api.deleteUnit(id); toast('Unit deleted'); await refresh();
      }
    }
  } catch (ex) { toast(ex.message, 'error'); }
});

list.addEventListener('change', async e => {
  const sel = e.target.closest('select[data-action="status"]');
  if (!sel) return;
  const u = findUnit(sel.dataset.property, sel.dataset.id);
  try { await api.saveUnit({ ...u, status: sel.value }); toast(`${u.label} marked ${UNIT_STATUS[sel.value].toLowerCase()}`); await refresh(); }
  catch (ex) { toast(ex.message, 'error'); await refresh(); }
});

search.addEventListener('input', render);
statusFilter.addEventListener('change', render);

await refresh();
if (location.hash === '#new') { history.replaceState(null, '', location.pathname); propertyForm(); }
else if (location.hash.startsWith('#p-')) document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: 'start' });

api.subscribe(() => refresh());
