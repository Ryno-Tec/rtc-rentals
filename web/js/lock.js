// App lock: after the first sign-in, the app opens with a 6-digit PIN or the phone's fingerprint
// or face unlock, the way banking apps do. It locks when the app is reopened or left idle.
//
// This protects the app on this device (someone picking up an unlocked phone). The account itself
// stays protected by the password at sign-in. The PIN never leaves the device: only a salted
// PBKDF2 hash is kept in this browser. Fingerprint/face uses the phone's own platform authenticator
// (WebAuthn) with user verification required; RTC Rentals never sees the fingerprint or face.
import { esc, openModal, toast, icon } from './shell.js';

const KEY = email => 'rtc-lock:' + (email || '').toLowerCase();
const OFFERED = email => 'rtc-lock-offered:' + (email || '').toLowerCase();
const SESSION = 'rtc-unlocked';
const LAST = 'rtc-last-active';
const MAX_FAILS = 5;
export const LOCK_AFTER = { 0: 'Every time the app is opened', 1: 'After 1 minute away', 5: 'After 5 minutes away', 15: 'After 15 minutes away' };

const ls = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage off */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* storage off */ } },
};
const ss = {
  get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* storage off */ } },
  del(k) { try { sessionStorage.removeItem(k); } catch { /* storage off */ } },
};

const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const rand = n => crypto.getRandomValues(new Uint8Array(n));

async function hashPin(pin, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(salt), iterations: 210000 }, key, 256);
  return b64(bits);
}
const sameText = (a, b) => a.length === b.length && [...a].reduce((d, c, i) => d | (c.charCodeAt(0) ^ b.charCodeAt(i)), 0) === 0;
const validPin = p => /^\d{6}$/.test(p) && !/^(\d)\1{5}$/.test(p) && !['123456', '654321', '012345', '123123'].includes(p);

