import { api } from './data.js';
import { docsApi, KINDS, roomTemplate } from './docs-data.js';
import { mountShell, esc, icon, toast, openModal, formData } from './shell.js';
import { mountInspection, inspectionCard } from './inspect-ui.js';

const profile = await mountShell('inspections.html');
const docs = docsApi('landlord');
const list = document.getElementById('list');
const newBtn = document.getElementById('new-inspection');
newBtn.innerHTML = `${icon.plus}New inspection`;
let tenancies = [], properties = [], inspections = [];

const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const fullUnit = l => { for (const p of properties) { const u = p.units.find(x => x.id === l?.unit?.id); if (u) return u; } return {}; };
const where = l => [l?.unit?.label, l?.unit?.property?.name].filter(Boolean).join(', ');
const open = l => !['ended', 'cancelled'].includes(l.status);

function listView() {
  const rows = tenancies.filter(l => open(l) || inspections.some(i => i.lease_id === l.id));
  if (!rows.length) return `<div class="card empty"><h2>No tenants yet</h2><p>Add your tenant on Tenants &amp; leases first, then record the condition of their home here.</p>
    <a class="btn" href="tenants.html">${icon.users}Tenants &amp; leases</a></div>`;
  return rows.map(l => {
    const mine = inspections.filter(i => i.lease_id === l.id);
    return `<article class="card prop">
      <div class="prop-head"><div class="meta"><h2>${esc(l.tenant?.full_name || 'Tenant')}</h2><div class="addr">${esc(where(l))}</div></div>
        <div class="prop-actions"><button class="btn btn-sm ${mine.length ? 'btn-ghost' : ''}" type="button" data-action="new" data-id="${l.id}">${icon.plus}New inspection</button></div></div>
      ${mine.length ? mine.map(i => inspectionCard(i, 'landlord')).join('')
        : '<div class="units-empty">No inspections yet. Do a move-in check before the tenant gets the keys, or ask the tenant to start one in their app.</div>'}
    </article>`;
  }).join('');
}

async function render() {
  const m = location.hash.match(/^#i-(.+)$/);
  newBtn.classList.toggle('hidden', Boolean(m));
  if (!m) { list.innerHTML = listView(); return; }
  list.innerHTML = '<div id="insp-host"><p class="muted">Loading…</p></div>';
  const find = () => inspections.find(i => i.id === m[1]);
  const l = tenancies.find(x => x.id === find()?.lease_id);
  window.scrollTo(0, 0);
  await mountInspection(document.getElementById('insp-host'), {
    api: docs, role: 'landlord', myName: profile.full_name, back: '#', where: where(l),
    names: { landlord: profile.full_name || 'Landlord', tenant: l?.tenant?.full_name || 'Tenant' },
    async load() { inspections = await docs.inspections(); return find(); },
    async baseline() { const i = find(); return inspections.find(x => x.lease_id === i.lease_id && x.kind === 'move_in' && x.id !== i.id) || null; },
  });
}

async function refresh() {
  try {
    [tenancies, properties] = await Promise.all([api.tenancies(), api.properties()]);
    inspections = await docs.inspections();
    await render();
  } catch (e) {
    list.innerHTML = `<div class="form-error">Couldn’t load inspections: ${esc(e.message)}${/inspection_items|inspection_photos|schema cache|does not exist/i.test(e.message)
      ? '<br>The database is missing the latest update. Run <code>006_inspections_lease_signing.sql</code> in the Supabase SQL Editor.' : ''}</div>`;
  }
}

function newInspection(leaseId) {
  const choices = tenancies.filter(open);
  if (!choices.length) { toast('Add a tenant first, on Tenants & leases.', 'error'); return; }
  const kindFor = id => inspections.some(i => i.lease_id === id && i.kind === 'move_in') ? 'move_out' : 'move_in';
  const first = leaseId || choices[0].id;
  openModal({
    title: 'New inspection', submitLabel: 'Start inspection',
    body: `
      <div class="field"><label for="ni-lease">Tenant and home</label><select id="ni-lease" name="lease_id">
        ${choices.map(l => `<option value="${l.id}" ${l.id === first ? 'selected' : ''}>${esc(l.tenant?.full_name || 'Tenant')} · ${esc(where(l))}</option>`).join('')}</select></div>
      <div class="grid-2">
        <div class="field"><label for="ni-kind">Type</label><select id="ni-kind" name="kind">
          ${Object.entries(KINDS).map(([k, v]) => `<option value="${k}" ${k === kindFor(first) ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        <div class="field"><label for="ni-date">Date of the inspection</label><input id="ni-date" name="inspected_on" type="date" value="${today()}" required></div>
      </div>
      <p class="hint" style="margin:0">The checklist is set up from the unit’s bedrooms and bathrooms. You can add or remove rooms and items afterwards. Your tenant sees it in their app and can add notes and photos too.</p>`,
    async onSubmit(form) {
      const d = formData(form);
      if (!d.inspected_on) throw new Error('Choose the date of the inspection.');
      const l = tenancies.find(x => x.id === d.lease_id);
      const id = await docs.createInspection({ ...d, rooms: roomTemplate(fullUnit(l)) });
      inspections = await docs.inspections();
      location.hash = `i-${id}`;
    },
  });
}

newBtn.addEventListener('click', () => newInspection());
list.addEventListener('click', e => { const a = e.target.closest('[data-action="new"]'); if (a) newInspection(a.dataset.id); });
window.addEventListener('hashchange', render);
await refresh();
