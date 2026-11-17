// Session guard: shared-device sign-in rules. Run: node tests/web/session-guard.test.mjs
import assert from 'node:assert/strict';
const mk = () => { const m = new Map(); return { getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), _m: m }; };
const keysOf = st => [...st._m.keys()];
globalThis.localStorage = new Proxy(mk(), { ownKeys: t => keysOf(t), getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }) });
globalThis.sessionStorage = new Proxy(mk(), { ownKeys: t => keysOf(t), getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }) });
globalThis.matchMedia = () => ({ matches: false });
const AUTH = 'sb-abc-auth-token';

// An existing remembered session (from before this feature) stays signed in
localStorage.setItem(AUTH, '{"old":1}');
const g = await import('../../web/js/session-guard.js');
assert.equal(g.remembered(), true, 'old sessions count as remembered');
assert.equal(g.authStorage.getItem(AUTH), '{"old":1}');

// Choosing "not remembered" moves the session to this browser session only
g.setRemember(false);
assert.equal(localStorage.getItem(AUTH), null, 'nothing left in permanent storage');
assert.equal(sessionStorage.getItem(AUTH), '{"old":1}');
g.authStorage.setItem(AUTH, '{"new":1}');
assert.equal(localStorage.getItem(AUTH), null); assert.equal(sessionStorage.getItem(AUTH), '{"new":1}');
assert.equal(g.rememberDefault(), false, 'browser default is off once chosen off');

// Idle: 30 minutes when not remembered
g.touch();
assert.equal(g.expired(), false);
sessionStorage.setItem('rtc-session-seen', String(Date.now() - 31 * 60000));
assert.equal(g.expired(), true, 'expired after 30 minutes');
sessionStorage.setItem('rtc-session-seen', String(Date.now() - 29 * 60000));
assert.equal(g.expired(), false);

// Remembered: 30 days
g.setRemember(true);
assert.equal(localStorage.getItem(AUTH), '{"new":1}'); assert.equal(sessionStorage.getItem(AUTH), null);
localStorage.setItem('rtc-session-seen', String(Date.now() - 31 * 60000));
assert.equal(g.expired(), false, '31 minutes is fine when remembered');
localStorage.setItem('rtc-session-seen', String(Date.now() - 31 * 864e5));
assert.equal(g.expired(), true, 'expired after 30 days');

// Sign out here: revoked locally-scoped at Supabase, everything forgotten
let scope;
const sb = { auth: { signOut: async o => { scope = o.scope; return { error: null }; } } };
await g.signOutHere(sb);
assert.equal(scope, 'local'); assert.equal(localStorage.getItem(AUTH), null); assert.equal(sessionStorage.getItem(AUTH), null);
localStorage.setItem(AUTH, 'x');
await g.signOutEverywhere(sb);
assert.equal(scope, 'global'); assert.equal(localStorage.getItem(AUTH), null);
console.log('Session guard tests passed');
