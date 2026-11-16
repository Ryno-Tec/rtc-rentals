// Inspections and lease documents. Used by the owner pages, the tenant app and the witness
// page. The same calls serve both parties: on the live backend the database decides what
// each one may see and do (006_inspections_lease_signing.sql); the demo backend mirrors
// those rules on the sample data in this browser.
import { isDemo, client, demoStore, DataError } from './data.js';

export const KINDS = { move_in: 'Move-in', move_out: 'Move-out', routine: 'Routine check' };
export const CONDITIONS = { good: 'Good', fair: 'Fair', poor: 'Damaged', na: 'N/A' };
export const DOC_STATUS = { draft: 'Draft', sent: 'Out for signing', signed: 'Signed', void: 'Cancelled' };

export const bothConfirmed = i => Boolean(i.landlord_signed_at && i.tenant_signed_at);
export const witnessLink = token => new URL('witness.html?t=' + encodeURIComponent(token), location.href).href;

// The rooms and items a new inspection starts with, from the size of the unit.
export function roomTemplate(unit = {}) {
  const room = ['Walls and paint', 'Floor', 'Ceiling and lights', 'Windows and curtain rails', 'Door and lock', 'Plugs and switches'];
  const beds = Math.max(0, Number(unit.bedrooms) || 0), baths = Math.max(1, Math.floor(Number(unit.bathrooms) || 1));
  const out = [
    ['Entrance and security', ['Front door, lock and keys', 'Security gate and burglar bars', 'Intercom, remote or access tag', 'Keys and remotes handed over (say how many)']],
    [beds ? 'Lounge' : 'Main room', room],
    ['Kitchen', ['Walls and paint', 'Floor', 'Ceiling and lights', 'Cupboards and counters', 'Sink and taps', 'Stove and oven', 'Plugs and switches', 'Window']],
  ];
  for (let n = 1; n <= beds; n++) out.push([beds === 1 ? 'Bedroom' : `Bedroom ${n}`, [...room, 'Built-in cupboards']]);
  for (let n = 1; n <= baths; n++) out.push([baths === 1 ? 'Bathroom' : `Bathroom ${n}`,
    ['Walls and tiles', 'Floor', 'Toilet', 'Basin and taps', 'Bath or shower', 'Mirror and fittings', 'Hot water (geyser)', 'Window and ventilation']]);
  out.push(['Outside and meters', ['Electricity meter (note the reading)', 'Water meter (note the reading)', 'Parking or garage', 'Garden, yard or balcony']]);
  return out.map(([name, items]) => ({ room: name, items }));
}

// Shrink a camera photo before upload: phones produce 3–8 MB files, a record needs about 300 KB.
export async function compressImage(file, max = 1600, quality = 0.8) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new DataError('That file isn’t a photo this device can open. Try taking it again.'));
      im.src = url;
    });
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * scale));
    c.height = Math.max(1, Math.round(img.naturalHeight * scale));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', quality));
    if (!blob) throw new DataError('Couldn’t prepare that photo. Try again.');
    return { blob, dataUrl: () => c.toDataURL('image/jpeg', quality) };
  } finally { URL.revokeObjectURL(url); }
}

const sortInspection = i => {
  i.items = (i.items || []).sort((a, b) => a.sort - b.sort || a.created_at.localeCompare(b.created_at));
  i.photos = (i.photos || []).sort((a, b) => a.created_at.localeCompare(b.created_at));
  return i;
};
const sortDoc = d => { d.signatures = (d.signatures || []).sort((a, b) => a.signed_at.localeCompare(b.signed_at)); return d; };
const ok = r => { if (r.error) throw new DataError(r.error.message); return r.data; };
const ITEM_FIELDS = ['room', 'item', 'condition', 'landlord_note', 'tenant_note', 'sort'];
const pick = (o, keys) => Object.fromEntries(keys.filter(k => k in o).map(k => [k, o[k]]));

