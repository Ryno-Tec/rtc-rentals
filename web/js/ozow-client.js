// Starts an Ozow payment from the browser. The server function signs the request (the private key
// never reaches the browser); this posts the signed form to Ozow, which takes over the page.
import { client, DataError } from './data.js';

export async function startOzow(what) {
  const sb = await client();
  const { data, error } = await sb.functions.invoke('ozow-pay', { body: what });
  if (error) {
    let msg = 'Couldn’t reach Ozow. Try again in a moment.';
    try { const j = await error.context.json(); if (j?.error) msg = j.error; } catch { /* keep the default */ }
    throw new DataError(msg);
  }
  postToOzow(data.action, data.fields);
  return { redirecting: true, reference: data.reference };
}

export function postToOzow(action, fields) {
  const f = document.createElement('form');
  f.method = 'POST'; f.action = action; f.style.display = 'none';
  for (const [k, v] of Object.entries(fields)) {
    const i = document.createElement('input'); i.type = 'hidden'; i.name = k; i.value = v; f.appendChild(i);
  }
  document.body.appendChild(f);
  f.submit();
}

// Reads ?ozow=success|cancelled|error from the return trip, then tidies the address bar.
export function ozowReturn() {
  const q = new URLSearchParams(location.search);
  const result = q.get('ozow');
  if (!result) return null;
  q.delete('ozow'); q.delete('ref');
  history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : '') + location.hash);
  return result;
}
