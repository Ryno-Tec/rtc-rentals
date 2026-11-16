// The maintenance person's app: the jobs an owner assigned to them, and registration from an
// owner's login link (staff.html?t=<token>).
import { isDemo, configured, client, leaveDemo } from './data.js';
import { maintApi as m, STATUS, PRIORITY, isOpen } from './maint-data.js';
import { brand, esc, icon, toast, openModal } from './shell.js';
import { fmtWhen } from './lease-ui.js';
import { appLock, lockSettings } from './lock.js';
import { mountOAuth } from './oauth.js';
import { avatar, photoUrls, requirePhoto, changePhoto } from './photo.js';

const ico = {
  ...icon,
  phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="9" r="2.5"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20l1.3-3.9A8 8 0 1 1 8 19z"/></svg>',
};
const view = document.getElementById('t-view');
const tabsEl = document.getElementById('t-tabs');
document.getElementById('t-brand').innerHTML = brand('Maintenance');
const token = new URLSearchParams(location.search).get('t');
const tone = s => ({ open: 'late', assigned: 'soon', in_progress: 'info', resolved: 'ok', closed: 'muted' }[s]);
const day = s => s ? new Date(s + 'T00:00').toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short' }) : '';
const tel = p => (p || '').replace(/[^\d+]/g, '');
const wa = p => tel(p).replace(/^\+/, '').replace(/^0/, '27');
let jobs = [];

if (isDemo()) {
  document.getElementById('t-demo').innerHTML = `<div class="demo-banner" role="status"><strong>Demo mode</strong>
    <span>You’re seeing the app as Sipho, the owner’s handyman. Sample data, saved only in this browser.</span>
    <a class="demo-switch" href="maintenance.html">← Back to owner view</a></div>`;
  document.getElementById('t-signout').textContent = 'Owner view';
}
document.getElementById('t-signout').addEventListener('click', async () => {
  if (isDemo()) { location.href = 'maintenance.html'; return; }
  await m.signOut(); leaveDemo(); location.replace('index.html');
});

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------
const tab = () => (location.hash === '#done' ? 'done' : 'todo');

function jobCard(j) {
  const next = j.status === 'assigned' || j.status === 'open' ? ['in_progress', 'Start the work']
    : j.status === 'in_progress' ? ['resolved', 'Mark it fixed'] : null;
  return `<article class="card req job">
    <div class="req-head">
      <div><h2>${esc(j.title)}</h2>
        <div class="unit-sub">${esc(j.category || 'Other')} · logged ${fmtWhen(j.created_at)}</div></div>
      <div class="job-pills">${j.priority === 'urgent' || j.priority === 'high' ? `<span class="pill pill-${j.priority === 'urgent' ? 'late' : 'soon'}">${PRIORITY[j.priority]}</span>` : ''}
        <span class="pill pill-${tone(j.status)}">${STATUS[j.status]}</span></div>
    </div>
    ${j.scheduled_for ? `<p class="job-when"><b>Booked for ${day(j.scheduled_for)}</b></p>` : ''}
    <a class="job-addr" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(j.address || '')}">${ico.pin}<span>${esc(j.address || j.property_name || '')}</span></a>
    ${j.description ? `<p class="req-desc">${esc(j.description)}</p>` : ''}
    <div class="job-contacts">
      ${j.tenant_phone ? `<div><span class="unit-sub">Tenant</span> ${esc(j.tenant_name || '')}
        <a class="btn btn-ghost btn-sm" href="tel:${esc(tel(j.tenant_phone))}">${ico.phone}Call</a>
        <a class="btn btn-ghost btn-sm" target="_blank" rel="noopener" href="https://wa.me/${esc(wa(j.tenant_phone))}">${ico.chat}WhatsApp</a></div>` : ''}
      ${j.owner_phone ? `<div><span class="unit-sub">Owner</span> ${esc(j.owner_name || '')}
        <a class="btn btn-ghost btn-sm" href="tel:${esc(tel(j.owner_phone))}">${ico.phone}Call</a></div>` : ''}
    </div>
    ${j.updates.length ? `<ol class="timeline">${j.updates.map(u => `<li><span class="tl-dot ${u.author === 'staff' ? 'tl-ok' : 'tl-ll'}"></span>
      <div>${u.status ? `<b>${STATUS[u.status]}.</b> ` : ''}${esc(u.body)}<div class="unit-sub">${u.author === 'staff' ? 'You' : u.author === 'tenant' ? 'Tenant' : 'Owner'} · ${fmtWhen(u.created_at)}</div></div></li>`).join('')}</ol>` : ''}
    ${j.status !== 'closed' ? `<div class="job-actions">
      ${next ? `<button class="btn" type="button" data-job="${j.id}" data-status="${next[0]}">${next[1]}</button>` : ''}
      <button class="btn btn-ghost" type="button" data-job="${j.id}" data-status="">Add a note</button>
      ${j.status === 'resolved' ? `<button class="btn btn-ghost" type="button" data-job="${j.id}" data-status="in_progress">Not fixed after all</button>` : ''}
    </div>` : '<p class="unit-sub" style="margin:12px 0 0">The owner closed this job.</p>'}
  </article>`;
}

