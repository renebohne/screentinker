/*
 * 3.0 energy & carbon (server: lib/energy, routes/energy.js; docs/energy.md).
 *
 *   #/energy[?start=YYYY-MM-DD&end=YYYY-MM-DD]
 *
 * Estimated kWh and CO2e per screen, group and workspace for a period, what the power schedules
 * saved, "what if" switch-off suggestions that open the existing power-schedule editor, the CSV and
 * ESG-appendix downloads, the per-screen wattage table, the workspace's grid settings and, for an
 * organization admin, the rollup across the organization's workspaces.
 *
 * ⚠️ EVERY FIGURE ON THIS PAGE IS AN ESTIMATE and the page says so where the numbers are, not only
 * in the methodology: how much of the on-time was inferred, and how many screens use a guessed
 * wattage, sit right under the totals.
 *
 * Values from the server reach the page through esc() only.
 */
import { api, downloadEnergyFile } from '../api.js';
import { t, tn } from '../i18n.js';
import { esc } from '../utils.js';
import { showToast } from '../components/toast.js';
import { openGroupPowerScheduleModal } from '../components/group-power-schedule-modal.js';

let state = { start: null, end: null, report: null, settings: null, devices: null };

const iso = (d) => d.toISOString().slice(0, 10);
function presetRange(name) {
  const now = new Date();
  const today = iso(now);
  if (name === 'last_month') {
    const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
    return { start: iso(first), end: iso(last) };
  }
  if (name === 'last_year') {
    const y = now.getUTCFullYear() - 1;
    return { start: `${y}-01-01`, end: `${y}-12-31` };
  }
  if (name === 'year') return { start: `${now.getUTCFullYear()}-01-01`, end: today };
  if (name === 'last_30') return { start: iso(new Date(now.getTime() - 29 * 86400000)), end: today };
  return { start: today.slice(0, 8) + '01', end: today };
}

const num = (n, digits = 1) => (Number(n) || 0).toLocaleString(undefined, { maximumFractionDigits: digits });
const kwh = (n) => t('energy.unit.kwh', { n: num(n, n >= 100 ? 0 : 1) });
const kg = (n) => (n >= 1000 ? t('energy.unit.t', { n: num(n / 1000, 2) }) : t('energy.unit.kg', { n: num(n, n >= 100 ? 0 : 1) }));

function wattsSourceLabel(s) {
  return ({
    override: t('energy.src.override'), datasheet: t('energy.src.datasheet'), size: t('energy.src.size'),
    workspace_default: t('energy.src.workspace_default'), default: t('energy.src.default'), snapshot: t('energy.src.snapshot'),
  })[s] || s;
}
function intensitySourceLabel(s) {
  return ({
    device_country: t('energy.isrc.device_country'), workspace_override: t('energy.isrc.workspace_override'),
    timezone: t('energy.isrc.timezone'), workspace_country: t('energy.isrc.workspace_country'), world: t('energy.isrc.world'),
  })[s] || s;
}

function cachedUser() {
  try { return JSON.parse(localStorage.getItem('user') || 'null'); } catch { return null; }
}

