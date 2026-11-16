// Shared lease screens: the document itself, the signature blocks, and the signing steps.
// Used by the owner's Leases page, the tenant app and the witness page.
import { esc, openModal, toast, icon } from './shell.js';
import { signPad } from './sign-pad.js';
import { DOC_STATUS } from './docs-data.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const fmtWhen = iso => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
export const docBadge = d => `<span class="badge ${{ draft: 'plain tag', sent: 's-notice', signed: 's-occupied', void: 's-vacant' }[d.status]}">${DOC_STATUS[d.status]}</span>`;

const sigs = (doc, role, witness = false) => (doc.signatures || []).filter(s => witness ? s.witness_for === role : s.role === role);
export const hasSigned = (doc, role) => sigs(doc, role).length > 0;
export const witnessesLeft = (doc, role) => Math.max(0, (doc.witnesses_per_party || 0) - sigs(doc, role, true).length);

// What is still outstanding, in words.
export function waitingOn(doc) {
  if (doc.status !== 'sent') return '';
  const out = [];
  for (const [role, label] of [['landlord', 'the landlord'], ['tenant', 'the tenant']]) {
    if (!hasSigned(doc, role)) out.push(label);
    else if (witnessesLeft(doc, role)) out.push(`${witnessesLeft(doc, role)} witness${witnessesLeft(doc, role) > 1 ? 'es' : ''} for ${label}`);
  }
  return out.length ? `Waiting for ${out.join(' and ')}.` : '';
}

function partyBlock(label, p = {}) {
  const row = (k, v) => v ? `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>` : '';
  return `<div class="lease-party"><h3>${label}</h3><dl class="kv">
    ${row('Name', p.name)}${row('ID or registration no.', p.id_number)}${row('Address for notices', p.address)}${row('Email', p.email)}${row('Phone', p.phone)}
  </dl></div>`;
}

function sigSlot(label, s, pendingText) {
  return `<div class="sig-slot ${s ? 'signed' : ''}">
    <div class="sig-label">${esc(label)}</div>
    ${s ? `<img class="sig-img" src="${esc(s.signature)}" alt="Signature of ${esc(s.signer_name)}">
           <div class="sig-name">${esc(s.signer_name)}</div>
           <div class="sig-meta">Signed ${fmtWhen(s.signed_at)}${s.method === 'link' ? ' · by secure link' : s.method === 'in_person' ? ' · in person' : ''}</div>`
        : `<div class="sig-pending">${esc(pendingText)}</div>`}
  </div>`;
}

export function signaturesHtml(doc) {
  const n = doc.witnesses_per_party || 0;
  const side = (role, label) => {
    const w = sigs(doc, role, true);
    return `<div class="sig-side">
      ${sigSlot(label, sigs(doc, role)[0], doc.status === 'draft' ? 'Signs after the lease is sent' : 'Not signed yet')}
      ${Array.from({ length: n }, (_, k) => sigSlot(`Witness ${k + 1} for the ${role}`, w[k], 'Not signed yet')).join('')}
    </div>`;
  };
  return `<section class="lease-sigs"><h3>Signatures</h3><div class="sig-grid">${side('landlord', 'The Landlord')}${side('tenant', 'The Tenant')}</div></section>`;
}

