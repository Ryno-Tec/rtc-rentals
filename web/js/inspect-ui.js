// The inspection screen, shared by the owner's Inspections page and the tenant app.
// Either party rates each item, adds notes and photos, then confirms. The database clears
// the other party's confirmation when something changes, and locks the record once both agree.
import { fileName } from './paper.js';
import { esc, openModal, toast, icon, confirmDialog } from './shell.js';
import { KINDS, CONDITIONS, bothConfirmed } from './docs-data.js';
import { fmtWhen, printPage } from './lease-ui.js';

const camera = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.5"/></svg>';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const fmtDay = s => { if (!s) return ''; const [y, m, d] = s.slice(0, 10).split('-').map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };

export function inspectionStats(i) {
  const items = i.items || [];
  return { total: items.length, rated: items.filter(x => x.condition).length,
    fair: items.filter(x => x.condition === 'fair').length, poor: items.filter(x => x.condition === 'poor').length,
    photos: (i.photos || []).length };
}

// One-line state for lists: who still has to do what.
export function inspectionState(i, role) {
  const me = `${role}_signed_at`, other = role === 'landlord' ? 'tenant' : 'landlord';
  if (bothConfirmed(i)) return { tone: 'ok', badge: 's-occupied', text: 'Confirmed by both' };
  if (i[me]) return { tone: 'info', badge: 's-notice', text: `Waiting for the ${other}` };
  if (i[`${other}_signed_at`]) return { tone: 'soon', badge: 's-notice', text: 'Needs your confirmation' };
  const s = inspectionStats(i);
  return { tone: 'muted', badge: 'plain tag', text: s.rated ? `In progress · ${s.rated} of ${s.total}` : 'Not started' };
}

export function inspectionCard(i, role, where = '') {
  const st = inspectionState(i, role), s = inspectionStats(i);
  return `<a class="t-row insp-row" href="#${role === 'tenant' ? 'inspection/' : 'i-'}${i.id}">
    <div><div class="unit-label">${KINDS[i.kind]} inspection${where ? ` · ${esc(where)}` : ''}</div>
      <div class="unit-sub">${fmtDay(i.inspected_on)} · ${s.total} items${s.poor ? ` · ${s.poor} damaged` : ''}${s.photos ? ` · ${s.photos} photo${s.photos > 1 ? 's' : ''}` : ''}</div></div>
    <span class="badge ${st.badge}">${st.text}</span></a>`;
}

/**
 * Mounts one inspection into `host`.
 * ctx: { api, role, myName, names: {landlord, tenant}, where, load(): inspection, baseline(): inspection|null, back: href }
 */