// ============================================================================
// Live
// ============================================================================
const live = {
  async inspections() {
    const sb = await client();
    return ok(await sb.from('inspections').select('*, items:inspection_items(*), photos:inspection_photos(*)')
      .order('created_at', { ascending: false })).map(sortInspection);
  },
  async createInspection({ lease_id, kind, inspected_on, rooms }) {
    const sb = await client();
    const insp = ok(await sb.from('inspections').insert({ lease_id, kind, inspected_on }).select().single());
    const rows = rooms.flatMap((r, ri) => r.items.map((item, ii) => ({ inspection_id: insp.id, room: r.room, item, sort: ri * 100 + ii })));
    if (rows.length) ok(await sb.from('inspection_items').insert(rows));
    return insp.id;
  },
  async deleteInspection(id) { const sb = await client(); ok(await sb.from('inspections').delete().eq('id', id)); },
  async saveInspection(id, patch) {
    const sb = await client(); ok(await sb.from('inspections').update(pick(patch, ['inspected_on', 'notes'])).eq('id', id));
  },
  async updateItem(id, patch) { const sb = await client(); ok(await sb.from('inspection_items').update(pick(patch, ITEM_FIELDS)).eq('id', id)); },
  async rateRoom(inspectionId, room, condition) {
    const sb = await client();
    ok(await sb.from('inspection_items').update({ condition }).eq('inspection_id', inspectionId).eq('room', room).is('condition', null));
  },
  async addItem(inspectionId, room, item, sort) {
    const sb = await client(); ok(await sb.from('inspection_items').insert({ inspection_id: inspectionId, room, item, sort }));
  },
  async deleteItem(id) { const sb = await client(); ok(await sb.from('inspection_items').delete().eq('id', id)); },
  async addPhoto(insp, itemId, file) {
    const sb = await client();
    const { blob } = await compressImage(file);
    const path = `${insp.landlord_id}/${insp.id}/${crypto.randomUUID()}.jpg`;
    const up = await sb.storage.from('inspections').upload(path, blob, { contentType: 'image/jpeg', cacheControl: '31536000' });
    if (up.error) throw new DataError(/row-level|policy|not authorized/i.test(up.error.message)
      ? 'Photos can’t be added to this inspection any more.' : `Photo upload failed: ${up.error.message}`);
    const row = await sb.from('inspection_photos').insert({ inspection_id: insp.id, item_id: itemId, path });
    if (row.error) { await sb.storage.from('inspections').remove([path]).catch(() => {}); throw new DataError(row.error.message); }
  },
  async deletePhoto(photo) {
    const sb = await client();
    ok(await sb.from('inspection_photos').delete().eq('id', photo.id));
    await sb.storage.from('inspections').remove([photo.path]).catch(() => {});   // owner only; harmless if refused
  },
  // { photo id: temporary URL } for a private bucket.
  async photoUrls(photos) {
    if (!photos.length) return {};
    const sb = await client();
    const { data, error } = await sb.storage.from('inspections').createSignedUrls(photos.map(p => p.path), 3600);
    if (error) throw new DataError(error.message);
    return Object.fromEntries(photos.map((p, i) => [p.id, data[i]?.signedUrl || '']));
  },
  async confirmInspection(id, name) { const sb = await client(); ok(await sb.rpc('confirm_inspection', { p_inspection: id, p_name: name })); },

  async leaseDocs() {
    const sb = await client();
    return ok(await sb.from('lease_documents').select('*, signatures:lease_signatures(*)').order('created_at', { ascending: false })).map(sortDoc);
  },
  async saveLeaseDoc(d) {
    const sb = await client();
    const row = { title: d.body.title, body: d.body, witnesses_per_party: d.body.witnesses_per_party || 0 };
    const q = d.id ? sb.from('lease_documents').update(row).eq('id', d.id) : sb.from('lease_documents').insert({ ...row, lease_id: d.lease_id });
    const r = await q.select().single();
    if (r.error) throw new DataError(r.error.code === '23505' ? 'This tenant already has a lease in progress. Open that one.' : r.error.message);
    return r.data.id;
  },
  async deleteLeaseDoc(id) { const sb = await client(); ok(await sb.from('lease_documents').delete().eq('id', id)); },
  async sendLeaseDoc(id) { const sb = await client(); ok(await sb.rpc('send_lease_document', { p_doc: id })); },
  async voidLeaseDoc(id) { const sb = await client(); ok(await sb.rpc('void_lease_document', { p_doc: id })); },
  async signLeaseDoc(id, name, signature) {
    const sb = await client(); ok(await sb.rpc('sign_lease_document', { p_doc: id, p_name: name, p_signature: signature }));
  },
  async addWitness(id, name, signature) {
    const sb = await client(); ok(await sb.rpc('add_lease_witness', { p_doc: id, p_name: name, p_signature: signature }));
  },
  async createWitnessLink(id) { const sb = await client(); return witnessLink(ok(await sb.rpc('create_lease_witness_link', { p_doc: id }))); },
  async witnessPreview(token) { const sb = await client(); return ok(await sb.rpc('lease_witness_preview', { p_token: token })); },
  async witnessSign(token, name, signature) {
    const sb = await client(); ok(await sb.rpc('lease_witness_sign', { p_token: token, p_name: name, p_signature: signature }));
  },
};

