import { isDemo, PROVINCES, leaveDemo } from './data.js';
import { tenantApi as api, CATEGORIES, URGENCY, REQUEST_STATUS, paymentReference } from './tenant-data.js';
import { brand, esc, money, icon, toast, openModal, formData } from './shell.js';

const ico = {
  ...icon,
  message: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16v11H9l-5 4z"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 3 5 14h6l-1 7 8-11h-6z"/></svg>',
  receipt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12 20 4l-6 16-3-7z"/></svg>',
};

// ---------------------------------------------------------------------------
// Session and chrome
// ---------------------------------------------------------------------------
const session = await api.session();
if (!session) location.replace('index.html');
else if (session.role !== 'tenant') location.replace('dashboard.html');

document.getElementById('t-brand').innerHTML = brand('Tenant');
const TABS = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'payments', label: 'Rent', icon: 'cash' },
  { id: 'repairs', label: 'Repairs', icon: 'tool' },
  { id: 'messages', label: 'Messages', icon: 'message' },
];
const tabsEl = document.getElementById('t-tabs');
tabsEl.innerHTML = TABS.map(t => `<a href="#${t.id}" data-tab="${t.id}">${ico[t.icon]}<span>${t.label}</span><b class="t-dot hidden"></b></a>`).join('');

if (isDemo()) {
  document.getElementById('t-demo').innerHTML = `<div class="demo-banner" role="status"><strong>Demo mode</strong>
    <span>You’re seeing the app as Lerato, who rents Room 1. Sample data, saved only in this browser.</span>
    <a class="demo-switch" href="dashboard.html">← Back to landlord view</a></div>`;
  document.getElementById('t-signout').textContent = 'Landlord view';
}
document.getElementById('t-signout').addEventListener('click', async () => {
  if (isDemo()) { location.href = 'dashboard.html'; return; }
  await api.signOut(); leaveDemo(); location.replace('index.html');
});

// ---------------------------------------------------------------------------
// Dates (fixed formats so every browser shows the same thing)
// ---------------------------------------------------------------------------
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ymd = s => { const [y, m, d] = s.slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d || 1); };
const monthName = s => { const d = ymd(s); return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`; };
const shortDate = d => `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)} ${d.getFullYear()}`;
const longDay = d => `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const lastDay = (y, m) => new Date(y, m + 1, 0).getDate();
const dueDate = (p, lease) => { const d = ymd(p.period_month); return new Date(d.getFullYear(), d.getMonth(), Math.min(lease.rent_due_day, lastDay(d.getFullYear(), d.getMonth()))); };
const daysUntil = d => Math.round((startOfDay(d) - startOfDay(new Date())) / 864e5);
const when = iso => {
  const d = new Date(iso), days = -daysUntil(d);
  const t = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (days === 0) return `Today ${t}`;
  if (days === 1) return `Yesterday ${t}`;
  return shortDate(d);
};
const METHOD = { ozow: 'Ozow instant EFT', eft: 'Bank EFT', card: 'Card', debicheck: 'Debit order', cash: 'Cash', other: 'Other' };
const paidLate = (p, lease) => p.paid_at && startOfDay(new Date(p.paid_at)) > dueDate(p, lease);

// ---------------------------------------------------------------------------
// State and rendering
// ---------------------------------------------------------------------------
const view = document.getElementById('t-view');
let data, requests = [], messages = [];

async function loadAll() {
  [data, requests, messages] = await Promise.all([api.home(), api.maintenance(), api.messages()]);
}

function currentTab() {
  const t = location.hash.slice(1);
  return TABS.some(x => x.id === t) ? t : 'home';
}

