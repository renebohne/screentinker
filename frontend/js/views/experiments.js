import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { esc } from '../utils.js';
import { t, tn } from '../i18n.js';

/*
 * Experiments (server: lib/experiments, docs/experiments.md): A/B tests of what one playlist slot
 * shows, judged against sales, QR scans, audience or an uploaded CSV.
 *
 *   #/experiments            the list
 *   #/experiments/new        create (also edits a draft: #/experiments/new?id=…)
 *   #/experiments/<id>       live results, start / stop / roll out, POS mapping, data
 *
 * Advanced view only: setting one up needs a playlist slot, two versions, and a way to measure —
 * more choices than a Simple-view task should ask for. The result itself is written as a sentence.
 */

const VARIANT_KINDS = ['content', 'deck', 'widget'];
const STATUS_COLORS = { draft: '#64748b', running: '#16a34a', ended: '#2563eb', stopped: '#a16207', rolled_out: '#7c3aed' };

function canWrite() {
  try { const u = JSON.parse(localStorage.getItem('user') || 'null'); return !(u && u.current_workspace_role === 'workspace_viewer' && !u.acting_as); } catch { return true; }
}

const fmtDate = (s) => (s ? new Date(s * 1000).toLocaleString() : '');
const fmtDay = (s) => (s ? new Date(s * 1000).toLocaleDateString() : '');
const pctText = (x) => (x == null ? '–' : `${x > 0 ? '+' : ''}${Number(x).toFixed(Math.abs(x) < 10 ? 1 : 0)}%`);
const plainPct = (x) => (x == null ? '–' : `${Number(x).toFixed(Math.abs(x) < 10 ? 1 : 0)}%`);
const absPct = (x) => `${Math.abs(Number(x)).toFixed(Math.abs(x) < 10 ? 1 : 0)}%`;
function fmtNum(n, digits = 2) {
  if (n == null || !Number.isFinite(Number(n))) return '–';
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: digits });
}
function fmtMoney(n, currency) {
  if (n == null) return '–';
  try { return currency ? Number(n).toLocaleString(undefined, { style: 'currency', currency }) : fmtNum(n); } catch { return fmtNum(n); }
}

function statusPill(status) {
  return `<span style="font-size:11px;padding:2px 8px;border-radius:999px;background:${STATUS_COLORS[status] || '#64748b'};color:#fff;white-space:nowrap">${esc(t(`exp.status.${status}`))}</span>`;
}

const STYLE = `<style>.exp-table{width:100%;border-collapse:collapse;font-size:13px}
  .exp-table th,.exp-table td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--border);vertical-align:top}
  .exp-table th{color:var(--text-muted);font-weight:500;white-space:nowrap}</style>`;

export async function render(app) {
  const hash = location.hash || '';
  if (hash.startsWith('#/experiments/new')) return renderForm(app, new URLSearchParams(hash.split('?')[1] || '').get('id'));
  const m = /^#\/experiments\/([A-Za-z0-9_-]+)/.exec(hash);
  if (m) return renderDetail(app, m[1]);
  return renderList(app);
}

/* ─── list ──────────────────────────────────────────────────────────────────────────────────── */

async function renderList(app) {
  app.innerHTML = `<div class="page-header"><div><h1>${esc(t('nav.experiments'))}</h1><div class="subtitle">${esc(t('exp.intro'))}</div></div></div><div id="expBody">${esc(t('common.loading'))}</div>`;
  const body = app.querySelector('#expBody');
  let list;
  try { list = await api.get('/experiments'); } catch (e) { body.innerHTML = `<p class="corp-notice corp-notice-danger">${esc(e.message)}</p>`; return; }
  body.innerHTML = `${canWrite() ? `<div class="corp-toolbar"><a class="btn btn-primary" href="#/experiments/new">${esc(t('exp.new'))}</a></div>` : ''}
    ${list.length ? list.map((x) => `<a class="corp-card" href="#/experiments/${esc(x.id)}" style="display:block;margin-bottom:12px;padding:16px;text-decoration:none;color:inherit">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><strong>${esc(x.name)}</strong> ${statusPill(x.status)}
        <span class="corp-help" style="font-size:12px">${esc(t(`exp.mode.${x.mode}`))}</span></div>
      <div class="corp-help" style="font-size:13px;margin-top:6px">${esc(x.variants.map((v) => `${v.label}: ${v.name}`).join(' · '))}</div>
      <div class="corp-help" style="font-size:12px;margin-top:4px">${esc(t('exp.in_playlist', { name: x.playlist_name || '–' }))}${x.start_at ? ` · ${esc(t('exp.started_at', { when: fmtDay(x.start_at) }))}` : ''}${x.end_at ? ` · ${esc(t('exp.ended_at', { when: fmtDay(x.end_at) }))}` : ''}</div>
    </a>`).join('') : `<div class="corp-empty">${esc(t('exp.empty'))}</div>`}
    <details style="margin-top:16px;font-size:13px;color:var(--text-secondary)"><summary>${esc(t('exp.how_title'))}</summary>
      <p style="margin-top:8px">${esc(t('exp.how_1'))}</p><p>${esc(t('exp.how_2'))}</p><p>${esc(t('exp.how_3'))}</p><p>${esc(t('exp.privacy'))}</p></details>`;
}

/* ─── create / edit a draft ─────────────────────────────────────────────────────────────────── */

