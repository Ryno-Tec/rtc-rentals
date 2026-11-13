// Data layer. One API, two backends:
//   live — Supabase (auth + Postgres with row-level security)
//   demo — sample data kept in this browser, same rules as the database
import { config } from './config.js';

export const configured = Boolean(config.supabaseUrl && config.supabaseAnonKey);

const DEMO_FLAG = 'rtc-rentals-demo-mode';
const DEMO_DATA = 'rtc-rentals-demo-data-v2';

// Browser storage can be missing or throw (private windows, blocked cookies).
const memory = new Map();
const store = {
  get(k, area = 'local') { try { return (area === 'local' ? localStorage : sessionStorage).getItem(k); } catch { return memory.get(area + k) ?? null; } },
  set(k, v, area = 'local') { try { (area === 'local' ? localStorage : sessionStorage).setItem(k, v); } catch { memory.set(area + k, v); } },
  del(k, area = 'local') { try { (area === 'local' ? localStorage : sessionStorage).removeItem(k); } catch { memory.delete(area + k); } },
};

export function isDemo() {
  return !configured || store.get(DEMO_FLAG, 'session') === '1';
}
export function enterDemo() { store.set(DEMO_FLAG, '1', 'session'); }
export function leaveDemo() { store.del(DEMO_FLAG, 'session'); }

export const TIERS = {
  starter: { display_name: 'Starter', price_zar: 149, max_units: 3,  max_properties: 3 },
  growth:  { display_name: 'Growth',  price_zar: 399, max_units: 10, max_properties: 10 },
  pro:     { display_name: 'Pro',     price_zar: 799, max_units: 25, max_properties: 25 },
  agency:  { display_name: 'Agency',  price_zar: null, max_units: null, max_properties: null },
};

export const PROVINCES = {
  EC: 'Eastern Cape', FS: 'Free State', GP: 'Gauteng', KZN: 'KwaZulu-Natal', LP: 'Limpopo',
  MP: 'Mpumalanga', NC: 'Northern Cape', NW: 'North West', WC: 'Western Cape',
};

export const PROPERTY_TYPES = {
  house: 'House', apartment_block: 'Apartment block', townhouse: 'Townhouse', flat: 'Flat',
  backyard_rooms: 'Backyard rooms', student_accommodation: 'Student accommodation',
  commercial: 'Commercial', other: 'Other',
};

export const UNIT_STATUS = {
  occupied: 'Occupied', vacant: 'Vacant', notice: 'On notice', maintenance: 'Maintenance',
};

export class DataError extends Error {}

// Turn database errors into something a landlord can act on.
function friendly(err, context = '') {
  const msg = err?.message || String(err);
  if (msg.includes('TIER_LIMIT:')) return new DataError(msg.split('TIER_LIMIT:')[1].trim());
  switch (err?.code) {
    case '23505': return new DataError(context === 'unit' ? 'This property already has a unit with that name.'
      : context === 'lease' ? 'That unit already has an active lease. End it first.' : 'That record already exists.');
    case '23503': return new DataError(context === 'delete'
      ? 'This has a lease linked to it, so it can’t be deleted. End the lease first.'
      : 'The linked property no longer exists. Refresh and try again.');
    case '23514': return new DataError('Some values aren’t valid. Postal codes are 4 digits and amounts can’t be negative.');
    case '42501': return new DataError('You don’t have permission to do that.');
  }
  return new DataError(msg);
}

const uid = () => (globalThis.crypto?.randomUUID?.() ??
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16);
  }));

const PROPERTY_FIELDS = ['name', 'property_type', 'street_address', 'suburb', 'city', 'province',
  'postal_code', 'erf_number', 'municipality_account', 'notes'];
const UNIT_FIELDS = ['property_id', 'label', 'bedrooms', 'bathrooms', 'size_m2', 'monthly_rent', 'deposit',
  'status', 'prepaid_meter_number', 'water_included', 'electricity_included', 'notes'];