function render() {
  const tab = currentTab();
  tabsEl.querySelectorAll('a').forEach(a => a.setAttribute('aria-current', a.dataset.tab === tab ? 'page' : 'false'));
  const openCount = requests.filter(r => !['resolved', 'closed'].includes(r.status)).length;
  tabsEl.querySelector('[data-tab="repairs"] .t-dot').classList.toggle('hidden', !openCount);
  const due = data.payments.find(p => p.status !== 'paid' && p.status !== 'refunded');
  tabsEl.querySelector('[data-tab="payments"] .t-dot').classList.toggle('hidden', !due);
  document.getElementById('t-name').textContent = data.tenant.full_name;
  view.innerHTML = { home: homeView, payments: paymentsView, repairs: repairsView, messages: messagesView }[tab]();
  if (tab === 'messages') {
    const list = view.querySelector('.chat');
    list.scrollTop = list.scrollHeight;
  }
}

function rentCard() {
  const { lease, payments, unit, tenant } = data;
  const due = payments.find(p => p.status !== 'paid' && p.status !== 'refunded');
  const ref = paymentReference(unit, tenant);
  if (due) {
    const d = dueDate(due, lease), n = daysUntil(d);
    const tone = n < 0 ? 'late' : n <= 3 ? 'soon' : 'ok';
    const label = n < 0 ? `${-n} ${-n === 1 ? 'day' : 'days'} overdue` : n === 0 ? 'Due today' : `Due in ${n} ${n === 1 ? 'day' : 'days'}`;
    const outstanding = Number(due.amount_due) - Number(due.amount_paid);
    return `
      <section class="card rent-card rent-${tone}" aria-labelledby="rent-h">
        <div class="rent-top"><h2 id="rent-h">${MONTHS[ymd(due.period_month).getMonth()]} rent</h2><span class="pill pill-${tone}">${label}</span></div>
        <div class="rent-amount num">${money(outstanding)}</div>
        <div class="muted">Due ${longDay(d)}</div>
        <button class="btn btn-pay" type="button" data-action="pay" data-id="${due.id}">Pay ${money(outstanding)} now</button>
        <div class="rent-eft">Or pay by EFT using reference <code class="ref">${esc(ref)}</code>
          <button class="btn-copy" type="button" data-copy="${esc(ref)}" aria-label="Copy reference">${ico.copy}</button></div>
      </section>`;
  }
  const last = payments[0];
  const next = last ? (() => { const y = ymd(last.period_month).getFullYear(), m = ymd(last.period_month).getMonth() + 1; return new Date(y, m, Math.min(lease.rent_due_day, lastDay(y, m))); })() : null;
  return `
    <section class="card rent-card rent-ok" aria-labelledby="rent-h">
      <div class="rent-top"><h2 id="rent-h">Rent</h2><span class="pill pill-ok">${ico.check}Paid up</span></div>
      <div class="rent-amount num">${money(0)}</div>
      <div class="muted">${last?.paid_at ? `${MONTHS[ymd(last.period_month).getMonth()]} rent paid on ${shortDate(new Date(last.paid_at))}.` : ''}
        ${next ? `Next rent of ${money(lease.monthly_rent)} is due ${longDay(next)}.` : ''}</div>
      ${last?.paid_at ? `<button class="btn btn-ghost" type="button" data-action="receipt" data-id="${last.id}">${ico.receipt}View receipt</button>` : ''}
    </section>`;
}

