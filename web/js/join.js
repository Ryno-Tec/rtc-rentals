// Tenant registration from an owner's invite link: join.html?t=<token>
import { api, configured, isDemo, client, enterDemo } from './data.js';
import { brand, icon, esc } from './shell.js';

document.getElementById('brand').innerHTML = brand('by Ryno-Tec');
document.getElementById('points').innerHTML = [
  'See your lease, rent due and every receipt',
  'Report a repair with photos and follow its progress',
  'Message your landlord without sharing more numbers',
].map(t => `<li>${icon.check}<span>${t}</span></li>`).join('');

const box = document.getElementById('box');
const token = new URLSearchParams(location.search).get('t') || '';
const show = html => { box.innerHTML = html; };
const problem = (title, text) => show(`<h2>${esc(title)}</h2><p class="muted">${esc(text)}</p>
  <a class="btn btn-ghost" href="index.html" style="margin-top:12px">Go to sign in</a>`);

async function accept() {
  show('<p class="muted">Linking your account to your lease…</p>');
  try { await api.acceptInvite(token); location.replace('tenant.html'); }
  catch (e) {
    problem('We couldn’t link your account', e.message + '.');
    box.insertAdjacentHTML('beforeend', ' <button class="btn btn-ghost" type="button" id="out" style="margin-top:12px">Sign out</button>');
    document.getElementById('out').addEventListener('click', async () => { await api.signOut(); location.reload(); });
  }
}

function form(p) {
  let mode = 'signup';
  const first = (p.tenant_name || '').trim().split(/\s+/)[0];
  show(`
    <h2>${first ? `Welcome, ${esc(first)}` : 'Welcome'}</h2>
    <p class="muted" style="margin:0"><b>${esc(p.landlord_name || 'Your landlord')}</b> invited you to RTC Rentals${p.unit_label ? ` for <b>${esc(p.unit_label)}</b>${p.property_name ? ', ' + esc(p.property_name) : ''}` : ''}.</p>
    <div class="tabs" role="tablist">
      <button type="button" role="tab" aria-selected="true" data-tab="signup">Create account</button>
      <button type="button" role="tab" aria-selected="false" data-tab="signin">I have an account</button>
    </div>
    <form id="form" novalidate>
      <div class="form-error hidden" role="alert" id="error"></div>
      <div class="field" id="name-field"><label for="name">Full name</label><input id="name" autocomplete="name" value="${esc(p.tenant_name || '')}"></div>
      <div class="field"><label for="email">Email</label><input id="email" type="email" autocomplete="email" required value="${esc(p.tenant_email || '')}"></div>
      <div class="field"><label for="password">Password</label><input id="password" type="password" autocomplete="new-password" required minlength="8">
        <div class="hint" id="pw-hint">At least 8 characters. You’ll use it to sign in to the app.</div></div>
      <div class="field" id="consent-field"><label style="display:flex;gap:8px;align-items:flex-start;font-weight:450">
        <input type="checkbox" id="consent" style="width:auto;margin-top:3px">
        <span>I agree that RTC Rentals and my landlord process my details to manage my lease, as POPIA allows.</span></label></div>
      <button class="btn" type="submit" id="submit">Create account</button>
    </form>`);
  const $ = id => document.getElementById(id);
  box.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => {
    mode = b.dataset.tab;
    box.querySelectorAll('[data-tab]').forEach(x => x.setAttribute('aria-selected', String(x === b)));
    for (const id of ['name-field', 'consent-field', 'pw-hint']) $(id).classList.toggle('hidden', mode === 'signin');
    $('password').autocomplete = mode === 'signin' ? 'current-password' : 'new-password';
    $('submit').textContent = mode === 'signin' ? 'Sign in and continue' : 'Create account';
    $('error').classList.add('hidden');
  }));
  $('form').addEventListener('submit', async e => {
    e.preventDefault();
    const err = m => { $('error').textContent = m; $('error').classList.remove('hidden'); };
    const email = $('email').value.trim(), pw = $('password').value, name = $('name').value.trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) return err('Enter your email address.');
    if (pw.length < 8) return err('Your password needs at least 8 characters.');
    if (mode === 'signup' && !name) return err('Enter your full name.');
    if (mode === 'signup' && !$('consent').checked) return err('Please tick the box to agree before continuing.');
    $('submit').disabled = true;
    try {
      if (mode === 'signin') { await api.signIn(email, pw); return accept(); }
      const r = await api.tenantSignUp(email, pw, name, token);
      if (r.needsConfirmation) return show(`<h2>Check your email</h2>
        <p class="muted">We sent a confirmation link to <b>${esc(email)}</b>. Open it on this phone or computer and your lease will be ready. It can land in spam.</p>`);
      await accept();
    } catch (ex) { err(ex.message); $('submit').disabled = false; }
  });
}

if (!configured || isDemo()) {
  show(`<h2>Tenant invites</h2><p class="muted">This is the preview build, so invite links aren’t live. You can look around the tenant app with sample data.</p>
    <button class="btn" type="button" id="demo" style="margin-top:12px">See the tenant view</button>`);
  document.getElementById('demo').addEventListener('click', () => { enterDemo(); location.href = 'tenant.html'; });
} else if (!token) {
  problem('This link is incomplete', 'Open the full invite link your landlord sent you.');
} else {
  // Arriving from the confirmation email: Supabase signs the tenant in from the address, then we link.
  const sb = await client();
  const { data } = await sb.auth.getSession();
  if (data.session) await accept();
  else {
    try {
      const p = await api.invitePreview(token);
      if (!p) problem('This invite link isn’t valid', 'Ask your landlord to send you a new invite.');
      else if (!p.valid) problem('This invite has been used or has expired', 'If you already registered, sign in. Otherwise ask your landlord for a new invite.');
      else form(p);
    } catch (e) { problem('We couldn’t check your invite', 'Check your connection and open the link again.'); }
  }
}
