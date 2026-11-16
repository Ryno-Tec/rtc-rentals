// Owner: every logged fault grouped by property, who it's assigned to, and the maintenance team.
import { api, isDemo } from './data.js';
import { maintApi as m, STATUS, PRIORITY, CATEGORIES, isOpen } from './maint-data.js';
import { mountShell, esc, icon, toast, openModal, formData, confirmDialog, money } from './shell.js';
import { contractDefaults, validateContract, buildContract, contractHtml } from './staff-contract.js';
import { printPage, fmtWhen } from './lease-ui.js';

const profile = await mountShell('maintenance.html');
const list = document.getElementById('list');
const newBtn = document.getElementById('new-fault');
newBtn.innerHTML = `${icon.plus}Log a fault`;
let requests = [], staff = [], properties = [];
const filters = { property: '', show: 'open' };

const tone = s => ({ open: 'late', assigned: 'soon', in_progress: 'info', resolved: 'ok', closed: 'muted' }[s]);
const prTone = p => ({ urgent: 'late', high: 'soon' }[p] || 'muted');
const day = s => { if (!s) return ''; const d = new Date(s.length === 10 ? s + 'T00:00' : s); return d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' }); };
const tab = () => (location.hash === '#team' ? 'team' : location.hash.startsWith('#contract-') ? 'contract' : 'faults');
const author = (u, r) => u.author === 'staff' ? (r.assigned_name || 'Maintenance') : u.author === 'tenant' ? 'Tenant' : 'You';

// ---------------------------------------------------------------------------
// Faults
// ---------------------------------------------------------------------------
function kpis() {
  const open = requests.filter(isOpen);
  const year = new Date().getFullYear();
  const spent = requests.filter(r => r.cost && new Date(r.resolved_at || r.updated_at || r.created_at).getFullYear() === year)
    .reduce((t, r) => t + Number(r.cost), 0);
  return `<div class="kpis">
    <div class="card kpi"><div class="label">Open faults</div><div class="value">${open.length}</div><div class="sub">${open.filter(r => r.status === 'in_progress').length} being worked on</div></div>
    <div class="card kpi"><div class="label">Not assigned yet</div><div class="value">${open.filter(r => !r.assigned_to).length}</div><div class="sub">Waiting for you</div></div>
    <div class="card kpi"><div class="label">Emergencies</div><div class="value">${open.filter(r => r.priority === 'urgent').length}</div><div class="sub">Open and urgent</div></div>
    <div class="card kpi"><div class="label">Spent in ${year}</div><div class="value num">${money(spent)}</div><div class="sub">Repairs with a cost recorded</div></div>
  </div>`;
}

function faultsView() {
  const rows = requests.filter(r => (!filters.property || r.unit?.property?.id === filters.property)
    && (filters.show === 'all' || (filters.show === 'open' ? isOpen(r) : !isOpen(r))));
  const byProp = new Map();
  for (const r of rows) {
    const k = r.unit?.property?.id || '-';
    if (!byProp.has(k)) byProp.set(k, { name: r.unit?.property?.name || 'Unknown property', rows: [] });
    byProp.get(k).rows.push(r);
  }
  const order = { urgent: 0, high: 1, medium: 2, low: 3 };
  return `${kpis()}
    <div class="filter-bar">
      <select id="f-prop" aria-label="Property"><option value="">All properties</option>
        ${properties.map(p => `<option value="${p.id}" ${p.id === filters.property ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
      <div class="seg" role="group" aria-label="Show">${[['open', 'Open'], ['done', 'Fixed and closed'], ['all', 'All']]
        .map(([k, l]) => `<button type="button" data-show="${k}" aria-pressed="${filters.show === k}">${l}</button>`).join('')}</div>
    </div>
    ${!rows.length ? `<div class="card empty"><h2>${filters.show === 'open' ? 'Nothing open' : 'No faults here'}</h2>
        <p>${filters.show === 'open' ? 'When a tenant reports a problem in their app, it appears here straight away.' : 'Try another filter.'}</p></div>`
      : [...byProp.values()].map(g => `<article class="card prop">
        <div class="card-head"><h2>${esc(g.name)}</h2><span class="muted">${g.rows.length} fault${g.rows.length > 1 ? 's' : ''}</span></div>
        ${g.rows.sort((a, b) => (order[a.priority] - order[b.priority]) || b.created_at.localeCompare(a.created_at)).map(r => `
          <button type="button" class="t-row fault-row" data-open="${r.id}">
            <div class="fault-main"><div class="unit-label">${esc(r.title)}</div>
              <div class="unit-sub">${esc(r.unit?.label || '')} · ${esc(r.category || 'Other')} · logged ${day(r.created_at)}${r.scheduled_for && isOpen(r) ? ` · booked ${day(r.scheduled_for)}` : ''}</div></div>
            <div class="fault-side">
              ${r.priority === 'urgent' || r.priority === 'high' ? `<span class="pill pill-${prTone(r.priority)}">${PRIORITY[r.priority]}</span>` : ''}
              <span class="fault-who">${r.assigned_name ? esc(r.assigned_name) : '<span class="muted">Not assigned</span>'}</span>
              <span class="pill pill-${tone(r.status)}">${STATUS[r.status]}</span></div>
          </button>`).join('')}
      </article>`).join('')}`;
}

const unitOptions = sel => properties.map(p => `<optgroup label="${esc(p.name)}">${p.units.map(u =>
  `<option value="${u.id}" ${u.id === sel ? 'selected' : ''}>${esc(u.label)}</option>`).join('')}</optgroup>`).join('');
const staffOptions = sel => `<option value="">Not assigned</option>${staff.filter(s => s.active || s.id === sel).map(s =>
  `<option value="${s.id}" ${s.id === sel ? 'selected' : ''}>${esc(s.full_name)}${s.trade ? ` (${esc(s.trade)})` : ''}</option>`).join('')}`;
const opts = (obj, sel) => Object.entries(obj).map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${v}</option>`).join('');

function faultForm(r) {
  const editing = Boolean(r);
  r = r || { priority: 'medium', status: 'open' };
  openModal({
    title: editing ? r.title : 'Log a fault', submitLabel: editing ? 'Save' : 'Log fault',
    body: `
      ${editing ? `<div class="fault-meta"><span class="pill pill-${tone(r.status)}">${STATUS[r.status]}</span>
          <span class="muted">${esc(r.unit?.property?.name || '')} · ${esc(r.unit?.label || '')} · logged ${fmtWhen(r.created_at)}</span></div>
          ${r.description ? `<p class="req-desc">${esc(r.description)}</p>` : ''}` : `
        <div class="field"><label for="mf-unit">Unit</label><select id="mf-unit" name="unit_id" required>${unitOptions(r.unit_id)}</select></div>
        <div class="field"><label for="mf-title">What’s wrong</label><input id="mf-title" name="title" maxlength="120" placeholder="e.g. Geyser leaking"></div>
        <div class="field"><label for="mf-desc">Details <span class="muted">(optional)</span></label><textarea id="mf-desc" name="description" rows="2" maxlength="2000"></textarea></div>
        <div class="field"><label for="mf-cat">Type</label><select id="mf-cat" name="category">${CATEGORIES.map(c => `<option>${c}</option>`).join('')}</select></div>`}
      <div class="grid-2">
        <div class="field"><label for="mf-who">Assigned to</label><select id="mf-who" name="assigned_to">${staffOptions(r.assigned_to)}</select>
          ${staff.length ? '' : '<div class="hint">Add your handyman or plumber under Team first.</div>'}</div>
        <div class="field"><label for="mf-date">Booked for <span class="muted">(optional)</span></label><input id="mf-date" name="scheduled_for" type="date" value="${esc(r.scheduled_for || '')}"></div>
      </div>
      <div class="grid-2">
        <div class="field"><label for="mf-pr">Urgency</label><select id="mf-pr" name="priority">${opts(PRIORITY, r.priority)}</select></div>
        <div class="field"><label for="mf-st">Status</label><select id="mf-st" name="status">${opts(STATUS, r.status)}</select></div>
      </div>
      ${editing ? `<div class="field"><label for="mf-cost">Cost (R) <span class="muted">(only you see this)</span></label><input id="mf-cost" name="cost" type="number" min="0" step="10" value="${r.cost ?? ''}"></div>
        <div class="field"><label for="mf-note">Add an update <span class="muted">(your tenant ${r.assigned_to ? 'and the maintenance person ' : ''}see it)</span></label>
          <textarea id="mf-note" name="note" rows="2" maxlength="2000" placeholder="e.g. Plumber coming Saturday 9 to 11"></textarea></div>
        <h3 class="form-section">Progress</h3>
        <ol class="timeline">
          <li><span class="tl-dot"></span><div><b>Logged</b><div class="unit-sub">${fmtWhen(r.created_at)}</div></div></li>
          ${r.updates.map(u => `<li><span class="tl-dot ${u.author === 'staff' ? 'tl-ok' : 'tl-ll'}"></span><div>${u.status ? `<b>${STATUS[u.status]}.</b> ` : ''}${esc(u.body)}
            <div class="unit-sub">${esc(author(u, r))} · ${fmtWhen(u.created_at)}</div></div></li>`).join('')}
        </ol>
        <p style="margin:0"><button type="button" class="btn btn-danger btn-sm" id="mf-del">${icon.trash}Delete this fault</button></p>` : ''}`,
    async onSubmit(form) {
      const f = formData(form);
      const id = await m.saveRequest({ ...(editing ? { id: r.id, unit_id: r.unit_id, title: r.title } : {}), ...f, note: undefined });
      if (f.note) await m.addUpdate(id, f.note);
      toast(editing ? 'Saved' : 'Fault logged');
      await refresh();
    },
  });
  document.getElementById('mf-del')?.addEventListener('click', async () => {
    document.querySelector('.modal-backdrop')?.remove();
    if (await confirmDialog('Delete this fault?', 'It is removed for you, your tenant and your maintenance team.', 'Delete')) {
      await m.deleteRequest(r.id); toast('Fault deleted'); await refresh();
    }
  });
}

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------
function loginState(s) {
  if (!s.active) return '<span class="badge plain tag">Inactive</span>';
  if (s.user_id) return '<span class="badge s-occupied">Uses the app</span>';
  if (s.invite && !s.invite.accepted_at && new Date(s.invite.expires_at) > new Date()) return `<span class="badge s-notice">Invited ${day(s.invite.created_at)}</span>`;
  return '<span class="badge plain tag">No login</span>';
}

function teamView() {
  const open = id => requests.filter(r => r.assigned_to === id && isOpen(r)).length;
  return `<div class="card card-pad team-intro"><div><h2>Your maintenance team</h2>
      <p class="muted" style="margin:4px 0 0">Add the people who fix things. Give them a login and they see only the jobs you assign to them, with the address and the tenant’s number, and they update the progress themselves.</p></div>
      <button class="btn" type="button" data-action="add-staff">${icon.plus}Add a person</button></div>
    ${staff.length ? `<section class="card">${staff.map(s => `
      <div class="t-row team-row">
        <div><div class="unit-label">${esc(s.full_name)} ${loginState(s)}</div>
          <div class="unit-sub">${esc(s.trade || 'Maintenance')} · ${s.is_employee ? 'Employed by you' : 'Contractor'}${s.phone ? ` · ${esc(s.phone)}` : ''} · ${open(s.id)} open job${open(s.id) === 1 ? '' : 's'}</div></div>
        <div class="prop-actions">
          ${s.active && !s.user_id ? `<button class="btn btn-sm" type="button" data-action="invite" data-id="${s.id}">${s.invite ? 'New login link' : 'Give a login'}</button>` : ''}
          ${s.is_employee ? `<a class="btn btn-ghost btn-sm" href="#contract-${s.id}">${icon.file}Contract</a>` : ''}
          <button class="btn btn-ghost btn-sm" type="button" data-action="edit-staff" data-id="${s.id}">${icon.edit}Edit</button>
        </div>
      </div>`).join('')}</section>`
    : `<div class="card empty"><h2>No one on your team yet</h2><p>Add your handyman, caretaker, plumber or electrician.</p></div>`}`;
}

function staffForm(s) {
  const editing = Boolean(s);
  s = s || { is_employee: false, active: true };
  openModal({
    title: editing ? `Edit ${s.full_name}` : 'Add a person to your team', submitLabel: editing ? 'Save' : 'Add',
    body: `
      <div class="field"><label for="sf-name">Name or company</label><input id="sf-name" name="full_name" maxlength="120" value="${esc(s.full_name || '')}"></div>
      <div class="field"><label for="sf-trade">Trade</label><input id="sf-trade" name="trade" maxlength="80" list="trades" value="${esc(s.trade || '')}" placeholder="e.g. Handyman">
        <datalist id="trades">${['Handyman', 'Caretaker', 'Plumber', 'Electrician', 'Gardener', 'Painter', 'Locksmith', 'Pest control'].map(t => `<option>${t}</option>`).join('')}</datalist></div>
      <div class="grid-2">
        <div class="field"><label for="sf-phone">Phone</label><input id="sf-phone" name="phone" type="tel" maxlength="30" value="${esc(s.phone || '')}"></div>
        <div class="field"><label for="sf-email">Email <span class="muted">(for their login)</span></label><input id="sf-email" name="email" type="email" maxlength="200" value="${esc(s.email || '')}"></div>
      </div>
      <label class="check" style="margin-bottom:10px"><input type="checkbox" name="is_employee" ${s.is_employee ? 'checked' : ''}> <span>I employ this person directly (not a contractor). You can then make their employment contract.</span></label>
      ${editing ? `<label class="check"><input type="checkbox" name="active" ${s.active ? 'checked' : ''}> <span>Active. Untick when they stop working for you: their login stops showing your jobs.</span></label>
        <div class="invite-actions" style="margin:14px 0 0">
          ${s.user_id ? '<button type="button" class="btn btn-ghost btn-sm" id="sf-nologin">Remove their login</button>' : ''}
          <button type="button" class="btn btn-danger btn-sm" id="sf-del">${icon.trash}Delete</button></div>` : ''}`,
    async onSubmit(form) {
      const f = formData(form);
      await m.saveStaff({ id: s.id, ...f, active: editing ? f.active : true, contract: s.contract ?? null });
      toast(editing ? 'Saved' : `${f.full_name} added`); await refresh();
    },
  });
  document.getElementById('sf-del')?.addEventListener('click', async () => {
    document.querySelector('.modal-backdrop')?.remove();
    if (await confirmDialog(`Delete ${s.full_name}?`, 'Their jobs stay, but become unassigned. To keep their history, untick Active instead.', 'Delete')) {
      await m.deleteStaff(s.id); toast('Deleted'); await refresh();
    }
  });
  document.getElementById('sf-nologin')?.addEventListener('click', async () => {
    document.querySelector('.modal-backdrop')?.remove();
    if (await confirmDialog('Remove their login?', 'They can no longer see your jobs. You can give them a new login later.', 'Remove login')) {
      await m.removeLogin(s.id); toast('Login removed'); await refresh();
    }
  });
}

async function invite(s) {
  const link = await m.createStaffInvite(s.id);
  const text = `Hi ${s.full_name.split(' ')[0]}, ${profile.full_name || 'I'} added you to the RTC Rentals maintenance team. Open this link to set up your login and see your jobs: ${link}`;
  openModal({
    title: `Login link for ${s.full_name}`, submitLabel: 'Done', cancel: false,
    body: `<p style="margin-top:0">Send this link. They create a password and see only the jobs you assign to them. It works once and expires in 14 days.</p>
      <div class="field"><label for="st-link">Link</label><input id="st-link" readonly value="${esc(link)}"></div>
      <div class="invite-actions">
        <button type="button" class="btn" id="st-copy">Copy link</button>
        <a class="btn btn-ghost" target="_blank" rel="noopener" href="https://wa.me/${(s.phone || '').replace(/\D/g, '').replace(/^0/, '27')}?text=${encodeURIComponent(text)}">WhatsApp</a>
        ${s.email ? `<a class="btn btn-ghost" href="mailto:${esc(s.email)}?subject=${encodeURIComponent('Your RTC Rentals maintenance login')}&body=${encodeURIComponent(text)}">Email</a>` : ''}
      </div>
      <p class="hint" style="margin-bottom:0">The link is shown once. If it gets lost, make a new one.${isDemo() ? ' In the demo the link doesn’t work; use “See what your maintenance person sees” instead.' : ''}</p>`,
    async onSubmit() {},
  });
  document.getElementById('st-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(link); toast('Link copied'); } catch { document.getElementById('st-link').select(); }
  });
  await refresh();
}

// ---------------------------------------------------------------------------
// Employment contract
// ---------------------------------------------------------------------------
function contractView(id) {
  const s = staff.find(x => x.id === id);
  if (!s) return '<div class="card empty"><h2>Not found</h2><p><a href="#team">Back to your team</a></p></div>';
  const doc = s.contract ? contractHtml(buildContract(s.contract)) : '';
  return `<a class="back no-print" href="#team">← Team</a>
    <div class="doc-bar no-print"><div class="doc-bar-title">Employment contract · ${esc(s.full_name)}</div>
      <div class="doc-bar-actions"><button class="btn ${s.contract ? 'btn-ghost' : ''}" type="button" data-action="contract-edit" data-id="${s.id}">${icon.edit}${s.contract ? 'Edit details' : 'Fill in the details'}</button>
        ${s.contract ? `<button class="btn" type="button" data-action="print">${icon.file}Print or save as PDF</button>` : ''}</div></div>
    <div class="notice no-print">For someone you employ directly: a caretaker, handyman, gardener or domestic worker. It follows the Basic Conditions of Employment Act and the rules for domestic workers. Print two copies, explain it in a language they understand, and both sign. Register them for UIF (uFiling) and with the Compensation Fund.</div>
    ${doc || `<div class="card empty"><h2>No contract yet</h2><p>Fill in the hours, wage and leave, and the contract is written for you.</p></div>`}`;
}

function contractForm(s) {
  const previous = staff.find(x => x.contract && x.id !== s.id)?.contract || {};
  const v = s.contract || contractDefaults(s, profile, previous);
  const f = (id, label, name, attrs = '') => `<div class="field"><label for="${id}">${label}</label><input id="${id}" name="${name}" value="${esc(v[name] ?? '')}" ${attrs}></div>`;
  openModal({
    title: `Contract for ${s.full_name}`, submitLabel: 'Write the contract',
    body: `<h3 class="form-section">Employer (you)</h3>
      <div class="grid-2">${f('cf-en', 'Name', 'employer_name')}${f('cf-ei', 'ID or registration number', 'employer_id_number', 'autocomplete="off"')}</div>
      ${f('cf-ea', 'Address', 'employer_address')}
      <div class="grid-2">${f('cf-ep', 'Phone', 'employer_phone', 'type="tel"')}${f('cf-ee', 'Email', 'employer_email', 'type="email"')}</div>
      <h3 class="form-section">Employee</h3>
      <div class="grid-2">${f('cf-wn', 'Name', 'employee_name')}${f('cf-wi', 'ID or passport number', 'employee_id_number', 'autocomplete="off"')}</div>
      ${f('cf-wa', 'Address', 'employee_address')}
      <div class="grid-2">${f('cf-wp', 'Phone', 'employee_phone', 'type="tel"')}${f('cf-we', 'Email', 'employee_email', 'type="email"')}</div>
      <h3 class="form-section">The job</h3>
      <div class="grid-2">${f('cf-jt', 'Job title', 'job_title')}${f('cf-sd', 'Start date', 'start_date', 'type="date"')}</div>
      ${f('cf-wp2', 'Where they work', 'workplace', 'placeholder="e.g. 12 Mabaso Street, Orlando East, Soweto"')}
      <div class="field"><label for="cf-du">Duties <span class="muted">(one per line)</span></label><textarea id="cf-du" name="duties" rows="4" maxlength="3000">${esc(v.duties || '')}</textarea></div>
      <h3 class="form-section">Hours</h3>
      <div class="grid-2">${f('cf-days', 'Days', 'days')}${f('cf-hw', 'Ordinary hours a week', 'hours_per_week', 'type="number" min="1" max="45"')}</div>
      <div class="grid-2">${f('cf-st', 'Start', 'start_time', 'type="time"')}${f('cf-et', 'Finish', 'end_time', 'type="time"')}</div>
      <div class="grid-2">${f('cf-mb', 'Meal break (minutes)', 'meal_break', 'type="number" min="30" max="120"')}${f('cf-sat', 'Saturdays <span class="muted">(optional)</span>', 'saturday', 'placeholder="e.g. 08:00 to 13:00"')}</div>
      <h3 class="form-section">Pay and leave</h3>
      <div class="grid-2">${f('cf-wage', 'Wage (R)', 'wage', 'type="number" min="0" step="10"')}
        <div class="field"><label for="cf-pp">Paid</label><select id="cf-pp" name="pay_period">${opts({ week: 'Weekly', fortnight: 'Every two weeks', month: 'Monthly' }, v.pay_period)}</select></div></div>
      <div class="grid-2"><div class="field"><label for="cf-pm">How</label><select id="cf-pm" name="pay_method">${opts({ eft: 'Bank transfer', cash: 'Cash with a payslip' }, v.pay_method)}</select></div>
        ${f('cf-ta', 'Transport allowance (R) <span class="muted">(optional)</span>', 'transport_allowance', 'type="number" min="0" step="10"')}</div>
      <div class="grid-2">${f('cf-al', 'Annual leave (working days)', 'annual_leave_days', 'type="number" min="15" max="40"')}
        <div style="align-self:center"><label class="check"><input type="checkbox" name="accommodation" ${v.accommodation ? 'checked' : ''}> <span>Accommodation provided</span></label></div></div>
      ${f('cf-av', 'Value of accommodation (R) <span class="muted">(if provided)</span>', 'accommodation_value', 'type="number" min="0" step="10"')}
      <div class="field" style="margin-bottom:0"><label for="cf-oc">Other conditions <span class="muted">(optional, one per line)</span></label><textarea id="cf-oc" name="other_conditions" rows="2" maxlength="3000">${esc(v.other_conditions || '')}</textarea></div>
      <p class="hint" style="margin-bottom:0">The wage must be at least the national minimum wage. Check the current rate at labour.gov.za.</p>`,
    async onSubmit(form) {
      const c = { ...v, ...formData(form) };
      for (const k of ['duties', 'other_conditions']) c[k] = form.elements[k].value;
      validateContract(c);
      await m.saveStaff({ ...s, contract: c });
      toast('Contract written'); await refresh();
    },
  });
}

// ---------------------------------------------------------------------------
function render() {
  const t = tab();
  newBtn.classList.toggle('hidden', t !== 'faults');
  const tabs = `<div class="page-tabs no-print" role="tablist">
    <a href="#" role="tab" aria-selected="${t === 'faults'}">Faults</a>
    <a href="#team" role="tab" aria-selected="${t !== 'faults'}">Team</a>
    <a class="demo-switch" href="staff.html">See what your maintenance person sees →</a></div>`;
  list.innerHTML = tabs + (t === 'faults' ? faultsView() : t === 'team' ? teamView() : contractView(location.hash.slice(10)));
}

async function refresh() {
  try {
    [requests, staff, properties] = await Promise.all([m.requests(), m.staff(), api.properties()]);
    render();
  } catch (e) {
    list.innerHTML = `<div class="form-error">Couldn’t load maintenance: ${esc(e.message)}${/maintenance_staff|assigned_to|schema cache|does not exist/i.test(e.message)
      ? '<br>The database is missing the latest update. Run <code>007_maintenance_team.sql</code> in the Supabase SQL Editor.' : ''}</div>`;
  }
}

newBtn.addEventListener('click', () => {
  if (!properties.some(p => p.units.length)) return toast('Add a property and unit first.', 'error');
  faultForm(null);
});
list.addEventListener('click', async e => {
  const o = e.target.closest('[data-open]');
  if (o) return faultForm(requests.find(r => r.id === o.dataset.open));
  const sh = e.target.closest('[data-show]');
  if (sh) { filters.show = sh.dataset.show; return render(); }
  const a = e.target.closest('[data-action]');
  if (!a) return;
  const s = staff.find(x => x.id === a.dataset.id);
  try {
    if (a.dataset.action === 'add-staff') staffForm(null);
    if (a.dataset.action === 'edit-staff') staffForm(s);
    if (a.dataset.action === 'invite') await invite(s);
    if (a.dataset.action === 'contract-edit') contractForm(s);
    if (a.dataset.action === 'print') printPage();
  } catch (ex) { toast(ex.message, 'error'); }
});
list.addEventListener('change', e => { if (e.target.id === 'f-prop') { filters.property = e.target.value; render(); } });
window.addEventListener('hashchange', render);
m.subscribe(() => refresh()).catch(() => {});
await refresh();