function homeView() {
  const { unit, property, lease, landlord, tenant } = data;
  const first = tenant.full_name.split(' ')[0];
  const open = requests.filter(r => !['resolved', 'closed'].includes(r.status));
  const lastMsg = messages.at(-1);
  const start = ymd(lease.start_date), end = lease.end_date ? ymd(lease.end_date) : null;
  const monthsLeft = end ? Math.max(0, (end.getFullYear() - new Date().getFullYear()) * 12 + end.getMonth() - new Date().getMonth()) : null;
  return `
    <div class="t-hello"><h1>Hi ${esc(first)}</h1><p class="muted">${esc(unit.label)} · ${esc(property.name)}</p></div>
    <div class="t-grid">
      ${rentCard()}

      <section class="card card-pad" aria-labelledby="home-h">
        <h2 id="home-h">Your home</h2>
        <p class="t-addr">${esc(unit.label)}<br>${esc([property.street_address, property.suburb].filter(Boolean).join(', '))}<br>${esc([property.city, property.postal_code].filter(Boolean).join(' '))}, ${esc(PROVINCES[property.province])}</p>
        <dl class="kv">
          <div><dt>Rooms</dt><dd>${unit.bedrooms} bed · ${Number(unit.bathrooms)} bath</dd></div>
          <div><dt>Included in rent</dt><dd>${[unit.water_included && 'Water', unit.electricity_included && 'Electricity'].filter(Boolean).join(', ') || 'Nothing extra'}</dd></div>
          ${unit.prepaid_meter_number ? `<div><dt>${ico.bolt}Prepaid meter</dt><dd><code class="ref">${esc(unit.prepaid_meter_number)}</code>
            <button class="btn-copy" type="button" data-copy="${esc(unit.prepaid_meter_number)}" aria-label="Copy meter number">${ico.copy}</button></dd></div>` : ''}
        </dl>
      </section>

      <section class="card card-pad" aria-labelledby="lease-h">
        <h2 id="lease-h">Your lease</h2>
        <dl class="kv">
          <div><dt>Term</dt><dd>${MONTHS[start.getMonth()].slice(0, 3)} ${start.getFullYear()} – ${end ? `${MONTHS[end.getMonth()].slice(0, 3)} ${end.getFullYear()}` : 'month to month'}${monthsLeft != null ? ` <span class="muted">(${monthsLeft} months left)</span>` : ''}</dd></div>
          <div><dt>Monthly rent</dt><dd><span class="num">${money(lease.monthly_rent)}</span>, due on the ${ordinal(lease.rent_due_day)}</dd></div>
          <div><dt>Deposit held</dt><dd><span class="num">${money(lease.deposit)}</span> <span class="muted">in an interest-bearing account</span></dd></div>
          ${Number(lease.escalation_pct) ? `<div><dt>Increase at renewal</dt><dd>${Number(lease.escalation_pct)}%</dd></div>` : ''}
          <div><dt>Signed</dt><dd>${lease.signed_at ? shortDate(new Date(lease.signed_at)) : '<span class="muted">Waiting for signatures</span>'}</dd></div>
        </dl>
      </section>

      <section class="card card-pad" aria-labelledby="ll-h">
        <h2 id="ll-h">Your landlord</h2>
        <p style="margin:8px 0 2px;font-weight:600">${esc(landlord.full_name)}</p>
        ${landlord.phone ? `<p class="t-contact"><span>${esc(landlord.phone)}</span><button class="btn-copy" type="button" data-copy="${esc(landlord.phone)}" aria-label="Copy phone number">${ico.copy}</button></p>` : ''}
        <a class="btn btn-ghost" href="#messages">${ico.message}Send a message</a>
      </section>

      <section class="card" aria-labelledby="open-h">
        <div class="card-head"><h2 id="open-h">Repairs</h2><a href="#repairs">See all</a></div>
        ${open.length ? open.map(r => `<a class="t-row" href="#repairs"><div><div class="unit-label">${esc(r.title)}</div>
            <div class="unit-sub">Logged ${shortDate(new Date(r.created_at))}${r.contractor ? ` · ${esc(r.contractor)}` : ''}</div></div>
            <span class="pill pill-${statusTone(r.status)}">${REQUEST_STATUS[r.status]}</span></a>`).join('')
          : '<div class="units-empty">Nothing open. Something broken? <a href="#repairs" data-action="new-request">Report it</a>.</div>'}
      </section>

      ${lastMsg ? `<section class="card" aria-labelledby="msg-h">
        <div class="card-head"><h2 id="msg-h">Latest message</h2><a href="#messages">Open</a></div>
        <a class="t-row" href="#messages"><div><div class="unit-sub">${lastMsg.sender === 'tenant' ? 'You' : esc(landlord.full_name)} · ${when(lastMsg.created_at)}</div>
          <div class="t-preview">${esc(lastMsg.body)}</div></div></a>
      </section>` : ''}
    </div>`;
}

