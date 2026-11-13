import { api, PAY_METHODS, PROVINCES } from './data.js';
import { mountShell, esc, money, icon, toast, openModal, formData } from './shell.js';
import { monthKey, addMonths, monthLabel, today, rentFor, currentRent, chargeMonths, dueDate,
  chargeState, STATE_LABEL, balance, eftReference } from './ledger.js';

const profile = await mountShell('rent.html');
const view = document.getElementById('view');

let tenancies = [], payments = [], properties = [];
const showAll = new Set();
const fmtDate = d => d ? new Date(d.slice(0, 10) + 'T00:00:00').toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
const stateBadge = st => `<span class="badge ${{ paid: 's-occupied', partial: 's-notice', overdue: 's-vacant', due: 's-notice', upcoming: 'plain tag' }[st]}">${STATE_LABEL[st]}</span>`;
const isLive = l => ['active', 'signed'].includes(l.status);
const forLease = l => payments.filter(p => p.lease_id === l.id);

// ---------------------------------------------------------------------------
// Keep each lease's months up to date. A brand-new lease with history waits for
// the landlord to say which earlier months were already paid.
// ---------------------------------------------------------------------------
function needsSetup(l) {
  return !forLease(l).length && chargeMonths(l).length > 1;
}
async function fillMissing() {
  const rows = [];
  for (const l of tenancies) {
    if (!isLive(l) || needsSetup(l)) continue;
    const have = new Set(forLease(l).map(p => p.period_month));
    for (const m of chargeMonths(l)) if (!have.has(m)) rows.push({ lease_id: l.id, period_month: m, amount_due: rentFor(l, m), amount_paid: 0 });
  }
  if (rows.length) { await api.addCharges(rows); payments = await api.payments(tenancies.map(l => l.id)); }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function render() {
  const liveLeases = tenancies.filter(isLive);
  if (!tenancies.length) {
    view.innerHTML = `<div class="card empty"><h2>No tenants yet</h2>
      <p>Add your tenant and their lease first. Their rent shows up here month by month.</p>
      <a class="btn" href="tenants.html#new">${icon.plus}Add tenant</a></div>`;
    return;
  }
  const thisMonth = monthKey(new Date());
  const monthRows = payments.filter(p => p.period_month === thisMonth && liveLeases.some(l => l.id === p.lease_id));
  const dueNow = monthRows.reduce((t, p) => t + Number(p.amount_due), 0);
  const inNow = monthRows.reduce((t, p) => t + Number(p.amount_paid), 0);
  const owed = tenancies.reduce((t, l) => t + Math.max(0, balance(forLease(l).filter(p => dueDate(l, p.period_month) < today()))), 0);
  const deposits = liveLeases.reduce((t, l) => t + Number(l.deposit || 0), 0);

  view.innerHTML = `
    <div class="kpis">
      <div class="card kpi"><div class="label">Due in ${esc(monthLabel(thisMonth).split(' ')[0])}</div><div class="value num">${money(dueNow)}</div>
        <div class="sub">${liveLeases.length} active ${liveLeases.length === 1 ? 'lease' : 'leases'}</div></div>
      <div class="card kpi"><div class="label">Received this month</div><div class="value num">${money(inNow)}</div>
        <div class="sub">${dueNow ? Math.round(inNow / dueNow * 100) + '% collected' : '&nbsp;'}</div></div>
      <div class="card kpi"><div class="label">Overdue</div><div class="value num" style="${owed > 0 ? 'color:var(--red)' : ''}">${money(owed)}</div>
        <div class="sub">${owed > 0 ? 'past the due date' : 'nobody is behind'}</div></div>
      <div class="card kpi"><div class="label">Deposits held</div><div class="value num">${money(deposits)}</div>
        <div class="sub">for active leases</div></div>
    </div>
    ${tenancies.map(card).join('')}`;
}

function card(l) {
  const t = l.tenant || {}, u = l.unit || {};
  const head = `<div class="prop-head"><div class="meta">
      <h2>${esc(t.full_name || 'Tenant')}</h2>
      <div class="addr">${esc(u.label || '')}${u.property ? ' · ' + esc(u.property.name) : ''} · ${money(currentRent(l))} a month, due on the ${l.rent_due_day}${l.rent_due_day === 1 ? 'st' : l.rent_due_day === 2 ? 'nd' : l.rent_due_day === 3 ? 'rd' : 'th'}</div>
      <div class="stats"><span>EFT reference <code>${esc(eftReference(u.label, t.full_name))}</code></span></div>
    </div>
    <div class="prop-actions">
      <button class="btn btn-sm btn-ghost" type="button" data-action="statement" data-id="${l.id}">${icon.file}Statement</button>
    </div></div>`;

  if (needsSetup(l)) {
    const months = chargeMonths(l);
    const opts = [`<option value="">None, nothing paid yet</option>`, ...months.slice().reverse().map(m =>
      `<option value="${m}" ${m === addMonths(monthKey(new Date()), -1) ? 'selected' : ''}>Up to and including ${esc(monthLabel(m))}</option>`)].join('');
    return `<article class="card prop" id="l-${l.id}">${head}
      <form class="setup card-pad" data-setup="${l.id}">
        <h3 style="margin:0 0 6px">Set up the rent history</h3>
        <p class="muted" style="margin:0 0 12px">This lease started in ${esc(monthLabel(monthKey(l.start_date)))}, ${months.length} months ago.
          Tell us which months were already paid, so you only track what’s still open.</p>
        <div class="grid-2" style="align-items:end">
          <div class="field" style="margin:0"><label for="s-${l.id}">Months already paid in full</label><select id="s-${l.id}" name="through">${opts}</select></div>
          <div class="field" style="margin:0"><button class="btn" type="submit">${icon.check}Set up</button></div>
        </div>
      </form></article>`;
  }

  const rows = forLease(l).slice().sort((a, b) => b.period_month.localeCompare(a.period_month));
  const shown = showAll.has(l.id) ? rows : rows.slice(0, 12);
  const bal = balance(rows.filter(p => dueDate(l, p.period_month) < today()));
  return `<article class="card prop" id="l-${l.id}">${head}
    ${bal > 0 ? `<div class="form-error" style="margin:0 20px 12px">${money(bal)} overdue</div>` : ''}
    <div class="table-wrap"><table>
      <thead><tr><th>Month</th><th class="right">Rent</th><th class="right">Paid</th><th>Status</th><th class="hide-sm">Paid on</th><th><span class="hidden">Actions</span></th></tr></thead>
      <tbody>${shown.map(p => {
        const st = chargeState(l, p);
        return `<tr>
          <td><div class="unit-label">${esc(monthLabel(p.period_month))}</div><div class="unit-sub">due ${esc(fmtDate(dueDate(l, p.period_month)))}${p.opening_balance ? ' · before RTC Rentals' : ''}</div></td>
          <td class="right num">${money(p.amount_due)}</td>
          <td class="right num">${Number(p.amount_paid) ? money(p.amount_paid) : '<span class="muted">—</span>'}</td>
          <td>${stateBadge(st)}</td>
          <td class="hide-sm">${p.paid_at ? esc(fmtDate(p.paid_at)) + (p.method ? ` <span class="muted">· ${esc(PAY_METHODS[p.method] || p.method)}</span>` : '') : '<span class="muted">—</span>'}</td>
          <td class="actions" style="white-space:nowrap">
            ${st !== 'paid' ? `<button class="btn btn-sm" type="button" data-action="pay" data-id="${p.id}" data-lease="${l.id}">Record payment</button>` : ''}
            ${Number(p.amount_paid) && !p.opening_balance ? `<button class="btn btn-ghost btn-sm" type="button" data-action="receipt" data-id="${p.id}" data-lease="${l.id}">Receipt</button>` : ''}
            <button class="btn btn-ghost btn-icon" type="button" data-action="edit" data-id="${p.id}" data-lease="${l.id}" aria-label="Edit ${esc(monthLabel(p.period_month))}">${icon.edit}</button>
          </td></tr>`;
      }).join('')}</tbody></table></div>
    ${rows.length > 12 ? `<div class="units-empty"><button class="btn btn-ghost btn-sm" type="button" data-action="more" data-id="${l.id}">${showAll.has(l.id) ? 'Show the last 12 months' : `Show all ${rows.length} months`}</button></div>` : ''}
  </article>`;
}

let busy = null, again = false;
async function refresh() {
  if (busy) { again = true; return busy; }
  busy = (async () => { do { again = false; await load(); } while (again); })().finally(() => { busy = null; });
  return busy;
}
async function load() {
  try {
    [tenancies, properties] = await Promise.all([api.tenancies(), api.properties()]);
    payments = await api.payments(tenancies.map(l => l.id));
    await fillMissing();
    render();
  } catch (e) { view.innerHTML = `<div class="form-error">Couldn’t load rent: ${esc(e.message)}</div>`; }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function setup(l, through) {
  const rows = chargeMonths(l).map(m => {
    const due = rentFor(l, m), paid = through && m <= through;
    return { lease_id: l.id, period_month: m, amount_due: due, amount_paid: paid ? due : 0,
      method: paid ? 'eft' : null, paid_at: paid ? dueDate(l, m) + 'T12:00:00Z' : null, opening_balance: Boolean(paid) };
  });
  await api.addCharges(rows);
  toast('Rent history set up');
  await refresh();
}

function payForm(l, p) {
  const owing = Math.max(0, Number(p.amount_due) - Number(p.amount_paid));
  openModal({
    title: `Rent for ${monthLabel(p.period_month)}`,
    submitLabel: 'Record payment',
    body: `
      <p class="muted" style="margin-top:0">${esc(l.tenant?.full_name || '')} · ${money(p.amount_due)} due${Number(p.amount_paid) ? `, ${money(p.amount_paid)} already paid` : ''}.</p>
      <div class="grid-2">
        <div class="field"><label for="p-amt">Amount received</label>
          <div class="input-prefix"><span>R</span><input id="p-amt" name="amount" type="number" min="0.01" step="0.01" required inputmode="decimal" value="${owing || ''}"></div></div>
        <div class="field"><label for="p-date">Received on</label><input id="p-date" name="date" type="date" required value="${today()}" max="${today()}"></div>
      </div>
      <div class="grid-2">
        <div class="field"><label for="p-method">How</label><select id="p-method" name="method">${Object.entries(PAY_METHODS)
          .map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></div>
        <div class="field"><label for="p-ref">Bank reference <span class="muted">(optional)</span></label><input id="p-ref" name="reference" placeholder="${esc(eftReference(l.unit?.label, l.tenant?.full_name))}"></div>
      </div>
      <div class="field" style="margin-bottom:0"><label for="p-notes">Notes <span class="muted">(only you see these)</span></label><textarea id="p-notes" name="notes" rows="2">${esc(p.notes)}</textarea></div>`,
    async onSubmit(form) {
      const d = formData(form);
      if (!(d.amount > 0)) throw new Error('Enter the amount you received.');
      if (!d.date) throw new Error('Enter the date you received it.');
      await api.savePayment({ ...p, amount_paid: Math.round((Number(p.amount_paid) + d.amount) * 100) / 100,
        paid_at: d.date + 'T12:00:00Z', method: d.method, reference: d.reference ?? p.reference, notes: d.notes, opening_balance: false });
      toast(`Payment recorded for ${monthLabel(p.period_month)}`);
      await refresh();
    },
  });
}

function editForm(l, p) {
  openModal({
    title: `Edit ${monthLabel(p.period_month)}`,
    body: `
      <div class="grid-2">
        <div class="field"><label for="e-due">Rent due</label>
          <div class="input-prefix"><span>R</span><input id="e-due" name="amount_due" type="number" min="0" step="0.01" value="${Number(p.amount_due)}"></div>
          <div class="hint">Change it if this month’s rent was different, for example a discount.</div></div>
        <div class="field"><label for="e-paid">Total paid</label>
          <div class="input-prefix"><span>R</span><input id="e-paid" name="amount_paid" type="number" min="0" step="0.01" value="${Number(p.amount_paid)}"></div>
          <div class="hint">Set to 0 to undo a payment recorded by mistake.</div></div>
      </div>
      <div class="field" style="margin-bottom:0"><label for="e-notes">Notes</label><textarea id="e-notes" name="notes" rows="2">${esc(p.notes)}</textarea></div>`,
    async onSubmit(form) {
      const d = formData(form);
      const paid = d.amount_paid ?? 0;
      await api.savePayment({ ...p, amount_due: d.amount_due ?? 0, amount_paid: paid, notes: d.notes,
        ...(paid ? {} : { paid_at: null, method: null, reference: null }) });
      toast('Month updated');
      await refresh();
    },
  });
}

// Printable documents open in a new tab; the tenant gets a PDF via the browser's Save as PDF.
function printable(title, inner) {
  const w = window.open('', '_blank');
  if (!w) { toast('Allow pop-ups for this site to open the document.', 'error'); return; }
  w.document.write(`<!doctype html><html lang="en-ZA"><head><meta charset="utf-8"><title>${esc(title)}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>body{font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a;max-width:720px;margin:32px auto;padding:0 20px}
    h1{font-size:22px;margin:0 0 4px}.muted{color:#64748b}table{width:100%;border-collapse:collapse;margin-top:16px}
    th,td{text-align:left;padding:8px 6px;border-bottom:1px solid #e2e8f0}td.r,th.r{text-align:right}.total td{font-weight:700;border-top:2px solid #0f172a}
    .head{display:flex;justify-content:space-between;gap:24px;border-bottom:3px solid #1d4ed8;padding-bottom:12px;margin-bottom:16px}
    .print{margin-top:24px}@media print{.print{display:none}body{margin:0}}</style></head><body>${inner}
    <p class="print"><button onclick="print()">Print or save as PDF</button></p></body></html>`);
  w.document.close();
}
const propertyOf = l => properties.find(p => p.id === l.unit?.property?.id);
const addressOf = l => { const p = propertyOf(l); return p ? [p.street_address, p.suburb, p.city, PROVINCES[p.province], p.postal_code].filter(Boolean).join(', ') : ''; };
const docHead = (title, l) => `<div class="head"><div><h1>${esc(title)}</h1>
  <div class="muted">${esc(profile.full_name || '')}${profile.email ? ' · ' + esc(profile.email) : ''}</div></div>
  <div style="text-align:right"><b>${esc(l.tenant?.full_name || '')}</b><br>${esc(l.unit?.label || '')}<br><span class="muted">${esc(addressOf(l))}</span></div></div>`;

function receipt(l, p) {
  const no = `R-${p.period_month.slice(0, 7).replace('-', '')}-${p.id.slice(0, 4).toUpperCase()}`;
  printable(`Receipt ${no}`, `${docHead('Rent receipt', l)}
    <table><tbody>
      <tr><th>Receipt number</th><td>${no}</td></tr>
      <tr><th>Rent for</th><td>${esc(monthLabel(p.period_month))}</td></tr>
      <tr><th>Received on</th><td>${esc(fmtDate(p.paid_at))}</td></tr>
      <tr><th>Paid by</th><td>${esc(PAY_METHODS[p.method] || p.method || '')}${p.reference ? ' · ref ' + esc(p.reference) : ''}</td></tr>
      <tr><th>Rent due</th><td>${money(p.amount_due)}</td></tr>
      <tr class="total"><td>Amount received</td><td>${money(p.amount_paid)}</td></tr>
    </tbody></table>
    <p class="muted">${Number(p.amount_paid) >= Number(p.amount_due) ? `Rent for ${esc(monthLabel(p.period_month))} is paid in full. Thank you.` : `Balance for this month: ${money(Number(p.amount_due) - Number(p.amount_paid))}.`}</p>`);
}

function statement(l) {
  const rows = forLease(l).slice().sort((a, b) => a.period_month.localeCompare(b.period_month));
  let run = 0;
  const lines = rows.map(p => {
    run += Number(p.amount_due) - Number(p.amount_paid);
    return `<tr><td>${esc(monthLabel(p.period_month))}</td><td class="r">${money(p.amount_due)}</td><td class="r">${money(p.amount_paid)}</td><td>${p.paid_at ? esc(fmtDate(p.paid_at)) : ''}</td><td class="r">${money(run)}</td></tr>`;
  }).join('');
  printable(`Rent statement · ${l.tenant?.full_name || ''}`, `${docHead('Rent statement', l)}
    <p class="muted">Lease from ${esc(fmtDate(l.start_date))}${l.end_date ? ' to ' + esc(fmtDate(l.end_date)) : ''} · deposit held ${money(l.deposit)} · statement date ${esc(fmtDate(today()))}</p>
    <table><thead><tr><th>Month</th><th class="r">Rent</th><th class="r">Paid</th><th>Paid on</th><th class="r">Balance</th></tr></thead>
    <tbody>${lines}<tr class="total"><td colspan="4">Balance owing</td><td class="r">${money(run)}</td></tr></tbody></table>`);
}

view.addEventListener('submit', async e => {
  const f = e.target.closest('form[data-setup]');
  if (!f) return;
  e.preventDefault();
  f.querySelector('button').disabled = true;
  try { await setup(tenancies.find(l => l.id === f.dataset.setup), f.through.value || null); }
  catch (ex) { toast(ex.message, 'error'); f.querySelector('button').disabled = false; }
});
view.addEventListener('click', e => {
  const b = e.target.closest('button[data-action]');
  if (!b) return;
  const l = tenancies.find(x => x.id === (b.dataset.lease || b.dataset.id));
  const p = payments.find(x => x.id === b.dataset.id);
  if (b.dataset.action === 'pay') payForm(l, p);
  if (b.dataset.action === 'edit') editForm(l, p);
  if (b.dataset.action === 'receipt') receipt(l, p);
  if (b.dataset.action === 'statement') statement(l);
  if (b.dataset.action === 'more') { showAll.has(l.id) ? showAll.delete(l.id) : showAll.add(l.id); render(); }
});

await refresh();
if (location.hash.startsWith('#l-')) document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: 'start' });
api.subscribe(() => refresh());