// ============================================================================
// Demo
// ============================================================================
const { load, save, emit, uid } = demoStore;
const now = () => new Date().toISOString();
const LOCKED = 'This inspection was confirmed by both parties and can no longer be changed';

async function fingerprint(body) {
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(body)));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  } catch { return 'demo' + uid().replace(/-/g, ''); }
}
// In the demo the tenant is the sample tenant on the first lease.
const mine = (s, role, leaseId) => role === 'landlord' || leaseId === (s.leases || [])[0]?.id;
function findInspection(s, id, role) {
  const i = (s.inspections || []).find(x => x.id === id);
  if (!i || !mine(s, role, i.lease_id)) throw new DataError('Inspection not found');
  return i;
}
function touch(i, role) {            // a change by one party means the other must confirm again
  if (bothConfirmed(i)) throw new DataError(LOCKED);
  if (role === 'landlord') { i.tenant_signed_at = null; i.tenant_signed_name = null; }
  else { i.landlord_signed_at = null; i.landlord_signed_name = null; }
}
function findDoc(s, id, role) {
  const d = (s.leaseDocs || []).find(x => x.id === id);
  if (!d || !mine(s, role, d.lease_id) || (role === 'tenant' && d.status === 'draft')) throw new DataError('Lease not found');
  return d;
}
function finishDoc(s, d) {
  const n = (role, w) => d.signatures.filter(x => w ? x.witness_for === role : x.role === role).length;
  if (d.status !== 'sent' || !n('landlord') || !n('tenant') ||
      n('landlord', true) < d.witnesses_per_party || n('tenant', true) < d.witnesses_per_party) return;
  d.status = 'signed'; d.completed_at = now();
  const l = (s.leases || []).find(x => x.id === d.lease_id);
  if (l) { l.signed_at = now(); if (['draft', 'sent'].includes(l.status)) l.status = l.start_date <= now().slice(0, 10) ? 'active' : 'signed'; }
}
function checkSignature(name, signature, who = 'Type your full name') {
  if ((name || '').trim().length < 3) throw new DataError(who);
  if (!/^data:image\/png;base64,/.test(signature || '')) throw new DataError('Draw your signature in the box');
}
function recordWitness(s, d, role, name, signature, method) {
  if (d.status !== 'sent') throw new DataError('This lease is not open for signing');
  if (!d.witnesses_per_party) throw new DataError('This lease does not ask for witnesses');
  checkSignature(name, signature, 'The witness must type their full name');
  if (!d.signatures.some(x => x.role === role)) throw new DataError(`The ${role} must sign before their witness`);
  if (d.signatures.some(x => x.role !== 'witness' && x.signer_name.trim().toLowerCase() === name.trim().toLowerCase()))
    throw new DataError('A witness can’t be one of the people signing the lease');
  if (d.signatures.filter(x => x.witness_for === role).length >= d.witnesses_per_party)
    throw new DataError(`All the witnesses for the ${role} have already signed`);
  d.signatures.push({ id: uid(), document_id: d.id, role: 'witness', witness_for: role, signer_name: name.trim(), signature,
    method, body_hash: d.body_hash, signed_at: now() });
  finishDoc(s, d);
}