export async function render(app) {
  const q = new URLSearchParams(window.location.hash.split('?')[1] || '');
  const def = presetRange('month');
  state = { start: q.get('start') || def.start, end: q.get('end') || def.end, report: null, settings: null, devices: null };
  let copied = false;
  try { copied = !!(cachedUser()?.current_workspace?.origin_node_id); } catch { copied = false; }

  app.innerHTML = `
    <div class="page-header">
      <div><h1>${esc(t('nav.energy'))}</h1><div class="subtitle">${esc(t('energy.intro'))}</div></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button type="button" class="btn btn-secondary" data-dl="device">${esc(t('energy.export_csv'))}</button>
        <button type="button" class="btn btn-secondary" data-dl="day">${esc(t('energy.export_daily'))}</button>
        <button type="button" class="btn btn-secondary" data-dl="appendix">${esc(t('energy.export_appendix'))}</button>
      </div>
    </div>
    ${copied ? `<div class="corp-notice" style="margin-bottom:12px">${esc(t('energy.copied_note'))}</div>` : ''}
    <div class="energy-period">
      <select id="energyPreset" class="input" aria-label="${esc(t('energy.period'))}">
        <option value="month">${esc(t('energy.preset.month'))}</option>
        <option value="last_month">${esc(t('energy.preset.last_month'))}</option>
        <option value="last_30">${esc(t('energy.preset.last_30'))}</option>
        <option value="year">${esc(t('energy.preset.year'))}</option>
        <option value="last_year">${esc(t('energy.preset.last_year'))}</option>
        <option value="custom">${esc(t('energy.preset.custom'))}</option>
      </select>
      <input type="date" id="energyStart" class="input" value="${esc(state.start)}" aria-label="${esc(t('report.start_date'))}">
      <input type="date" id="energyEnd" class="input" value="${esc(state.end)}" aria-label="${esc(t('report.end_date'))}">
      <button type="button" class="btn btn-primary" id="energyApply">${esc(t('energy.apply'))}</button>
    </div>
    <div id="energyBody"><p style="color:var(--text-muted)">${esc(t('common.loading'))}</p></div>
    <div id="energyWhatIf"></div>
    <div id="energyScreens"></div>
    <div id="energySettings"></div>
    <div id="energyOrg"></div>
    <details class="energy-method"><summary>${esc(t('energy.method.title'))}</summary>
      <p>${esc(t('energy.method.ontime'))}</p><p>${esc(t('energy.method.watts'))}</p>
      <p>${esc(t('energy.method.carbon'))}</p><p>${esc(t('energy.method.savings'))}</p><p>${esc(t('energy.method.limits'))}</p>
    </details>`;

  const preset = app.querySelector('#energyPreset');
  preset.value = q.get('start') ? 'custom' : 'month';
  preset.addEventListener('change', () => {
    if (preset.value === 'custom') return;
    const r = presetRange(preset.value);
    app.querySelector('#energyStart').value = r.start;
    app.querySelector('#energyEnd').value = r.end;
    apply(app);
  });
  app.querySelector('#energyApply').addEventListener('click', () => { preset.value = 'custom'; apply(app); });
  app.querySelectorAll('[data-dl]').forEach((b) => b.addEventListener('click', () => download(b.dataset.dl)));

  await load(app);
  loadWhatIf(app);
  loadScreens(app);
  loadSettings(app);
}

function apply(app) {
  state.start = app.querySelector('#energyStart').value;
  state.end = app.querySelector('#energyEnd').value;
  load(app);
}

