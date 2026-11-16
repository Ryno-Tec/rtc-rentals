// Agencies: the property owners an agency manages for, the agency's team, and owner payouts.
import { isDemo, client, demoStore, DataError } from './data.js';

const ok = r => { if (r.error) throw new DataError(r.error.code === '42P01' || /schema cache/.test(r.error.message) ? 'Run database update 015 first.' : r.error.message); return r.data; };
const OWNER_FIELDS = ['full_name', 'email', 'phone', 'fee_pct', 'fee_fixed', 'fee_vat', 'payout_note', 'notes'];
const pick = (o, ks) => Object.fromEntries(ks.filter(k => k in o).map(k => [k, o[k]]));

function checkOwner(o) {
  if (!o.full_name || o.full_name.trim().length < 2) throw new DataError('Enter the owner’s name.');
  if (o.fee_pct != null && (o.fee_pct < 0 || o.fee_pct > 50)) throw new DataError('The management fee is a percentage from 0 to 50.');
  if (o.payout_note && /\d{8,}/.test(o.payout_note.replace(/\s/g, ''))) throw new DataError('Don’t store full account numbers here. Use the last 4 digits, e.g. “FNB …1234”.');
}

const live = {
  async owners() { const sb = await client(); return ok(await sb.from('property_owners').select('*').order('full_name')); },
  async saveOwner(o) {
    checkOwner(o);
    const sb = await client(); const row = pick(o, OWNER_FIELDS);
    return ok(await (o.id ? sb.from('property_owners').update(row).eq('id', o.id) : sb.from('property_owners').insert(row)).select().single());
  },
  async deleteOwner(id) { const sb = await client(); ok(await sb.from('property_owners').delete().eq('id', id)); },
  async payouts() { const sb = await client(); return ok(await sb.from('owner_payouts').select('*').order('paid_on', { ascending: false })); },
  async addPayout(p) {
    if (!(Number(p.amount) >= 0)) throw new DataError('Enter the amount paid.');
    const sb = await client();
    ok(await sb.from('owner_payouts').insert({ owner_id: p.owner_id, period_month: p.period_month, amount: Number(p.amount), paid_on: p.paid_on, reference: p.reference || null }));
  },
  async deletePayout(id) { const sb = await client(); ok(await sb.from('owner_payouts').delete().eq('id', id)); },
  async team() {
    const sb = await client();
    const [m, admin] = await Promise.all([sb.from('agency_members').select('*').order('full_name'), sb.rpc('is_account_admin')]);
    return { members: ok(m), isAdmin: admin.data === true };
  },
  async saveMember(m) {
    const sb = await client();
    return ok(await sb.rpc('save_member', { p_id: m.id || null, p_name: m.full_name, p_email: m.email, p_role: m.role, p_active: m.active !== false }));
  },
  async removeMember(id) { const sb = await client(); ok(await sb.rpc('remove_member', { p_id: id })); },
  async inviteMember(id) {
    const sb = await client();
    const token = ok(await sb.rpc('create_member_invite', { p_member: id }));
    return new URL('member.html?t=' + encodeURIComponent(token), location.href).href;
  },
};

