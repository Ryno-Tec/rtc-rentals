// Profile photos. Tenants and maintenance people must add one before using the app; owners may.
// Photos are shrunk on the phone (about 60 KB) and kept in the private profile-photos bucket.
import { isDemo, client, DataError, demoStore } from './data.js';
import { compressImage } from './docs-data.js';
import { esc, toast, openModal } from './shell.js';

const person = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8.5" r="4"/><path d="M4 20.5c1.4-3.8 4.4-5.5 8-5.5s6.6 1.7 8 5.5"/></svg>';
const urlCache = new Map();

// Signed links for a list of storage paths (or demo data URLs). Returns { path: url }.
export async function photoUrls(paths) {
  const want = [...new Set(paths.filter(Boolean))].filter(p => !urlCache.has(p));
  if (want.length) {
    if (isDemo()) want.forEach(p => urlCache.set(p, p));
    else {
      const sb = await client();
      const { data } = await sb.storage.from('profile-photos').createSignedUrls(want, 3600);
      for (const r of data || []) if (r.signedUrl) urlCache.set(r.path, r.signedUrl);
    }
  }
  return Object.fromEntries(paths.filter(Boolean).map(p => [p, urlCache.get(p) || '']));
}

export function avatar(url, name = '', size = 36) {
  const initials = (name || '').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  return `<span class="avatar" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.38)}px">${url
    ? `<img src="${esc(url)}" alt="Photo of ${esc(name)}">` : initials ? esc(initials) : person}</span>`;
}

// Save a new photo for the signed-in person. Returns the stored path (or a data URL in the demo).
export async function savePhoto(file, email, old) {
  const { blob, dataUrl } = await compressImage(file, 480, 0.82);
  if (isDemo()) {
    // The demo keeps the photo on the sample record with this email (owner, tenant or team member).
    const url = dataUrl(), s = demoStore.load(), e = (email || '').toLowerCase();
    if ((s.profile?.email || '').toLowerCase() === e) s.profile.photo_path = url;
    for (const t of s.tenants || []) if ((t.email || '').toLowerCase() === e) t.photo_path = url;
    for (const m of s.staff || []) if ((m.email || '').toLowerCase() === e) m.photo_path = url;
    try { demoStore.save(s); } catch { throw new DataError('The demo couldn’t keep that photo in this browser.'); }
    demoStore.emit();
    return url;
  }
  const sb = await client();
  const { data: { session } } = await sb.auth.getSession();
  const path = `${session.user.id}/photo-${Date.now()}.jpg`;
  const up = await sb.storage.from('profile-photos').upload(path, blob, { contentType: 'image/jpeg', upsert: false });
  if (up.error) throw new DataError(up.error.message);
  const { error } = await sb.rpc('set_my_photo', { p_path: path });
  if (error) throw new DataError(error.message);
  if (old && old !== path && !old.startsWith('data:')) sb.storage.from('profile-photos').remove([old]).catch(() => {});
  return path;
}

const photoField = (current, name) => `
  <div class="photo-pick">
    <div class="photo-preview" id="pp-preview">${avatar(current, name, 120)}</div>
    <div class="photo-btns">
      <label class="btn">Take a photo<input type="file" accept="image/*" capture="user" hidden id="pp-cam"></label>
      <label class="btn btn-ghost">Choose a photo<input type="file" accept="image/*" hidden id="pp-file"></label>
    </div>
  </div>`;

function wire(root, onFile) {
  for (const id of ['pp-cam', 'pp-file']) root.querySelector('#' + id).addEventListener('change', e => {
    const f = e.target.files[0]; if (!f) return;
    const url = URL.createObjectURL(f);
    root.querySelector('#pp-preview').innerHTML = `<span class="avatar" style="width:120px;height:120px"><img src="${url}" alt="New photo"></span>`;
    onFile(f);
  });
}

/**
 * Full-screen step that must be completed before the app opens (tenants and maintenance people).
 * Resolves with the saved path.
 */
export function requirePhoto({ host, name, email, who }) {
  return new Promise(resolve => {
    let file = null;
    host.innerHTML = `<div class="card card-pad photo-gate">
      <h1>Add your profile photo</h1>
      <p class="muted">${esc(who)} Take a clear photo of your face, like an ID photo.</p>
      ${photoField(null, name)}
      <div class="form-error hidden" role="alert" id="pp-err"></div>
      <button class="btn btn-block" type="button" id="pp-save" disabled>Save and continue</button>
      <p class="hint" style="margin-bottom:0">Only you, and the people you rent from or work for, can see it.</p></div>`;
    const save = host.querySelector('#pp-save'), err = host.querySelector('#pp-err');
    wire(host, f => { file = f; save.disabled = false; err.classList.add('hidden'); });
    save.addEventListener('click', async () => {
      save.disabled = true; save.textContent = 'Saving…';
      try { const p = await savePhoto(file, email, null); resolve(p); }
      catch (e) { err.textContent = e.message; err.classList.remove('hidden'); save.disabled = false; save.textContent = 'Save and continue'; }
    });
  });
}

// Change the photo later (any role).
export function changePhoto({ name, email, url, path, onSaved }) {
  let file = null;
  openModal({
    title: 'Your profile photo', submitLabel: 'Save photo',
    body: photoField(url, name),
    async onSubmit() {
      if (!file) throw new Error('Take or choose a photo first.');
      const p = await savePhoto(file, email, path);
      toast('Photo saved'); onSaved?.(p);
    },
  });
  wire(document.querySelector('.modal'), f => { file = f; });
}