async function download(kind) {
  const range = `start=${encodeURIComponent(state.start)}&end=${encodeURIComponent(state.end)}`;
  const path = kind === 'appendix' ? `appendix?${range}&download=1` : `export?${range}${kind === 'day' ? '&by=day' : ''}`;
  try {
    const blob = await downloadEnergyFile(path);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = kind === 'appendix' ? `energy-appendix-${state.start}-to-${state.end}.txt` : `energy-${state.start}-to-${state.end}${kind === 'day' ? '-daily' : ''}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (e) { showToast(e.message, 'error'); }
}

function tile(label, value, sub = '') {
  return `<div class="fresh-tile"><div class="fresh-tile-value">${esc(value)}</div><div class="fresh-tile-label">${esc(label)}</div>${sub ? `<div class="energy-tile-sub">${esc(sub)}</div>` : ''}</div>`;
}

function change(cur, prev) {
  if (!prev) return '';
  const pct = Math.round(((cur - prev) / prev) * 100);
  return t('energy.vs_previous', { pct: (pct > 0 ? '+' : '') + pct });
}

async function load(app) {
  const body = document.getElementById('energyBody');
  if (!body) return;
  let r;
  try { r = await api.getEnergyReport(state.start, state.end); } catch (e) {
    body.innerHTML = `<p class="corp-notice corp-notice-danger">${esc(e.message)}</p>`;
    return;
  }
  if (!document.contains(body)) return;
  state.report = r;
  const T = r.totals;
  if (!T.screens) {
    body.innerHTML = `<div class="corp-empty">${esc(t('energy.empty'))}</div>`;
    loadOrg(app);
    return;
  }
  const estimated = (r.watts_sources.size || 0) + (r.watts_sources.default || 0) + (r.watts_sources.workspace_default || 0);
  body.innerHTML = `
    <div class="fresh-tiles">
      ${tile(t('energy.tile.kwh'), kwh(T.kwh), change(T.kwh, r.previous.kwh))}
      ${tile(t('energy.tile.co2'), kg(T.kg_co2e))}
      ${tile(t('energy.tile.saved'), kwh(T.saved_kwh), kg(T.saved_kg_co2e))}
      ${tile(t('energy.tile.screens'), String(T.screens), t('energy.tile.on_hours', { n: num(T.on_hours, 0) }))}
    </div>
    <p class="corp-help energy-caveat">${esc(t('energy.caveat', { inferred: Math.round(T.inferred_share * 100), offline: num(T.offline_hours, 0) }))}
      ${estimated ? ` ${esc(tn('energy.caveat_watts', estimated))}` : ''}</p>
    <h2 class="energy-h2">${esc(t('energy.by_day'))}</h2>
    ${chartHtml(r.by_day)}
    ${r.by_group.length ? `<h2 class="energy-h2">${esc(t('energy.by_group'))}</h2>
      <p class="corp-help" style="font-size:12px">${esc(t('energy.by_group_note'))}</p>
      <div class="table-wrap"><table class="corp-table"><thead><tr><th>${esc(t('energy.col.group'))}</th><th>${esc(t('energy.col.screens'))}</th><th>${esc(t('energy.col.kwh'))}</th><th>${esc(t('energy.col.co2'))}</th><th>${esc(t('energy.col.saved'))}</th></tr></thead><tbody>
      ${r.by_group.map((g) => `<tr><td>${esc(g.name)}</td><td>${esc(g.screens)}</td><td>${esc(num(g.kwh))}</td><td>${esc(num(g.kg_co2e))}</td><td>${esc(num(g.saved_kwh))}</td></tr>`).join('')}
      </tbody></table></div>` : ''}
    <h2 class="energy-h2">${esc(t('energy.by_screen'))}</h2>
    <div class="table-wrap"><table class="corp-table"><thead><tr><th>${esc(t('energy.col.screen'))}</th><th>${esc(t('energy.col.on_hours'))}</th><th>${esc(t('energy.col.sched_off'))}</th><th>${esc(t('energy.col.watts'))}</th><th>${esc(t('energy.col.kwh'))}</th><th>${esc(t('energy.col.co2'))}</th><th>${esc(t('energy.col.saved'))}</th></tr></thead><tbody>
    ${r.by_device.map((d) => `<tr><td>${esc(d.removed ? t('energy.removed_screen') : d.name)}</td><td>${esc(num(d.on_hours, 0))}</td><td>${esc(num(d.sched_off_hours, 0))}</td>
      <td title="${esc(wattsSourceLabel(d.watts_source))}">${esc(num(d.on_watts, 0))} W <span class="energy-src">${esc(wattsSourceLabel(d.watts_source))}</span></td>
      <td>${esc(num(d.kwh))}</td><td title="${esc(`${num(d.g_per_kwh, 0)} g/kWh · ${intensitySourceLabel(d.intensity_source)}`)}">${esc(num(d.kg_co2e))}</td><td>${esc(num(d.saved_kwh))}</td></tr>`).join('')}
    </tbody></table></div>`;
  loadOrg(app);
}

/*
 * One series (kWh per day), one hue, bars anchored to the baseline. The exact value is on hover and
 * in the CSV; the chart is for the shape of the period.
 */
function chartHtml(days) {
  if (!days.length) return '';
  const max = Math.max(...days.map((d) => d.kwh), 0.001);
  const W = Math.max(days.length * 10, 300), H = 120, gap = 2;
  const bw = W / days.length - gap;
  const bars = days.map((d, i) => {
    const h = Math.max(d.kwh > 0 ? 2 : 0, (d.kwh / max) * (H - 4));
    const x = i * (bw + gap);
    return `<g><title>${esc(`${d.day}: ${kwh(d.kwh)} · ${kg(d.kg_co2e)}${d.saved_kwh ? ` · ${t('energy.saved_short', { v: kwh(d.saved_kwh) })}` : ''}`)}</title>
      <rect x="${x.toFixed(1)}" y="0" width="${(bw + gap).toFixed(1)}" height="${H}" fill="transparent"></rect>
      <rect class="energy-bar" x="${x.toFixed(1)}" y="${(H - h).toFixed(1)}" width="${Math.max(bw, 1).toFixed(1)}" height="${h.toFixed(1)}" rx="${bw >= 8 ? 2 : 0}"></rect></g>`;
  }).join('');
  return `<div class="energy-chart" role="img" aria-label="${esc(t('energy.chart_label', { max: kwh(max) }))}">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" width="100%" height="${H}">${bars}<line x1="0" y1="${H - 0.5}" x2="${W}" y2="${H - 0.5}" class="energy-axis"></line></svg>
    <div class="energy-chart-axis"><span>${esc(days[0].day)}</span><span>${esc(t('energy.chart_max', { v: kwh(max) }))}</span><span>${esc(days[days.length - 1].day)}</span></div>
  </div>`;
}

/* ============================== what if ============================== */

async function loadWhatIf(app) {
  const host = document.getElementById('energyWhatIf');
  if (!host) return;
  const hours = Array.from({ length: 24 }, (_, h) => `<option value="${h}">${String(h).padStart(2, '0')}:00</option>`).join('');
  host.innerHTML = `<h2 class="energy-h2">${esc(t('energy.whatif.title'))}</h2>
    <p class="corp-help">${esc(t('energy.whatif.intro'))}</p>
    <div class="energy-period">
      <label>${esc(t('energy.whatif.from'))} <select class="input" id="wiStart">${hours}</select></label>
      <label>${esc(t('energy.whatif.to'))} <select class="input" id="wiEnd">${hours}</select></label>
      <select class="input" id="wiDays" aria-label="${esc(t('energy.whatif.days'))}">
        <option value="">${esc(t('energy.whatif.every_day'))}</option>
        <option value="1,2,3,4,5">${esc(t('energy.whatif.weeknights'))}</option>
        <option value="0,6">${esc(t('energy.whatif.weekends'))}</option>
      </select>
      <button type="button" class="btn btn-secondary" id="wiGo">${esc(t('energy.whatif.go'))}</button>
    </div>
    <div id="wiList"></div>`;
  host.querySelector('#wiStart').value = '22';
  host.querySelector('#wiEnd').value = '6';
  const run = async () => {
    const list = host.querySelector('#wiList');
    const s = host.querySelector('#wiStart').value, e = host.querySelector('#wiEnd').value;
    if (s === e) { list.innerHTML = `<p class="corp-help">${esc(t('energy.whatif.same'))}</p>`; return; }
    list.innerHTML = `<p style="color:var(--text-muted)">${esc(t('common.loading'))}</p>`;
    let r;
    try { r = await api.getEnergySuggestions(s, e, host.querySelector('#wiDays').value); } catch (err) {
      list.innerHTML = `<p class="corp-notice corp-notice-danger">${esc(err.message)}</p>`; return;
    }
    if (!document.contains(list)) return;
    if (!r.suggestions.length) { list.innerHTML = `<div class="corp-empty">${esc(t('energy.whatif.none'))}</div>`; return; }
    const canWrite = !!(state.report && state.report.can_write);
    list.innerHTML = `<p class="energy-whatif-fleet">${esc(t('energy.whatif.fleet', { kwh: kwh(r.fleet.kwh_per_year), kg: kg(r.fleet.kg_co2e_per_year) }))}</p>
      <ul class="energy-suggestions">${r.suggestions.map((sg, i) => `<li>
        <div><strong>${esc(sg.group_id ? sg.name : sg.devices[0].name)}</strong>
          <div class="corp-help">${esc(t('energy.whatif.line', { screens: tn('energy.screens', sg.devices.length), kwh: kwh(sg.kwh_per_year), kg: kg(sg.kg_co2e_per_year), hours: num(sg.lit_hours_per_week, 0) }))}</div></div>
        ${canWrite ? (sg.group_id
          ? `<button type="button" class="btn btn-secondary btn-sm" data-wi="${i}">${esc(t('energy.whatif.set_group'))}</button>`
          : `<a class="btn btn-secondary btn-sm" href="#/device/${encodeURIComponent(sg.devices[0].id)}">${esc(t('energy.whatif.set_screen'))}</a>`) : ''}
      </li>`).join('')}</ul>`;
    list.querySelectorAll('[data-wi]').forEach((b) => b.addEventListener('click', () => {
      const sg = r.suggestions[Number(b.dataset.wi)];
      openGroupPowerScheduleModal({ id: sg.group_id, name: sg.name }, sg.devices.map((d) => ({ id: d.id })));
    }));
  };
  host.querySelector('#wiGo').addEventListener('click', run);
  run();
}

/* ============================== screens' wattage ============================== */

async function loadScreens(app) {
  const host = document.getElementById('energyScreens');
  if (!host) return;
  let r, s;
  try { [r, s] = await Promise.all([api.getEnergyDevices(), state.settings ? Promise.resolve(state.settings) : api.getEnergySettings()]); } catch { return; }
  if (!document.contains(host)) return;
  state.devices = r.devices; state.settings = s;
  if (!r.devices.length) { host.innerHTML = ''; return; }
  const countries = `<option value="">${esc(t('energy.country_auto'))}</option>` + s.countries.map((c) => `<option value="${esc(c.code)}">${esc(c.name)}</option>`).join('');
  const groups = new Map();
  for (const d of r.devices) for (const g of d.groups) groups.set(g.id, g.name);
  host.innerHTML = `<h2 class="energy-h2">${esc(t('energy.screens_title'))}</h2>
    <p class="corp-help">${esc(t('energy.screens_intro'))}</p>
    ${r.can_write && groups.size ? `<div class="energy-period">
      <select class="input" id="bulkGroup" aria-label="${esc(t('energy.col.group'))}">${[...groups].map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`).join('')}</select>
      <input class="input" type="number" min="0.1" step="0.1" id="bulkOn" placeholder="${esc(t('energy.on_watts'))}" style="width:120px">
      <input class="input" type="number" min="0" step="0.1" id="bulkSb" placeholder="${esc(t('energy.standby_watts'))}" style="width:120px">
      <button type="button" class="btn btn-secondary" id="bulkSave">${esc(t('energy.bulk_save'))}</button>
    </div>` : ''}
    <div class="table-wrap"><table class="corp-table"><thead><tr><th>${esc(t('energy.col.screen'))}</th><th>${esc(t('energy.col.model'))}</th><th>${esc(t('energy.col.watts'))}</th><th>${esc(t('energy.col.source'))}</th><th>${esc(t('energy.col.grid'))}</th>${r.can_write ? `<th>${esc(t('energy.col.override'))}</th>` : ''}</tr></thead><tbody>
    ${r.devices.map((d) => `<tr data-dev="${esc(d.id)}"><td>${esc(d.name)}</td><td>${esc(d.model || '—')}</td>
      <td>${esc(num(d.on_watts, 1))} W / ${esc(num(d.standby_watts, 1))} W</td>
      <td>${esc(wattsSourceLabel(d.source))}${d.detail ? ` <span class="energy-src">${esc(d.detail)}</span>` : ''}${d.source_url ? ` <a href="${esc(d.source_url)}" target="_blank" rel="noopener noreferrer">${esc(t('energy.datasheet_link'))}</a>` : ''}</td>
      <td>${esc(num(d.g_per_kwh, 0))} g · ${esc(intensitySourceLabel(d.intensity_source))}</td>
      ${r.can_write ? `<td class="energy-override">
        <input class="input" type="number" min="0.1" step="0.1" data-f="on" value="${esc(d.override && d.override.on_watts != null ? d.override.on_watts : '')}" placeholder="${esc(t('energy.on_watts'))}" aria-label="${esc(t('energy.on_watts'))}">
        <input class="input" type="number" min="0" step="0.1" data-f="sb" value="${esc(d.override && d.override.standby_watts != null ? d.override.standby_watts : '')}" placeholder="${esc(t('energy.standby_watts'))}" aria-label="${esc(t('energy.standby_watts'))}">
        <select class="input" data-f="cc" aria-label="${esc(t('energy.country'))}">${countries}</select>
        <button type="button" class="btn btn-secondary btn-sm" data-save>${esc(t('common.save'))}</button></td>` : ''}</tr>`).join('')}
    </tbody></table></div>`;
  host.querySelectorAll('tr[data-dev]').forEach((tr) => {
    const d = r.devices.find((x) => x.id === tr.dataset.dev);
    const sel = tr.querySelector('[data-f="cc"]');
    if (sel && d.override && d.override.country) sel.value = d.override.country;
    tr.querySelector('[data-save]')?.addEventListener('click', async () => {
      const val = (f) => tr.querySelector(`[data-f="${f}"]`).value;
      try {
        await api.setEnergyDevice(d.id, { on_watts: val('on') === '' ? null : Number(val('on')), standby_watts: val('sb') === '' ? null : Number(val('sb')), country: val('cc') || null });
        showToast(t('energy.saved_toast'), 'success');
        loadScreens(app); load(app);
      } catch (e) { showToast(e.message, 'error'); }
    });
  });
  host.querySelector('#bulkSave')?.addEventListener('click', async () => {
    const on = host.querySelector('#bulkOn').value, sb = host.querySelector('#bulkSb').value;
    try {
      const res = await api.setEnergyGroup(host.querySelector('#bulkGroup').value, { on_watts: on === '' ? null : Number(on), standby_watts: sb === '' ? null : Number(sb) });
      showToast(tn('energy.bulk_done', res.screens), 'success');
      loadScreens(app); load(app);
    } catch (e) { showToast(e.message, 'error'); }
  });
}

