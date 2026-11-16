import { api, isDemo, PROVINCES } from './data.js';
import { docsApi } from './docs-data.js';
import { mountShell, esc, icon, toast, openModal, formData, confirmDialog } from './shell.js';
import { buildLease, leaseDefaults } from './lease-template.js';
import { docHtml, docBadge, waitingOn, partyActions, runPartyAction, printButton, fmtWhen } from './lease-ui.js';

const profile = await mountShell('leases.html');
const docs = docsApi('landlord');
const list = document.getElementById('list');
let tenancies = [], properties = [], leaseDocs = [];

const live = l => ['active', 'signed', 'draft', 'sent'].includes(l.status);
const docsFor = leaseId => leaseDocs.filter(d => d.lease_id === leaseId);
// The document that matters for a lease: the one in progress, else the latest signed one.
const currentDoc = leaseId => { const ds = docsFor(leaseId); return ds.find(d => ['draft', 'sent'].includes(d.status)) || ds.find(d => d.status === 'signed') || null; };
const fullUnit = l => { for (const p of properties) { const u = p.units.find(x => x.id === l.unit?.id); if (u) return { unit: u, property: p }; } return {}; };

function listView() {
  const rows = tenancies.filter(live);
  if (!rows.length) {
    return `<div class="card empty"><h2>No tenants yet</h2><p>Add your tenant on Tenants &amp; leases first. Then build their lease here.</p>
      <a class="btn" href="tenants.html">${icon.users}Tenants &amp; leases</a></div>`;
  }
  return rows.map(l => {
    const d = currentDoc(l.id), t = l.tenant || {}, u = l.unit || {};
    const older = docsFor(l.id).filter(x => x !== d);
    return `<article class="card prop">
      <div class="prop-head">
        <div class="meta">
          <h2>${esc(t.full_name || 'Tenant')} ${d ? docBadge(d) : '<span class="badge plain tag">No lease in the app</span>'}</h2>
          <div class="addr">${esc(u.label || '')}${u.property ? ' · ' + esc(u.property.name) : ''}</div>
          <div class="stats"><span>${!d ? 'Build the lease from the terms you’ve already captured, then send it to sign.'
            : d.status === 'draft' ? 'Not sent yet. Check it, then send it for signing.'
            : d.status === 'sent' ? esc(waitingOn(d)) : `Signed by everyone on ${fmtWhen(d.completed_at)}.`}</span></div>
        </div>
        <div class="prop-actions">
          ${d ? `<a class="btn btn-sm" href="#d-${d.id}">${d.status === 'draft' ? 'Open draft' : d.status === 'sent' ? 'Open and sign' : 'Open lease'}</a>` : ''}
          ${!d || d.status === 'signed' ? `<button class="btn btn-sm ${d ? 'btn-ghost' : ''}" type="button" data-action="new" data-id="${l.id}">${icon.plus}${d ? 'New lease (renewal)' : 'Create lease'}</button>` : ''}
        </div>
      </div>
      ${older.length ? `<div class="older">${older.map(x => `<a class="t-row" href="#d-${x.id}"><div class="unit-sub">Earlier lease · created ${fmtWhen(x.created_at)}</div>${docBadge(x)}</a>`).join('')}</div>` : ''}
    </article>`;
  }).join('');
}

function docView(d) {
  const l = tenancies.find(x => x.id === d.lease_id) || {};
  const noApp = !isDemo() && l.tenant && !l.tenant.user_id;
  const bar = d.status === 'draft' ? `
      <button class="btn" type="button" data-action="send" data-id="${d.id}">Send for signing</button>
      <button class="btn btn-ghost" type="button" data-action="edit" data-id="${d.id}">${icon.edit}Edit details</button>
      <button class="btn btn-danger" type="button" data-action="delete" data-id="${d.id}">${icon.trash}Delete draft</button>`
    : d.status === 'sent' ? `${partyActions(d, 'landlord')}${printButton}
      <button class="btn btn-danger" type="button" data-action="void" data-id="${d.id}">Cancel signing</button>`
    : printButton;
  const note = d.status === 'draft'
    ? `<div class="notice">This lease is written around the Rental Housing Act and the Consumer Protection Act, in plain language. It is a starting point, not legal advice. Read it through, and have an attorney check it if anything about your letting is unusual.</div>`
    : d.status === 'sent' ? `<div class="notice">${esc(waitingOn(d)) || 'Everyone has signed.'} The text is locked: to change anything, cancel signing and start again.
        ${noApp ? '<br><b>Your tenant isn’t using the app yet.</b> Invite them on <a href="tenants.html">Tenants &amp; leases</a> so they can open and sign this lease.' : ' Your tenant signs in their app, under Lease.'}</div>`
    : d.status === 'void' ? '<div class="notice">This lease was cancelled before everyone signed. It is kept for your records.</div>' : '';
  return `<a class="back no-print" href="#">← All leases</a>
    <div class="doc-bar no-print"><div class="doc-bar-title">${esc(l.tenant?.full_name || 'Lease')} ${docBadge(d)}</div><div class="doc-bar-actions">${bar}</div></div>
    ${note}${docHtml(d, { audit: true })}`;
}

