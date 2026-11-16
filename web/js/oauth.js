// "Continue with Google / Apple / Microsoft". A button only shows once that provider is switched
// on in Supabase (Authentication > Sign In / Providers), so nothing breaks before set-up.
import { configured, isDemo, client, DataError } from './data.js';
import { config } from './config.js';
import { esc } from './shell.js';

const NAMES = { google: 'Google', apple: 'Apple', azure: 'Microsoft' };

export async function enabledProviders() {
  if (!configured || isDemo()) return [];
  try {
    const url = config.supabaseUrl.trim().replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
    const r = await fetch(`${url}/auth/v1/settings`, { headers: { apikey: config.supabaseAnonKey.trim() } });
    if (!r.ok) return [];
    const ext = (await r.json()).external || {};
    return Object.keys(NAMES).filter(k => ext[k]);
  } catch { return []; }
}

export async function signInWith(provider, redirectTo) {
  const sb = await client();
  const { error } = await sb.auth.signInWithOAuth({ provider, options: {
    redirectTo, scopes: provider === 'azure' ? 'email openid profile' : undefined } });
  if (error) throw new DataError(error.message);
}

/** Renders the buttons into `host` (hidden when none are switched on). `redirectTo` = where to come back to. */
export async function mountOAuth(host, { redirectTo = location.href, verb = 'Continue', onError } = {}) {
  const list = await enabledProviders();
  if (!list.length) { host.innerHTML = ''; host.classList.add('hidden'); return; }
  host.classList.remove('hidden');
  host.innerHTML = `<div class="oauth-btns">${list.map(p =>
    `<button type="button" class="btn btn-ghost btn-block oauth-${p}" data-provider="${p}">${verb} with ${esc(NAMES[p])}</button>`).join('')}</div>
    <div class="divider">or use your email</div>`;
  host.querySelectorAll('[data-provider]').forEach(b => b.addEventListener('click', async () => {
    b.disabled = true;
    try { await signInWith(b.dataset.provider, redirectTo); }
    catch (e) { b.disabled = false; onError?.(e.message); }
  }));
}