const { load, save, emit, uid } = demoStore;
const D = s => { s.agency = s.agency || { owners: [], payouts: [], members: [] }; return s.agency; };
const demo = {
  async owners() { const s = load(); return D(s).owners.slice().sort((a, b) => a.full_name.localeCompare(b.full_name)); },
  async saveOwner(o) {
    checkOwner(o); const s = load(), a = D(s);
    let x = o.id && a.owners.find(y => y.id === o.id);
    if (x) Object.assign(x, pick(o, OWNER_FIELDS)); else { x = { id: uid(), fee_pct: 0, fee_fixed: 0, fee_vat: false, ...pick(o, OWNER_FIELDS) }; a.owners.push(x); }
    save(s); emit(); return x;
  },
  async deleteOwner(id) { const s = load(), a = D(s); a.owners = a.owners.filter(x => x.id !== id); for (const p of s.properties) if (p.owner_id === id) p.owner_id = null; save(s); emit(); },
  async payouts() { return D(load()).payouts.slice().sort((a, b) => b.paid_on.localeCompare(a.paid_on)); },
  async addPayout(p) { if (!(Number(p.amount) >= 0)) throw new DataError('Enter the amount paid.'); const s = load(); D(s).payouts.push({ id: uid(), ...p, amount: Number(p.amount) }); save(s); emit(); },
  async deletePayout(id) { const s = load(), a = D(s); a.payouts = a.payouts.filter(x => x.id !== id); save(s); emit(); },
  async team() { return { members: D(load()).members, isAdmin: true }; },
  async saveMember(m) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(m.email || '')) throw new DataError('Enter a valid email.');
    const s = load(), a = D(s); let x = m.id && a.members.find(y => y.id === m.id);
    if (x) Object.assign(x, { full_name: m.full_name, email: m.email, role: m.role, active: m.active !== false });
    else { x = { id: uid(), full_name: m.full_name, email: m.email, role: m.role, active: true, user_id: null }; a.members.push(x); }
    save(s); emit(); return x.id;
  },
  async removeMember(id) { const s = load(), a = D(s); a.members = a.members.filter(x => x.id !== id); save(s); emit(); },
  async inviteMember(id) { const s = load(); const m = D(s).members.find(x => x.id === id); if (m) m.invited = new Date().toISOString(); save(s); emit(); return new URL('member.html?t=demo', location.href).href; },
};

export const agencyApi = isDemo() ? demo : live;

// One owner's statement for a month: rent received, costs, management fee and what is owed to them.
export function ownerStatement({ owner, month, properties, tenancies, payments, expenses, repairs, payouts }) {
  const mine = new Set(properties.filter(p => p.owner_id === owner.id).map(p => p.id));
  const inMonth = d => d && String(d).slice(0, 7) === month;
  const leaseProp = Object.fromEntries(tenancies.map(l => [l.id, l.unit?.property?.id]));
  const lines = [];
  for (const p of payments) {
    if (!mine.has(leaseProp[p.lease_id]) || !(Number(p.amount_paid) > 0) || !inMonth(p.paid_at)) continue;
    const l = tenancies.find(x => x.id === p.lease_id);
    lines.push({ kind: 'in', date: p.paid_at.slice(0, 10), text: `Rent: ${l?.tenant?.full_name || 'Tenant'}, ${l?.unit?.label || ''} (${new Date(p.period_month + 'T12:00').toLocaleDateString('en-ZA', { month: 'long', year: 'numeric' })})`, amount: Number(p.amount_paid) });
  }
  for (const e of expenses) if (mine.has(e.property_id) && inMonth(e.spent_on))
    lines.push({ kind: 'out', date: e.spent_on, text: e.description || e.category, amount: Number(e.amount) });
  for (const r of repairs) { const when = r.resolved_at || r.updated_at; if (mine.has(r.unit?.property?.id) && Number(r.cost) > 0 && inMonth(when))
    lines.push({ kind: 'out', date: when.slice(0, 10), text: `Repair: ${r.title}`, amount: Number(r.cost) }); }
  lines.sort((a, b) => a.date.localeCompare(b.date));
  const rent = lines.filter(l => l.kind === 'in').reduce((t, l) => t + l.amount, 0);
  const costs = lines.filter(l => l.kind === 'out').reduce((t, l) => t + l.amount, 0);
  const feeEx = rent > 0 ? Math.round((rent * Number(owner.fee_pct || 0) / 100 + Number(owner.fee_fixed || 0)) * 100) / 100 : 0;
  const vat = owner.fee_vat ? Math.round(feeEx * 0.15 * 100) / 100 : 0;
  const due = Math.round((rent - costs - feeEx - vat) * 100) / 100;
  const paid = payouts.filter(p => p.owner_id === owner.id && String(p.period_month).slice(0, 7) === month).reduce((t, p) => t + Number(p.amount), 0);
  return { lines, rent, costs, fee: feeEx, vat, due, paid, balance: Math.round((due - paid) * 100) / 100, properties: properties.filter(p => mine.has(p.id)) };
}