const OUTCOME_OPTIONS = [
  ['sales', 'units'], ['sales', 'revenue'], ['sales', 'orders'], ['qr', 'scans'], ['audience', 'impressions'], ['audience', 'dwell'], ['csv', 'value'],
];

async function renderForm(app, editId) {
  app.innerHTML = `<div class="page-header"><div><h1>${esc(editId ? t('exp.edit_title') : t('exp.new'))}</h1><div class="subtitle">${esc(t('exp.form_intro'))}</div></div></div><div id="expForm">${esc(t('common.loading'))}</div>`;
  const box = app.querySelector('#expForm');
  let opts, existing = null;
  try {
    opts = await api.get('/experiments/options');
    if (editId) existing = await api.get(`/experiments/${encodeURIComponent(editId)}`);
  } catch (e) { box.innerHTML = `<p class="corp-notice corp-notice-danger">${esc(e.message)}</p>`; return; }
  if (!canWrite()) { box.innerHTML = `<p class="corp-notice">${esc(t('exp.read_only'))}</p>`; return; }
  if (opts.approvals) { box.innerHTML = `<p class="corp-notice corp-notice-danger">${esc(t('exp.approvals_on'))}</p>`; return; }
  if (!opts.playlists.length) { box.innerHTML = `<div class="corp-empty">${esc(t('exp.no_playlists'))}</div>`; return; }

  const cfg = (existing && existing.config) || {};
  const state = {
    variants: existing ? existing.variants.map((v) => ({ kind: v.kind, id: v.id, label: v.label, qr_link_id: v.qr_link_id || '' }))
      : [{ kind: 'content', id: '', label: 'A', qr_link_id: '' }, { kind: 'content', id: '', label: 'B', qr_link_id: '' }],
    slot: null,
  };
  const listFor = (kind) => (kind === 'content' ? opts.content : kind === 'deck' ? opts.decks : opts.widgets);
  const optionList = (list, sel) => list.map((x) => `<option value="${esc(x.id)}" ${x.id === sel ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
  const outcomeOptions = (sel, allowNone) => `${allowNone ? `<option value="">${esc(t('exp.f.none'))}</option>` : ''}${OUTCOME_OPTIONS
    .filter(([s]) => s !== 'sales' || opts.data_sources.length)
    .map(([s, m]) => `<option value="${s}:${m}" ${sel === `${s}:${m}` ? 'selected' : ''}>${esc(t(`exp.metric.${m}`))}</option>`).join('')}`;
  const primarySel = cfg.outcome ? `${cfg.outcome.source}:${cfg.outcome.metric}` : (opts.data_sources.length ? 'sales:units' : 'csv:value');
  const secSel = (cfg.secondary && cfg.secondary[0]) ? `${cfg.secondary[0].source}:${cfg.secondary[0].metric}` : '';
  const dsChecked = new Set((cfg.sales && cfg.sales.data_source_ids) || []);
  const plannedEnd = existing && existing.planned_end_at ? new Date(existing.planned_end_at * 1000).toISOString().slice(0, 10) : '';

  box.innerHTML = `
    <div class="settings-section">
      <div class="form-group"><label for="expName">${esc(t('exp.f.name'))}</label><input id="expName" class="input" maxlength="120" value="${esc(existing ? existing.name : '')}" placeholder="${esc(t('exp.f.name_ph'))}"></div>
    </div>
    <div class="settings-section">
      <h3 style="font-size:15px;margin-bottom:4px">${esc(t('exp.f.where'))}</h3>
      <p class="corp-help" style="font-size:13px;margin-bottom:10px">${esc(t('exp.f.where_hint'))}</p>
      <div class="form-group"><label for="expPlaylist">${esc(t('exp.f.playlist'))}</label><select id="expPlaylist" class="input"><option value="">—</option>${optionList(opts.playlists, existing ? existing.playlist_id : '')}</select></div>
      <div class="form-group"><label for="expSlot">${esc(t('exp.f.slot'))}</label><select id="expSlot" class="input" disabled></select></div>
      <div id="expScreens" class="corp-help" style="font-size:13px"></div>
    </div>
    <div class="settings-section">
      <h3 style="font-size:15px;margin-bottom:4px">${esc(t('exp.f.versions'))}</h3>
      <p class="corp-help" style="font-size:13px;margin-bottom:10px">${esc(t('exp.f.versions_hint'))}</p>
      <div id="expVariants"></div>
      <button class="btn btn-secondary btn-sm" id="expAddVariant" type="button">${esc(t('exp.f.add_version'))}</button>
    </div>
    <div class="settings-section">
      <h3 style="font-size:15px;margin-bottom:4px">${esc(t('exp.f.split'))}</h3>
      <label style="display:flex;gap:8px;align-items:flex-start;margin:8px 0;font-size:14px"><input type="radio" name="expMode" value="location" ${!existing || existing.mode === 'location' ? 'checked' : ''}>
        <span><strong>${esc(t('exp.mode.location'))}</strong><br><span class="corp-help" style="font-size:13px">${esc(t('exp.mode.location_hint'))}</span></span></label>
      <label style="display:flex;gap:8px;align-items:flex-start;margin:8px 0;font-size:14px"><input type="radio" name="expMode" value="time" ${existing && existing.mode === 'time' ? 'checked' : ''}>
        <span><strong>${esc(t('exp.mode.time'))}</strong><br><span class="corp-help" style="font-size:13px">${esc(t('exp.mode.time_hint'))}</span></span></label>
      <div class="form-group" id="expBlockWrap"><label for="expBlock">${esc(t('exp.f.turn'))}</label>
        <select id="expBlock" class="input" style="max-width:220px">${[1, 2, 3, 4].map((h) => `<option value="${h}" ${(cfg.block_hours || 1) === h ? 'selected' : ''}>${esc(tn('exp.f.hours', h))}</option>`).join('')}</select></div>
    </div>
    <div class="settings-section">
      <h3 style="font-size:15px;margin-bottom:4px">${esc(t('exp.f.judge'))}</h3>
      <div class="form-group"><label for="expPrimary">${esc(t('exp.f.primary'))}</label><select id="expPrimary" class="input">${outcomeOptions(primarySel, false)}</select></div>
      <div class="form-group"><label for="expSecondary">${esc(t('exp.f.secondary'))}</label><select id="expSecondary" class="input">${outcomeOptions(secSel, true)}</select></div>
      ${opts.data_sources.length ? '' : `<p class="corp-help" style="font-size:13px">${esc(t('exp.f.no_pos'))} <a href="#/data-sources">${esc(t('nav.data_sources'))}</a></p>`}
      <div id="expSalesWrap">
        <div class="form-group"><label>${esc(t('exp.f.pos_sources'))}</label>
          ${opts.data_sources.map((d) => `<label style="display:flex;gap:8px;font-size:14px;margin:4px 0"><input type="checkbox" class="exp-ds" value="${esc(d.id)}" ${dsChecked.has(d.id) || (!existing && opts.data_sources.length === 1) ? 'checked' : ''}> ${esc(d.name)} <span class="corp-help">(${esc(d.type === 'square' ? 'Square' : 'Shopify')})</span></label>`).join('')}
          <p class="corp-help" style="font-size:12px;margin-top:4px">${esc(t('exp.f.pos_scopes'))}</p></div>
        <div class="form-group"><label for="expItems">${esc(t('exp.f.items'))}</label><input id="expItems" class="input" value="${esc(((cfg.sales && cfg.sales.items) || []).join(', '))}" placeholder="${esc(t('exp.f.items_ph'))}">
          <p class="corp-help" style="font-size:12px;margin-top:4px">${esc(t('exp.f.items_hint'))}</p></div>
      </div>
      <div id="expCsvWrap" class="form-group"><label for="expCsvLabel">${esc(t('exp.f.csv_label'))}</label><input id="expCsvLabel" class="input" maxlength="60" value="${esc(cfg.csv_label || '')}" placeholder="${esc(t('exp.f.csv_label_ph'))}"></div>
      <div style="display:flex;gap:16px;flex-wrap:wrap">
        <div class="form-group"><label for="expWindow">${esc(t('exp.f.window'))}</label>
          <select id="expWindow" class="input">${[0, 1, 2, 3].map((h) => `<option value="${h}" ${(cfg.attribution_hours || 0) === h ? 'selected' : ''}>${esc(h ? tn('exp.f.window_n', h) : t('exp.f.window_0'))}</option>`).join('')}</select></div>
        <div class="form-group" id="expBaselineWrap"><label for="expBaseline">${esc(t('exp.f.baseline'))}</label>
          <select id="expBaseline" class="input">${[0, 14, 28, 56].map((d) => `<option value="${d}" ${(cfg.baseline_days ?? 28) === d ? 'selected' : ''}>${esc(d ? tn('exp.f.days', d) : t('exp.f.none'))}</option>`).join('')}</select></div>
        <div class="form-group"><label for="expMinLift">${esc(t('exp.f.min_lift'))}</label>
          <select id="expMinLift" class="input">${[0.05, 0.1, 0.2].map((x) => `<option value="${x}" ${(cfg.min_lift || 0.1) === x ? 'selected' : ''}>${Math.round(x * 100)}%</option>`).join('')}</select></div>
        <div class="form-group"><label for="expEnd">${esc(t('exp.f.end'))}</label><input id="expEnd" type="date" class="input" value="${esc(plannedEnd)}"></div>
      </div>
      <p class="corp-help" style="font-size:12px">${esc(t('exp.f.window_hint'))}</p>
    </div>
    <div id="expFormError" style="color:var(--danger);font-size:13px;min-height:18px;margin:8px 0"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap">
      <a class="btn btn-secondary" href="${existing ? `#/experiments/${esc(existing.id)}` : '#/experiments'}">${esc(t('common.cancel'))}</a>
      <button class="btn btn-primary" id="expSave" type="button">${esc(t('exp.f.save_draft'))}</button>
    </div>`;

  const $ = (sel) => box.querySelector(sel);
  const mode = () => (box.querySelector('input[name="expMode"]:checked') || {}).value || 'location';

  function renderVariants() {
    $('#expVariants').innerHTML = state.variants.map((v, i) => `
      <div class="exp-variant" data-i="${i}" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-bottom:10px;padding:10px;border:1px solid var(--border);border-radius:var(--radius)">
        <div class="form-group" style="margin:0;width:90px"><label>${esc(t('exp.f.label'))}</label><input class="input exp-v-label" maxlength="40" value="${esc(v.label)}"></div>
        <div class="form-group" style="margin:0"><label>${esc(t('exp.f.kind'))}</label><select class="input exp-v-kind">${VARIANT_KINDS.map((k) => `<option value="${k}" ${v.kind === k ? 'selected' : ''}>${esc(t(`exp.kind.${k}`))}</option>`).join('')}</select></div>
        <div class="form-group" style="margin:0;flex:1;min-width:180px"><label>${esc(t('exp.f.shows'))}</label><select class="input exp-v-id"><option value="">—</option>${optionList(listFor(v.kind), v.id)}</select></div>
        <div class="form-group" style="margin:0;min-width:160px"><label>${esc(t('exp.f.qr'))}</label><select class="input exp-v-qr"><option value="">${esc(t('exp.f.none'))}</option>${optionList(opts.qr_links, v.qr_link_id)}</select></div>
        ${state.variants.length > 2 ? `<button class="btn btn-secondary btn-sm exp-v-remove" type="button" aria-label="${esc(t('common.delete'))}">×</button>` : ''}
        ${i === 0 ? `<div class="corp-help" style="font-size:12px;flex-basis:100%">${esc(t('exp.f.control_hint'))}</div>` : ''}
      </div>`).join('');
    $('#expAddVariant').hidden = state.variants.length >= 4;
    box.querySelectorAll('.exp-variant').forEach((row) => {
      const i = Number(row.dataset.i);
      row.querySelector('.exp-v-label').addEventListener('input', (e) => { state.variants[i].label = e.target.value; });
      row.querySelector('.exp-v-kind').addEventListener('change', (e) => { state.variants[i].kind = e.target.value; state.variants[i].id = ''; renderVariants(); });
      row.querySelector('.exp-v-id').addEventListener('change', (e) => { state.variants[i].id = e.target.value; });
      row.querySelector('.exp-v-qr').addEventListener('change', (e) => { state.variants[i].qr_link_id = e.target.value; });
      const rm = row.querySelector('.exp-v-remove');
      if (rm) rm.addEventListener('click', () => { state.variants.splice(i, 1); renderVariants(); });
    });
  }
  $('#expAddVariant').addEventListener('click', () => {
    state.variants.push({ kind: 'content', id: '', label: 'ABCD'[state.variants.length], qr_link_id: '' });
    renderVariants();
  });

  function syncVisibility() {
    const sources = [$('#expPrimary').value, $('#expSecondary').value].map((x) => x.split(':')[0]);
    $('#expSalesWrap').hidden = !sources.includes('sales');
    $('#expCsvWrap').hidden = !sources.includes('csv');
    $('#expBlockWrap').hidden = mode() !== 'time';
    $('#expBaselineWrap').hidden = mode() !== 'location';
  }
  box.querySelectorAll('input[name="expMode"]').forEach((r) => r.addEventListener('change', syncVisibility));
  $('#expPrimary').addEventListener('change', syncVisibility);
  $('#expSecondary').addEventListener('change', syncVisibility);

  async function loadSlot(selectedItem) {
    const plId = $('#expPlaylist').value;
    const sel = $('#expSlot');
    sel.disabled = true; sel.innerHTML = ''; $('#expScreens').textContent = '';
    if (!plId) return;
    try {
      state.slot = await api.get(`/experiments/slot?playlist_id=${encodeURIComponent(plId)}`);
    } catch (e) { $('#expScreens').textContent = e.message; return; }
    const items = state.slot.items;
    sel.innerHTML = items.length
      ? items.map((it) => `<option value="${it.id}" ${String(it.id) === String(selectedItem) ? 'selected' : ''} ${it.busy ? 'disabled' : ''}>${esc(it.name || t('common.unknown'))}${it.busy ? ` (${esc(t('exp.row_badge'))})` : ''}</option>`).join('')
      : `<option value="">${esc(t('exp.f.no_items'))}</option>`;
    sel.disabled = !items.length;
    const nUnits = state.slot.units.length;
    $('#expScreens').textContent = state.slot.screens ? t('exp.f.screens_summary', { screens: state.slot.screens, locations: nUnits }) : t('exp.f.no_screens');
    // Variant A defaults to what the slot shows now: the control.
    const cur = items.find((it) => String(it.id) === String(sel.value));
    if (cur && !existing && !state.variants[0].id) {
      state.variants[0] = { ...state.variants[0], kind: cur.kind, id: cur.ref_id };
      renderVariants();
    }
  }
  $('#expPlaylist').addEventListener('change', () => loadSlot(null));
  $('#expSlot').addEventListener('change', () => {
    const cur = state.slot && state.slot.items.find((it) => String(it.id) === $('#expSlot').value);
    if (cur && !existing) { state.variants[0] = { ...state.variants[0], kind: cur.kind, id: cur.ref_id }; renderVariants(); }
  });

  $('#expSave').addEventListener('click', async () => {
    const [ps, pm] = $('#expPrimary').value.split(':');
    const sec = $('#expSecondary').value;
    const end = $('#expEnd').value;
    const payload = {
      name: $('#expName').value.trim(),
      mode: mode(),
      playlist_id: $('#expPlaylist').value,
      slot_item_id: Number($('#expSlot').value) || null,
      variants: state.variants.map((v) => ({ kind: v.kind, id: v.id, label: v.label, qr_link_id: v.qr_link_id || null })),
      planned_end_at: end ? Math.floor(new Date(`${end}T23:59:00`).getTime() / 1000) : null,
      config: {
        outcome: { source: ps, metric: pm },
        secondary: sec ? [{ source: sec.split(':')[0], metric: sec.split(':')[1] }] : [],
        block_hours: Number($('#expBlock').value),
        attribution_hours: Number($('#expWindow').value),
        baseline_days: Number($('#expBaseline').value),
        min_lift: Number($('#expMinLift').value),
        csv_label: $('#expCsvLabel').value.trim(),
        sales: { data_source_ids: [...box.querySelectorAll('.exp-ds:checked')].map((c) => c.value), items: $('#expItems').value },
      },
    };
    $('#expSave').disabled = true;
    try {
      const saved = existing ? await api.put(`/experiments/${encodeURIComponent(existing.id)}`, payload) : await api.post('/experiments', payload);
      location.hash = `#/experiments/${saved.id}`;
    } catch (e) {
      $('#expFormError').textContent = e.message;
      $('#expSave').disabled = false;
    }
  });

  renderVariants();
  syncVisibility();
  if (existing) await loadSlot(existing.slot_item_id);
}

