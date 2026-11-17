// Owner: rental income and expenses per SARS tax year, per property, for the ITR12 rental section.
import { fileName } from './paper.js';
import { api } from './data.js';
import { maintApi } from './maint-data.js';
import { taxApi, EXPENSE_CATEGORIES, taxYearOf, taxYearRange, taxYearLabel, inYear } from './tax-data.js';
import { mountShell, esc, icon, toast, openModal, formData, confirmDialog } from './shell.js';
import { printPage } from './lease-ui.js';

const profile = await mountShell('tax.html');
const list = document.getElementById('list');
const addBtn = document.getElementById('add-expense');
addBtn.innerHTML = `${icon.plus}Add an expense`;

const rand = n => { const v = Number(n) || 0, [w, c] = Math.abs(v).toFixed(2).split('.'); return `${v < 0 ? '−' : ''}R ${w.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')},${c}`; };
const day = s => new Date(String(s).slice(0, 10) + 'T12:00').toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' });
let year = taxYearOf(new Date());
let properties = [], tenancies = [], payments = [], repairs = [], expenses = [];

function years() {
  const dates = [...payments.map(p => p.paid_at || p.period_month), ...expenses.map(e => e.spent_on), ...tenancies.map(l => l.start_date)].filter(Boolean);
  const first = dates.length ? Math.min(...dates.map(taxYearOf)) : year;
  const now = taxYearOf(new Date()), out = [];      // always offer last year: that is the one being filed
  for (let y = now; y >= Math.min(first, year, now - 1); y--) out.push(y);
  return out;
}

