// Ozow from the browser. The server function creates the payment with Ozow (the Client Secret never
// reaches the browser) and returns Ozow's payment page; on the way back the server asks Ozow how it went.
import { client, DataError } from './data.js';

async function call(name, body) {
  const sb = await client();
  const { data, error } = await sb.functions.invoke(name, { body });
  if (error) {
    let msg = 'Couldn’t reach Ozow. Try again in a moment.';
    try { const j = await error.context.json(); if (j?.error) msg = j.error; } catch { /* keep the default */ }
    throw new DataError(msg);
  }
  return data;
}

export async function startOzow(what) {
  const data = await call('ozow-pay', what);
  location.assign(data.redirectUrl);
  return { redirecting: true, reference: data.reference };
}

// Reads ?ozow=back&ref=… from the return trip, then tidies the address bar.
export function ozowReturn() {
  const q = new URLSearchParams(location.search);
  if (!q.get('ozow')) return null;
  const ref = q.get('ref');
  q.delete('ozow'); q.delete('ref');
  history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : '') + location.hash);
  return ref || null;
}

// Asks the server (which asks Ozow) until the payment settles, for up to about a minute.
export async function checkOzow(reference, { tries = 10, wait = 5000 } = {}) {
  let status = 'started';
  for (let i = 0; i < tries; i++) {
    try { status = (await call('ozow-check', { reference })).status || status; } catch { /* try again */ }
    if (!['started', 'pending'].includes(status)) return status;
    await new Promise(r => setTimeout(r, wait));
  }
  return status;
}

export const OZOW_RESULT = {
  complete: ['Payment received. Thank you!', ''],
  already: ['Payment received. Thank you!', ''],
  cancelled: ['Payment cancelled. Nothing was taken from your account.', ''],
  abandoned: ['Payment cancelled. Nothing was taken from your account.', ''],
  error: ['The bank couldn’t complete the payment. Nothing was taken. Try again or pay by EFT.', 'error'],
  pending_investigation: ['Ozow is checking this payment. It updates here once they confirm.', ''],
  pending: ['Your bank is still confirming the payment. It updates here once it clears.', ''],
  started: ['Your bank is still confirming the payment. It updates here once it clears.', ''],
};