/* ─── detail and results ────────────────────────────────────────────────────────────────────── */

function verdictSentence(exp, outcome, c) {
  const v = exp.variants[c.variant] ? exp.variants[c.variant].label : '?';
  const ctrl = exp.variants[0] ? exp.variants[0].label : 'A';
  const metric = outcome.metric;
  const what = exp.config.sales && exp.config.sales.items && exp.config.sales.items.length ? t('exp.what.item') : t('exp.what.all');
  const vars = { v, c: ctrl, pct: absPct(c.lift_pct || 0), low: plainPct(c.low_pct), high: plainPct(c.high_pct), what, name: exp.config.csv_label || t('exp.metric.value') };
  if (c.verdict === 'better' || c.verdict === 'worse') return t(`exp.v.${c.verdict}.${metric}`, vars);
  if (c.verdict === 'no_difference') return t('exp.v.no_difference', vars);
  let s = t('exp.v.not_enough');
  if (c.reason === 'few_locations') s += ` ${t('exp.v.few_locations')}`;
  if (c.more_days === 'many') s += ` ${t('exp.v.many_days')}`;
  else if (c.more_days > 0) s += ` ${tn('exp.v.more_days', c.more_days)}`;
  if (c.lift_pct != null) s += ` ${t('exp.v.so_far', { v, pct: pctText(c.lift_pct) })}`;
  return s;
}

