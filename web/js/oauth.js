// "Continue with Google / Apple / Microsoft". A button only shows once that provider is switched
// on in Supabase (Authentication > Sign In / Providers), so nothing breaks before set-up.
import { configured, isDemo, client, DataError } from './data.js';
import { config } from './config.js';
import { esc } from './shell.js';

const NAMES = { google: 'Google', apple: 'Apple', azure: 'Microsoft' };
// Each provider's own mark, from the artwork it publishes for sign-in buttons (Google's is icons/google-g.png).
// Microsoft's mark goes in icons/microsoft-logo.svg (from Microsoft's sign-in branding artwork); until
// that file exists the button shows text only.
const LOGOS = {
  google: '<img src="icons/google-g.png" alt="" width="18" height="18">',
  azure: '<img src="icons/microsoft-logo.svg" alt="" width="18" height="18" onerror="this.remove()">',
};

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
    // Supabase needs Microsoft's email claim; the app registration adds xms_edov so unverified
    // email domains can't be used to take over someone else's account.
    redirectTo, scopes: provider === 'azure' ? 'openid email profile' : undefined,
    queryParams: provider === 'azure' ? { prompt: 'select_account' } : undefined } });
  if (error) throw new DataError(error.message);
}

/** Renders the buttons into `host` (hidden when none are switched on). `redirectTo` = where to come back to. */
export async function mountOAuth(host, { redirectTo = location.href, verb = 'Continue', onError } = {}) {
  const list = await enabledProviders();
  if (!list.length) { host.innerHTML = ''; host.classList.add('hidden'); return; }
  host.classList.remove('hidden');
  host.innerHTML = `<div class="oauth-btns">${list.map(p =>
    `<button type="button" class="btn btn-ghost btn-block oauth-${p}" data-provider="${p}">${LOGOS[p] || ''}<span>${verb} with ${esc(NAMES[p])}</span></button>`).join('')}</div>
    <div class="divider">or use your email</div>`;
  host.querySelectorAll('[data-provider]').forEach(b => b.addEventListener('click', async () => {
    b.disabled = true;
    try { await signInWith(b.dataset.provider, redirectTo); }
    catch (e) { b.disabled = false; onError?.(e.message); }
  }));
}
