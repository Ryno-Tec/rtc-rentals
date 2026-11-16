// Ozow pay-by-bank: building a signed payment request and checking Ozow's signed responses.
// Plain JavaScript (Web Crypto) so it runs in Supabase Edge Functions (Deno) and in the Node tests.
// Field order and hashing follow Ozow's "Post from merchant website" and "Process Ozow response" steps.

export const OZOW_PAY_URL = 'https://pay.ozow.com/';

// Request fields in Ozow's table order. Only the ones we post are hashed; we post no optional fields.
const REQUEST_ORDER = ['SiteCode', 'CountryCode', 'CurrencyCode', 'Amount', 'TransactionReference', 'BankReference',
  'Optional1', 'Optional2', 'Optional3', 'Optional4', 'Optional5', 'Customer',
  'CancelUrl', 'ErrorUrl', 'SuccessUrl', 'NotifyUrl', 'IsTest'];
// Response/notification fields 1–13, in order. Hash, SubStatus, MaskedAccountNumber, BankName and SmartIndicators are left out.
const RESPONSE_ORDER = ['SiteCode', 'TransactionId', 'TransactionReference', 'Amount', 'Status',
  'Optional1', 'Optional2', 'Optional3', 'Optional4', 'Optional5', 'CurrencyCode', 'IsTest', 'StatusMessage'];

export async function sha512Hex(text) {
  const buf = await crypto.subtle.digest('SHA-512', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

const present = v => v !== undefined && v !== null && v !== '';

/** The HashCheck for a payment request: the posted fields in order, then the private key, lower-cased, SHA-512. */
export async function signRequest(fields, privateKey) {
  const joined = REQUEST_ORDER.filter(k => present(fields[k])).map(k => String(fields[k])).join('') + privateKey;
  return sha512Hex(joined.toLowerCase());
}

/** True when a response or notification carries Ozow's valid signature for this private key. */
export async function verifyResponse(params, privateKey) {
  if (!params || !params.Hash || !privateKey) return false;
  const joined = RESPONSE_ORDER.map(k => (params[k] ?? '')).join('') + privateKey;
  const mine = (await sha512Hex(joined.toLowerCase())).replace(/^0+/, '');
  const theirs = String(params.Hash).toLowerCase().replace(/^0+/, '');
  if (mine.length !== theirs.length) return false;
  let diff = 0;
  for (let i = 0; i < mine.length; i++) diff |= mine.charCodeAt(i) ^ theirs.charCodeAt(i);
  return diff === 0;
}

/** The reference the customer sees in their bank: letters, digits, spaces and dashes, 20 characters at most. */
export const bankReference = s => String(s || 'RENT').replace(/[^A-Za-z0-9 -]/g, '').trim().slice(0, 20) || 'RENT';

/** A unique merchant reference for one payment attempt (Ozow allows 50 characters). */
export const newReference = () => 'RTC' + crypto.randomUUID().replace(/-/g, '').slice(0, 20).toUpperCase();

/** The fields to post to Ozow, signed. */
export async function paymentRequest({ siteCode, privateKey, amount, reference, bankRef, cancelUrl, errorUrl, successUrl, notifyUrl, isTest }) {
  const fields = {
    SiteCode: siteCode, CountryCode: 'ZA', CurrencyCode: 'ZAR', Amount: Number(amount).toFixed(2),
    TransactionReference: reference, BankReference: bankReference(bankRef),
    CancelUrl: cancelUrl, ErrorUrl: errorUrl, SuccessUrl: successUrl, NotifyUrl: notifyUrl,
    IsTest: isTest ? 'true' : 'false',
  };
  fields.HashCheck = await signRequest(fields, privateKey);
  return fields;
}