// The whole agreement. `audit` adds the network address column (shown to the two parties only).
export function docHtml(doc, { audit = false } = {}) {
  const b = doc.body || {};
  const signed = (doc.signatures || []).length > 0;
  return `<article class="lease-doc printable">
    <header class="lease-head"><div class="lease-brand">RTC Rentals</div><h2>${esc(doc.title || b.title || 'Residential lease agreement')}</h2></header>
    <div class="lease-parties">${partyBlock('The Landlord', b.parties?.landlord)}${partyBlock('The Tenant', b.parties?.tenant)}</div>
    ${b.summary?.length ? `<section class="lease-summary"><h3>Key terms</h3><dl class="kv">${b.summary.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl></section>` : ''}
    ${(b.sections || []).map((s, si) => `<section class="lease-section"><h3>${si + 1}. ${esc(s.heading)}</h3>
      ${s.clauses.map((c, ci) => `<p><span class="clause-no">${si + 1}.${ci + 1}</span>${esc(c)}</p>`).join('')}</section>`).join('')}
    ${signaturesHtml(doc)}
    ${doc.body_hash ? `<footer class="lease-foot">
      <div>Document fingerprint (SHA-256): <code>${esc(doc.body_hash)}</code></div>
      ${doc.completed_at ? `<div>Completed ${fmtWhen(doc.completed_at)}. Signed electronically under the Electronic Communications and Transactions Act 25 of 2002.</div>` : ''}
      ${audit && signed ? `<table class="lease-audit"><thead><tr><th>Signed by</th><th>As</th><th>When</th><th>How</th><th>Network address</th></tr></thead><tbody>
        ${doc.signatures.map(s => `<tr><td>${esc(s.signer_name)}</td><td>${s.role === 'witness' ? `Witness for the ${s.witness_for}` : s.role === 'landlord' ? 'Landlord' : 'Tenant'}</td>
          <td>${fmtWhen(s.signed_at)}</td><td>${{ account: 'Own account', in_person: 'In person, on the party’s device', link: 'One-time secure link' }[s.method] || ''}</td>
          <td>${esc((s.ip || '').split(',')[0] || '—')}</td></tr>`).join('')}</tbody></table>` : ''}
    </footer>` : ''}
  </article>`;
}

// Name + drawn signature + a tick box. onSign(name, pngDataUrl) may throw to show an error.
export function signModal({ title, intro, name = '', nameLabel = 'Your full name', agree, submitLabel = 'Sign', onSign }) {
  let pad;
  openModal({
    title, submitLabel,
    body: `${intro ? `<p class="sign-intro">${intro}</p>` : ''}
      <div class="field"><label for="sg-name">${esc(nameLabel)}</label><input id="sg-name" name="name" value="${esc(name)}" autocomplete="name" maxlength="120"></div>
      <div class="field"><label>Signature</label><div id="sg-pad"></div><div class="hint">Use your finger on a phone, or the mouse on a computer.</div></div>
      <label class="check"><input type="checkbox" name="agree"> <span>${agree}</span></label>`,
    async onSubmit(form) {
      const n = form.elements.name.value.trim();
      if (n.length < 3) throw new Error('Type the full name of the person signing.');
      if (pad.isEmpty()) throw new Error('Draw the signature in the box.');
      if (!form.elements.agree.checked) throw new Error('Tick the box to confirm.');
      await onSign(n, pad.toDataURL());
    },
  });
  pad = signPad(document.getElementById('sg-pad'));
}

// The buttons a party sees on a lease that is out for signing.
export function partyActions(doc, role) {
  if (doc.status !== 'sent') return '';
  if (!hasSigned(doc, role)) return `<button class="btn" type="button" data-doc-action="sign" data-id="${doc.id}">Sign the lease</button>`;
  const left = witnessesLeft(doc, role);
  if (!left) return '';
  return `<button class="btn" type="button" data-doc-action="witness-here" data-id="${doc.id}">My witness signs here</button>
    <button class="btn btn-ghost" type="button" data-doc-action="witness-link" data-id="${doc.id}">Send my witness a link</button>`;
}

// Carries out one of the actions above. Returns true if it handled the click.
export async function runPartyAction(action, doc, { role, api, myName, refresh }) {
  const other = role === 'landlord' ? 'tenant' : 'landlord';
  if (action === 'sign') {
    signModal({
      title: 'Sign the lease', name: myName, submitLabel: 'Sign the lease',
      intro: 'Read the whole lease before you sign. Your signature is recorded with your name, the date and time, and a fingerprint of this exact text.',
      agree: 'I have read this lease, I understand it, and I agree to be bound by it.',
      async onSign(name, png) {
        await api.signLeaseDoc(doc.id, name, png);
        toast(witnessesLeft(doc, role) ? 'Signed. Now ask your witness to sign.' : `Signed. ${hasSigned(doc, other) ? '' : `The ${other} still has to sign.`}`);
        await refresh();
      },
    });
    return true;
  }
  if (action === 'witness-here') {
    signModal({
      title: 'Witness signature', nameLabel: 'Witness’s full name', submitLabel: 'Sign as witness',
      intro: 'Hand the phone to your witness. A witness is an adult who is not a party to this lease and saw you sign it.',
      agree: `I confirm that I witnessed ${esc(sigs(doc, role)[0]?.signer_name || `the ${role}`)} sign this lease.`,
      async onSign(name, png) { await api.addWitness(doc.id, name, png); toast('Witness signature added'); await refresh(); },
    });
    return true;
  }
  if (action === 'witness-link') {
    let link;
    try { link = await api.createWitnessLink(doc.id); } catch (e) { toast(e.message, 'error'); return true; }
    const text = `Please witness my signature on my lease. Open this link, check the details and sign: ${link}`;
    openModal({
      title: 'Link for your witness', submitLabel: 'Done', cancel: false,
      body: `<p style="margin-top:0">Send this link to your witness. They don’t need an account. It works once and expires in 7 days.</p>
        <div class="field"><label for="w-link">Witness link</label><input id="w-link" readonly value="${esc(link)}"></div>
        <div class="invite-actions">
          <button type="button" class="btn" id="w-copy">Copy link</button>
          <a class="btn btn-ghost" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(text)}">WhatsApp</a>
          <a class="btn btn-ghost" href="mailto:?subject=${encodeURIComponent('Please witness my lease signature')}&body=${encodeURIComponent(text)}">Email</a>
        </div>
        <p class="hint" style="margin-bottom:0">The link is shown once. Your witness sees who signed and the address, not the rest of the lease.</p>`,
      async onSubmit() {},
    });
    document.getElementById('w-copy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(link); toast('Link copied'); }
      catch { document.getElementById('w-link').select(); toast('Selected. Press copy on your keyboard.'); }
    });
    await refresh();
    return true;
  }
  if (action === 'print') { printPage(); return true; }
  return false;
}

// Prints only the element marked .printable (the lease, or an inspection report).
export function printPage() {
  document.body.classList.add('print-doc');
  const done = () => { document.body.classList.remove('print-doc'); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  window.print();
}

export const printButton = `<button class="btn btn-ghost" type="button" data-doc-action="print">${icon.file}Print or save as PDF</button>`;