const TENANT_FIELDS = ['full_name', 'id_number', 'email', 'phone', 'employer', 'monthly_income'];
const LEASE_FIELDS = ['unit_id', 'status', 'start_date', 'end_date', 'monthly_rent', 'deposit', 'rent_due_day', 'escalation_pct'];
const PAYMENT_FIELDS = ['amount_due', 'amount_paid', 'status', 'method', 'paid_at', 'reference', 'notes'];
export const LEASE_STATUS = { draft: 'Draft', sent: 'Sent to sign', signed: 'Signed', active: 'Active', ended: 'Ended', cancelled: 'Cancelled' };
export const PAY_METHODS = { eft: 'EFT', cash: 'Cash', ozow: 'Ozow', card: 'Card', debicheck: 'DebiCheck', other: 'Other' };
const payStatus = p => Number(p.amount_paid) >= Number(p.amount_due) && Number(p.amount_due) > 0 ? 'paid'
  : Number(p.amount_paid) > 0 ? 'partial' : 'pending';
function validateTenancy({ tenant, lease }) {
  if (!tenant.full_name?.trim()) throw new DataError('Enter the tenant’s name.');
  if (!lease.unit_id) throw new DataError('Choose the unit they rent.');
  if (!lease.start_date) throw new DataError('Enter the date the lease started.');
  if (lease.end_date && lease.end_date <= lease.start_date) throw new DataError('The end date must be after the start date.');
  if (!(Number(lease.monthly_rent) >= 0)) throw new DataError('Enter the monthly rent.');
  const d = Number(lease.rent_due_day);
  if (!(d >= 1 && d <= 28)) throw new DataError('Rent due day must be between 1 and 28.');
}
const pick = (obj, keys) => Object.fromEntries(keys.filter(k => k in obj).map(k => [k, obj[k]]));

// ============================================================================
// Live backend (Supabase)
// ============================================================================
let clientPromise;
export function client() {
  clientPromise ??= import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm')
    .then(({ createClient }) => createClient(
      // Tolerate the REST path or stray spaces the dashboard copy can include.
      config.supabaseUrl.trim().replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, ''), config.supabaseAnonKey.trim()));
  return clientPromise;
}

