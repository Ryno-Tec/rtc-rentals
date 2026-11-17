// Tenant portal data. Same two backends as the landlord side:
//   live — Supabase, limited by the tenant policies in 002_tenant_portal.sql
//   demo — the shared sample data in this browser (Lerato Nkosi, Room 1)
import { signOutHere } from './session-guard.js';
import { isDemo, client, demoStore, DataError } from './data.js';
import { startOzow } from './ozow-client.js';

export const CATEGORIES = ['Plumbing', 'Electrical', 'Doors & windows', 'Appliances', 'Roof & leaks', 'Security', 'Pests', 'Other'];
export const URGENCY = {
  low: 'Can wait',
  medium: 'This week',
  high: 'As soon as possible',
  urgent: 'Emergency',
};
export const REQUEST_STATUS = {
  open: 'Logged', assigned: 'Booked', in_progress: 'In progress', resolved: 'Fixed', closed: 'Closed',
};

// Short EFT reference a tenant can type into their banking app.
export function paymentReference(unit, tenant) {
  const surname = (tenant.full_name || '').trim().split(/\s+/).pop() || 'TENANT';
  return `${unit.label.replace(/[^a-z0-9]/gi, '')}-${surname}`.toUpperCase().slice(0, 20);
}

// ============================================================================
// Live
// ============================================================================
const live = {
  async session() {
    const sb = await client();
    const { data } = await sb.auth.getSession();
    const u = data.session?.user;
    return u ? { email: u.email, role: u.user_metadata?.role || 'landlord' } : null;
  },
  async home() {
    const sb = await client();
    const t = await sb.from('tenants').select('id, full_name, email, phone, landlord_id, photo_path').single();
    if (t.error) throw new DataError('Your tenant profile isn’t linked yet. Ask your landlord to resend your invite.');
    const [lease, landlord, payments, online] = await Promise.all([
      sb.from('leases').select('*, unit:units(*, property:properties(*))').in('status', ['signed', 'active']).maybeSingle(),
      sb.from('landlords').select('full_name, phone, email, photo_path').eq('id', t.data.landlord_id).single(),
      sb.from('payments').select('*').order('period_month', { ascending: false }),
      sb.rpc('tenant_can_pay_online'),
    ]);
    for (const r of [lease, landlord, payments]) if (r.error) throw new DataError(r.error.message);
    if (!lease.data) {
      const e = new DataError('You don’t have an active lease yet. Your landlord will send it for signing.');
      e.partial = { tenant: t.data, landlord: landlord.data };   // enough for Messages and the Lease tab
      throw e;
    }
    const { unit, ...l } = lease.data;
    const { property, ...un } = unit;
    return { tenant: t.data, lease: l, unit: un, property, landlord: landlord.data, payments: payments.data,
      canPayOnline: online.error ? false : Boolean(online.data) };
  },
  async pay(paymentId) {
    return startOzow({ payment_id: paymentId });          // leaves the page for Ozow; the result comes back as ?ozow=…
  },
  async maintenance() {
    const sb = await client();
    const { data, error } = await sb.from('maintenance_requests')
      .select('*, maintenance_updates(*)').order('created_at', { ascending: false });
    if (error) throw new DataError(error.message);
    return data.map(r => ({ ...r, updates: (r.maintenance_updates || [])
      .map(x => ({ at: x.created_at, text: x.body, author: x.author || 'landlord' })).sort((a, b) => a.at.localeCompare(b.at)) }));
  },
  async logRequest(unitId, req) {
    const sb = await client();
    const { error } = await sb.from('maintenance_requests').insert({ unit_id: unitId, ...req });
    if (error) throw new DataError(error.message);
  },
  async messages() {
    const sb = await client();
    const { data, error } = await sb.from('messages').select('*').order('created_at');
    if (error) throw new DataError(error.message);
    return data;
  },
  // ---- Automatic payments ----
  async autopay(leaseId) {
    const sb = await client();
    const [o, m] = await Promise.all([sb.rpc('tenant_autopay_options'),
      sb.from('payment_mandates').select('*, mandate_collections(period_month, amount, status, completed_at)').eq('lease_id', leaseId).order('created_at', { ascending: false }).limit(1)]);
    return { options: o.data?.[0] || { ozow_capitec: false, netcash: false }, mandate: m.data?.[0] || null };
  },
  async setupAutopay(leaseId, maxAmount) {
    const sb = await client();
    const { data, error } = await sb.functions.invoke('autopay-setup', { body: { lease_id: leaseId, max_amount: maxAmount } });
    if (error) { let m = 'Couldn’t start automatic payments. Try again.'; try { m = (await error.context.json()).error || m; } catch {} throw new DataError(m); }
    return data;
  },
  async checkAutopay(mandateId) {
    const sb = await client();
    const { data } = await sb.functions.invoke('autopay-check', { body: { mandate_id: mandateId } });
    return data?.status || 'pending';
  },
  async stopAutopay(mandateId) {
    const sb = await client();
    const { error } = await sb.rpc('cancel_mandate', { p_mandate: mandateId });
    if (error) throw new DataError(error.message);
  },
  async send(tenantId, body) {
    const sb = await client();
    const { error } = await sb.from('messages').insert({ tenant_id: tenantId, sender: 'tenant', body });
    if (error) throw new DataError(error.message);
  },
  async signOut() { await signOutHere(await client()); },
  async subscribe(onChange) {
    const sb = await client();
    const ch = sb.channel('tenant')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, onChange)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'maintenance_requests' }, onChange)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'maintenance_updates' }, onChange)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'payments' }, onChange)
      .subscribe();
    return () => sb.removeChannel(ch);
  },
};