// Everything that counts for one property in the chosen year.
function lines(y) {
  const propOfLease = Object.fromEntries(tenancies.map(l => [l.id, l.unit?.property?.id]));
  const rows = [];
  for (const p of payments) {
    if (Number(p.amount_paid) > 0 && inYear(p.paid_at, y)) {
      const l = tenancies.find(x => x.id === p.lease_id);
      rows.push({ kind: 'income', property: propOfLease[p.lease_id], date: p.paid_at.slice(0, 10), category: 'Rent received',
        description: `${l?.tenant?.full_name || 'Tenant'} · ${l?.unit?.label || ''} · ${new Date(p.period_month + 'T12:00').toLocaleDateString('en-ZA', { month: 'long', year: 'numeric' })}`,
        amount: Number(p.amount_paid) });
    }
  }
  for (const r of repairs) {
    const when = r.resolved_at || r.updated_at;
    if (Number(r.cost) > 0 && inYear(when, y)) rows.push({ kind: 'expense', property: r.unit?.property?.id, date: when.slice(0, 10),
      category: EXPENSE_CATEGORIES.repairs, description: `${r.title} (Maintenance)`, amount: Number(r.cost), source: 'maintenance' });
  }
  for (const e of expenses) {
    if (inYear(e.spent_on, y)) rows.push({ kind: 'expense', property: e.property_id, date: e.spent_on, category: EXPENSE_CATEGORIES[e.category],
      description: e.description || '', amount: Number(e.amount), id: e.id });
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

function view() {
  const rows = lines(year);
  const charged = payments.filter(p => inYear(p.period_month, year)).reduce((t, p) => t + Number(p.amount_due), 0);
  const income = rows.filter(r => r.kind === 'income').reduce((t, r) => t + r.amount, 0);
  const spend = rows.filter(r => r.kind === 'expense').reduce((t, r) => t + r.amount, 0);
  const props = properties.filter(p => rows.some(r => r.property === p.id) || tenancies.some(l => l.unit?.property?.id === p.id));
  const perProp = props.map(p => {
    const mine = rows.filter(r => r.property === p.id);
    const inc = mine.filter(r => r.kind === 'income').reduce((t, r) => t + r.amount, 0);
    const cats = {};
    for (const r of mine.filter(x => x.kind === 'expense')) cats[r.category] = (cats[r.category] || 0) + r.amount;
    const exp = Object.values(cats).reduce((t, v) => t + v, 0);
    return { p, inc, cats, exp, net: inc - exp };
  });
  return `
    <div class="filter-bar no-print">
      <select id="ty" aria-label="Tax year">${years().map(y => `<option value="${y}" ${y === year ? 'selected' : ''}>${taxYearLabel(y)}</option>`).join('')}</select>
      <button class="btn btn-ghost" type="button" data-action="csv">${icon.file}Download CSV</button>
      <button class="btn btn-ghost" type="button" data-action="print">${icon.file}Print or save as PDF</button>
    </div>
    <article class="printable tax-report">
      <div class="print-only"><h2>Rental income and expenses</h2><p>${esc(profile.full_name || '')} · ${taxYearLabel(year)}</p></div>
      <div class="kpis">
        <div class="card kpi"><div class="label">Rent received</div><div class="value num">${rand(income)}</div><div class="sub">Rent charged for the year: ${rand(charged)}</div></div>
        <div class="card kpi"><div class="label">Expenses</div><div class="value num">${rand(spend)}</div><div class="sub">${rows.filter(r => r.kind === 'expense').length} items</div></div>
        <div class="card kpi"><div class="label">Net rental income</div><div class="value num">${rand(income - spend)}</div><div class="sub">${income - spend < 0 ? 'A loss for the year' : 'Before tax'}</div></div>
        <div class="card kpi"><div class="label">Properties</div><div class="value">${perProp.length}</div><div class="sub">One rental schedule each</div></div>
      </div>
      ${perProp.map(({ p, inc, cats, exp, net }) => `
        <section class="card tax-prop">
          <div class="card-head"><h2>${esc(p.name)}</h2><span class="muted">${esc([p.street_address, p.suburb, p.city].filter(Boolean).join(', '))}</span></div>
          <table class="tax-table"><tbody>
            <tr class="tax-sum"><th scope="row">Gross rental income</th><td class="num">${rand(inc)}</td></tr>
            ${Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([c, v]) => `<tr><th scope="row">${esc(c)}</th><td class="num">${rand(-v)}</td></tr>`).join('')
              || '<tr><th scope="row" class="muted">No expenses recorded</th><td></td></tr>'}
            <tr class="tax-sum"><th scope="row">Total expenses</th><td class="num">${rand(-exp)}</td></tr>
            <tr class="tax-net"><th scope="row">Net rental income</th><td class="num">${rand(net)}</td></tr>
          </tbody></table>
        </section>`).join('') || '<div class="card empty"><h2>Nothing in this tax year</h2><p>Record rent on the Rent page and add expenses here.</p></div>'}
      <section class="card tax-lines">
        <div class="card-head"><h2>Every item</h2><span class="muted">${rows.length} for this year</span></div>
        ${rows.length ? `<div class="table-wrap"><table class="t-table"><thead><tr><th>Date</th><th>Property</th><th>Type</th><th class="hide-sm">Details</th><th class="right">Amount</th><th class="no-print"></th></tr></thead><tbody>
          ${rows.map(r => `<tr><td>${day(r.date)}</td><td>${esc(properties.find(p => p.id === r.property)?.name || '')}</td><td>${esc(r.category)}</td>
            <td class="hide-sm">${esc(r.description)}</td><td class="right num">${rand(r.kind === 'income' ? r.amount : -r.amount)}</td>
            <td class="actions no-print">${r.id ? `<button class="btn btn-ghost btn-icon btn-sm" type="button" data-action="edit" data-id="${r.id}" aria-label="Edit">${icon.edit}</button>` : ''}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="units-empty">No rent or expenses recorded in this tax year.</div>'}
      </section>
      <div class="notice tax-note">For the rental section (local rental income) of your ITR12: declare the gross rental income and the deductible expenses for each property. Only bond <b>interest</b> is deductible, not capital repayments, and improvements (for example a new room or carport) are not repairs. Repairs with a cost on a Maintenance job are counted automatically, so don’t add them again. This report is a record to give your tax practitioner, not tax advice.</div>
    </article>`;
}

function csv() {
  const rows = lines(year);
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const out = [['Tax year', 'Date', 'Property', 'Kind', 'Type', 'Details', 'Amount (R)'].map(q).join(',')]
    .concat(rows.map(r => [taxYearLabel(year), r.date, properties.find(p => p.id === r.property)?.name || '', r.kind === 'income' ? 'Income' : 'Expense',
      r.category, r.description, (r.kind === 'income' ? r.amount : -r.amount).toFixed(2)].map(q).join(',')));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + out.join('\r\n')], { type: 'text/csv' }));
  a.download = `RTC-Rentals-tax-${year - 1}-${String(year).slice(2)}.csv`;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function expenseForm(e) {
  const editing = Boolean(e);
  const r = taxYearRange(year), today = new Date().toISOString().slice(0, 10);
  e = e || { spent_on: today <= r.to && today >= r.from ? today : r.to, category: 'rates', property_id: properties[0]?.id };
  openModal({
    title: editing ? 'Edit expense' : 'Add an expense', submitLabel: editing ? 'Save' : 'Add',
    body: `
      <div class="field"><label for="ex-prop">Property</label><select id="ex-prop" name="property_id">${properties.map(p => `<option value="${p.id}" ${p.id === e.property_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
      <div class="grid-2">
        <div class="field"><label for="ex-cat">Type</label><select id="ex-cat" name="category">${Object.entries(EXPENSE_CATEGORIES).map(([k, v]) => `<option value="${k}" ${k === e.category ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        <div class="field"><label for="ex-date">Date paid</label><input id="ex-date" name="spent_on" type="date" value="${esc(e.spent_on || '')}"></div>
      </div>
      <div class="grid-2">
        <div class="field"><label for="ex-amt">Amount (R)</label><input id="ex-amt" name="amount" type="number" min="0" step="0.01" value="${e.amount ?? ''}"></div>
        <div class="field"><label for="ex-desc">Details <span class="muted">(optional)</span></label><input id="ex-desc" name="description" maxlength="200" value="${esc(e.description || '')}" placeholder="e.g. City of Tshwane, March"></div>
      </div>
      <p class="hint" style="margin:0">Keep the slip or invoice: SARS can ask for proof for five years.</p>
      ${editing ? '<p style="margin:12px 0 0"><button type="button" class="btn btn-danger btn-sm" id="ex-del">Delete</button></p>' : ''}`,
    async onSubmit(form) { await taxApi.saveExpense({ id: e.id, ...formData(form) }); toast(editing ? 'Saved' : 'Expense added'); await refresh(); },
  });
  document.getElementById('ex-del')?.addEventListener('click', async () => {
    document.querySelector('.modal-backdrop')?.remove();
    if (await confirmDialog('Delete this expense?', 'It is removed from your tax report.', 'Delete')) { await taxApi.deleteExpense(e.id); toast('Deleted'); await refresh(); }
  });
}

async function refresh() {
  try {
    [properties, tenancies, repairs, expenses] = await Promise.all([api.properties(), api.tenancies(),
      maintApi.requests().catch(() => []), taxApi.expenses()]);
    payments = await api.payments(tenancies.map(l => l.id));
    list.innerHTML = view();
  } catch (e) {
    list.innerHTML = `<div class="form-error">Couldn’t load the tax report: ${esc(e.message)}${/expenses|schema cache|does not exist/i.test(e.message)
      ? '<br>The database is missing the latest update. Run <code>008_photos_tax_social.sql</code> in the Supabase SQL Editor.' : ''}</div>`;
  }
}

addBtn.addEventListener('click', () => properties.length ? expenseForm(null) : toast('Add a property first.', 'error'));
list.addEventListener('change', e => { if (e.target.id === 'ty') { year = Number(e.target.value); list.innerHTML = view(); } });
list.addEventListener('click', e => {
  const a = e.target.closest('[data-action]'); if (!a) return;
  if (a.dataset.action === 'csv') csv();
  if (a.dataset.action === 'print') printPage(fileName('TaxReport', profile.full_name, `${year - 1}-${String(year).slice(2)}`));
  if (a.dataset.action === 'edit') expenseForm(expenses.find(x => x.id === a.dataset.id));
});
await refresh();
