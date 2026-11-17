// Shared look for documents people keep: receipts, leases, statements, reports.
// One header (logo, business details, document number), one receipt layout, and file names
// like "RTCRentals-Receipt-FreddieRick-RTC-RCT-2026-000001" so saved PDFs sort and search well.
import { esc, money } from './shell.js';

export const BUSINESS = {
  name: 'Ryno-Tec Consulting (Pty) Ltd',
  reg: '2026/818634/07',
  email: 'rentals@ryno-tec.co.za',
  web: 'rentals.ryno-tec.co.za',
};

const pascal = s => String(s || '').normalize('NFKD').replace(/[^\w\s-]/g, '').split(/[\s_-]+/).filter(Boolean)
  .map(w => w[0].toUpperCase() + w.slice(1)).join('');
/** "RTCRentals-Lease-FreddieRick-RTC-LSE-2026-000004". Parts that are empty are left out. */
export function fileName(kind, person, ref) {
  return ['RTCRentals', pascal(kind), pascal(person), String(ref || '').replace(/[^\w-]/g, '')].filter(Boolean).join('-');
}

const logo = '<img class="paper-logo" src="icons/logo.svg" alt="" width="40" height="40">';

/** Letterhead: RTC Rentals + Ryno-Tec details on the left, the document's name and number on the right. */
export function paperHead({ title, number, numberLabel = 'No.', date, extra = '' }) {
  return `<header class="paper-head">
    <div class="paper-brand">${logo}<div><b>RTC Rentals</b>
      <span>${esc(BUSINESS.name)}</span><span>Reg. ${esc(BUSINESS.reg)}</span>
      <span>${esc(BUSINESS.email)} · ${esc(BUSINESS.web)}</span></div></div>
    <div class="paper-id"><div class="paper-title">${esc(title)}</div>
      ${number ? `<div><span>${esc(numberLabel)}</span> <code>${esc(number)}</code></div>` : ''}
      ${date ? `<div><span>Date</span> ${esc(date)}</div>` : ''}${extra}</div>
  </header>`;
}


/**
 * A receipt. r = { number, issued, month, paidOn, late, method, reference, due, paid,
 *   tenant: { name, email }, home, landlord: { name, email, phone } }
 */
export function receiptHtml(r) {
  const balance = Math.max(0, Number(r.due || 0) - Number(r.paid || 0));
  const full = balance === 0;
  return `<article class="paper receipt-paper printable">
    ${paperHead({ title: 'Rent receipt', number: r.number, numberLabel: 'Receipt', date: r.issued })}
    <div class="receipt-hero">
      <div><div class="receipt-label">Amount received</div><div class="receipt-total num">${money(r.paid)}</div>
        <div class="receipt-for">${esc(r.month)} rent${r.paidOn ? ` · paid ${esc(r.paidOn)}` : ''}${r.late ? ' <span class="receipt-late">after the due date</span>' : ''}</div></div>
      <div class="receipt-stamp ${full ? '' : 'part'}">${full ? 'Paid' : 'Part paid'}</div>
    </div>
    <div class="paper-parties">
      <div><h4>Received from</h4><b>${esc(r.tenant?.name || '')}</b>${r.tenant?.email ? `<span>${esc(r.tenant.email)}</span>` : ''}<span>${esc(r.home || '')}</span></div>
      <div><h4>Received by</h4><b>${esc(r.landlord?.name || '')}</b>${r.landlord?.email ? `<span>${esc(r.landlord.email)}</span>` : ''}${r.landlord?.phone ? `<span>${esc(r.landlord.phone)}</span>` : ''}<span>Landlord</span></div>
    </div>
    <table class="paper-lines"><thead><tr><th>Description</th><th class="right">Amount</th></tr></thead><tbody>
      <tr><td>Rent for ${esc(r.month)}</td><td class="right num">${money(r.due)}</td></tr>
      <tr class="paper-sub"><td>Paid</td><td class="right num">${money(r.paid)}</td></tr>
      <tr class="paper-total"><td>${full ? 'Balance for the month' : 'Still owing for the month'}</td><td class="right num">${money(balance)}</td></tr>
    </tbody></table>
    <dl class="paper-meta">
      <div><dt>Payment method</dt><dd>${esc(r.method || '—')}</dd></div>
      ${r.reference ? `<div><dt>Bank / Ozow reference</dt><dd><code>${esc(r.reference)}</code></dd></div>` : ''}
      <div><dt>Receipt number</dt><dd><code>${esc(r.number || '—')}</code></dd></div>
    </dl>
    <footer class="paper-foot">${full ? 'Thank you. This month is paid in full.' : `A balance of ${money(balance)} remains for this month.`}
      Issued by the landlord through RTC Rentals. Quote the receipt number in any query to ${esc(BUSINESS.email)}.</footer>
  </article>`;
}
