// Maintenance: the owner's fault board and team, and the maintenance person's jobs.
// Live: Supabase (007_maintenance_team.sql decides who sees what). Demo: sample data in this browser.
import { isDemo, client, demoStore, DataError, demoAvatar } from './data.js';

export const STATUS = { open: 'Logged', assigned: 'Booked', in_progress: 'In progress', resolved: 'Fixed', closed: 'Closed' };
export const PRIORITY = { low: 'Can wait', medium: 'This week', high: 'As soon as possible', urgent: 'Emergency' };
export const CATEGORIES = ['Plumbing', 'Electrical', 'Doors & windows', 'Appliances', 'Roof & leaks', 'Security', 'Pests', 'Garden & outside', 'Other'];
export const staffLink = token => new URL('staff.html?t=' + encodeURIComponent(token), location.href).href;
export const isOpen = r => !['resolved', 'closed'].includes(r.status);

const ok = r => { if (r.error) throw new DataError(r.error.message); return r.data; };
const pick = (o, keys) => Object.fromEntries(keys.filter(k => k in o).map(k => [k, o[k] === '' ? null : o[k]]));
const REQ_FIELDS = ['unit_id', 'title', 'description', 'category', 'priority', 'status', 'assigned_to', 'scheduled_for', 'cost'];
const STAFF_FIELDS = ['full_name', 'trade', 'phone', 'email', 'is_employee', 'active', 'contract'];

function validateRequest(r) {
  if (!r.unit_id) throw new DataError('Choose the unit.');
  if (!r.title || r.title.trim().length < 3) throw new DataError('Describe the fault in a few words.');
  if (r.cost !== undefined && r.cost !== null && r.cost !== '' && !(Number(r.cost) >= 0)) throw new DataError('Cost must be a positive amount.');
}
function validateStaff(m) {
  if (!m.full_name || m.full_name.trim().length < 2) throw new DataError('Enter their name.');
  if (m.email && !/^\S+@\S+\.\S+$/.test(m.email)) throw new DataError('That email address doesn’t look right.');
}

// ============================================================================
// Live
// ============================================================================
const live = {
  async requests() {
    const sb = await client();
    return ok(await sb.from('maintenance_requests')
      .select('*, unit:units(id, label, property:properties(id, name)), updates:maintenance_updates(body, author, status, created_at)')
      .order('created_at', { ascending: false }))
      .map(r => ({ ...r, updates: (r.updates || []).sort((a, b) => a.created_at.localeCompare(b.created_at)) }));
  },
  async saveRequest(r) {
    validateRequest(r);
    const sb = await client();
    const row = pick(r, REQ_FIELDS);
    if (r.id) { ok(await sb.from('maintenance_requests').update(row).eq('id', r.id)); return r.id; }
    return ok(await sb.from('maintenance_requests').insert(row).select('id').single()).id;
  },
  async deleteRequest(id) { const sb = await client(); ok(await sb.from('maintenance_requests').delete().eq('id', id)); },
  async addUpdate(requestId, body, status = null) {
    const sb = await client();
    ok(await sb.from('maintenance_updates').insert({ request_id: requestId, body, author: 'landlord', status }));
  },
  async staff() {
    const sb = await client();
    const [m, inv] = await Promise.all([
      sb.from('maintenance_staff').select('*').order('active', { ascending: false }).order('full_name'),
      sb.from('staff_invites').select('staff_id, created_at, expires_at, accepted_at').order('created_at', { ascending: false }),
    ]);
    const invites = inv.error ? [] : inv.data;
    return ok(m).map(s => ({ ...s, invite: invites.find(i => i.staff_id === s.id) || null }));
  },
  async saveStaff(m) {
    validateStaff(m);
    const sb = await client();
    const row = pick(m, STAFF_FIELDS);
    if (m.id) { ok(await sb.from('maintenance_staff').update(row).eq('id', m.id)); return m.id; }
    return ok(await sb.from('maintenance_staff').insert(row).select('id').single()).id;
  },
  async removeLogin(id) { const sb = await client(); ok(await sb.from('maintenance_staff').update({ user_id: null }).eq('id', id)); },
  async deleteStaff(id) { const sb = await client(); ok(await sb.from('maintenance_staff').delete().eq('id', id)); },
  async createStaffInvite(id) {
    const sb = await client();
    return staffLink(ok(await sb.rpc('create_staff_invite', { p_staff: id })));
  },

  // ---- The maintenance person ----
  async session() {
    const sb = await client();
    const { data } = await sb.auth.getSession();
    const u = data.session?.user;
    return u ? { email: u.email, name: u.user_metadata?.full_name || '', role: u.user_metadata?.role || 'landlord' } : null;
  },
  async me() { const sb = await client(); return ok(await sb.from('maintenance_staff').select('id, full_name, trade, landlord_id, photo_path')); },
  async jobs() { const sb = await client(); return ok(await sb.rpc('staff_jobs')); },
  async updateJob(id, status, note) {
    const sb = await client();
    ok(await sb.rpc('staff_update_job', { p_request: id, p_status: status || null, p_note: note || null }));
  },
  async invitePreview(token) {
    const sb = await client();
    return ok(await sb.rpc('staff_invite_preview', { p_token: token }))?.[0] || null;
  },
  async signUp(email, password, fullName, token) {
    const sb = await client();
    const { data, error } = await sb.auth.signUp({ email, password,
      options: { data: { full_name: fullName, role: 'staff' }, emailRedirectTo: staffLink(token) } });
    if (error) throw new DataError(error.message);
    if (data.user && !data.user.identities?.length) throw new DataError('That email already has an account. Sign in instead.');
    return { needsConfirmation: !data.session };
  },
  async signIn(email, password) {
    const sb = await client();
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw new DataError(error.message === 'Invalid login credentials' ? 'Email or password is incorrect.' : error.message);
  },
  async acceptInvite(token) {
    const sb = await client();
    ok(await sb.rpc('accept_staff_invite', { p_token: token }));
    const { data: { user } } = await sb.auth.getUser();     // Google/Apple sign-ins arrive without a role
    if (user?.user_metadata?.role !== 'staff') { await sb.auth.updateUser({ data: { role: 'staff' } }); await sb.auth.refreshSession(); }
  },
  async signOut() { const sb = await client(); await sb.auth.signOut(); },
  async subscribe(onChange) {
    const sb = await client();
    const ch = sb.channel('maintenance')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'maintenance_requests' }, onChange)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'maintenance_updates' }, onChange)
      .subscribe();
    return () => sb.removeChannel(ch);
  },
};