const live = {
  async session() {
    const sb = await client();
    const { data } = await sb.auth.getSession();
    const u = data.session?.user;
    return u ? { email: u.email, name: u.user_metadata?.full_name || '', role: u.user_metadata?.role || 'landlord' } : null;
  },
  async signIn(email, password) {
    const sb = await client();
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw new DataError(error.message === 'Invalid login credentials'
      ? 'Email or password is incorrect.' : error.message);
  },
  async signUp(email, password, fullName) {
    const sb = await client();
    const { data, error } = await sb.auth.signUp({
      email, password,
      options: { data: { full_name: fullName }, emailRedirectTo: new URL('dashboard.html', location.href).href },
    });
    if (error) throw new DataError(error.message);
    return { needsConfirmation: !data.session };
  },
  async resetPassword(email) {
    const sb = await client();
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: new URL('index.html', location.href).href });
    if (error) throw new DataError(error.message);
  },
  async updatePassword(password) {
    const sb = await client();
    const { error } = await sb.auth.updateUser({ password });
    if (error) throw new DataError(error.message);
  },
  async signOut() { const sb = await client(); await sb.auth.signOut(); },

  async profile() {
    const sb = await client();
    const { data, error } = await sb.from('landlords').select('full_name, email, tier').single();
    if (error) throw friendly(error);
    return { ...data, limits: TIERS[data.tier] };
  },
  async properties() {
    const sb = await client();
    const { data, error } = await sb.from('properties').select('*, units(*)').order('name');
    if (error) throw friendly(error);
    for (const p of data) p.units.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
    return data;
  },
  async saveProperty(p) {
    const sb = await client();
    const row = pick(p, PROPERTY_FIELDS);
    const q = p.id ? sb.from('properties').update(row).eq('id', p.id) : sb.from('properties').insert(row);
    const { data, error } = await q.select().single();
    if (error) throw friendly(error, 'property');
    return data;
  },
  async deleteProperty(id) {
    const sb = await client();
    const { error } = await sb.from('properties').delete().eq('id', id);
    if (error) throw friendly(error, 'delete');
  },
  async saveUnit(u) {
    const sb = await client();
    const row = pick(u, UNIT_FIELDS);
    const q = u.id ? sb.from('units').update(row).eq('id', u.id) : sb.from('units').insert(row);
    const { data, error } = await q.select().single();
    if (error) throw friendly(error, 'unit');
    return data;
  },
  async deleteUnit(id) {
    const sb = await client();
    const { error } = await sb.from('units').delete().eq('id', id);
    if (error) throw friendly(error, 'delete');
  },
  async tenancies() {
    const sb = await client();
    const { data, error } = await sb.from('leases')
      .select('*, tenant:tenants(*), unit:units(id, label, status, property:properties(id, name))')
      .order('start_date', { ascending: false });
    if (error) throw friendly(error);
    return data;
  },
  async saveTenancy({ tenant, lease }) {
    validateTenancy({ tenant, lease });
    const sb = await client();
    const trow = pick(tenant, TENANT_FIELDS);
    const t = tenant.id ? await sb.from('tenants').update(trow).eq('id', tenant.id).select().single()
                        : await sb.from('tenants').insert(trow).select().single();
    if (t.error) throw friendly(t.error);
    const lrow = { ...pick(lease, LEASE_FIELDS), tenant_id: t.data.id };
    const l = lease.id ? await sb.from('leases').update(lrow).eq('id', lease.id).select().single()
                       : await sb.from('leases').insert(lrow).select().single();
    if (l.error) throw friendly(l.error, 'lease');
    if (['active', 'signed'].includes(lrow.status))
      await sb.from('units').update({ status: 'occupied' }).eq('id', lrow.unit_id).eq('status', 'vacant');
    return l.data;
  },
  async payments(leaseIds) {
    if (!leaseIds.length) return [];
    const sb = await client();
    const { data, error } = await sb.from('payments').select('*').in('lease_id', leaseIds).order('period_month');
    if (error) throw friendly(error);
    return data;
  },
  async addCharges(rows) {
    if (!rows.length) return;
    const sb = await client();
    const { error } = await sb.from('payments').insert(rows.map(r => ({ ...r, status: payStatus(r) })));
    if (error) throw friendly(error);
  },
  async savePayment(p) {
    const sb = await client();
    const row = pick(p, PAYMENT_FIELDS);
    row.status = payStatus({ ...p, ...row });
    const { error } = await sb.from('payments').update(row).eq('id', p.id);
    if (error) throw friendly(error);
  },
  async subscribe(onChange) {
    const sb = await client();
    const ch = sb.channel('portfolio')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'properties' }, onChange)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'units' }, onChange)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'leases' }, onChange)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'payments' }, onChange)
      .subscribe();
    return () => sb.removeChannel(ch);
  },
};

// ============================================================================
// Demo backend (sample data in this browser)
// ============================================================================
function seed() {
  const now = new Date().toISOString();
  const p = (id, name, property_type, street_address, suburb, city, province, postal_code) =>
    ({ id, name, property_type, street_address, suburb, city, province, postal_code,
       erf_number: null, municipality_account: null, notes: null, created_at: now });
  const u = (property_id, label, bedrooms, bathrooms, monthly_rent, status, extra = {}) =>
    ({ id: uid(), property_id, label, bedrooms, bathrooms, size_m2: null, monthly_rent, deposit: monthly_rent,
       status, prepaid_meter_number: null, water_included: false, electricity_included: false, notes: null,
       created_at: now, ...extra });
  const a = uid(), b = uid(), c = uid();
  const units = [
      u(a, 'Room 1', 1, 1, 3200, 'occupied', { water_included: true, prepaid_meter_number: '04211873320' }),
      u(a, 'Room 2', 1, 1, 3200, 'occupied', { water_included: true }),
      u(a, 'Room 3', 1, 1, 3500, 'vacant', { water_included: true }),
      u(a, 'Cottage', 2, 1, 5800, 'occupied', { prepaid_meter_number: '04212345678' }),
      u(b, 'Flat 1103', 2, 1, 7900, 'notice', { size_m2: 62 }),
      u(c, 'Unit A', 3, 2, 11500, 'occupied', { size_m2: 110 }),
      u(c, 'Unit B', 3, 2, 11500, 'maintenance', { size_m2: 110, notes: 'Geyser replacement booked' }),
  ];
  return {
    ...tenantSeed(units[0], now),
    profile: { full_name: 'Thabo Mabaso', email: 'thabo@example.co.za', phone: '082 555 0142', tier: 'growth' },
    properties: [
      p(a, 'Mabaso Street rooms', 'backyard_rooms', '12 Mabaso Street', 'Orlando East', 'Soweto', 'GP', '1804'),
      p(b, 'Hatfield flat', 'flat', '1103 Hatfield Square, 1115 Burnett Street', 'Hatfield', 'Pretoria', 'GP', '0083'),
      p(c, 'Wellington Road townhouses', 'townhouse', '14 Wellington Road', 'Durbanville', 'Cape Town', 'WC', '7550'),
    ],
    units,
  };
}