/* ============================== workspace settings ============================== */

async function loadSettings(app) {
  const host = document.getElementById('energySettings');
  if (!host) return;
  let s;
  try { s = state.settings || await api.getEnergySettings(); } catch { return; }
  if (!document.contains(host)) return;
  state.settings = s;
  const cur = s.settings;
  const dis = s.can_admin ? '' : ' disabled';
  host.innerHTML = `<h2 class="energy-h2">${esc(t('energy.settings_title'))}</h2>
    <p class="corp-help">${esc(t('energy.settings_intro', { source: `${s.source.name} (${s.source.year})`, world: num(s.world.g, 0) }))}</p>
    <div class="energy-settings">
      <label>${esc(t('energy.country'))}<select class="input" id="esCountry"${dis}><option value="">${esc(t('energy.country_none'))}</option>
        ${s.countries.map((c) => `<option value="${esc(c.code)}">${esc(`${c.name} — ${num(c.g_per_kwh, 0)} g (${c.year})`)}</option>`).join('')}</select></label>
      <label>${esc(t('energy.grid_override'))}<input class="input" type="number" min="0" max="2000" id="esGrid" value="${esc(cur.grid_g_per_kwh ?? '')}"${dis}></label>
      <label>${esc(t('energy.default_on'))}<input class="input" type="number" min="0.1" step="0.1" id="esOn" value="${esc(cur.default_on_watts ?? '')}" placeholder="${esc(t('energy.default_auto', { eei: s.assumptions.eei, size: s.assumptions.default_diagonal_in }))}"${dis}></label>
      <label>${esc(t('energy.default_standby'))}<input class="input" type="number" min="0" step="0.1" id="esSb" value="${esc(cur.default_standby_watts ?? '')}" placeholder="${esc(String(s.assumptions.default_standby_w))}"${dis}></label>
      ${s.can_admin ? `<button type="button" class="btn btn-primary" id="esSave">${esc(t('common.save'))}</button>` : `<p class="corp-help">${esc(t('energy.admin_only'))}</p>`}
    </div>`;
  host.querySelector('#esCountry').value = cur.country || '';
  host.querySelector('#esSave')?.addEventListener('click', async () => {
    const v = (id) => host.querySelector(id).value;
    try {
      await api.updateEnergySettings({ country: v('#esCountry') || null, grid_g_per_kwh: v('#esGrid') === '' ? null : Number(v('#esGrid')),
        default_on_watts: v('#esOn') === '' ? null : Number(v('#esOn')), default_standby_watts: v('#esSb') === '' ? null : Number(v('#esSb')) });
      showToast(t('energy.saved_toast'), 'success');
      state.settings = null;
      load(app); loadScreens(app); loadSettings(app);
    } catch (e) { showToast(e.message, 'error'); }
  });
}