function render() {
  const t = tab();
  const todo = jobs.filter(isOpen), done = jobs.filter(j => !isOpen(j));
  tabsEl.innerHTML = [['todo', `To do (${todo.length})`], ['done', 'Done']].map(([id, l]) =>
    `<a href="#${id}" aria-current="${t === id ? 'page' : 'false'}"><span>${l}</span></a>`).join('');
  const rows = t === 'todo' ? todo : done;
  view.innerHTML = `<div class="t-hello"><h1>${t === 'todo' ? 'Your jobs' : 'Done'}</h1>
      <p class="muted">${t === 'todo' ? 'Jobs the owner assigned to you. Update each one as you go: the owner and the tenant see it straight away.' : 'Jobs you’ve finished.'}</p></div>
    ${rows.length ? rows.map(jobCard).join('') : `<div class="card empty"><h2>${t === 'todo' ? 'No jobs right now' : 'Nothing here yet'}</h2>
      <p>${t === 'todo' ? 'When the owner assigns you a job, it shows here.' : 'Finished jobs show here.'}</p></div>`}`;
}

function update(id, status) {
  const j = jobs.find(x => x.id === id);
  const title = status === 'in_progress' && j.status === 'resolved' ? 'Not fixed after all' : status === 'in_progress' ? 'Start the work' : status === 'resolved' ? 'Mark it fixed' : 'Add a note';
  openModal({
    title, submitLabel: title === 'Add a note' ? 'Add note' : title,
    body: `<p style="margin-top:0"><b>${esc(j.title)}</b> · ${esc(j.address || '')}</p>
      <div class="field" style="margin-bottom:0"><label for="ju-note">Note <span class="muted">${status ? '(optional)' : ''}</span></label>
        <textarea id="ju-note" name="note" rows="3" maxlength="2000" placeholder="${status === 'resolved' ? 'What you did, and anything the tenant should know' : 'e.g. Need a part, back on Thursday'}"></textarea>
        <div class="hint">The owner and the tenant see this.</div></div>`,
    async onSubmit(form) {
      const note = form.elements.note.value.trim();
      if (!status && !note) throw new Error('Write the note first.');
      await m.updateJob(id, status || null, note);
      toast(status === 'resolved' ? 'Marked fixed. Thank you!' : 'Updated');
      await load();
    },
  });
}

async function load() {
  try { jobs = (await m.jobs()).map(j => ({ ...j, updates: j.updates || [] })); render(); }
  catch (e) { view.innerHTML = `<div class="form-error">Couldn’t load your jobs: ${esc(e.message)}</div>`; }
}

// ---------------------------------------------------------------------------
// Registration from an owner's link
// ---------------------------------------------------------------------------
function problem(title, text) {
  tabsEl.innerHTML = '';
  view.innerHTML = `<div class="card card-pad"><h2>${esc(title)}</h2><p class="muted">${esc(text)}</p>
    <a class="btn btn-ghost" href="index.html" style="margin-top:8px">Go to sign in</a></div>`;
}

async function accept() {
  view.innerHTML = '<p class="muted">Linking your login to the team…</p>';
  try { await m.acceptInvite(token); history.replaceState(null, '', 'staff.html'); await start(); }
  catch (e) { problem('We couldn’t link your login', e.message + '.'); }
}