/** The 95% interval as a bar around zero, scaled to ±(the widest end, at least 25%). */
function intervalBar(c) {
  if (c.low_pct == null || c.high_pct == null) return '';
  const span = Math.max(25, Math.abs(c.low_pct), Math.abs(c.high_pct), Math.abs(c.lift_pct || 0));
  const x = (p) => 50 + (p / span) * 50;
  const color = c.verdict === 'better' ? '#16a34a' : c.verdict === 'worse' ? '#dc2626' : '#64748b';
  return `<div style="position:relative;height:18px;margin:6px 0 2px;background:var(--bg-input);border-radius:4px" aria-hidden="true">
    <div style="position:absolute;left:50%;top:0;bottom:0;width:1px;background:var(--text-muted)"></div>
    <div style="position:absolute;left:${x(c.low_pct)}%;width:${Math.max(0.5, x(c.high_pct) - x(c.low_pct))}%;top:5px;height:8px;background:${color};opacity:0.5;border-radius:4px"></div>
    <div style="position:absolute;left:calc(${x(c.lift_pct || 0)}% - 1px);top:2px;height:14px;width:3px;background:${color}"></div>
  </div>`;
}

function outcomeBlock(exp, res, block, primary) {
  if (!block) return '';
  const o = block.outcome;
  const money = o.metric === 'revenue';
  const fmt = (n) => (money ? fmtMoney(n, res.currency) : fmtNum(n));
  const rateLabel = o.source === 'audience' ? (o.metric === 'dwell' ? t('exp.r.per_look') : t('exp.r.per_screen_hour')) : (block.adjusted ? t('exp.r.index') : t('exp.r.per_hour'));
  return `<div class="corp-card" style="padding:16px;margin-bottom:12px">
    <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><h3 style="font-size:15px;margin:0">${esc(primary ? t('exp.r.primary', { metric: t(`exp.metric.${o.metric}`) }) : t('exp.r.secondary', { metric: t(`exp.metric.${o.metric}`) }))}</h3>
      <span class="corp-help" style="font-size:12px">${esc(tn('exp.r.days', block.days))}</span></div>
    ${block.comparisons.map((c) => `<p style="font-size:${primary ? 16 : 14}px;margin:10px 0 0;font-weight:${primary ? 600 : 400}">${esc(verdictSentence(exp, o, c))}</p>${intervalBar(c)}`).join('')}
    <div class="table-wrap" style="margin-top:10px"><table class="exp-table">
      <thead><tr><th>${esc(t('exp.r.version'))}</th><th>${esc(t('exp.r.exposure_hours'))}</th><th>${esc(t('exp.r.total'))}</th><th>${esc(rateLabel)}</th>${o.source === 'sales' || o.source === 'csv' ? `<th>${esc(t('exp.r.per_location_day'))}</th>` : ''}<th>${esc(t('exp.r.vs_control'))}</th></tr></thead>
      <tbody>${block.variants.map((v) => {
        const c = block.comparisons.find((x) => x.variant === v.variant);
        return `<tr><td>${esc(exp.variants[v.variant] ? `${exp.variants[v.variant].label} · ${exp.variants[v.variant].name}` : String(v.variant))}</td>
          <td>${fmtNum(v.exposure_hours, 0)}</td><td>${esc(fmt(v.value))}</td><td>${esc(block.adjusted ? fmtNum(v.rate, 3) : fmt(v.rate))}</td>
          ${o.source === 'sales' || o.source === 'csv' ? `<td>${esc(fmt(v.per_location_day))}</td>` : ''}
          <td>${c ? `${esc(pctText(c.lift_pct))}${c.low_pct != null ? ` <span class="corp-help">(${esc(pctText(c.low_pct))} … ${esc(pctText(c.high_pct))})</span>` : ''}` : esc(t('exp.r.control'))}</td></tr>`;
      }).join('')}</tbody></table></div>
    ${block.adjusted ? `<p class="corp-help" style="font-size:12px;margin-top:8px">${esc(t('exp.r.adjusted_note'))}</p>` : ''}
    ${(block.notes || []).map((n) => `<p class="corp-help" style="font-size:12px;margin-top:6px">${esc(t(`exp.note.${n}`))}</p>`).join('')}
    ${primary ? block.comparisons.filter((c) => c.welch).map((c) => `<p class="corp-help" style="font-size:11px;margin-top:6px">${esc(t('exp.r.welch', { v: exp.variants[c.variant].label, t: c.welch.t, df: c.welch.df, low: pctText(c.welch.low_pct), high: pctText(c.welch.high_pct) }))}</p>`).join('') : ''}
  </div>`;
}