const ordinal = n => n + (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th');
const statusTone = s => ({ open: 'soon', assigned: 'info', in_progress: 'info', resolved: 'ok', closed: 'muted' }[s]);

function paymentsView() {
  const { payments, lease } = data;
  const paid = payments.filter(p => p.status === 'paid');
  const total = paid.reduce((t, p) => t + Number(p.amount_paid), 0);
  const onTime = paid.filter(p => !paidLate(p, lease)).length;
  return `
    <div class="t-hello"><h1>Rent</h1><p class="muted">${money(lease.monthly_rent)} a month, due on the ${ordinal(lease.rent_due_day)}.</p></div>
    <div class="t-grid">
      ${rentCard()}
      <section class="card card-pad t-stats">
        <div><div class="label">Paid since you moved in</div><div class="value num">${money(total)}</div></div>
        <div><div class="label">On time</div><div class="value num">${onTime} of ${paid.length}</div></div>
      </section>
      <section class="card t-wide" aria-labelledby="hist-h">
        <div class="card-head"><h2 id="hist-h">Payment history</h2></div>
        <div class="table-wrap"><table class="t-table">
          <thead><tr><th>Month</th><th class="right">Amount</th><th class="hide-sm">Paid</th><th>Status</th><th><span class="hidden">Receipt</span></th></tr></thead>
          <tbody>${payments.map(p => {
            const late = paidLate(p, lease);
            const status = p.status === 'paid' ? (late ? ['soon', 'Paid late'] : ['ok', 'Paid'])
              : daysUntil(dueDate(p, lease)) < 0 ? ['late', 'Overdue'] : ['info', 'Due'];
            return `<tr>
              <td><div class="unit-label">${monthName(p.period_month)}</div><div class="unit-sub">${p.method ? METHOD[p.method] : `Due ${shortDate(dueDate(p, lease))}`}</div></td>
              <td class="right num">${money(p.amount_due)}</td>
              <td class="hide-sm">${p.paid_at ? shortDate(new Date(p.paid_at)) : '<span class="muted">—</span>'}</td>
              <td><span class="pill pill-${status[0]}">${status[1]}</span></td>
              <td class="actions">${p.status === 'paid'
                ? `<button class="btn btn-ghost btn-sm" type="button" data-action="receipt" data-id="${p.id}">${ico.receipt}<span class="hide-sm">Receipt</span></button>`
                : `<button class="btn btn-sm" type="button" data-action="pay" data-id="${p.id}">Pay</button>`}</td>
            </tr>`;
          }).join('')}</tbody>
        </table></div>
      </section>
    </div>`;
}

function repairsView() {
  return `
    <div class="t-hello t-hello-row"><div><h1>Repairs</h1><p class="muted">Report anything that’s broken. Your landlord sees it straight away.</p></div>
      <button class="btn" type="button" data-action="new-request">${ico.plus}Report a problem</button></div>
    ${requests.length ? requests.map(r => `
      <article class="card req">
        <div class="req-head">
          <div><h2>${esc(r.title)}</h2>
            <div class="unit-sub">${esc(r.category || 'Other')} · ${URGENCY[r.priority]} · logged ${shortDate(new Date(r.created_at))}</div></div>
          <span class="pill pill-${statusTone(r.status)}">${REQUEST_STATUS[r.status]}</span>
        </div>
        ${r.description ? `<p class="req-desc">${esc(r.description)}</p>` : ''}
        ${r.photo_names?.length ? `<p class="unit-sub">${r.photo_names.length} photo${r.photo_names.length > 1 ? 's' : ''} attached</p>` : ''}
        <ol class="timeline">
          <li><span class="tl-dot"></span><div><b>You reported it</b><div class="unit-sub">${when(r.created_at)}</div></div></li>
          ${(r.updates || []).map(u => `<li><span class="tl-dot tl-ll"></span><div>${esc(u.text)}<div class="unit-sub">${esc(data.landlord.full_name)} · ${when(u.at)}</div></div></li>`).join('')}
          ${r.resolved_at ? `<li><span class="tl-dot tl-ok"></span><div><b>Marked fixed</b><div class="unit-sub">${when(r.resolved_at)}</div></div></li>` : ''}
        </ol>
      </article>`).join('')
    : `<div class="card empty"><h2>No repairs logged</h2><p>When something breaks, report it here with a photo.</p></div>`}`;
}

function messagesView() {
  const { landlord } = data;
  let lastDay = '';
  return `
    <div class="t-hello"><h1>Messages</h1><p class="muted">With ${esc(landlord.full_name)}, your landlord.</p></div>
    <section class="card chat-card">
      <div class="chat" aria-live="polite">
        ${messages.length ? messages.map(m => {
          const d = new Date(m.created_at), day = shortDate(d);
          const sep = day !== lastDay ? `<div class="chat-day">${-daysUntil(d) === 0 ? 'Today' : -daysUntil(d) === 1 ? 'Yesterday' : day}</div>` : '';
          lastDay = day;
          return `${sep}<div class="bubble ${m.sender === 'tenant' ? 'me' : 'them'}"><div>${esc(m.body)}</div>
            <time>${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}</time></div>`;
        }).join('') : '<div class="units-empty">No messages yet. Say hello.</div>'}
      </div>
      <form class="composer" id="composer">
        <label for="msg" class="hidden">Message</label>
        <textarea id="msg" name="body" rows="1" placeholder="Write a message" maxlength="5000" required></textarea>
        <button class="btn" type="submit" aria-label="Send">${ico.send}</button>
      </form>
    </section>`;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
function payFlow(id) {
  const p = data.payments.find(x => x.id === id);
  const amount = Number(p.amount_due) - Number(p.amount_paid);
  openModal({
    title: `Pay ${MONTHS[ymd(p.period_month).getMonth()]} rent`,
    submitLabel: `Pay ${money(amount)} with Ozow`,
    body: `
      <dl class="kv">
        <div><dt>Amount</dt><dd class="num" style="font-weight:650">${money(amount)}</dd></div>
        <div><dt>To</dt><dd>${esc(data.landlord.full_name)}</dd></div>
        <div><dt>For</dt><dd>${esc(data.unit.label)}, ${esc(data.property.name)}</dd></div>
        <div><dt>Reference</dt><dd><code class="ref">${esc(paymentReference(data.unit, data.tenant))}</code></dd></div>
      </dl>
      <p class="muted" style="margin:14px 0 0;font-size:13px">Ozow opens your bank’s app so you can approve the payment. It reflects immediately and you get a receipt here.${isDemo() ? ' <b>In the demo nothing is charged.</b>' : ''}</p>`,
    async onSubmit() {
      const done = await api.pay(id);
      await refresh();
      toast('Payment received. Thank you!');
      if (done) receipt(done.id);
    },
  });
}

function receipt(id) {
  const p = data.payments.find(x => x.id === id);
  const { tenant, unit, property, landlord, lease } = data;
  openModal({
    title: 'Rent receipt', submitLabel: 'Done', cancel: false,
    body: `
      <div class="receipt">
        <div class="receipt-top">${brand('Rent receipt')}<span class="pill pill-ok">${ico.check}Paid</span></div>
        <div class="receipt-amount num">${money(p.amount_paid)}</div>
        <dl class="kv">
          <div><dt>Receipt no.</dt><dd><code class="ref">${esc(p.provider_ref || p.id.slice(0, 8).toUpperCase())}</code></dd></div>
          <div><dt>For</dt><dd>${monthName(p.period_month)} rent</dd></div>
          <div><dt>Paid on</dt><dd>${shortDate(new Date(p.paid_at))}${paidLate(p, lease) ? ' <span class="muted">(after the due date)</span>' : ''}</dd></div>
          <div><dt>Method</dt><dd>${METHOD[p.method] || '—'}</dd></div>
          <div><dt>Tenant</dt><dd>${esc(tenant.full_name)}</dd></div>
          <div><dt>Property</dt><dd>${esc(unit.label)}, ${esc(property.street_address)}, ${esc(property.city)}</dd></div>
          <div><dt>Landlord</dt><dd>${esc(landlord.full_name)}</dd></div>
        </dl>
        <p class="unit-sub" style="margin:12px 0 0">Issued through RTC Rentals, a product of Ryno-Tec Consulting (Pty) Ltd.</p>
      </div>`,
    async onSubmit() {},
  });
}

function newRequest() {
  openModal({
    title: 'Report a problem', submitLabel: 'Send to landlord',
    body: `
      <div class="field"><label for="r-title">What’s wrong?</label>
        <input id="r-title" name="title" required maxlength="120" placeholder="e.g. Geyser not heating"></div>
      <div class="grid-2">
        <div class="field"><label for="r-cat">Type</label>
          <select id="r-cat" name="category">${CATEGORIES.map(c => `<option>${c}</option>`).join('')}</select></div>
        <div class="field"><label for="r-urg">How urgent?</label>
          <select id="r-urg" name="priority">${Object.entries(URGENCY).map(([k, v]) => `<option value="${k}" ${k === 'medium' ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label for="r-desc">Details</label>
        <textarea id="r-desc" name="description" maxlength="2000" placeholder="Where is it, when did it start, and what have you noticed?"></textarea></div>
      <div class="field" style="margin-bottom:0"><label for="r-photo">Photos <span class="muted">(optional)</span></label>
        <input id="r-photo" name="photos" type="file" accept="image/*" multiple>
        <div class="hint">A clear photo helps your landlord send the right person.</div></div>
      <p class="form-note hidden" id="r-emergency">For gas leaks, fire or flooding, get to safety and call emergency services on <b>112</b> first, then phone your landlord.</p>`,
    async onSubmit(form) {
      const d = formData(form);
      if (!d.title) throw new Error('Say briefly what’s wrong, like “Geyser not heating”.');
      const photos = [...form.querySelector('#r-photo').files].map(f => f.name);
      await api.logRequest(data.unit.id, {
        title: d.title, category: d.category, priority: d.priority, description: d.description,
        ...(isDemo() ? { photo_names: photos } : {}),
      });
      toast('Sent to your landlord');
      await refresh();
    },
  });
  const urg = document.getElementById('r-urg');
  urg.addEventListener('change', () => document.getElementById('r-emergency').classList.toggle('hidden', urg.value !== 'urgent'));
}

async function copy(text, btn) {
  try { await navigator.clipboard.writeText(text); toast('Copied'); }
  catch {
    const el = btn.previousElementSibling;
    if (el) { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
    toast('Selected. Press copy on your keyboard.');
  }
}

view.addEventListener('click', e => {
  const c = e.target.closest('[data-copy]');
  if (c) { copy(c.dataset.copy, c); return; }
  const a = e.target.closest('[data-action]');
  if (!a) return;
  const { action, id } = a.dataset;
  if (action === 'pay') payFlow(id);
  if (action === 'receipt') receipt(id);
  if (action === 'new-request') { e.preventDefault(); if (currentTab() !== 'repairs') location.hash = 'repairs'; newRequest(); }
});

view.addEventListener('submit', async e => {
  if (e.target.id !== 'composer') return;
  e.preventDefault();
  const ta = e.target.querySelector('textarea');
  const body = ta.value.trim();
  if (!body) return;
  ta.disabled = true;
  try { await api.send(data.tenant.id, body); await refresh(); document.getElementById('msg')?.focus(); }
  catch (ex) { toast(ex.message, 'error'); ta.disabled = false; }
});
view.addEventListener('keydown', e => {
  if (e.target.id === 'msg' && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.target.form.requestSubmit(); }
});

async function refresh() {
  try { await loadAll(); render(); }
  catch (ex) { view.innerHTML = `<div class="card card-pad"><h2>Can’t open your home yet</h2><p class="muted">${esc(ex.message)}</p></div>`; }
}

window.addEventListener('hashchange', () => { if (data) { render(); window.scrollTo(0, 0); } });
await refresh();
api.subscribe(() => {
  // Don't wipe a half-typed message when something else changes.
  const draft = document.getElementById('msg')?.value;
  refresh().then(() => { const ta = document.getElementById('msg'); if (ta && draft) ta.value = draft; });
});