function render() {
  const m = location.hash.match(/^#d-(.+)$/);
  const d = m && leaseDocs.find(x => x.id === m[1]);
  list.innerHTML = d ? docView(d) : listView();
  if (m) window.scrollTo(0, 0);
}

async function refresh() {
  try {
    [tenancies, properties] = await Promise.all([api.tenancies(), api.properties()]);
    leaseDocs = await docs.leaseDocs();
    render();
  } catch (e) {
    list.innerHTML = `<div class="form-error">Couldn’t load leases: ${esc(e.message)}${/lease_documents|schema cache|does not exist/i.test(e.message)
      ? '<br>The database is missing the latest update. Run <code>006_inspections_lease_signing.sql</code> in the Supabase SQL Editor.' : ''}</div>`;
  }
}

const field = (id, label, name, v, attrs = '', hint = '') => `<div class="field"><label for="${id}">${label}</label><input id="${id}" name="${name}" value="${esc(v ?? '')}" ${attrs}>${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
const tick = (name, label, on) => `<label class="check" style="margin-bottom:12px"><input type="checkbox" name="${name}" ${on ? 'checked' : ''}> <span>${label}</span></label>`;

function leaseForm(l, doc) {
  const { unit, property } = fullUnit(l);
  const previous = leaseDocs.find(d => d.body?.inputs?.landlord_name)?.body;
  const v = doc?.body?.inputs || leaseDefaults({ lease: l, tenant: l.tenant, unit, property, profile, previous });
  openModal({
    title: doc ? 'Edit lease details' : `Lease for ${l.tenant?.full_name || 'tenant'}`, submitLabel: doc ? 'Save draft' : 'Create draft',
    body: `
      <h3 class="form-section">Landlord</h3>
      <div class="grid-2">${field('lf-ln', 'Full name or company', 'landlord_name', v.landlord_name, 'required')}${field('lf-li', 'ID or registration number', 'landlord_id_number', v.landlord_id_number, 'autocomplete="off"')}</div>
      ${field('lf-la', 'Address for notices', 'landlord_address', v.landlord_address)}
      <div class="grid-2">${field('lf-le', 'Email', 'landlord_email', v.landlord_email, 'type="email"')}${field('lf-lp', 'Phone', 'landlord_phone', v.landlord_phone, 'type="tel"')}</div>
      <h3 class="form-section">Tenant</h3>
      <div class="grid-2">${field('lf-tn', 'Full name', 'tenant_name', v.tenant_name, 'required')}${field('lf-ti', 'ID or passport number', 'tenant_id_number', v.tenant_id_number, 'autocomplete="off"')}</div>
      <div class="grid-2">${field('lf-te', 'Email', 'tenant_email', v.tenant_email, 'type="email"')}${field('lf-tp', 'Phone', 'tenant_phone', v.tenant_phone, 'type="tel"')}</div>
      <h3 class="form-section">The home</h3>
      ${field('lf-pa', 'Address', 'premises_address', v.premises_address, 'required')}
      ${field('lf-pd', 'What it has', 'premises_description', v.premises_description, '', 'For example: 3 bedrooms with built-in cupboards, 1 bathroom, lounge, kitchen with built-in cupboards.')}
      <div class="grid-2">${field('lf-pk', 'Parking <span class="muted">(optional)</span>', 'parking', v.parking)}${field('lf-mo', 'Most people who may live there', 'max_occupants', v.max_occupants, 'type="number" min="1" max="30" step="1"')}</div>
      <div class="grid-2"><div class="field"><label for="lf-pr">Province</label><select id="lf-pr" name="province">${Object.entries(PROVINCES).map(([k, n]) => `<option value="${k}" ${k === v.province ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
        <div style="align-self:center">${tick('pets_allowed', 'Pets allowed', v.pets_allowed)}</div></div>
      <h3 class="form-section">Period and rent</h3>
      <div class="grid-2">${field('lf-sd', 'Starts', 'start_date', v.start_date, 'type="date" required')}${field('lf-ed', 'Ends <span class="muted">(blank = month to month)</span>', 'end_date', v.end_date, 'type="date"')}</div>
      <div class="grid-2">${field('lf-rent', 'Monthly rent (R)', 'monthly_rent', v.monthly_rent, 'type="number" min="0" step="10" required')}${field('lf-dep', 'Deposit (R)', 'deposit', v.deposit, 'type="number" min="0" step="10"')}</div>
      <div class="grid-2">${field('lf-due', 'Rent due on day', 'rent_due_day', v.rent_due_day, 'type="number" min="1" max="31" step="1"')}${field('lf-esc', 'Yearly increase (%)', 'escalation_pct', v.escalation_pct, 'type="number" min="0" max="100" step="0.5"')}</div>
      <div class="grid-2">${field('lf-lf', 'Late payment fee (R) <span class="muted">(optional)</span>', 'late_fee', v.late_fee, 'type="number" min="0" step="10"')}${field('lf-ld', 'Charged after how many days', 'late_fee_days', v.late_fee_days, 'type="number" min="1" max="31" step="1"')}</div>
      <h3 class="form-section">Where rent is paid</h3>
      <div class="grid-2">${field('lf-bn', 'Bank', 'bank_name', v.bank_name)}${field('lf-bh', 'Account holder', 'bank_holder', v.bank_holder)}</div>
      <div class="grid-2">${field('lf-ba', 'Account number', 'bank_account', v.bank_account, 'inputmode="numeric" autocomplete="off"')}${field('lf-bb', 'Branch code', 'bank_branch', v.bank_branch, 'inputmode="numeric"')}</div>
      <div class="grid-2">${field('lf-bt', 'Account type', 'bank_type', v.bank_type, 'placeholder="e.g. Cheque"')}${field('lf-ref', 'Payment reference', 'payment_reference', v.payment_reference)}</div>
      <h3 class="form-section">Services</h3>
      ${tick('water_included', 'Water is included in the rent', v.water_included)}
      ${tick('electricity_included', 'Electricity is included in the rent', v.electricity_included)}
      ${tick('levies_by_landlord', 'There are levies, and the landlord pays them', v.levies_by_landlord)}
      ${field('lf-pm', 'Prepaid electricity meter number <span class="muted">(optional)</span>', 'prepaid_meter', v.prepaid_meter)}
      <h3 class="form-section">Extras</h3>
      <div class="field"><label for="lf-sc">Special conditions <span class="muted">(optional, one per line)</span></label><textarea id="lf-sc" name="special_conditions" rows="3" maxlength="4000">${esc(v.special_conditions)}</textarea></div>
      <div class="field" style="margin-bottom:0"><label for="lf-w">Witnesses</label><select id="lf-w" name="witnesses_per_party">
        ${[[0, 'No witnesses (the law doesn’t require them)'], [1, 'One witness each'], [2, 'Two witnesses each']].map(([k, n]) => `<option value="${k}" ${Number(v.witnesses_per_party) === k ? 'selected' : ''}>${n}</option>`).join('')}</select>
        <div class="hint">Witnesses can sign on your phone or through a secure link, without an account.</div></div>`,
    async onSubmit(form) {
      const input = formData(form);
      input.witnesses_per_party = Number(input.witnesses_per_party) || 0;
      const id = await docs.saveLeaseDoc({ id: doc?.id, lease_id: l.id, body: buildLease(input) });
      toast(doc ? 'Draft saved' : 'Draft created. Read it through, then send it.');
      await refresh();
      location.hash = `d-${id}`;
    },
  });
}

