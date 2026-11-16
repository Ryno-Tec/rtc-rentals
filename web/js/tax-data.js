// Tax years and rental expenses for the SARS-ready reports.
// South African tax years run 1 March to the end of February; "2027" = 1 Mar 2026 – 28 Feb 2027.
import { isDemo, client, demoStore, DataError } from './data.js';

export const EXPENSE_CATEGORIES = {
  rates: 'Rates and taxes', levies: 'Levies (body corporate / HOA)', insurance: 'Building insurance',
  bond_interest: 'Bond interest (interest only)', repairs: 'Repairs and maintenance', agent_fees: 'Agent and management fees',
  advertising: 'Advertising', utilities: 'Water and electricity paid by you', legal_accounting: 'Legal and accounting fees',
  garden_security: 'Garden, cleaning and security', other: 'Other',
};

export const taxYearOf = d => { const x = new Date(typeof d === 'string' && d.length === 10 ? d + 'T12:00' : d); return x.getMonth() >= 2 ? x.getFullYear() + 1 : x.getFullYear(); };
export function taxYearRange(y) {
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return { from: `${y - 1}-03-01`, to: `${y}-02-${leap ? 29 : 28}` };
}
export const taxYearLabel = y => `${y - 1}/${String(y).slice(2)} tax year (1 March ${y - 1} – ${taxYearRange(y).to.slice(8)} February ${y})`;
export const inYear = (d, y) => { if (!d) return false; const s = String(d).slice(0, 10), r = taxYearRange(y); return s >= r.from && s <= r.to; };

const ok = r => { if (r.error) throw new DataError(r.error.message); return r.data; };
function validate(e) {
  if (!e.property_id) throw new DataError('Choose the property.');
  if (!e.spent_on) throw new DataError('Enter the date.');
  if (!EXPENSE_CATEGORIES[e.category]) throw new DataError('Choose a type.');
  if (!(Number(e.amount) > 0)) throw new DataError('Enter the amount.');
}
const FIELDS = ['property_id', 'spent_on', 'category', 'description', 'amount'];
const pick = e => Object.fromEntries(FIELDS.map(k => [k, e[k] === '' ? null : e[k]]));

const live = {
  async expenses() { const sb = await client(); return ok(await sb.from('expenses').select('*').order('spent_on', { ascending: false })); },
  async saveExpense(e) {
    validate(e);
    const sb = await client();
    if (e.id) { ok(await sb.from('expenses').update(pick(e)).eq('id', e.id)); return e.id; }
    return ok(await sb.from('expenses').insert(pick(e)).select('id').single()).id;
  },
  async deleteExpense(id) { const sb = await client(); ok(await sb.from('expenses').delete().eq('id', id)); },
};

const { load, save, emit, uid } = demoStore;
const demo = {
  async expenses() { return (load().expenses || []).slice().sort((a, b) => b.spent_on.localeCompare(a.spent_on)); },
  async saveExpense(e) {
    validate(e);
    const s = load(); s.expenses = s.expenses || [];
    let row = e.id && s.expenses.find(x => x.id === e.id);
    if (!row) { row = { id: uid(), created_at: new Date().toISOString() }; s.expenses.push(row); }
    Object.assign(row, pick(e), { amount: Number(e.amount) });
    save(s); emit(); return row.id;
  },
  async deleteExpense(id) { const s = load(); s.expenses = (s.expenses || []).filter(x => x.id !== id); save(s); emit(); },
};

export const taxApi = isDemo() ? demo : live;
