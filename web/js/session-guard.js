// Sign-in on shared devices, the way banking sites do it.
//
// - "Keep me signed in on this device" is off by default in a browser. Off: the session lives in
//   sessionStorage, so closing the browser (or the tab) ends it, and 30 minutes without activity
//   signs the person out. On (own phone or the installed app): it is kept, but 30 days without use
//   still signs out.
// - Sign out ends this session at Supabase too (the refresh token is revoked), not only in this browser.
// - "Sign out on all devices" ends every session of the account, e.g. after using a shared computer.
// - Sessions created before this existed are treated as remembered, so nobody is thrown out by an update.

const FLAG = 'rtc-remember';                 // '1' = keep signed in, '0' = this browser session only
const SEEN = 'rtc-session-seen';             // last activity (ms) in the same storage as the session
export const IDLE_MINUTES = 30;
export const REMEMBER_DAYS = 30;

const safe = fn => { try { return fn(); } catch { return null; } };
const local = { get: k => safe(() => localStorage.getItem(k)), set: (k, v) => safe(() => localStorage.setItem(k, v)), del: k => safe(() => localStorage.removeItem(k)) };
const sess = { get: k => safe(() => sessionStorage.getItem(k)), set: (k, v) => safe(() => sessionStorage.setItem(k, v)), del: k => safe(() => sessionStorage.removeItem(k)) };
const isAuthKey = k => /^sb-.*-auth-token/.test(k);

// One-off: a session saved before this feature counts as "keep me signed in".
if (local.get(FLAG) === null && safe(() => Object.keys(localStorage).some(isAuthKey))) local.set(FLAG, '1');

export const installedApp = () => safe(() => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true) || false;
export const remembered = () => local.get(FLAG) === '1';
/** Default for the checkbox: on in the installed app (a personal phone), off in a browser. */
export const rememberDefault = () => (local.get(FLAG) === null ? installedApp() : remembered());

/** Call just before signing in (password or Google/Microsoft). */
export function setRemember(on) {
  local.set(FLAG, on ? '1' : '0');
  const from = on ? sess : local, to = on ? local : sess;
  for (const k of safe(() => Object.keys(on ? sessionStorage : localStorage)) || []) {
    if (isAuthKey(k) || k === SEEN) { const v = from.get(k); if (v !== null) to.set(k, v); from.del(k); }
  }
}

/** Storage handed to Supabase: localStorage when remembered, sessionStorage otherwise. */
export const authStorage = {
  getItem: k => (remembered() ? local.get(k) : sess.get(k)) ?? sess.get(k),
  setItem: (k, v) => { (remembered() ? local : sess).set(k, v); if (!remembered()) local.del(k); },
  removeItem: k => { local.del(k); sess.del(k); },
};

const store = () => (remembered() ? local : sess);
const limitMs = () => (remembered() ? REMEMBER_DAYS * 864e5 : IDLE_MINUTES * 6e4);
export const touch = () => store().set(SEEN, String(Date.now()));
export function expired() {
  const seen = Number(store().get(SEEN) || 0);
  return seen > 0 && Date.now() - seen > limitMs();
}
function forget() {
  for (const s of [localStorage, sessionStorage]) for (const k of safe(() => Object.keys(s)) || []) if (isAuthKey(k)) safe(() => s.removeItem(k));
  local.del(SEEN); sess.del(SEEN);
}

/** Watches a live Supabase client: signs out after the idle limit, keeps the activity time fresh. */
export async function guard(sb) {
  const { data } = await sb.auth.getSession();
  if (data.session && expired()) {
    await sb.auth.signOut({ scope: 'local' }).catch(() => {});
    forget();
    if (!/index\.html$|\/$/.test(location.pathname)) location.replace('index.html?signedout=idle');
    return;
  }
  if (data.session) touch();
  let last = 0;
  const bump = () => { const n = Date.now(); if (n - last > 15000) { last = n; touch(); } };
  for (const ev of ['pointerdown', 'keydown', 'scroll', 'touchstart']) addEventListener(ev, bump, { passive: true });
  const check = async () => {
    const { data: d } = await sb.auth.getSession();
    if (d.session && expired()) {
      await sb.auth.signOut({ scope: 'local' }).catch(() => {});
      forget();
      location.replace('index.html?signedout=idle');
    }
  };
  setInterval(check, 60000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
  sb.auth.onAuthStateChange((event, s) => { if (event === 'SIGNED_IN' && s) touch(); if (event === 'SIGNED_OUT') forget(); });
}

/** Ends this device's session (revoked at Supabase). */
export async function signOutHere(sb) { await sb.auth.signOut({ scope: 'local' }).catch(() => {}); forget(); }
/** Ends every session of this account, on every device. */
export async function signOutEverywhere(sb) {
  const { error } = await sb.auth.signOut({ scope: 'global' });
  forget();
  if (error) throw error;
}

/** The "Keep me signed in" checkbox for sign-in forms (id="remember"). */
export const rememberField = () => `<label class="check remember-me" style="margin:2px 0 14px"><input type="checkbox" id="remember" ${rememberDefault() ? 'checked' : ''}>
  <span>Keep me signed in on this device <span class="muted">— leave off on a shared or public computer</span></span></label>`;
/** Applies the checkbox (if the page has one) just before signing in. */
export function applyRemember() {
  const box = typeof document !== 'undefined' && document.getElementById('remember');
  if (box) setRemember(box.checked);
}