export async function mountInspection(host, ctx) {
  const { api, role } = ctx;
  const other = role === 'landlord' ? 'tenant' : 'landlord';
  const myNote = `${role}_note`, theirNote = `${other}_note`;
  let insp, urls = {}, base = null;

  const locked = () => bothConfirmed(insp);
  const rooms = () => {
    const map = new Map();
    for (const it of insp.items) { if (!map.has(it.room)) map.set(it.room, []); map.get(it.room).push(it); }
    return [...map];
  };
  const baseFor = it => base?.items.find(b => b.room === it.room && b.item === it.item);

  function statusHtml() {
    const s = inspectionStats(insp);
    const who = (r, label) => insp[`${r}_signed_at`]
      ? `<span class="pill pill-ok">${icon.check}${label}: ${esc(insp[`${r}_signed_name`] || 'confirmed')}, ${fmtWhen(insp[`${r}_signed_at`])}</span>`
      : `<span class="pill pill-muted">${label}: not confirmed yet</span>`;
    let next;
    if (locked()) next = 'Both of you confirmed this inspection. It is now a permanent record and can’t be changed.';
    else if (s.rated < s.total) next = `Rate each item, add a note or a photo where something isn’t perfect, then confirm. ${s.total - s.rated} of ${s.total} still to rate.`;
    else if (insp[`${role}_signed_at`]) next = `You’ve confirmed. The ${other} now needs to check it and confirm. If they change anything, you’ll be asked to confirm again.`;
    else if (insp[`${other}_signed_at`]) next = `The ${other} has confirmed this inspection. Check every room. If you agree, confirm. If not, change the rating or add your note and photo, and they’ll be asked to confirm again.`;
    else next = `Everything is rated. Confirm when you’re happy with it, then the ${other} does the same.`;
    return `<div class="insp-totals"><span><b>${s.total}</b> items</span><span><b>${s.fair}</b> fair</span><span><b>${s.poor}</b> damaged</span><span><b>${s.photos}</b> photos</span></div>
      <div class="insp-pills">${who('landlord', 'Landlord')}${who('tenant', 'Tenant')}</div>
      <p class="insp-next">${next}</p>
      <div class="insp-actions no-print">
        ${!locked() && !insp[`${role}_signed_at`] ? `<button class="btn" type="button" data-ia="confirm">Confirm this inspection</button>` : ''}
        <button class="btn btn-ghost" type="button" data-ia="print">${icon.file}Print or save as PDF</button>
        ${role === 'landlord' && !locked() ? `<button class="btn btn-danger" type="button" data-ia="delete">${icon.trash}Delete</button>` : ''}
      </div>`;
  }

  function itemHtml(it) {
    const b = baseFor(it), ro = locked();
    const photos = insp.photos.filter(p => p.item_id === it.id);
    return `<div class="insp-item ${it.condition === 'poor' ? 'is-poor' : it.condition === 'fair' ? 'is-fair' : ''}" data-item="${it.id}">
      <div class="insp-item-top">
        <div class="insp-name">${esc(it.item)}${b?.condition ? `<span class="insp-base">At move-in: ${CONDITIONS[b.condition]}</span>` : ''}</div>
        <div class="seg" role="group" aria-label="Condition of ${esc(it.item)}">
          ${Object.entries(CONDITIONS).map(([k, v]) => `<button type="button" class="seg-${k}" data-cond="${k}" aria-pressed="${it.condition === k}" ${ro ? 'disabled' : ''}>${v}</button>`).join('')}
        </div>
      </div>
      ${it[theirNote] ? `<div class="insp-note theirs"><b>${other === 'landlord' ? 'Landlord' : 'Tenant'}:</b> ${esc(it[theirNote])}</div>` : ''}
      ${ro ? (it[myNote] ? `<div class="insp-note"><b>${role === 'landlord' ? 'Landlord' : 'Tenant'}:</b> ${esc(it[myNote])}</div>` : '')
           : `<textarea class="insp-mynote" rows="1" maxlength="1000" placeholder="Your note (optional)" aria-label="Your note on ${esc(it.item)}">${esc(it[myNote] || '')}</textarea>`}
      <div class="insp-photos">
        ${photos.map(p => `<button type="button" class="thumb" data-photo="${p.id}" aria-label="Open photo"><img src="${esc(urls[p.id] || '')}" alt="Photo of ${esc(it.item)}" loading="lazy"></button>`).join('')}
        ${ro ? '' : `<button type="button" class="btn btn-ghost btn-sm no-print note-btn" data-ia="note">${icon.edit}Note</button>
          <label class="btn btn-ghost btn-sm addphoto no-print">${camera}Photo<input type="file" accept="image/*" multiple hidden data-addphoto="${it.id}"></label>
          ${role === 'landlord' || it.created_by === 'tenant' ? `<button type="button" class="btn btn-ghost btn-icon btn-sm no-print" data-ia="del-item" data-id="${it.id}" aria-label="Remove ${esc(it.item)}">${icon.trash}</button>` : ''}`}
      </div>
    </div>`;
  }

  function render() {
    host.innerHTML = `
      <div class="insp printable">
        <a class="back no-print" href="${ctx.back}">← All inspections</a>
        <div class="card card-pad insp-head">
          <h2>${KINDS[insp.kind]} inspection</h2>
          <p class="muted" style="margin:2px 0 10px">${esc(ctx.where || '')}${ctx.where ? ' · ' : ''}${fmtDay(insp.inspected_on)}${ctx.names ? ` · ${esc(ctx.names.landlord)} (landlord) and ${esc(ctx.names.tenant)} (tenant)` : ''}</p>
          <div id="insp-status">${statusHtml()}</div>
        </div>
        ${rooms().map(([room, items]) => `
          <section class="card insp-room" data-room="${esc(room)}">
            <div class="card-head"><h2>${esc(room)}</h2>
              ${!locked() && items.some(x => !x.condition) ? `<button type="button" class="btn btn-ghost btn-sm no-print" data-ia="room-good" data-room="${esc(room)}">Mark the rest Good</button>` : ''}</div>
            ${items.map(itemHtml).join('')}
            ${locked() ? '' : `<div class="insp-add no-print"><button type="button" class="btn btn-ghost btn-sm" data-ia="add-item" data-room="${esc(room)}">${icon.plus}Add an item to ${esc(room)}</button></div>`}
          </section>`).join('')}
        ${locked() ? '' : `<p class="no-print"><button type="button" class="btn btn-ghost" data-ia="add-room">${icon.plus}Add a room or area</button></p>`}
      </div>`;
  }

  async function reload() {
    insp = await ctx.load();
    if (!insp) { host.innerHTML = `<div class="card empty"><h2>Inspection not found</h2><p><a href="${ctx.back}">Back to inspections</a></p></div>`; return false; }
    base = insp.kind === 'move_out' ? await ctx.baseline?.() : null;
    urls = await api.photoUrls(insp.photos).catch(() => ({}));
    render();
    return true;
  }
  // After my change the other party must confirm again: show that without redrawing the whole page.
  function touched() {
    insp[`${other}_signed_at`] = null; insp[`${other}_signed_name`] = null;
    host.querySelector('#insp-status').innerHTML = statusHtml();
  }
  const fail = async e => { toast(e.message, 'error'); await reload(); };

  host.onclick = async e => {
    const cond = e.target.closest('[data-cond]');
    if (cond && !cond.disabled) {
      const row = cond.closest('[data-item]'), it = insp.items.find(x => x.id === row.dataset.item);
      if (it.condition === cond.dataset.cond) return;
      it.condition = cond.dataset.cond;
      row.querySelectorAll('[data-cond]').forEach(b => b.setAttribute('aria-pressed', String(b === cond)));
      row.classList.toggle('is-poor', it.condition === 'poor'); row.classList.toggle('is-fair', it.condition === 'fair');
      touched();
      try { await api.updateItem(it.id, { condition: it.condition }); } catch (ex) { await fail(ex); }
      if (insp.items.filter(x => x.room === it.room).every(x => x.condition)) row.closest('.insp-room').querySelector('[data-ia="room-good"]')?.remove();
      return;
    }
    const ph = e.target.closest('[data-photo]');
    if (ph) { openPhoto(insp.photos.find(p => p.id === ph.dataset.photo)); return; }
    const a = e.target.closest('[data-ia]');
    if (!a) return;
    const act = a.dataset.ia;
    try {
      if (act === 'note') { const row = a.closest('[data-item]'); row.classList.add('show-note'); row.querySelector('.insp-mynote')?.focus(); return; }
      if (act === 'print') printPage(fileName(`${KINDS[insp.kind] || ''} inspection`, ctx.names?.tenant, (insp.completed_at || insp.created_at || '').slice(0, 10)));
      if (act === 'room-good') { await api.rateRoom(insp.id, a.dataset.room, 'good'); await reload(); }
      if (act === 'del-item' && await confirmDialog('Remove this item?', 'Its notes and photos are removed too.', 'Remove')) { await api.deleteItem(a.dataset.id); await reload(); }
      if (act === 'add-item') addItem(a.dataset.room);
      if (act === 'add-room') addItem(null);
      if (act === 'confirm') confirmFlow();
      if (act === 'delete' && await confirmDialog('Delete this inspection?', 'Everything recorded in it, including photos, is removed.', 'Delete')) {
        await api.deleteInspection(insp.id); toast('Inspection deleted'); location.hash = ctx.back.replace(/^#/, '');
      }
    } catch (ex) { await fail(ex); }
  };

  host.onchange = async e => {
    const note = e.target.closest('.insp-mynote');
    if (note) {
      const it = insp.items.find(x => x.id === note.closest('[data-item]').dataset.item);
      const v = note.value.trim() || null;
      if (v === (it[myNote] || null)) return;
      it[myNote] = v; touched();
      try { await api.updateItem(it.id, { [myNote]: v }); } catch (ex) { await fail(ex); }
      return;
    }
    const input = e.target.closest('[data-addphoto]');
    if (input && input.files.length) {
      const label = input.closest('label'), files = [...input.files].slice(0, 6);
      label.classList.add('busy'); label.firstChild.nextSibling.textContent = 'Uploading…';
      try { for (const f of files) await api.addPhoto(insp, input.dataset.addphoto, f); toast(files.length > 1 ? `${files.length} photos added` : 'Photo added'); }
      catch (ex) { toast(ex.message, 'error'); }
      await reload();
    }
  };

  function openPhoto(p) {
    if (!p) return;
    const mine = p.added_by === role && !locked();
    openModal({
      title: `Photo · added by the ${p.added_by} on ${fmtWhen(p.created_at)}`, submitLabel: mine ? 'Remove photo' : 'Close', danger: mine, cancel: mine,
      body: `<img class="photo-full" src="${esc(urls[p.id] || '')}" alt="Inspection photo">`,
      async onSubmit() { if (mine) { await api.deletePhoto(p); await reload(); } },
    });
  }

  function addItem(room) {
    openModal({
      title: room ? `Add an item to ${room}` : 'Add a room or area', submitLabel: 'Add',
      body: `${room ? '' : '<div class="field"><label for="ai-room">Room or area</label><input id="ai-room" name="room" maxlength="80" placeholder="e.g. Study, Carport, Storeroom"></div>'}
        <div class="field" style="margin-bottom:0"><label for="ai-item">What to check</label><input id="ai-item" name="item" maxlength="120" placeholder="e.g. Blinds, Air conditioner, Remote"></div>`,
      async onSubmit(form) {
        const r = room || form.elements.room.value.trim(), item = form.elements.item.value.trim();
        if (!r) throw new Error('Name the room or area.');
        if (!item) throw new Error('Say what should be checked.');
        const inRoom = insp.items.filter(x => x.room === r);
        const sort = inRoom.length ? Math.max(...inRoom.map(x => x.sort)) + 1 : (Math.max(0, ...insp.items.map(x => x.sort)) / 100 | 0) * 100 + 100;
        await api.addItem(insp.id, r, item, sort);
        await reload();
      },
    });
  }

  function confirmFlow() {
    const s = inspectionStats(insp);
    if (s.rated < s.total) { toast(`Rate every item first. ${s.total - s.rated} still to do.`, 'error'); host.querySelector('.insp-item:not(:has([aria-pressed="true"]))')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
    openModal({
      title: 'Confirm this inspection', submitLabel: 'Confirm',
      body: `<dl class="kv" style="margin-top:0">
          <div><dt>Items checked</dt><dd>${s.total}</dd></div>
          <div><dt>Fair</dt><dd>${s.fair}</dd></div>
          <div><dt>Damaged</dt><dd>${s.poor}</dd></div>
          <div><dt>Photos</dt><dd>${s.photos}</dd></div></dl>
        <div class="field" style="margin-top:14px"><label for="ci-name">Your full name</label><input id="ci-name" name="name" value="${esc(ctx.myName || '')}" maxlength="120" autocomplete="name"></div>
        <label class="check"><input type="checkbox" name="agree"> <span>I confirm this is a true record of the condition of the home on ${fmtDay(insp.inspected_on)}.</span></label>
        <p class="hint" style="margin-bottom:0">Once both of you confirm, the record is locked and counts as signed by both.</p>`,
      async onSubmit(form) {
        if (!form.elements.agree.checked) throw new Error('Tick the box to confirm.');
        await api.confirmInspection(insp.id, form.elements.name.value);
        toast('Confirmed');
        await reload();
      },
    });
  }

  return reload();
}