list.addEventListener('click', async e => {
  const pa = e.target.closest('[data-doc-action]');
  if (pa) {
    const d = leaseDocs.find(x => x.id === (pa.dataset.id || location.hash.slice(3)));
    await runPartyAction(pa.dataset.docAction, d, { role: 'landlord', api: docs, myName: d?.body?.parties?.landlord?.name || profile.full_name, refresh });
    return;
  }
  const a = e.target.closest('[data-action]');
  if (!a) return;
  const { action, id } = a.dataset;
  try {
    if (action === 'new') leaseForm(tenancies.find(l => l.id === id), null);
    const d = leaseDocs.find(x => x.id === id);
    if (action === 'edit') leaseForm(tenancies.find(l => l.id === d.lease_id), d);
    if (action === 'send') {
      openModal({
        title: 'Send this lease for signing?', submitLabel: 'Send for signing',
        body: `<p style="margin:0">The text is locked once it’s sent, and your tenant will see it in their app. You sign here; they sign there.${d.witnesses_per_party ? ` Each of you also needs ${d.witnesses_per_party === 1 ? 'a witness' : 'two witnesses'}.` : ''}</p>`,
        async onSubmit() { await docs.sendLeaseDoc(id); toast('Sent. You can sign now.'); await refresh(); },
      });
    }
    if (action === 'delete' && await confirmDialog('Delete this draft?', 'The draft lease is removed. The tenant and their rent records stay.', 'Delete draft')) {
      await docs.deleteLeaseDoc(id); toast('Draft deleted'); location.hash = ''; await refresh();
    }
    if (action === 'void' && await confirmDialog('Cancel signing?', 'Signatures collected so far no longer count. You can then create a new lease.', 'Cancel signing')) {
      await docs.voidLeaseDoc(id); toast('Signing cancelled'); await refresh();
    }
  } catch (ex) { toast(ex.message, 'error'); }
});

window.addEventListener('hashchange', render);
await refresh();