// ============================================================================
// Demo
// ============================================================================
const { load, save, emit, uid, listeners } = demoStore;
const demoLease = s => {
  const lease = (s.leases || [])[0];
  if (!lease) throw new DataError('The sample tenant’s lease is missing. Use “Reset demo data” on the landlord side.');
  const unit = s.units.find(u => u.id === lease.unit_id);
  if (!unit) throw new DataError('The sample tenant’s unit was removed. Use “Reset demo data” on the landlord side.');
  return { lease, unit, property: s.properties.find(p => p.id === unit.property_id) };
};

const demo = {
  async session() { return { email: 'lerato.n@example.co.za', role: 'tenant' }; },
  async home() {
    const s = load();
    const { lease, unit, property } = demoLease(s);
    const tenant = s.tenants.find(t => t.id === lease.tenant_id);
    return {
      tenant, lease, unit, property,
      landlord: { full_name: s.profile.full_name, phone: s.profile.phone, email: s.profile.email },
      payments: s.payments.filter(p => p.lease_id === lease.id)
        .sort((a, b) => b.period_month.localeCompare(a.period_month)),
      canPayOnline: true,
    };
  },
  async pay(paymentId) {
    const s = load();
    const p = s.payments.find(x => x.id === paymentId);
    if (!p) throw new DataError('That payment no longer exists.');
    if (p.status === 'paid') throw new DataError('This month is already paid.');
    await new Promise(r => setTimeout(r, 900));          // the Ozow round trip
    Object.assign(p, { status: 'paid', amount_paid: p.amount_due, method: 'ozow', paid_at: new Date().toISOString(),
      provider_ref: `RTC-${p.period_month.slice(0, 7).replace('-', '')}-${String(Math.floor(Math.random() * 9000) + 1000)}` });
    save(s); emit();
    return p;
  },
  async maintenance() {
    const s = load();
    const { unit } = demoLease(s);
    return (s.maintenance || []).filter(r => r.unit_id === unit.id)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  },
  async logRequest(unitId, req) {
    const s = load();
    const now = new Date().toISOString();
    s.maintenance = s.maintenance || [];
    s.maintenance.push({ id: uid(), unit_id: unitId, status: 'open', contractor: null, created_at: now, updated_at: now,
      updates: [], ...req });
    // The sample landlord acknowledges a moment later, so the timeline shows how updates arrive.
    const id = s.maintenance.at(-1).id;
    save(s); emit();
    setTimeout(() => {
      const s2 = load(); const r = (s2.maintenance || []).find(x => x.id === id);
      if (!r) return;
      r.updates.push({ at: new Date().toISOString(), text: 'Thanks, I’ve seen this and will arrange someone.' });
      save(s2); emit();
    }, 2500);
  },
  async messages() {
    const s = load();
    const { lease } = demoLease(s);
    return (s.messages || []).filter(m => m.tenant_id === lease.tenant_id)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  },
  async send(tenantId, body) {
    const s = load();
    s.messages = s.messages || [];
    s.messages.push({ id: uid(), tenant_id: tenantId, sender: 'tenant', body, created_at: new Date().toISOString() });
    save(s); emit();
  },
  async signOut() {},
  async subscribe(onChange) { listeners.add(onChange); return () => listeners.delete(onChange); },
  async autopay(leaseId) {
    const s = load();
    const m = (s.mandates || []).filter(x => x.lease_id === leaseId).sort((a, b) => b.created_at.localeCompare(a.created_at))[0] || null;
    return { options: { ozow_capitec: true, netcash: true }, mandate: m };
  },
  async setupAutopay(leaseId, maxAmount) {
    const s = load(); s.mandates = s.mandates || [];
    if (s.mandates.some(m => m.lease_id === leaseId && ['pending', 'active'].includes(m.status))) throw new DataError('Automatic payments are already set up.');
    const m = { id: uid(), lease_id: leaseId, provider: 'ozow_capitec', status: 'active', max_amount: Math.ceil(maxAmount),
      created_at: new Date().toISOString(), activated_at: new Date().toISOString(), mandate_collections: [] };
    s.mandates.push(m); save(s); emit();
    return { mandate_id: m.id, redirectUrl: null, demo: true };
  },
  async checkAutopay(id) { return (load().mandates || []).find(m => m.id === id)?.status || 'pending'; },
  async stopAutopay(id) {
    const s = load(); const m = (s.mandates || []).find(x => x.id === id);
    if (m) Object.assign(m, { status: 'cancelled', cancelled_at: new Date().toISOString() });
    save(s); emit();
  },
};

export const tenantApi = isDemo() ? demo : live;