// ============================================================================
// Demo
// ============================================================================
const { load, save, emit, uid, listeners } = demoStore;
const now = () => new Date().toISOString();

// Older demo data (saved before the team existed) gets a team and an author on each update.
function ready(s) {
  if (!s.staff) {
    const t = now();
    s.staff = [
      { id: uid(), full_name: 'Sipho Ndlovu', trade: 'Handyman', phone: '073 210 4455', email: 'sipho.n@example.co.za', is_employee: true, active: true, user_id: 'demo', contract: null, created_at: t, photo_path: demoAvatar('SN', '#15803d') },
      { id: uid(), full_name: 'Mabaso Plumbing', trade: 'Plumber', phone: '011 938 2210', email: null, is_employee: false, active: true, user_id: null, contract: null, created_at: t },
    ];
    for (const r of s.maintenance || []) {
      const who = /plumb/i.test(r.contractor || '') ? s.staff[1] : r.contractor ? s.staff[0] : null;
      if (who) { r.assigned_to = who.id; r.assigned_name = who.full_name; }
    }
    const unitB = (s.units || []).find(u => u.label === 'Unit B');
    if (unitB) {
      const ago = d => new Date(Date.now() - d * 864e5).toISOString();
      s.maintenance = s.maintenance || [];
      s.maintenance.push({ id: uid(), unit_id: unitB.id, title: 'Geyser burst', category: 'Plumbing', priority: 'urgent',
        description: 'Water through the ceiling in the passage. Mains closed.', status: 'in_progress', cost: null,
        assigned_to: s.staff[1].id, assigned_name: s.staff[1].full_name, scheduled_for: ago(-1).slice(0, 10),
        created_at: ago(2), updated_at: ago(1),
        updates: [{ at: ago(2), text: 'Mabaso Plumbing on the way.', author: 'landlord' },
                  { at: ago(1), text: 'Old geyser removed. New 150 L unit arrives tomorrow.', author: 'staff', status: 'in_progress' }] });
    }
    save(s);
  }
  for (const r of s.maintenance || []) for (const u of r.updates || []) u.author ||= 'landlord';
  return s;
}
const S = () => ready(load());
const withUnit = (s, r) => {
  const unit = s.units.find(u => u.id === r.unit_id) || {};
  const property = s.properties.find(p => p.id === unit.property_id) || {};
  return { ...r, unit: { id: unit.id, label: unit.label, property: { id: property.id, name: property.name } },
    updates: (r.updates || []).map(u => ({ body: u.text, author: u.author, status: u.status || null, created_at: u.at }))
      .sort((a, b) => a.created_at.localeCompare(b.created_at)) };
};
const statusAfterAssign = (r, s) => {
  const m = s.staff.find(x => x.id === r.assigned_to);
  r.assigned_name = m?.full_name || null;
  if (r.assigned_to && r.status === 'open') r.status = 'assigned';
  if (!r.assigned_to && r.status === 'assigned') r.status = 'open';
  r.resolved_at = isOpen(r) ? null : (r.resolved_at || now());
};
// The demo maintenance person is the first team member with a login.
const demoMe = s => s.staff.find(m => m.user_id && m.active);