export async function biometricAvailable() {
  try {
    return window.isSecureContext && !!window.PublicKeyCredential
      && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch { return false; }
}

async function createBiometric(email, name) {
  const cred = await navigator.credentials.create({ publicKey: {
    challenge: rand(32),
    rp: { name: 'RTC Rentals', id: location.hostname },
    user: { id: rand(16), name: email, displayName: name || email },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
    timeout: 60000, attestation: 'none',
  } });
  if (!cred) throw new Error('Fingerprint or face unlock wasn’t set up.');
  return b64(cred.rawId);
}

async function checkBiometric(credId) {
  const a = await navigator.credentials.get({ publicKey: {
    challenge: rand(32), rpId: location.hostname, timeout: 60000, userVerification: 'required',
    allowCredentials: [{ type: 'public-key', id: unb64(credId), transports: ['internal'] }],
  } });
  // Byte 32 of the authenticator data holds the flags; 0x04 = the person was verified (fingerprint, face or device PIN).
  const flags = a && new Uint8Array(a.response.authenticatorData)[32];
  return Boolean(a && b64(a.rawId) === credId && (flags & 0x04));
}

// ---------------------------------------------------------------------------
// The lock screen
// ---------------------------------------------------------------------------
const touch = () => ls.set(LAST, Date.now());
function due(cfg) {
  if (!ss.get(SESSION)) return true;                       // the app was just opened
  const last = Number(ls.get(LAST) || 0);
  return Date.now() - last > (cfg.after ?? 5) * 60000;
}

function lockScreen(email, cfg, signOut) {
  return new Promise(resolve => {
    document.getElementById('app-lock')?.remove();
    const el = document.createElement('div');
    el.id = 'app-lock'; el.className = 'app-lock'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', 'App locked');
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', cfg.cred ? 'bio' : '', '0', 'del'];
    el.innerHTML = `
      <div class="lock-box">
        <div class="brand-mark lock-mark">${icon.logo}</div>
        <h1>Enter your PIN</h1>
        <p class="muted lock-who">${esc(email)}</p>
        <div class="lock-dots" aria-hidden="true">${'<i></i>'.repeat(6)}</div>
        <p class="lock-msg" role="alert"></p>
        <input class="lock-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" aria-label="PIN" type="password">
        <div class="lock-pad">${keys.map(k => k === '' ? '<span></span>'
          : k === 'bio' ? `<button type="button" data-k="bio" aria-label="Use fingerprint or face">${FINGER}</button>`
          : k === 'del' ? `<button type="button" data-k="del" aria-label="Delete">⌫</button>`
          : `<button type="button" data-k="${k}">${k}</button>`).join('')}</div>
        <button type="button" class="btn-link lock-forgot">Forgot your PIN? Sign in with your password</button>
      </div>`;
    document.body.appendChild(el);
    document.documentElement.classList.add('locked');
    const input = el.querySelector('.lock-input'), dots = el.querySelectorAll('.lock-dots i'), msg = el.querySelector('.lock-msg');
    let pin = '', busy = false;
    const draw = () => dots.forEach((d, i) => d.classList.toggle('on', i < pin.length));
    const done = () => {
      ss.set(SESSION, '1'); touch();
      const c = ls.get(KEY(email)); if (c) { c.fails = 0; ls.set(KEY(email), c); }
      el.remove(); document.documentElement.classList.remove('locked'); resolve();
    };
    const out = async () => { ls.del(KEY(email)); ss.del(SESSION); await signOut(); location.replace('index.html'); };

    async function tryPin() {
      busy = true;
      const c = ls.get(KEY(email));
      const ok = sameText(await hashPin(pin, c.salt), c.hash);
      if (ok) return done();
      c.fails = (c.fails || 0) + 1; ls.set(KEY(email), c);
      pin = ''; draw(); busy = false; input.value = '';
      el.querySelector('.lock-box').classList.remove('shake'); void el.offsetWidth; el.querySelector('.lock-box').classList.add('shake');
      const left = MAX_FAILS - c.fails;
      if (left <= 0) { msg.textContent = 'Too many wrong PINs. Signing you out…'; setTimeout(out, 1200); return; }
      msg.textContent = `Wrong PIN. ${left} ${left === 1 ? 'try' : 'tries'} left before you’re signed out.`;
    }
    function press(k) {
      if (busy) return;
      if (k === 'bio') return bio();
      if (k === 'del') pin = pin.slice(0, -1);
      else if (pin.length < 6) pin += k;
      msg.textContent = ''; draw();
      if (pin.length === 6) tryPin();
    }
    async function bio() {
      try { if (await checkBiometric(ls.get(KEY(email)).cred)) done(); else msg.textContent = 'Not recognised. Use your PIN.'; }
      catch { msg.textContent = 'Fingerprint or face unlock was cancelled. Use your PIN.'; }
    }
    el.addEventListener('click', e => { const b = e.target.closest('[data-k]'); if (b) press(b.dataset.k); });
    input.addEventListener('input', () => { const d = input.value.replace(/\D/g, '').slice(0, 6); pin = d; draw(); if (pin.length === 6 && !busy) tryPin(); });
    document.addEventListener('keydown', function onKey(e) {
      if (!document.body.contains(el)) { document.removeEventListener('keydown', onKey); return; }
      if (document.activeElement === input) return;
      if (/^\d$/.test(e.key)) press(e.key); else if (e.key === 'Backspace') press('del');
    });
    el.querySelector('.lock-forgot').addEventListener('click', out);
    if (cfg.cred) setTimeout(bio, 300);                     // offer the fingerprint/face prompt straight away
    else if (!matchMedia('(pointer: coarse)').matches) input.focus();
  });
}
const FINGER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 11v3a8 8 0 0 0 1 4"/><path d="M8.5 12a3.5 3.5 0 0 1 7 0v1.5a12 12 0 0 0 .8 4.3"/><path d="M5.5 15a12 12 0 0 1-.5-3.5 7 7 0 0 1 12.6-4.2"/><path d="M18.8 10a7 7 0 0 1 .2 1.5V13"/><path d="M8.6 20a10 10 0 0 1-1.6-4.6V12a5 5 0 0 1 .4-2"/></svg>';

/**
 * Call once a page knows who is signed in. Resolves when the app may show its content.
 * `user` = { email, name }, `signOut` = async function that ends the session.
 */
export async function appLock(user, signOut) {
  if (!user?.email) return;
  const cfg = ls.get(KEY(user.email));
  if (cfg && due(cfg)) await lockScreen(user.email, cfg, signOut);
  else { ss.set(SESSION, '1'); touch(); }

  // Keep track of activity; lock again when the app comes back after being away too long.
  let t = 0;
  const seen = () => { const n = Date.now(); if (n - t > 10000) { t = n; touch(); } };
  ['pointerdown', 'keydown', 'scroll'].forEach(ev => addEventListener(ev, seen, { passive: true, capture: true }));
  document.addEventListener('visibilitychange', async () => {
    const c = ls.get(KEY(user.email));
    if (document.visibilityState === 'hidden') { touch(); return; }
    if (c && Date.now() - Number(ls.get(LAST) || 0) > (c.after ?? 5) * 60000 && !document.getElementById('app-lock')) {
      ss.del(SESSION); await lockScreen(user.email, c, signOut);
    }
  });
  if (!cfg && !ls.get(OFFERED(user.email))) setTimeout(() => offerLock(user), 1500);
}

// ---------------------------------------------------------------------------
// Setting it up
// ---------------------------------------------------------------------------
function offerLock(user) {
  ls.set(OFFERED(user.email), Date.now());
  const bar = document.createElement('div');
  bar.className = 'install-bar lock-offer'; bar.setAttribute('role', 'region'); bar.setAttribute('aria-label', 'Protect the app');
  bar.innerHTML = `<div class="install-text"><b>Protect the app with a PIN</b><span>Open it with a 6-digit PIN or your fingerprint or face, like a banking app.</span></div>
    <button type="button" class="btn btn-sm" data-go>Set up</button><button type="button" class="btn btn-ghost btn-sm" data-x>Not now</button>`;
  document.body.appendChild(bar);
  bar.querySelector('[data-x]').addEventListener('click', () => bar.remove());
  bar.querySelector('[data-go]').addEventListener('click', () => { bar.remove(); lockSettings(user); });
}

export function lockOn(email) { return Boolean(ls.get(KEY(email))); }

export async function lockSettings(user) {
  const cfg = ls.get(KEY(user.email));
  const canBio = await biometricAvailable();
  openModal({
    title: cfg ? 'App lock' : 'Set up app lock', submitLabel: cfg ? 'Save' : 'Turn on app lock',
    body: `<p style="margin-top:0" class="muted">${cfg ? 'The app is locked with your PIN on this phone or computer.' : 'Choose a 6-digit PIN to open the app on this phone or computer.'}
        Your password still protects your account; the PIN only works on this device.</p>
      <div class="grid-2">
        <div class="field"><label for="lk-pin">${cfg ? 'New PIN <span class="muted">(leave blank to keep)</span>' : '6-digit PIN'}</label>
          <input id="lk-pin" name="pin" type="password" inputmode="numeric" autocomplete="new-password" maxlength="6" pattern="\\d{6}"></div>
        <div class="field"><label for="lk-pin2">Type it again</label>
          <input id="lk-pin2" name="pin2" type="password" inputmode="numeric" autocomplete="new-password" maxlength="6"></div>
      </div>
      ${canBio ? `<label class="check" style="margin-bottom:14px"><input type="checkbox" name="bio" ${!cfg || cfg.cred ? 'checked' : ''}> <span>Also unlock with fingerprint or face</span></label>`
        : '<p class="hint">Fingerprint or face unlock isn’t available in this browser. On a phone, install the app first, then come back here.</p>'}
      <div class="field"><label for="lk-after">Lock the app</label><select id="lk-after" name="after">
        ${Object.entries(LOCK_AFTER).map(([k, v]) => `<option value="${k}" ${Number(k) === (cfg?.after ?? 5) ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      ${cfg ? '<button type="button" class="btn btn-danger btn-sm" id="lk-off">Turn off app lock</button>' : ''}`,
    async onSubmit(form) {
      const pin = form.elements.pin.value.trim(), pin2 = form.elements.pin2.value.trim();
      const wantBio = Boolean(form.elements.bio?.checked);
      if (!cfg || pin) {
        if (!validPin(pin)) throw new Error('Use 6 digits that aren’t all the same or in a simple sequence.');
        if (pin !== pin2) throw new Error('The two PINs don’t match.');
      }
      // Ask for the fingerprint/face first: browsers only allow it straight after a tap.
      let cred = cfg?.cred || null;
      if (wantBio && !cred) {
        try { cred = await createBiometric(user.email, user.name); }
        catch { throw new Error('Fingerprint or face unlock wasn’t set up. Try again, or untick it to use only the PIN.'); }
      }
      if (!wantBio) cred = null;
      const next = { v: 1, after: Number(form.elements.after.value), cred, fails: 0, salt: cfg?.salt, hash: cfg?.hash };
      if (pin) { next.salt = b64(rand(16)); next.hash = await hashPin(pin, next.salt); }
      ls.set(KEY(user.email), next); ss.set(SESSION, '1'); touch();
      toast(cfg ? 'App lock saved' : `App lock on${cred ? ', with fingerprint or face' : ''}`);
      document.dispatchEvent(new CustomEvent('applock-change'));
    },
  });
  document.getElementById('lk-off')?.addEventListener('click', () => {
    ls.del(KEY(user.email)); document.querySelector('.modal-backdrop')?.remove();
    toast('App lock turned off'); document.dispatchEvent(new CustomEvent('applock-change'));
  });
}