function guardrailsBlock(exp, res) {
  const out = [];
  for (const g of res.guardrails || []) {
    const v = g.variant != null && exp.variants[g.variant] ? exp.variants[g.variant].label : '';
    const ok = /_balanced$/.test(g.code);
    out.push(`<li style="color:${ok ? 'var(--text-secondary)' : 'var(--warning, #ca8a04)'}">${ok ? '✓' : '⚠'} ${esc(t(`exp.g.${g.code}`, { v, pct: g.worst_pct != null ? `${g.worst_pct}%` : '', message: g.message || '', when: g.at ? fmtDate(g.at) : t('exp.never') }))}</li>`);
  }
  return out.length ? `<div class="settings-section"><h3 style="font-size:15px;margin-bottom:6px">${esc(t('exp.g.title'))}</h3><ul style="margin:0 0 0 18px;padding:0;font-size:13px;line-height:1.7">${out.join('')}</ul></div>` : '';
}

async function renderDetail(app, id) {
  app.innerHTML = `${STYLE}<div id="expDetail">${esc(t('common.loading'))}</div>`;
  const box = app.querySelector('#expDetail');
  let exp, res;
  try {
    exp = await api.get(`/experiments/${encodeURIComponent(id)}`);
    res = await api.get(`/experiments/${encodeURIComponent(id)}/results`);
  } catch (e) { box.innerHTML = `<p class="corp-notice corp-notice-danger">${esc(e.message)}</p><p><a href="#/experiments">${esc(t('exp.back'))}</a></p>`; return; }
  const write = canWrite();
  const usesSales = [exp.config.outcome, ...(exp.config.secondary || [])].some((o) => o.source === 'sales');
  const usesCsv = [exp.config.outcome, ...(exp.config.secondary || [])].some((o) => o.source === 'csv');
  const started = !!exp.start_at;
  const variantOptions = exp.variants.map((v, i) => `<option value="${i}">${esc(`${v.label} · ${v.name}`)}</option>`).join('');
  const best = (() => {
    const p = res.primary;
    if (!p) return null;
    const winners = p.comparisons.filter((c) => c.verdict === 'better').sort((a, b) => b.lift_pct - a.lift_pct);
    if (winners.length) return winners[0].variant;
    if (p.comparisons.length && p.comparisons.every((c) => c.verdict === 'worse')) return 0;
    return null;
  })();

  box.innerHTML = `
    <div class="page-header"><div>
      <div style="font-size:13px;margin-bottom:4px"><a href="#/experiments">← ${esc(t('nav.experiments'))}</a></div>
      <h1 style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">${esc(exp.name)} ${statusPill(exp.status)}</h1>
      <div class="subtitle">${esc(t(`exp.mode.${exp.mode}`))} · ${esc(t('exp.in_playlist', { name: exp.playlist_name || '–' }))}${exp.start_at ? ` · ${esc(t('exp.started_at', { when: fmtDate(exp.start_at) }))}` : ''}${exp.end_at ? ` · ${esc(t('exp.ended_at', { when: fmtDate(exp.end_at) }))}` : exp.planned_end_at ? ` · ${esc(t('exp.ends_at', { when: fmtDay(exp.planned_end_at) }))}` : ''}</div>
    </div></div>
    ${exp.notice ? `<p class="corp-notice" style="margin-bottom:12px">${esc(t(`exp.notice.${exp.notice}`))}</p>` : ''}
    ${exp.status === 'rolled_out' && exp.winner != null ? `<p class="corp-notice" style="margin-bottom:12px">${esc(t('exp.rolled_out_note', { v: `${exp.variants[exp.winner].label} · ${exp.variants[exp.winner].name}` }))}</p>` : ''}
    ${write ? `<div class="corp-toolbar" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      ${exp.status === 'draft' ? `<button class="btn btn-primary" id="expStart">${esc(t('exp.start'))}</button><a class="btn btn-secondary" href="#/experiments/new?id=${esc(exp.id)}">${esc(t('common.edit'))}</a>` : ''}
      ${exp.status === 'running' ? `<button class="btn btn-secondary" id="expStop">${esc(t('exp.stop'))}</button>` : ''}
      ${['running', 'ended', 'stopped'].includes(exp.status) ? `<span style="display:flex;gap:6px;align-items:center"><select id="expWinner" class="input" style="width:auto">${variantOptions}</select><button class="btn btn-primary" id="expRollout">${esc(t('exp.rollout'))}</button></span>` : ''}
      ${exp.status !== 'running' ? `<button class="btn btn-secondary" id="expDelete" style="color:var(--danger)">${esc(t('common.delete'))}</button>` : ''}
    </div>` : ''}
    <div class="settings-section"><h3 style="font-size:15px;margin-bottom:6px">${esc(t('exp.versions'))}</h3>
      <ul style="margin:0 0 0 18px;padding:0;font-size:14px;line-height:1.7">${exp.variants.map((v, i) => `<li><strong>${esc(v.label)}</strong> · ${esc(v.name)} <span class="corp-help">(${esc(t(`exp.kind.${v.kind}`))}${i === 0 ? `, ${esc(t('exp.r.control'))}` : ''})</span>${started ? ` <span class="corp-help">· ${esc(tn('exp.plays', res.plays[i] || 0))}</span>` : ''}</li>`).join('')}</ul></div>
    ${started ? `${outcomeBlock(exp, res, res.primary, true)}${(res.secondary || []).map((b) => outcomeBlock(exp, res, b, false)).join('')}${guardrailsBlock(exp, res)}`
      : `<div class="corp-empty" style="margin-bottom:12px">${esc(t('exp.not_started'))}</div>`}
    <div class="settings-section" id="expUnits"></div>
    ${usesSales || usesCsv ? `<div class="settings-section"><h3 style="font-size:15px;margin-bottom:6px">${esc(t('exp.data_title'))}</h3>
      ${usesSales ? `<p style="font-size:13px">${esc(exp.sales.synced_at ? t('exp.sales_synced', { when: fmtDate(exp.sales.synced_at) }) : t('exp.sales_never'))}</p>
        ${exp.sales.error ? `<p style="font-size:13px;color:var(--danger)">${esc(exp.sales.error)}</p>` : ''}
        ${write ? `<button class="btn btn-secondary btn-sm" id="expImport">${esc(t('exp.import_now'))}</button>` : ''}
        <p class="corp-help" style="font-size:12px;margin-top:6px">${esc(t('exp.sales_hint'))}</p>` : ''}
      ${usesCsv && write ? `<div style="margin-top:12px"><label style="font-size:13px" for="expCsvFile">${esc(t('exp.csv_upload'))}</label>
        <input type="file" id="expCsvFile" accept=".csv,text/csv" class="input" style="margin-top:4px">
        <p class="corp-help" style="font-size:12px;margin-top:4px">${esc(t('exp.csv_hint'))}</p><div id="expCsvResult" style="font-size:13px"></div></div>` : ''}
    </div>` : ''}
    <details style="margin-top:8px;font-size:13px;color:var(--text-secondary)"><summary>${esc(t('exp.how_title'))}</summary>
      <p style="margin-top:8px">${esc(t('exp.how_1'))}</p><p>${esc(t('exp.how_2'))}</p><p>${esc(t('exp.how_3'))}</p><p>${esc(t('exp.privacy'))}</p></details>`;

  renderUnits(box.querySelector('#expUnits'), exp, res, write && usesSales && ['draft', 'running'].includes(exp.status));
  if (best != null && box.querySelector('#expWinner')) box.querySelector('#expWinner').value = String(best);

  const act = (sel, fn) => { const el = box.querySelector(sel); if (el) el.addEventListener('click', async () => { el.disabled = true; try { await fn(); } catch (e) { showToast(e.message, 'error'); } finally { el.disabled = false; } }); };
  act('#expStart', async () => {
    if (!confirm(t('exp.confirm_start'))) return;
    await api.post(`/experiments/${encodeURIComponent(exp.id)}/start`, {});
    showToast(t('exp.started'), 'success'); renderDetail(app, exp.id);
  });
  act('#expStop', async () => {
    if (!confirm(t('exp.confirm_stop'))) return;
    await api.post(`/experiments/${encodeURIComponent(exp.id)}/stop`, {});
    showToast(t('exp.stopped'), 'success'); renderDetail(app, exp.id);
  });
  act('#expRollout', async () => {
    const k = Number(box.querySelector('#expWinner').value);
    if (!confirm(t('exp.confirm_rollout', { v: `${exp.variants[k].label} · ${exp.variants[k].name}` }))) return;
    await api.post(`/experiments/${encodeURIComponent(exp.id)}/rollout`, { variant: k });
    showToast(t('exp.rolled_out'), 'success'); renderDetail(app, exp.id);
  });
  act('#expDelete', async () => {
    if (!confirm(t('exp.confirm_delete', { name: exp.name }))) return;
    await api.delete(`/experiments/${encodeURIComponent(exp.id)}`);
    location.hash = '#/experiments';
  });
  act('#expImport', async () => {
    showToast(t('exp.importing'), 'info');
    await api.post(`/experiments/${encodeURIComponent(exp.id)}/import-sales`, {});
    showToast(t('exp.imported'), 'success'); renderDetail(app, exp.id);
  });
  const file = box.querySelector('#expCsvFile');
  if (file) file.addEventListener('change', async () => {
    const f = file.files && file.files[0];
    const out = box.querySelector('#expCsvResult');
    if (!f) return;
    if (f.size > 2 * 1024 * 1024) { out.textContent = t('exp.csv_too_big'); return; }
    try {
      const r = await api.post(`/experiments/${encodeURIComponent(exp.id)}/outcomes/csv`, { csv: await f.text() });
      showToast(tn('exp.csv_ok', r.rows), 'success'); renderDetail(app, exp.id);
    } catch (e) {
      const errs = (e.body && e.body.errors) || [];
      out.innerHTML = errs.length
        ? `<ul style="margin:6px 0 0 18px;color:var(--danger)">${errs.map((x) => `<li>${esc(x.row ? t('exp.csv_row', { row: x.row, message: x.message }) : x.message)}</li>`).join('')}</ul>`
        : `<p style="color:var(--danger)">${esc(e.message)}</p>`;
    }
  });
}

