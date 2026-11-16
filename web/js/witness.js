// A witness opens a one-time link, sees whose signature they are witnessing, and signs.
// No account. They see who signed and for which home, not the lease itself.
import { docsApi } from './docs-data.js';
import { brand, esc, icon } from './shell.js';
import { signPad } from './sign-pad.js';
import { fmtWhen } from './lease-ui.js';

const view = document.getElementById('w-view');
const token = new URLSearchParams(location.search).get('t') || '';
const api = docsApi('witness');
const frame = inner => { view.innerHTML = `<div class="witness-brand">${brand('Witness a signature')}</div>${inner}`; };

let p = null;
try { p = token ? await api.witnessPreview(token) : null; }
catch (e) { frame(`<div class="card card-pad"><h2>Can’t open this link</h2><p class="muted">${esc(e.message)}</p></div>`); }

if (!view.querySelector('.card')) {
  if (!p) frame('<div class="card card-pad"><h2>This witness link isn’t valid</h2><p class="muted">Check that you opened the whole link, or ask the person who sent it for a new one.</p></div>');
  else if (!p.valid) frame('<div class="card card-pad"><h2>This link can’t be used any more</h2><p class="muted">It has already been used, it has expired, or the lease is no longer open for signing. Ask the person who sent it for a new one if you still need to sign.</p></div>');
  else {
    const who = p.witness_for === 'landlord' ? 'landlord' : 'tenant';
    frame(`
      <div class="card card-pad">
        <h2>${esc(p.party_name)} asks you to witness their signature</h2>
        <p class="muted" style="margin:4px 0 0">They signed a lease as the ${who}. As a witness you confirm that this is their signature. You are not agreeing to the lease or taking on any of its duties.</p>
        <dl class="kv">
          <div><dt>Document</dt><dd>${esc(p.title)}</dd></div>
          <div><dt>Home</dt><dd>${esc(p.premises || '—')}</dd></div>
          <div><dt>Landlord</dt><dd>${esc(p.landlord_name || '—')}</dd></div>
          <div><dt>Tenant</dt><dd>${esc(p.tenant_name || '—')}</dd></div>
          <div><dt>Signed by ${esc(p.party_name)}</dt><dd>${fmtWhen(p.party_signed_at)}</dd></div>
        </dl>
        <div class="sig-slot signed" style="margin-top:12px"><div class="sig-label">Their signature</div>
          <img class="sig-img" src="${esc(p.party_signature || '')}" alt="Signature of ${esc(p.party_name)}"></div>
      </div>
      <form class="card card-pad" id="w-form" novalidate>
        <h2>Your details</h2>
        <div class="form-error hidden" role="alert"></div>
        <div class="field" style="margin-top:12px"><label for="w-name">Your full name</label><input id="w-name" name="name" autocomplete="name" maxlength="120"></div>
        <div class="field"><label>Your signature</label><div id="w-pad"></div><div class="hint">Use your finger on a phone, or the mouse on a computer.</div></div>
        <label class="check"><input type="checkbox" name="agree"> <span>I am an adult, I am not the landlord or the tenant on this lease, and ${esc(p.party_name)} has confirmed to me that the signature above is theirs.</span></label>
        <button class="btn" type="submit" style="margin-top:16px">Sign as witness</button>
        <p class="hint" style="margin-bottom:0">Your name, signature, the time and your network address are recorded with the lease. Document fingerprint: <code>${esc((p.fingerprint || '').slice(0, 16))}…</code></p>
      </form>`);
    const pad = signPad(document.getElementById('w-pad'));
    const form = document.getElementById('w-form'), err = form.querySelector('.form-error');
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const btn = form.querySelector('[type=submit]');
      const fail = m => { err.textContent = m; err.classList.remove('hidden'); err.scrollIntoView({ block: 'center' }); };
      const name = form.elements.name.value.trim();
      if (name.length < 3) return fail('Type your full name.');
      if (pad.isEmpty()) return fail('Draw your signature in the box.');
      if (!form.elements.agree.checked) return fail('Tick the box to confirm.');
      btn.disabled = true; err.classList.add('hidden');
      try {
        await api.witnessSign(token, name, pad.toDataURL());
        frame(`<div class="card card-pad"><h2><span class="pill pill-ok">${icon.check}Done</span> Thank you, ${esc(name.split(' ')[0])}</h2>
          <p class="muted">Your witness signature has been added to the lease. You can close this page.</p></div>`);
      } catch (ex) { btn.disabled = false; fail(ex.message + '.'); }
    });
  }
}