/* ============================== organization rollup ============================== */

async function loadOrg(app) {
  const host = document.getElementById('energyOrg');
  if (!host || !state.report || !state.report.org_admin) { if (host) host.innerHTML = ''; return; }
  let r;
  try { r = await api.getEnergyOrg(state.start, state.end); } catch { host.innerHTML = ''; return; }
  if (!document.contains(host) || r.workspaces.length < 2) { host.innerHTML = ''; return; }
  host.innerHTML = `<h2 class="energy-h2">${esc(t('energy.org_title'))}</h2>
    <p class="corp-help">${esc(t('energy.org_intro', { kwh: kwh(r.totals.kwh), kg: kg(r.totals.kg_co2e), saved: kwh(r.totals.saved_kwh) }))}</p>
    <div class="table-wrap"><table class="corp-table"><thead><tr><th>${esc(t('energy.col.workspace'))}</th><th>${esc(t('energy.col.screens'))}</th><th>${esc(t('energy.col.kwh'))}</th><th>${esc(t('energy.col.co2'))}</th><th>${esc(t('energy.col.saved'))}</th></tr></thead><tbody>
    ${r.workspaces.map((w) => `<tr><td>${esc(w.name)}</td><td>${esc(w.screens)}</td><td>${esc(num(w.kwh))}</td><td>${esc(num(w.kg_co2e))}</td><td>${esc(num(w.saved_kwh))}</td></tr>`).join('')}
    </tbody></table></div>
    <button type="button" class="btn btn-secondary btn-sm" id="orgCsv">${esc(t('energy.export_org'))}</button>`;
  host.querySelector('#orgCsv').addEventListener('click', async () => {
    try {
      const blob = await downloadEnergyFile(`org/export?start=${encodeURIComponent(state.start)}&end=${encodeURIComponent(state.end)}`);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = `energy-organization-${state.start}-to-${state.end}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) { showToast(e.message, 'error'); }
  });
}

export function cleanup() { state = { start: null, end: null, report: null, settings: null, devices: null }; }