const demo = {
  async inspections(role = 'landlord') {
    const s = load();
    return structuredClone((s.inspections || []).filter(i => mine(s, role, i.lease_id)))
      .sort((a, b) => b.created_at.localeCompare(a.created_at)).map(sortInspection);
  },
  async createInspection({ lease_id, kind, inspected_on, rooms }, role = 'landlord') {
    const s = load();
    s.inspections = s.inspections || [];
    const id = uid();
    s.inspections.push({ id, lease_id, landlord_id: 'demo', kind, inspected_on, notes: null, started_by: role,
      landlord_signed_at: null, landlord_signed_name: null, tenant_signed_at: null, tenant_signed_name: null, created_at: now(),
      items: rooms.flatMap((r, ri) => r.items.map((item, ii) => ({ id: uid(), inspection_id: id, room: r.room, item, condition: null,
        landlord_note: null, tenant_note: null, sort: ri * 100 + ii, created_by: role, created_at: now() }))),
      photos: [] });
    save(s); emit();
    return id;
  },
  async deleteInspection(id) {
    const s = load(); const i = findInspection(s, id, 'landlord');
    if (bothConfirmed(i)) throw new DataError(LOCKED);
    s.inspections = s.inspections.filter(x => x.id !== id); save(s); emit();
  },
  async saveInspection(id, patch) {
    const s = load(); const i = findInspection(s, id, 'landlord');
    if (bothConfirmed(i)) throw new DataError(LOCKED);
    Object.assign(i, pick(patch, ['inspected_on', 'notes'])); save(s); emit();
  },
  async updateItem(id, patch, role = 'landlord') {
    const s = load();
    const i = (s.inspections || []).find(x => x.items.some(y => y.id === id));
    if (!i) throw new DataError('That item no longer exists.');
    findInspection(s, i.id, role);
    const item = i.items.find(y => y.id === id);
    const p = pick(patch, ITEM_FIELDS);
    delete p[role === 'tenant' ? 'landlord_note' : 'tenant_note'];        // each party writes only their own note
    if (Object.keys(p).some(k => (p[k] ?? null) !== (item[k] ?? null))) { touch(i, role); Object.assign(item, p); save(s); emit(); }
  },
  async rateRoom(inspectionId, room, condition, role = 'landlord') {
    const s = load(); const i = findInspection(s, inspectionId, role);
    const todo = i.items.filter(x => x.room === room && !x.condition);
    if (!todo.length) return;
    touch(i, role); todo.forEach(x => { x.condition = condition; }); save(s); emit();
  },
  async addItem(inspectionId, room, item, sort, role = 'landlord') {
    const s = load(); const i = findInspection(s, inspectionId, role);
    touch(i, role);
    i.items.push({ id: uid(), inspection_id: i.id, room, item, condition: null, landlord_note: null, tenant_note: null, sort, created_by: role, created_at: now() });
    save(s); emit();
  },
  async deleteItem(id, role = 'landlord') {
    const s = load();
    const i = (s.inspections || []).find(x => x.items.some(y => y.id === id));
    if (!i) return;
    findInspection(s, i.id, role);
    const item = i.items.find(y => y.id === id);
    if (role === 'tenant' && item.created_by !== 'tenant') throw new DataError('Only the landlord can remove this item. Mark it “N/A” instead');
    touch(i, role);
    i.items = i.items.filter(y => y.id !== id); i.photos = i.photos.filter(p => p.item_id !== id);
    save(s); emit();
  },
  async addPhoto(insp, itemId, file, role = 'landlord') {
    const { dataUrl } = await compressImage(file, 640, 0.6);            // small: the demo keeps photos in this browser
    const s = load(); const i = findInspection(s, insp.id, role);
    touch(i, role);
    i.photos.push({ id: uid(), inspection_id: i.id, item_id: itemId, path: 'demo', url: dataUrl(), added_by: role, created_at: now() });
    try { localStorage.setItem('rtc-rentals-quota-check', '1'); localStorage.removeItem('rtc-rentals-quota-check'); } catch { /* storage off */ }
    if (JSON.stringify(s).length > 4_000_000) throw new DataError('The demo can only keep a few photos in this browser. The live app has no such limit.');
    save(s); emit();
  },
  async deletePhoto(photo, role = 'landlord') {
    const s = load(); const i = findInspection(s, photo.inspection_id, role);
    const p = i.photos.find(x => x.id === photo.id);
    if (!p) return;
    if (p.added_by !== role) throw new DataError('Only the person who added a photo can remove it');
    touch(i, role);
    i.photos = i.photos.filter(x => x.id !== photo.id); save(s); emit();
  },
  async photoUrls(photos) { return Object.fromEntries(photos.map(p => [p.id, p.url || ''])); },
  async confirmInspection(id, name, role = 'landlord') {
    const s = load(); const i = findInspection(s, id, role);
    if ((name || '').trim().length < 3) throw new DataError('Type your full name to confirm');
    if (!i.items.length) throw new DataError('Add at least one item before confirming');
    const left = i.items.filter(x => !x.condition).length;
    if (left) throw new DataError(`Rate every item before confirming (${left} still to do)`);
    i[`${role}_signed_at`] = i[`${role}_signed_at`] || now(); i[`${role}_signed_name`] = name.trim();
    save(s); emit();
  },

  async leaseDocs(role = 'landlord') {
    const s = load();
    return structuredClone((s.leaseDocs || []).filter(d => mine(s, role, d.lease_id) && (role === 'landlord' || d.status !== 'draft')))
      .sort((a, b) => b.created_at.localeCompare(a.created_at)).map(sortDoc);
  },
  async saveLeaseDoc(d) {
    const s = load(); s.leaseDocs = s.leaseDocs || [];
    const row = { title: d.body.title, body: d.body, witnesses_per_party: d.body.witnesses_per_party || 0 };
    if (d.id) {
      const x = findDoc(s, d.id, 'landlord');
      if (x.status !== 'draft') throw new DataError('This lease was already sent for signing. Cancel it and start a new one to change it');
      Object.assign(x, row); save(s); emit(); return x.id;
    }
    if (s.leaseDocs.some(x => x.lease_id === d.lease_id && ['draft', 'sent'].includes(x.status)))
      throw new DataError('This tenant already has a lease in progress. Open that one.');
    const id = uid();
    s.leaseDocs.push({ id, lease_id: d.lease_id, landlord_id: 'demo', ...row, body_hash: null, status: 'draft', sent_at: null,
      completed_at: null, created_at: now(), signatures: [] });
    save(s); emit(); return id;
  },
  async deleteLeaseDoc(id) {
    const s = load(); const d = findDoc(s, id, 'landlord');
    if (d.status !== 'draft') throw new DataError('Only a draft can be deleted');
    s.leaseDocs = s.leaseDocs.filter(x => x.id !== id); save(s); emit();
  },
  async sendLeaseDoc(id) {
    const s = load(); const d = findDoc(s, id, 'landlord');
    if (d.status !== 'draft') throw new DataError('This lease was already sent');
    d.body_hash = await fingerprint(d.body); d.status = 'sent'; d.sent_at = now();
    const l = (s.leases || []).find(x => x.id === d.lease_id); if (l?.status === 'draft') l.status = 'sent';
    save(s); emit();
  },
  async voidLeaseDoc(id) {
    const s = load(); const d = findDoc(s, id, 'landlord');
    if (d.status !== 'sent') throw new DataError('Only a lease that is out for signing can be cancelled');
    d.status = 'void';
    const l = (s.leases || []).find(x => x.id === d.lease_id); if (l?.status === 'sent') l.status = 'draft';
    save(s); emit();
  },
  async signLeaseDoc(id, name, signature, role = 'landlord') {
    const s = load(); const d = findDoc(s, id, role);
    if (d.status !== 'sent') throw new DataError('This lease is not open for signing');
    checkSignature(name, signature);
    if (d.signatures.some(x => x.role === role)) throw new DataError('You have already signed this lease');
    d.signatures.push({ id: uid(), document_id: d.id, role, witness_for: null, signer_name: name.trim(), signature, method: 'account',
      body_hash: d.body_hash, signed_at: now() });
    finishDoc(s, d); save(s); emit();
  },
  async addWitness(id, name, signature, role = 'landlord') {
    const s = load(); const d = findDoc(s, id, role);
    recordWitness(s, d, role, name, signature, 'in_person'); save(s); emit();
  },
  async createWitnessLink(id, role = 'landlord') {
    const s = load(); const d = findDoc(s, id, role);
    if (d.status !== 'sent') throw new DataError('This lease is not open for signing');
    if (!d.witnesses_per_party) throw new DataError('This lease does not ask for witnesses');
    if (!d.signatures.some(x => x.role === role)) throw new DataError('Sign the lease yourself first, then invite your witness');
    if (d.signatures.filter(x => x.witness_for === role).length >= d.witnesses_per_party) throw new DataError('All your witnesses have already signed');
    const token = uid().replace(/-/g, '') + uid().replace(/-/g, '');
    s.witnessLinks = s.witnessLinks || [];
    s.witnessLinks.push({ token, document_id: d.id, witness_for: role, used_at: null, expires_at: new Date(Date.now() + 7 * 864e5).toISOString() });
    save(s); emit();
    return witnessLink(token);
  },
  async witnessPreview(token) {
    const s = load();
    const k = (s.witnessLinks || []).find(x => x.token === token);
    const d = k && (s.leaseDocs || []).find(x => x.id === k.document_id);
    if (!d) return null;
    const party = d.signatures.find(x => x.role === k.witness_for);
    return { valid: !k.used_at && new Date(k.expires_at) > new Date() && d.status === 'sent'
        && d.signatures.filter(x => x.witness_for === k.witness_for).length < d.witnesses_per_party,
      title: d.title, witness_for: k.witness_for, party_name: party?.signer_name, party_signature: party?.signature,
      party_signed_at: party?.signed_at, landlord_name: d.body.parties?.landlord?.name, tenant_name: d.body.parties?.tenant?.name,
      premises: d.body.premises?.address, fingerprint: d.body_hash };
  },
  async witnessSign(token, name, signature) {
    const s = load();
    const k = (s.witnessLinks || []).find(x => x.token === token);
    if (!k) throw new DataError('This witness link is not valid');
    if (k.used_at) throw new DataError('This witness link has already been used');
    if (new Date(k.expires_at) <= new Date()) throw new DataError('This witness link has expired. Ask for a new one');
    const d = s.leaseDocs.find(x => x.id === k.document_id);
    recordWitness(s, d, k.witness_for, name, signature, 'link');
    k.used_at = now(); save(s); emit();
  },
};

// The live database knows who is signed in. The demo doesn't, so each demo method that depends on
// the caller declares `role = 'landlord'` as its last parameter and this fills it in. (A function's
// `length` counts the parameters before the first default, which is exactly where role sits.)
export function docsApi(role) {
  if (!isDemo()) return live;
  return new Proxy(demo, {
    get(target, name) {
      const fn = target[name];
      if (typeof fn !== 'function') return fn;
      return (...args) => { const a = args.slice(0, fn.length); while (a.length < fn.length) a.push(undefined); a.push(role); return fn.apply(target, a); };
    },
  });
}