// Sample tenant for the tenant portal demo: Lerato in Room 1, seven months into her lease,
// with this month's rent still to pay (due on the 25th).
function tenantSeed(unit, now) {
  const today = new Date();
  const ym = (y, m) => { const d = new Date(y, m, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`; };
  const at = (y, m, day, h = 9) => new Date(y, m, day, h).toISOString();
  const Y = today.getFullYear(), M = today.getMonth();
  const tenantId = uid(), leaseId = uid();
  const start = new Date(Y, M - 7, 1);
  const payments = [];
  for (let k = 7; k >= 1; k--) {
    const late = k === 4;
    payments.push({
      id: uid(), lease_id: leaseId, period_month: ym(Y, M - k), amount_due: 3200, amount_paid: 3200,
      status: 'paid', method: k % 3 === 0 ? 'eft' : 'ozow',
      provider_ref: `RTC-${ym(Y, M - k).slice(0, 7).replace('-', '')}-0417`,
      paid_at: late ? at(Y, M - k + 1, 2, 14) : at(Y, M - k, 23 - (k % 3)), created_at: now,
    });
  }
  payments.push({ id: uid(), lease_id: leaseId, period_month: ym(Y, M), amount_due: 3200, amount_paid: 0,
    status: 'pending', method: null, provider_ref: null, paid_at: null, created_at: now });
  const ago = d => new Date(Date.now() - d * 864e5).toISOString();
  return {
    tenants: [{ id: tenantId, full_name: 'Lerato Nkosi', email: 'lerato.n@example.co.za', phone: '071 482 9930',
      employer: 'Bara Hospital', created_at: now }],
    leases: [{ id: leaseId, unit_id: unit.id, tenant_id: tenantId, status: 'active',
      start_date: ym(start.getFullYear(), start.getMonth()), end_date: ym(start.getFullYear() + 1, start.getMonth()),
      monthly_rent: 3200, deposit: 3200, rent_due_day: 25, escalation_pct: 6, signed_at: ago(222), created_at: now }],
    payments,
    maintenance: [
      { id: uid(), unit_id: unit.id, title: 'Window latch broken', category: 'Doors & windows',
        description: 'The bedroom window won’t lock. It blows open at night when it’s windy.',
        priority: 'medium', status: 'assigned', contractor: 'Sipho (handyman)', created_at: ago(3), updated_at: ago(1),
        updates: [{ at: ago(1), text: 'Sipho will come on Saturday morning between 9 and 11.' }] },
      { id: uid(), unit_id: unit.id, title: 'Kitchen tap leaking', category: 'Plumbing',
        description: 'Tap drips constantly, even when closed tight.', priority: 'low', status: 'resolved',
        contractor: 'Mabaso Plumbing', created_at: ago(48), updated_at: ago(44), resolved_at: ago(44),
        updates: [{ at: ago(46), text: 'Plumber booked for Thursday.' }, { at: ago(44), text: 'Washer replaced. Let us know if it drips again.' }] },
    ],
    messages: [
      { id: uid(), tenant_id: tenantId, sender: 'landlord', body: 'Welcome to Room 1, Lerato! Your prepaid meter number is on the Home tab. Shout if anything needs fixing.', created_at: ago(220) },
      { id: uid(), tenant_id: tenantId, sender: 'tenant', body: 'Thank you! Quick one: is it fine if my sister stays over this weekend?', created_at: ago(30) },
      { id: uid(), tenant_id: tenantId, sender: 'landlord', body: 'Of course, no problem. Just keep the gate locked at night please.', created_at: ago(30) },
      { id: uid(), tenant_id: tenantId, sender: 'tenant', body: 'Hi, I logged the window latch. It’s the bedroom one.', created_at: ago(3) },
      { id: uid(), tenant_id: tenantId, sender: 'landlord', body: 'Got it, I’ve asked Sipho to come on Saturday morning.', created_at: ago(1) },
    ],
  };
}

function load() {
  try { const raw = store.get(DEMO_DATA); if (raw) return JSON.parse(raw); } catch { /* fall through */ }
  const s = seed(); save(s); return s;
}
function save(s) { store.set(DEMO_DATA, JSON.stringify(s)); }

const listeners = new Set();
function emit() { for (const fn of listeners) fn(); }

function validateProperty(p) {
  if (!p.name?.trim()) throw new DataError('Give the property a name.');
  if (!p.street_address?.trim() || !p.city?.trim()) throw new DataError('Street address and city are required.');
  if (!PROVINCES[p.province]) throw new DataError('Choose a province.');
  if (p.postal_code && !/^\d{4}$/.test(p.postal_code)) throw new DataError('Postal codes are 4 digits.');
}
function validateUnit(u) {
  if (!u.label?.trim()) throw new DataError('Give the unit a name, like “Room 1” or “Flat 4”.');
  if (!(u.monthly_rent >= 0)) throw new DataError('Enter the monthly rent.');
  if (u.deposit < 0) throw new DataError('Deposit can’t be negative.');
}

const demo = {
  async session() { const s = load(); return { email: s.profile.email, name: s.profile.full_name, role: 'landlord' }; },
  async signIn() {}, async signUp() { return { needsConfirmation: false }; },
  async resetPassword() {}, async updatePassword() {}, async signOut() {},

  async profile() { const s = load(); return { ...s.profile, limits: TIERS[s.profile.tier] }; },
  async properties() {
    const s = load();
    return [...s.properties].sort((x, y) => x.name.localeCompare(y.name)).map(p => ({
      ...p,
      units: s.units.filter(u => u.property_id === p.id)
        .sort((x, y) => x.label.localeCompare(y.label, undefined, { numeric: true })),
    }));
  },
  async saveProperty(p) {
    validateProperty(p);
    const s = load();
    const row = pick(p, PROPERTY_FIELDS);
    if (p.id) {
      const i = s.properties.findIndex(x => x.id === p.id);
      if (i < 0) throw new DataError('That property no longer exists.');
      s.properties[i] = { ...s.properties[i], ...row };
    } else {
      const lim = TIERS[s.profile.tier].max_properties;
      if (lim != null && s.properties.length >= lim)
        throw new DataError(`Your ${TIERS[s.profile.tier].display_name} plan allows ${lim} properties. Upgrade to add more.`);
      s.properties.push({ id: uid(), created_at: new Date().toISOString(), ...row });
    }
    save(s); emit();
  },
  async deleteProperty(id) {
    const s = load();
    const unitIds = s.units.filter(u => u.property_id === id).map(u => u.id);
    if ((s.leases || []).some(l => unitIds.includes(l.unit_id)))
      throw new DataError('A unit here has a lease linked to it, so the property can’t be deleted. End the lease first.');
    s.properties = s.properties.filter(p => p.id !== id);
    s.units = s.units.filter(u => u.property_id !== id);
    save(s); emit();
  },
  async saveUnit(u) {
    validateUnit(u);
    const s = load();
    const row = pick(u, UNIT_FIELDS);
    if (s.units.some(x => x.property_id === row.property_id && x.id !== u.id &&
        x.label.trim().toLowerCase() === row.label.trim().toLowerCase()))
      throw new DataError('This property already has a unit with that name.');
    if (u.id) {
      const i = s.units.findIndex(x => x.id === u.id);
      if (i < 0) throw new DataError('That unit no longer exists.');
      s.units[i] = { ...s.units[i], ...row };
    } else {
      const lim = TIERS[s.profile.tier].max_units;
      if (lim != null && s.units.length >= lim)
        throw new DataError(`Your ${TIERS[s.profile.tier].display_name} plan allows ${lim} units. Upgrade to add more.`);
      s.units.push({ id: uid(), created_at: new Date().toISOString(), ...row });
    }
    save(s); emit();
  },
  async deleteUnit(id) {
    const s = load();
    if ((s.leases || []).some(l => l.unit_id === id))
      throw new DataError('This unit has a lease linked to it, so it can’t be deleted. End the lease first.');
    s.units = s.units.filter(u => u.id !== id);
    save(s); emit();
  },
  async tenancies() {
    const s = load();
    return (s.leases || []).map(l => {
      const unit = s.units.find(u => u.id === l.unit_id);
      const property = unit && s.properties.find(p => p.id === unit.property_id);
      return { ...l, tenant: (s.tenants || []).find(t => t.id === l.tenant_id) || null,
        unit: unit ? { id: unit.id, label: unit.label, status: unit.status, property: property ? { id: property.id, name: property.name } : null } : null };
    }).sort((a, b) => b.start_date.localeCompare(a.start_date));
  },
  async saveTenancy({ tenant, lease }) {
    validateTenancy({ tenant, lease });
    const s = load();
    s.tenants = s.tenants || []; s.leases = s.leases || [];
    const now = new Date().toISOString();
    let t = tenant.id && s.tenants.find(x => x.id === tenant.id);
    if (t) Object.assign(t, pick(tenant, TENANT_FIELDS));
    else { t = { id: uid(), created_at: now, ...pick(tenant, TENANT_FIELDS) }; s.tenants.push(t); }
    const row = { ...pick(lease, LEASE_FIELDS), tenant_id: t.id };
    if (['active', 'signed'].includes(row.status) &&
        s.leases.some(x => x.unit_id === row.unit_id && x.id !== lease.id && ['active', 'signed'].includes(x.status)))
      throw new DataError('That unit already has an active lease. End it first.');
    let l = lease.id && s.leases.find(x => x.id === lease.id);
    if (l) Object.assign(l, row); else { l = { id: uid(), created_at: now, ...row }; s.leases.push(l); }
    if (['active', 'signed'].includes(row.status)) {
      const u = s.units.find(x => x.id === row.unit_id);
      if (u && u.status === 'vacant') u.status = 'occupied';
    }
    save(s); emit();
    return l;
  },
  async payments(leaseIds) {
    const s = load();
    return (s.payments || []).filter(p => leaseIds.includes(p.lease_id))
      .sort((a, b) => a.period_month.localeCompare(b.period_month));
  },
  async addCharges(rows) {
    const s = load();
    s.payments = s.payments || [];
    for (const r of rows) {
      if (s.payments.some(p => p.lease_id === r.lease_id && p.period_month === r.period_month)) continue;
      s.payments.push({ id: uid(), created_at: new Date().toISOString(), amount_paid: 0, method: null, paid_at: null,
        provider_ref: null, reference: null, notes: null, opening_balance: false, ...r, status: payStatus(r) });
    }
    save(s); emit();
  },
  async savePayment(p) {
    const s = load();
    const x = (s.payments || []).find(y => y.id === p.id);
    if (!x) throw new DataError('That month no longer exists. Refresh and try again.');
    Object.assign(x, pick(p, PAYMENT_FIELDS));
    x.status = payStatus(x);
    save(s); emit();
  },
  async subscribe(onChange) { listeners.add(onChange); return () => listeners.delete(onChange); },
  reset() { save(seed()); emit(); },
};

export const api = isDemo() ? demo : live;
export function resetDemo() { demo.reset(); }

// Shared with the tenant portal so both sides of the demo use the same sample data.
export const demoStore = { load, save, emit, uid, listeners };

// Portfolio maths shared by the dashboard and properties pages.
export function summarise(properties) {
  const units = properties.flatMap(p => p.units);
  const by = s => units.filter(u => u.status === s).length;
  const rentRoll = units.filter(u => u.status === 'occupied' || u.status === 'notice')
    .reduce((t, u) => t + Number(u.monthly_rent), 0);
  const potential = units.reduce((t, u) => t + Number(u.monthly_rent), 0);
  return {
    properties: properties.length,
    units: units.length,
    occupied: by('occupied'), vacant: by('vacant'), notice: by('notice'), maintenance: by('maintenance'),
    occupancy: units.length ? (by('occupied') + by('notice')) / units.length : 0,
    rentRoll, potential, vacancyLoss: potential - rentRoll,
  };
}
