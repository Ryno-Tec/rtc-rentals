// Netcash DebiCheck debit orders (each landlord's own Netcash account). The tenant authenticates the
// DebiCheck mandate with their bank through Netcash; the landlord records the mandate reference in
// RTC Rentals. Each month the server uploads a DebiCheck batch with that month's amount.
//   NIWS_NIF web service: BatchFileUpload(ServiceKey, File) -> file token; RequestFileUploadReport(ServiceKey, token)
export const NETCASH_NIF = 'https://ws.netcash.co.za/NIWS/niws_nif.svc';
// Netcash's published software vendor key for integrators who are not registered ISVs.
export const NETCASH_VENDOR_KEY = '24ade73c-98cf-47b3-99be-cc7b867b3080';

const clean = (s, n) => String(s ?? '').replace(/[\t\r\n]/g, ' ').trim().slice(0, n);
const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, '');

// The next weekday after `from` (DebiCheck action dates must be in the future).
export function actionDate(from = new Date()) {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + 1));
  while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

/** rows: [{ accountRef, mandateRef, amount, ourRef }] */
export function debicheckBatch({ serviceKey, batchName, date, rows, trackingDays = 3, vendorKey = NETCASH_VENDOR_KEY }) {
  if (!rows.length) throw new Error('No collections in the batch');
  const cents = rows.map(r => Math.round(Number(r.amount) * 100));
  if (cents.some(c => !(c > 0))) throw new Error('Every collection needs an amount');
  const lines = [
    ['H', serviceKey, '1', 'DebiCheck', clean(batchName, 40), ymd(date), vendorKey],
    ['K', '101', '162', '232', '249', '301'],
    ...rows.map((r, i) => ['T', clean(r.accountRef, 22), String(cents[i]), String(trackingDays), clean(r.mandateRef, 50), clean(r.ourRef, 50)]),
    ['F', String(rows.length), String(cents.reduce((a, b) => a + b, 0)), '9999'],
  ];
  return lines.map(l => l.join('\t')).join('\r\n');
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function envelope(method, fields) {
  return `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>`
    + `<${method} xmlns="http://tempuri.org/">${Object.entries(fields).map(([k, v]) => `<${k}>${esc(v)}</${k}>`).join('')}</${method}>`
    + `</soap:Body></soap:Envelope>`;
}
async function soap(method, fields, fetchImpl = fetch) {
  const res = await fetchImpl(NETCASH_NIF, { method: 'POST', body: envelope(method, fields),
    headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `http://tempuri.org/INIWS_NIF/${method}` } });
  const text = await res.text();
  const m = text.match(new RegExp(`<${method}Result>([\\s\\S]*?)</${method}Result>`));
  if (!res.ok || !m) throw new Error(`Netcash answered ${res.status}`);
  return m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
}
const ERR = { 100: 'Netcash rejected the service key', 101: 'Date format error', 102: 'Parameter error', 200: 'Netcash general error' };
export async function uploadBatch({ serviceKey, file, fetchImpl }) {
  const r = await soap('BatchFileUpload', { ServiceKey: serviceKey, File: file }, fetchImpl);
  if (ERR[r]) throw new Error(ERR[r]);
  return r;                                   // file token
}
/** Load report: only errors are listed. Returns { result, errors: [lines] } or null if not ready. */
export async function uploadReport({ serviceKey, token, fetchImpl }) {
  const r = await soap('RequestFileUploadReport', { ServiceKey: serviceKey, FileToken: token }, fetchImpl);
  if (ERR[r]) throw new Error(ERR[r]);
  if (!/###BEGIN/.test(r)) return null;
  const body = r.split('###BEGIN')[1].split('###END')[0].trim().split(/\r?\n/).filter(Boolean);
  const head = (body.shift() || '').toUpperCase();
  return { result: /UNSUCCESSFUL/.test(head) ? 'unsuccessful' : /ERRORS/.test(head) ? 'errors' : 'successful', errors: body };
}