function registerForm(p) {
  let mode = 'signup';
  tabsEl.innerHTML = '';
  view.innerHTML = `<div class="card card-pad join-staff">
    <h2>Welcome${p.staff_name ? ', ' + esc(p.staff_name.split(' ')[0]) : ''}</h2>
    <p class="muted" style="margin:4px 0 0"><b>${esc(p.owner_name || 'A property owner')}</b> added you to their maintenance team on RTC Rentals. Set up your login to see the jobs they give you.</p>
    <div class="auth-box"><div class="tabs" role="tablist">
      <button type="button" role="tab" aria-selected="true" data-mode="signup">Create login</button>
      <button type="button" role="tab" aria-selected="false" data-mode="signin">I have a login</button></div></div>
    <div id="oauth" class="oauth hidden" style="margin-top:16px"></div>
    <form id="sj" novalidate>
      <div class="form-error hidden" role="alert" id="sj-err"></div>
      <div class="field" id="sj-name-f"><label for="sj-name">Full name</label><input id="sj-name" autocomplete="name" value="${esc(p.staff_name || '')}"></div>
      <div class="field"><label for="sj-email">Email</label><input id="sj-email" type="email" autocomplete="email" value="${esc(p.staff_email || '')}"></div>
      <div class="field"><label for="sj-pw">Password</label><input id="sj-pw" type="password" autocomplete="new-password" minlength="8"><div class="hint" id="sj-hint">At least 8 characters.</div></div>
      <label class="check" id="sj-consent-f" style="margin-bottom:14px"><input type="checkbox" id="sj-consent"> <span>I understand the owner and RTC Rentals keep my name, contact details and job updates to manage the work (POPIA), and I’ll keep tenants’ details private.</span></label>
      <button class="btn" type="submit" id="sj-go">Create login</button>
    </form></div>`;
  const $ = id => document.getElementById(id);
  mountOAuth($('oauth'), { redirectTo: location.href, onError: t => { $('sj-err').textContent = t; $('sj-err').classList.remove('hidden'); } });
  view.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => {
    mode = b.dataset.mode;
    view.querySelectorAll('[data-mode]').forEach(x => x.setAttribute('aria-selected', String(x === b)));
    for (const id of ['sj-name-f', 'sj-consent-f', 'sj-hint']) $(id).classList.toggle('hidden', mode === 'signin');
    $('sj-go').textContent = mode === 'signin' ? 'Sign in and continue' : 'Create login';
  }));
  $('sj').addEventListener('submit', async e => {
    e.preventDefault();
    const err = t => { $('sj-err').textContent = t; $('sj-err').classList.remove('hidden'); };
    const email = $('sj-email').value.trim(), pw = $('sj-pw').value, name = $('sj-name').value.trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) return err('Enter your email address.');
    if (pw.length < 8) return err('Your password needs at least 8 characters.');
    if (mode === 'signup' && !name) return err('Enter your full name.');
    if (mode === 'signup' && !$('sj-consent').checked) return err('Tick the box to continue.');
    $('sj-go').disabled = true;
    try {
      if (mode === 'signin') { await m.signIn(email, pw); return accept(); }
      const r = await m.signUp(email, pw, name, token);
      if (r.needsConfirmation) {
        view.innerHTML = `<div class="card card-pad"><h2>Check your email</h2><p class="muted">We sent a confirmation link to <b>${esc(email)}</b>. Open it on this phone and your jobs will be ready.</p></div>`;
        return;
      }
      await accept();
    } catch (ex) { err(ex.message); $('sj-go').disabled = false; }
  });
}

async function start() {
  const s = await m.session();
  if (!s) { location.replace('index.html'); return; }
  if (!isDemo() && s.role !== 'staff') { location.replace(s.role === 'tenant' ? 'tenant.html' : 'dashboard.html'); return; }
  await appLock(s, async () => { await m.signOut(); leaveDemo(); });
  document.getElementById('t-lock').innerHTML = icon.lock;
  document.getElementById('t-lock').addEventListener('click', () => lockSettings(s));
  const me = await m.me().catch(() => []);
  document.getElementById('t-name').textContent = me[0]?.full_name || s.name || s.email;
  if (!me.length && !isDemo()) return problem('You’re not on a team yet', 'Ask the property owner to send you a login link.');
  const mine = me[0] || {};
  if (!mine.photo_path) {
    tabsEl.innerHTML = '';
    mine.photo_path = await requirePhoto({ host: view, name: mine.full_name || s.name, email: s.email,
      who: 'Owners and tenants see your photo on each job, so they know who is coming to the door.' });
    toast('Photo saved');
  }
  let photoUrl = '';
  const drawMe = async () => {
    photoUrl = (await photoUrls([mine.photo_path]).catch(() => ({})))[mine.photo_path] || '';
    document.getElementById('t-me').innerHTML = avatar(photoUrl, mine.full_name, 30);
  };
  drawMe();
  document.getElementById('t-me').addEventListener('click', () => changePhoto({ name: mine.full_name, email: s.email, url: photoUrl,
    path: mine.photo_path, onSaved: p => { mine.photo_path = p; drawMe(); } }));
  window.addEventListener('hashchange', render);
  view.addEventListener('click', e => { const b = e.target.closest('[data-job]'); if (b) update(b.dataset.job, b.dataset.status); });
  m.subscribe(() => load()).catch(() => {});
  await load();
}

if (token && configured && !isDemo()) {
  const sb = await client();
  const { data } = await sb.auth.getSession();
  if (data.session) await accept();
  else {
    try {
      const p = await m.invitePreview(token);
      if (!p) problem('This login link isn’t valid', 'Ask the owner to send you a new one.');
      else if (!p.valid) problem('This link has been used or has expired', 'If you already set up your login, sign in. Otherwise ask the owner for a new link.');
      else registerForm(p);
    } catch { problem('We couldn’t check your link', 'Check your connection and open the link again.'); }
  }
} else {
  await start();
}
