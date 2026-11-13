// Shared page chrome: sidebar, auth guard, demo banner, modal, toasts, formatting.
import { api, isDemo, configured, leaveDemo, resetDemo } from './data.js';

export const icon = {
  logo: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 9.5V20h13V9.5"/><path d="M10 20v-5.5h4V20"/></svg>',
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
  building: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16"/><path d="M16 9h2a2 2 0 0 1 2 2v10"/><path d="M2 21h20M8 7h4M8 11h4M8 15h4"/></svg>',
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18.5 14a6.5 6.5 0 0 1 3 6"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg>',
  cash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 9.5v5M18 9.5v5"/></svg>',
  tool: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3.5 17.5a2 2 0 0 0 2.8 2.8l5.8-5.8a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.3-.5-.5-2.3z"/></svg>',
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-4-4L4 16z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
};

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// SA style "R 31 600", the same on every browser (Intl output for en-ZA varies by engine).
export const money = n => {
  const v = Math.round(Number(n) || 0);
  return `${v < 0 ? '-' : ''}R ${Math.abs(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}`;
};
export const pct = n => `${Math.round(n * 100)}%`;

export function brand(sub = 'by Ryno-Tec') {
  return `<div class="brand"><div class="brand-mark">${icon.logo}</div><div>RTC Rentals<small>${esc(sub)}</small></div></div>`;
}

const NAV = [
  { href: 'dashboard.html', label: 'Dashboard', icon: 'home' },
  { href: 'properties.html', label: 'Properties & units', icon: 'building' },
  { href: 'tenants.html', label: 'Tenants & leases', icon: 'users' },
  { href: 'rent.html', label: 'Rent', icon: 'cash' },
];
const SOON = [
  { label: 'Lease e-signing', icon: 'file' },
  { label: 'Maintenance', icon: 'tool' },
];

// Renders the sidebar around #content and returns the signed-in profile.
export async function mountShell(active) {
  const session = await api.session();
  if (!session) { location.replace('index.html'); return new Promise(() => {}); }
  if (session.role === 'tenant') { location.replace('tenant.html'); return new Promise(() => {}); }
  const profile = await api.profile().catch(() => ({ full_name: session.name, email: session.email, limits: null }));

  const content = document.getElementById('content');
  const shell = document.createElement('div');
  shell.className = 'shell';
  shell.innerHTML = `
    <aside class="sidebar" aria-label="Main navigation">
      ${brand()}
      <nav class="nav">
        ${NAV.map(n => `<a href="${n.href}" ${n.href === active ? 'aria-current="page"' : ''}>${icon[n.icon]}${n.label}</a>`).join('')}
        <div class="nav-label">Coming in Phase 1</div>
        ${SOON.map(n => `<span class="soon">${icon[n.icon]}${n.label}<em>Soon</em></span>`).join('')}
      </nav>
      <div class="sidebar-foot">
        <div class="who">${esc(profile.full_name || profile.email)}</div>
        <div class="muted">${profile.limits ? esc(profile.limits.display_name) + ' plan' : ''}</div>
        <button class="btn btn-ghost btn-sm" id="signout">${isDemo() && !configured ? 'Reset demo data' : isDemo() ? 'Leave demo' : 'Sign out'}</button>
      </div>
    </aside>
    <div class="main">
      <div class="topbar"><button id="navtoggle" aria-label="Open menu" aria-expanded="false">${icon.menu}</button>${brand('')}</div>
      ${isDemo() ? `<div class="demo-banner" role="status"><strong>Demo mode</strong>
        <span>${configured ? 'Sample data, saved only in this browser.' : 'Sample data, saved only in this browser. Connect Supabase in js/config.js to go live.'}</span>
        <a class="demo-switch" href="tenant.html">See what your tenant sees →</a></div>` : ''}
    </div>`;
  content.replaceWith(shell);
  shell.querySelector('.main').appendChild(content);

  const toggle = shell.querySelector('#navtoggle');
  toggle.addEventListener('click', e => {
    e.stopPropagation();
    const open = shell.classList.toggle('nav-open');
    toggle.setAttribute('aria-expanded', String(open));
  });
  shell.addEventListener('click', e => {
    if (shell.classList.contains('nav-open') && !e.target.closest('.sidebar')) {
      shell.classList.remove('nav-open'); toggle.setAttribute('aria-expanded', 'false');
    }
  });

  shell.querySelector('#signout').addEventListener('click', async () => {
    if (isDemo() && !configured) {
      if (await confirmDialog('Reset demo data?', 'This puts the sample properties back and removes your changes.', 'Reset')) {
        resetDemo(); toast('Demo data reset');
      }
      return;
    }
    if (isDemo()) leaveDemo(); else await api.signOut();
    location.replace('index.html');
  });
  return profile;
}

// ---------- Toasts ----------
export function toast(message, kind = '') {
  let box = document.querySelector('.toasts');
  if (!box) { box = document.createElement('div'); box.className = 'toasts'; box.setAttribute('aria-live', 'polite'); document.body.appendChild(box); }
  const t = document.createElement('div');
  t.className = `toast ${kind}`; t.textContent = message;
  box.appendChild(t);
  setTimeout(() => t.remove(), 3800);
}

// ---------- Modal ----------
// openModal({ title, body (html), submitLabel, onSubmit(form) }) — onSubmit may throw to show an error.
export function openModal({ title, body, submitLabel = 'Save', danger = false, cancel = true, onSubmit }) {
  const prev = document.activeElement;
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `
    <form class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" novalidate>
      <div class="modal-head"><h2 id="modal-title">${esc(title)}</h2>
        <button type="button" class="btn btn-ghost btn-icon" data-close aria-label="Close">${icon.close}</button></div>
      <div class="modal-body"><div class="form-error hidden" role="alert"></div>${body}</div>
      <div class="modal-foot">${cancel ? '<button type="button" class="btn btn-ghost" data-close>Cancel</button>' : ''}
        <button type="submit" class="btn ${danger ? 'btn-danger' : ''}">${esc(submitLabel)}</button></div>
    </form>`;
  document.body.appendChild(wrap);
  const form = wrap.querySelector('form');
  const err = wrap.querySelector('.form-error');
  const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); prev?.focus?.(); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  wrap.addEventListener('mousedown', e => { if (e.target === wrap) close(); });
  wrap.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true; err.classList.add('hidden');
    try { await onSubmit(form); close(); }
    catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); btn.disabled = false; err.scrollIntoView({ block: 'nearest' }); }
  });
  (form.querySelector('.modal-body input, .modal-body select, .modal-body textarea') || form.querySelector('[type=submit]')).focus();
  return close;
}

export function confirmDialog(title, message, action = 'Delete') {
  return new Promise(resolve => {
    let done = false;
    const close = openModal({
      title, submitLabel: action, danger: true,
      body: `<p style="margin:0">${esc(message)}</p>`,
      onSubmit: async () => { done = true; resolve(true); },
    });
    const obs = new MutationObserver(() => {
      if (!document.body.contains(document.querySelector('.modal-backdrop'))) { obs.disconnect(); if (!done) resolve(false); }
    });
    obs.observe(document.body, { childList: true });
    void close;
  });
}

// Reads a form into an object, converting number and checkbox inputs.
export function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'number') out[el.name] = el.value === '' ? null : Number(el.value);
    else out[el.name] = el.value.trim() === '' ? null : el.value.trim();
  }
  return out;
}
