// Small helpers shared by the Edge Functions.
export const SITE_URL = (globalThis.Deno?.env.get('SITE_URL') || 'https://rentals.ryno-tec.co.za').replace(/\/+$/, '');
export const cors = {
  'Access-Control-Allow-Origin': SITE_URL,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Vary': 'Origin',
};
export const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
export const fail = (status, message) => json(status, { error: message });