const demo = {
  async requests() { const s = S(); return (s.maintenance || []).map(r => withUnit(s, r)).sort((a, b) => b.created_at.localeCompare(a.created_at)); },
  async saveRequest(r) {
    validateRequest(r);
    const s = S(); s.maintenance = s.maintenance || [];
    let row = r.id && s.maintenance.find(x => x.id === r.id);
    if (!row) { row = { id: uid(), status: 'open', updates: [], created_at: now() }; s.maintenance.push(row); }
    Object.assign(row, pick(r, REQ_FIELDS), { updated_at: now() });
    if (row.cost !== null && row.cost !== undefined) row.cost = Number(row.cost);
    statusAfterAssign(row, s);
    save(s); emit(); return row.id;
  },
  async deleteRequest(id) { const s = S(); s.maintenance = s.maintenance.filter(r => r.id !== id); save(s); emit(); },
  async addUpdate(requestId, body, status = null) {
    const s = S(); const r = s.maintenance.find(x => x.id === requestId);
    r.updates.push({ at: now(), text: body, author: 'landlord', status }); save(s); emit();
  },
  async staff() { return S().staff.slice().sort((a, b) => Number(b.active) - Number(a.active) || a.full_name.localeCompare(b.full_name)); },
  async saveStaff(m) {
    validateStaff(m);
    const s = S();
    let row = m.id && s.staff.find(x => x.id === m.id);
    if (!row) { row = { id: uid(), active: true, user_id: null, created_at: now() }; s.staff.push(row); }
    Object.assign(row, pick(m, STAFF_FIELDS));
    for (const r of s.maintenance || []) if (r.assigned_to === row.id) r.assigned_name = row.full_name;
    save(s); emit(); return row.id;
  },
  async removeLogin(id) { const s = S(); s.staff.find(x => x.id === id).user_id = null; save(s); emit(); },
  async deleteStaff(id) {
    const s = S(); s.staff = s.staff.filter(x => x.id !== id);
    for (const r of s.maintenance || []) if (r.assigned_to === id) { r.assigned_to = null; statusAfterAssign(r, s); }
    save(s); emit();
  },
  async createStaffInvite(id) {
    const s = S(); const m = s.staff.find(x => x.id === id);
    m.invite = { created_at: now(), expires_at: new Date(Date.now() + 14 * 864e5).toISOString(), accepted_at: null };
    save(s); emit();
    return staffLink('demo-' + uid().slice(0, 8));
  },

  async session() { return { email: 'sipho.n@example.co.za', name: 'Sipho Ndlovu', role: 'staff' }; },
  async me() { const m = demoMe(S()); return m ? [m] : []; },
  async jobs() {
    const s = S(); const me = demoMe(s); if (!me) return [];
    const lease = (s.leases || [])[0], tenant = lease && s.tenants.find(t => t.id === lease.tenant_id);
    return (s.maintenance || []).filter(r => r.assigned_to === me.id).map(r => {
      const unit = s.units.find(u => u.id === r.unit_id) || {}, p = s.properties.find(x => x.id === unit.property_id) || {};
      const t = lease?.unit_id === unit.id ? tenant : null;
      return { id: r.id, title: r.title, description: r.description, category: r.category, priority: r.priority, status: r.status,
        scheduled_for: r.scheduled_for || null, created_at: r.created_at, updated_at: r.updated_at,
        unit_label: unit.label, property_name: p.name, address: [unit.label, p.street_address, p.suburb, p.city].filter(Boolean).join(', '),
        tenant_name: t?.full_name || null, tenant_phone: t?.phone || null, owner_name: s.profile.full_name, owner_phone: s.profile.phone,
        updates: (r.updates || []).map(u => ({ body: u.text, author: u.author, status: u.status || null, created_at: u.at })) };
    }).sort((a, b) => Number(!isOpen(a)) - Number(!isOpen(b)) || (a.scheduled_for || '9').localeCompare(b.scheduled_for || '9'));
  },
  async updateJob(id, status, note) {
    const s = S(); const r = s.maintenance.find(x => x.id === id);
    if (!r || r.assigned_to !== demoMe(s)?.id) throw new DataError('Job not found');
    if (r.status === 'closed') throw new DataError('The owner has closed this job');
    if (!status && !note) throw new DataError('Add a note or choose a status');
    const changed = status && status !== r.status;
    if (changed) { r.status = status; statusAfterAssign(r, s); }
    r.updates.push({ at: now(), author: 'staff', status: changed ? status : null,
      text: note || ({ in_progress: 'Work has started.', resolved: 'Work is done.' }[status] || 'Job accepted.') });
    r.updated_at = now(); save(s); emit();
  },
  async invitePreview() { return null; },
  async signUp() { throw new DataError('Accounts are switched off in the demo.'); },
  async signIn() { throw new DataError('Accounts are switched off in the demo.'); },
  async acceptInvite() { throw new DataError('Accounts are switched off in the demo.'); },
  async signOut() {},
  async subscribe(onChange) { listeners.add(onChange); return () => listeners.delete(onChange); },
};

export const maintApi = isDemo() ? demo : live;