function renderUnits(el, exp, res, editable) {
  const units = res.units || [];
  const sources = exp.config.sales ? exp.config.sales.data_source_ids || [] : [];
  el.innerHTML = `<h3 style="font-size:15px;margin-bottom:6px">${esc(t('exp.locations'))}</h3>
    ${units.length ? '' : `<p class="corp-help" style="font-size:13px">${esc(t('exp.f.no_screens'))}</p>`}
    <p class="corp-help" style="font-size:12px;margin-bottom:8px">${esc(exp.mode === 'location' ? t('exp.locations_hint') : t('exp.locations_hint_time'))}</p>
    <div class="table-wrap"><table class="exp-table"><thead><tr>
      <th>${esc(t('exp.r.location'))}</th><th>${esc(t('exp.r.screens'))}</th>${exp.mode === 'location' ? `<th>${esc(t('exp.r.version'))}</th>` : ''}
      ${sources.length ? `<th>Square</th><th>Shopify</th>` : ''}<th>${esc(t('exp.r.baseline'))}</th></tr></thead>
      <tbody>${units.map((u) => `<tr data-key="${esc(u.unit_key)}"><td>${esc(u.label)}</td><td>${u.screens}</td>
        ${exp.mode === 'location' ? `<td>${u.variant != null && exp.variants[u.variant] ? esc(exp.variants[u.variant].label) : '–'}</td>` : ''}
        ${sources.length ? `<td>${editable ? `<input class="input exp-sq" style="min-width:120px" value="${esc(u.square_location_id || '')}" list="expSqLocs">` : esc(u.square_location_id || '–')}</td>
          <td>${editable ? `<input class="input exp-sh" style="min-width:120px" value="${esc(u.shopify_location_id || '')}" list="expShLocs">` : esc(u.shopify_location_id || '–')}</td>` : ''}
        <td>${u.baseline_per_day != null ? esc(fmtNum(u.baseline_per_day)) : '–'}</td></tr>`).join('')}</tbody></table></div>
    ${editable && units.length ? `<datalist id="expSqLocs"><option value="*">${esc(t('exp.pos_all'))}</option></datalist><datalist id="expShLocs"><option value="*">${esc(t('exp.pos_all'))}</option><option value="online">${esc(t('exp.pos_online'))}</option></datalist>
      <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap"><button class="btn btn-secondary btn-sm" id="expLoadLocs">${esc(t('exp.pos_load'))}</button><button class="btn btn-primary btn-sm" id="expSaveUnits">${esc(t('exp.pos_save'))}</button></div>
      <p class="corp-help" style="font-size:12px;margin-top:6px">${esc(t('exp.pos_hint'))}</p>` : ''}`;
  if (!editable || !units.length) return;
  el.querySelector('#expSaveUnits').addEventListener('click', async () => {
    const list = [...el.querySelectorAll('tr[data-key]')].map((row) => ({
      unit_key: row.dataset.key,
      square_location_id: (row.querySelector('.exp-sq') || {}).value || null,
      shopify_location_id: (row.querySelector('.exp-sh') || {}).value || null,
    }));
    try { await api.put(`/experiments/${encodeURIComponent(exp.id)}/units`, { units: list }); showToast(t('exp.pos_saved'), 'success'); } catch (e) { showToast(e.message, 'error'); }
  });
  el.querySelector('#expLoadLocs').addEventListener('click', async () => {
    for (const dsId of sources) {
      try {
        const r = await api.get(`/experiments/${encodeURIComponent(exp.id)}/pos-locations?data_source_id=${encodeURIComponent(dsId)}`);
        const dl = el.querySelector(r.type === 'square' ? '#expSqLocs' : '#expShLocs');
        for (const l of r.locations) {
          const o = document.createElement('option');
          o.value = l.id; o.textContent = l.name;
          dl.appendChild(o);
        }
        showToast(tn('exp.pos_found', r.locations.length), 'info');
      } catch (e) { showToast(e.message, 'error'); }
    }
  });
}
