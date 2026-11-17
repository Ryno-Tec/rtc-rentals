// A team member opens their invite link, creates a login (or signs in, or uses Google/Microsoft),
// and is linked to the agency's account.
import { rememberField, applyRemember } from './session-guard.js';
import { configured, isDemo, client, DataError } from './data.js';
import { brand, esc } from './shell.js';
import { mountOAuth } from './oauth.js';

document.getElementById('brand').innerHTML = brand('Team');
const view = document.getElementById('view');
const token = new URLSearchParams(location.search).get('t');
const link = () => new URL('member.html?t=' + encodeURIComponent(token), location.href).href;
const problem = (h, p) => { view.innerHTML = `<h2>${esc(h)}</h2><p class="muted">${esc(p)}</p><p><a class="btn btn-ghost" href="index.html">Go to sign in</a></p>`; };

async function accept() {
  view.innerHTML = '<p class="muted">Linking your login to the team…</p>';
  try {
    const sb = await client();
    const { error } = await sb.rpc('accept_member_invite', { p_token: token });
    if (error) throw new DataError(error.message);
    const { data: { user } } = await sb.auth.getUser();         // Google/Microsoft sign-ins arrive without a role
    if (user?.user_metadata?.role !== 'member') { await sb.auth.updateUser({ data: { role: 'member' } }); await sb.auth.refreshSession(); }
    location.replace('dashboard.html');
  } catch (e) { problem('We couldn’t link your login', e.message); }
}

function form(p) {
  let mode = 'signup';
  view.innerHTML = `<h2>Welcome${p.member_name ? ', ' + esc(p.member_name.split(' ')[0]) : ''}</h2>
    <p class="muted" style="margin:4px 0 16px"><b>${esc(p.agency_name || 'Your agency')}</b> added you to their team as ${p.role === 'admin' ? 'an admin' : 'an agent'}.</p>
    <div class="tabs" role="tablist"><button type="button" role="tab" aria-selected="true" data-mode="signup">Create login</button>
      <button type="button" role="tab" aria-selected="false" data-mode="signin">I have a login</button></div>
    <div id="oauth" class="oauth hidden" style="margin-top:16px"></div>
    <form id="mj" novalidate>
      <div class="form-error hidden" role="alert" id="mj-err"></div>
      <div class="field" id="mj-name-f"><label for="mj-name">Full name</label><input id="mj-name" autocomplete="name" value="${esc(p.member_name || '')}"></div>
      <div class="field"><label for="mj-email">Work email</label><input id="mj-email" type="email" autocomplete="email" value="${esc(p.member_email || '')}"></div>
      <div class="field"><label for="mj-pw">Password</label><input id="mj-pw" type="password" autocomplete="new-password" minlength="8"><div class="hint" id="mj-hint">At least 8 characters.</div></div>
      <label class="check" id="mj-consent-f" style="margin-bottom:14px"><input type="checkbox" id="mj-consent"> <span>I’ll keep owners’ and tenants’ personal information private and use it only for the agency’s work (POPIA).</span></label>
      ${rememberField()}
      <button class="btn btn-block" type="submit" id="mj-go">Create login</button>
    </form>`;
  const $ = id => document.getElementById(id);
  const err = t => { $('mj-err').textContent = t; $('mj-err').classList.remove('hidden'); };
  mountOAuth($('oauth'), { redirectTo: link(), onError: err });
  view.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => {
    mode = b.dataset.mode;
    view.querySelectorAll('[data-mode]').forEach(x => x.setAttribute('aria-selected', String(x === b)));
    for (const id of ['mj-name-f', 'mj-consent-f', 'mj-hint']) $(id).classList.toggle('hidden', mode === 'signin');
    $('mj-go').textContent = mode === 'signin' ? 'Sign in and continue' : 'Create login';
  }));
  $('mj').addEventListener('submit', async e => {
    e.preventDefault();
    const email = $('mj-email').value.trim(), pw = $('mj-pw').value, name = $('mj-name').value.trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) return err('Enter your email address.');
    if (pw.length < 8) return err('Your password needs at least 8 characters.');
    if (mode === 'signup' && !name) return err('Enter your full name.');
    if (mode === 'signup' && !$('mj-consent').checked) return err('Tick the box to continue.');
    $('mj-go').disabled = true;
    try {
      applyRemember();
      const sb = await client();
      if (mode === 'signin') {
        const { error } = await sb.auth.signInWithPassword({ email, password: pw });
        if (error) throw new DataError(error.message === 'Invalid login credentials' ? 'Email or password is incorrect.' : error.message);
        return accept();
      }
      const { data, error } = await sb.auth.signUp({ email, password: pw, options: { data: { full_name: name, role: 'member' }, emailRedirectTo: link() } });
      if (error) throw new DataError(error.message);
      if (data.user && !data.user.identities?.length) throw new DataError('That email already has an account. Choose “I have a login”.');
      if (!data.session) { view.innerHTML = `<h2>Check your email</h2><p class="muted">We sent a confirmation link to <b>${esc(email)}</b>. Open it and you’ll be linked to the team.</p>`; return; }
      await accept();
    } catch (ex) { err(ex.message); $('mj-go').disabled = false; }
  });
}

if (!token) problem('This link is incomplete', 'Open the full link from your invite.');
else if (!configured || isDemo()) problem('Team invites work on the live app', 'This is the demo.');
else {
  const sb = await client();
  const { data } = await sb.auth.getSession();
  if (data.session) await accept();
  else {
    const { data: p } = await sb.rpc('member_invite_preview', { p_token: token });
    const v = p?.[0];
    if (!v) problem('This invite link isn’t valid', 'Ask your agency for a new one.');
    else if (!v.valid) problem('This link has been used or has expired', 'If you already set up your login, sign in. Otherwise ask for a new link.');
    else form(v);
  }
}
