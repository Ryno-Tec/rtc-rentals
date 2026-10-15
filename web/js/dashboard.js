import { api, summarise, UNIT_STATUS, PROPERTY_TYPES } from './data.js';
import { mountShell, esc, money, pct, icon, toast } from './shell.js';

const profile = await mountShell('dashboard.html');
const first = (profile.full_name || '').split(' ')[0];
document.getElementById('greeting').textContent = first ? `Hi ${first}` : 'Dashboard';
document.getElementById('today').textContent = new Date().toLocaleDateString('en-ZA',
  { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
document.getElementById('add-btn').innerHTML = `${icon.plus}Add property`;

const view = document.getElementById('view');

async function render() {
  let properties;
  try { properties = await api.properties(); }
  catch (e) { view.innerHTML = `<div class="form-error">Couldn’t load your portfolio: ${esc(e.message)}</div>`; return; }

  if (!properties.length) {
    view.innerHTML = `<div class="card empty">
      <h2>Add your first property</h2>
      <p>Start with the address, then add each unit or room you rent out with its monthly rent.</p>
      <a class="btn" href="properties.html#new">${icon.plus}Add property</a></div>`;
    return;
  }

  const s = summarise(properties);
  const lim = profile.limits;
  const seg = (n, color) => s.units ? `<span style="width:${(n / s.units) * 100}%;background:${color}"></span>` : '';
  const vacant = properties.flatMap(p => p.units.filter(u => u.status !== 'occupied').map(u => ({ ...u, property: p })));

  view.innerHTML = `
    <div class="kpis">
      <div class="card kpi"><div class="label">Monthly rent roll</div><div class="value num">${money(s.rentRoll)}</div>
        <div class="sub">from occupied units and units on notice</div></div>
      <div class="card kpi"><div class="label">Occupancy</div><div class="value num">${pct(s.occupancy)}</div>
        <div class="sub">${s.occupied + s.notice} of ${s.units} units let</div></div>
      <div class="card kpi"><div class="label">Lost to vacancies</div><div class="value num">${money(s.vacancyLoss)}</div>
        <div class="sub">per month at asking rent</div></div>
      <div class="card kpi"><div class="label">Portfolio</div><div class="value num">${s.units} <span style="font-size:15px;font-weight:500" class="muted">units</span></div>
        <div class="sub">${s.properties} ${s.properties === 1 ? 'property' : 'properties'}${lim?.max_units ? ` · ${lim.max_units - s.units} left on ${esc(lim.display_name)}` : ''}</div></div>
    </div>

    <div class="two-col">
      <div class="card">
        <div class="card-head"><h2>Properties</h2><a href="properties.html">Manage</a></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Property</th><th class="right">Units</th><th class="right hide-sm">Let</th><th class="right">Rent roll</th></tr></thead>
          <tbody>${properties.map(p => {
            const ps = summarise([p]);
            return `<tr><td><a href="properties.html#p-${p.id}" class="unit-label">${esc(p.name)}</a>
                <div class="unit-sub">${esc(PROPERTY_TYPES[p.property_type])} · ${esc(p.suburb || p.city)}</div></td>
              <td class="right num">${ps.units}</td>
              <td class="right num hide-sm">${ps.units ? pct(ps.occupancy) : '—'}</td>
              <td class="right num">${money(ps.rentRoll)}</td></tr>`;
          }).join('')}</tbody>
        </table></div>
      </div>

      <div class="stack">
        <div class="card card-pad">
          <h2 style="margin-bottom:12px">Unit status</h2>
          <div class="meter" role="img" aria-label="${s.occupied} occupied, ${s.notice} on notice, ${s.maintenance} in maintenance, ${s.vacant} vacant">
            ${seg(s.occupied, 'var(--green)')}${seg(s.notice, '#f59e0b')}${seg(s.maintenance, 'var(--violet)')}${seg(s.vacant, '#ef4444')}
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 16px;margin-top:14px;font-size:13px">
            ${['occupied', 'notice', 'maintenance', 'vacant'].map(k =>
              `<div style="display:flex;justify-content:space-between"><span class="badge s-${k}">${UNIT_STATUS[k]}</span><b class="num">${s[k]}</b></div>`).join('')}
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h2>Needs attention</h2></div>
          ${vacant.length ? `<table><tbody>${vacant.map(u => `
            <tr><td><div class="unit-label">${esc(u.label)}</div><div class="unit-sub">${esc(u.property.name)}</div></td>
            <td><span class="badge s-${u.status}">${UNIT_STATUS[u.status]}</span></td>
            <td class="right num">${money(u.monthly_rent)}</td></tr>`).join('')}</tbody></table>`
          : '<div class="units-empty">Every unit is let. Nice.</div>'}
        </div>
      </div>
    </div>`;
}

await render();
api.subscribe(() => render().catch(e => toast(e.message, 'error')));
