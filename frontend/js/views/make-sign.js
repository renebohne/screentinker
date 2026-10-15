/*
 * 3.0 Make a sign: built-in sign templates, filled in and put on screens in under a minute.
 *
 *   #/simple/sign[?device=&from=]  in Simple view (guide-style, simple-home.js shell)
 *   #/signs[?from=slides]          in Advanced view (Slides → "New from template"), same steps
 *   #/simple/brand                 the workspace brand kit (components/brand-kit-editor.js)
 *
 * Steps: pick a template (a grid of live previews) → fill in the words (big inputs, live preview) →
 * pick screens → done. The server builds the sign into an ordinary slide deck and its widget
 * (routes/signs.js); this view then adds the widget to each chosen screen and publishes through the
 * same path the other Simple tasks use (simple-home.js showOnScreen → components/release.js), so a
 * workspace that reviews changes hears "sent for review", never "it's live".
 *
 * ⚠️ PREVIEWS ARE THE PLAYER'S OWN RENDER, in a frame with no permissions at all. The HTML comes
 * from the slide renderer on the server — the same bytes a screen gets — and is put in an iframe via
 * srcdoc with an EMPTY sandbox: no script, no same-origin, nothing to reach the dashboard with even
 * if a field somehow carried markup through (the server escapes it; this is the second wall).
 *
 * Values from the server and from the person reach the page through esc() or .value only.
 */
import { api } from '../api.js';
import { t, tn } from '../i18n.js';
import { esc, isPlatformAdmin } from '../utils.js';
import { openUseModal } from './templates.js';
import { shell, guideFrame, showOnScreen, simpleCanChange } from './simple-home.js';
import { mountBrandKit } from '../components/brand-kit-editor.js';

const PREVIEW_DEBOUNCE_MS = 350;
let timers = [];
let alive = 0; // bumped on every render/cleanup so a late response never paints a page that has moved on

/** t() returns the key itself when a string is missing; this returns null instead. */
function tx(key, vars) {
  const v = t(key, vars);
  return v === key ? null : v;
}

const tplName = (tp) => tx(`signs.tpl.${tp.id}.name`) || tp.name;
const fieldLabel = (tp, key) => tx(`signs.tpl.${tp.id}.f.${key}`) || tx(`signs.field.${key}`) || key;

/* ---------------------------------------------------------------- values */

function sampleText(tp, f) {
  const s = tx(`signs.sample.${tp.id}.${f.key}`);
  if (s != null) return s;
  return typeof f.sample === 'string' ? f.sample : '';
}

/** Rows samples are translated as "label|value" lines, so a translator sees one string per list. */
function sampleRows(tp, f) {
  const s = tx(`signs.sample.${tp.id}.${f.key}`);
  if (s != null) {
    return s.split('\n').map((line) => {
      const [label, value = ''] = line.split('|');
      return { label: label.trim(), value: value.trim() };
    }).filter((r) => r.label || r.value);
  }
  return Array.isArray(f.sample) ? f.sample.map((r) => ({ label: r.label, value: r.value })) : [];
}

function defaultTarget() {
  const d = new Date(Date.now() + 9 * 86400000);
  d.setHours(10, 0, 0, 0);
  return d.toISOString();
}

const COLOR_SLOT = { bg: 0, accent: 1, extra: 2 };

/** The values a template starts with: translated samples, pre-filled from the brand kit. */
function defaults(tp, brand) {
  const v = {};
  for (const f of tp.fields) {
    if (f.type === 'text' || f.type === 'url' || f.type === 'multiline') {
      v[f.key] = (f.brand && brand && brand[f.brand]) || sampleText(tp, f);
    } else if (f.type === 'rows') v[f.key] = sampleRows(tp, f);
    else if (f.type === 'datetime') v[f.key] = defaultTarget();
    else if (f.type === 'color') v[f.key] = (brand && brand.colors && brand.colors[COLOR_SLOT[f.key]]) || f.default;
    else if (f.type === 'toggle') v[f.key] = f.key === 'show_logo' ? !!(brand && brand.logo_content_id) : !!f.default;
    else if (f.type === 'select') v[f.key] = f.default;
  }
  return v;
}

/** datetime-local wants local "YYYY-MM-DDTHH:MM"; the server wants an instant. */
function toLocalInput(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function isEmpty(v) {
  return v == null || v === '' || (Array.isArray(v) && !v.some((r) => r.label || r.value));
}

/* ---------------------------------------------------------------- the form */

function fieldHtml(tp, f, v, brand) {
  const id = `sf_${f.key}`;
  const label = `<label class="simple-label" for="${id}">${esc(fieldLabel(tp, f.key))}${f.required ? '' : ` <span class="sign-optional">${esc(t('signs.optional'))}</span>`}</label>`;
  const val = v[f.key];
  switch (f.type) {
    case 'text':
      return `${label}<input id="${id}" class="input sign-input" data-key="${esc(f.key)}" maxlength="${Number(f.max) || 80}" value="${esc(val || '')}" autocomplete="off">`;
    case 'url':
      return `${label}<input id="${id}" class="input sign-input" data-key="${esc(f.key)}" maxlength="${Number(f.max) || 500}" value="${esc(val || '')}" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://">`;
    case 'multiline':
      return `${label}<textarea id="${id}" class="input sign-input" data-key="${esc(f.key)}" rows="${Math.min(5, Number(f.max_lines) || 4)}" maxlength="${Number(f.max) || 280}">${esc(val || '')}</textarea>
        <small class="sign-hint">${esc(tn('signs.lines_hint', Number(f.max_lines) || 5))}</small>`;
    case 'rows':
      return `<span class="simple-label">${esc(fieldLabel(tp, f.key))}</span><div class="sign-rows" data-rows="${esc(f.key)}">${rowsHtml(tp, f, val || [])}</div>`;
    case 'datetime':
      return `${label}<input id="${id}" type="datetime-local" class="input sign-input" data-key="${esc(f.key)}" data-type="datetime" value="${esc(toLocalInput(val))}">`;
    case 'color':
      return `<label class="sign-color" for="${id}"><input id="${id}" type="color" data-key="${esc(f.key)}" value="${esc(val || '#000000')}"><span>${esc(fieldLabel(tp, f.key))}</span></label>`;
    case 'toggle':
      // The logo switch only means something when there is a logo to show.
      if (f.key === 'show_logo' && !(brand && brand.logo_content_id)) return '';
      return `<label class="sign-toggle" for="${id}"><input id="${id}" type="checkbox" data-key="${esc(f.key)}" data-type="toggle" ${val ? 'checked' : ''}> <span>${esc(fieldLabel(tp, f.key))}</span></label>`;
    case 'select':
      return `${label}<select id="${id}" class="input sign-input" data-key="${esc(f.key)}">${(f.options || []).map((o) =>
        `<option value="${esc(o)}" ${o === val ? 'selected' : ''}>${esc(tx(`signs.option.${o}`) || o)}</option>`).join('')}</select>`;
    default:
      return '';
  }
}

function rowsHtml(tp, f, rows) {
  const ph1 = tx(`signs.tpl.${tp.id}.row_label`) || t('signs.row_label');
  const ph2 = tx(`signs.tpl.${tp.id}.row_value`) || t('signs.row_value');
  const max = Number(f.max_rows) || 6;
  return `${rows.map((r, i) => `
    <div class="sign-row">
      <input class="input sign-input" data-row-label="${i}" maxlength="60" value="${esc(r.label || '')}" placeholder="${esc(ph1)}" aria-label="${esc(ph1)} ${i + 1}">
      <input class="input sign-input" data-row-value="${i}" maxlength="30" value="${esc(r.value || '')}" placeholder="${esc(ph2)}" aria-label="${esc(ph2)} ${i + 1}">
      <button type="button" class="btn btn-secondary sign-row-del" data-row-del="${i}" aria-label="${esc(t('signs.row_remove'))}" title="${esc(t('signs.row_remove'))}">&times;</button>
    </div>`).join('')}
    ${rows.length < max ? `<button type="button" class="btn btn-secondary btn-sm" data-row-add>+ ${esc(t('signs.row_add'))}</button>` : ''}`;
}

function formHtml(tp, v, brand) {
  const main = tp.fields.filter((f) => !f.more).map((f) => fieldHtml(tp, f, v, brand)).join('');
  const more = tp.fields.filter((f) => f.more);
  const moreText = more.filter((f) => f.type !== 'color' && f.type !== 'toggle').map((f) => fieldHtml(tp, f, v, brand)).join('');
  const colors = more.filter((f) => f.type === 'color').map((f) => fieldHtml(tp, f, v, brand)).join('');
  const toggles = more.filter((f) => f.type === 'toggle').map((f) => fieldHtml(tp, f, v, brand)).join('');
  return `${main}
    <details class="sign-more">
      <summary>${esc(t('signs.more'))}</summary>
      ${moreText}
      ${colors ? `<span class="simple-label">${esc(t('signs.colors'))}</span><div class="sign-colors">${colors}</div>
        <button type="button" class="btn btn-secondary btn-sm" data-reset-colors>${esc(t('signs.colors_reset'))}</button>` : ''}
      ${toggles ? `<div class="sign-toggles">${toggles}</div>` : ''}
    </details>`;
}

/* ---------------------------------------------------------------- pieces */

function aspectToggle(aspect) {
  return `<div class="sign-aspect" role="group" aria-label="${esc(t('signs.shape'))}">
    <button type="button" data-aspect-pick="16:9" aria-pressed="${aspect === '16:9'}"><span class="ico ico-land" aria-hidden="true"></span>${esc(t('signs.landscape'))}</button>
    <button type="button" data-aspect-pick="9:16" aria-pressed="${aspect === '9:16'}"><span class="ico ico-port" aria-hidden="true"></span>${esc(t('signs.portrait'))}</button>
  </div>`;
}

function frameHtml(aspect, attrs, extraClass = '') {
  // sandbox="" — no scripts, no same-origin, no forms, no popups. See the header.
  return `<span class="sign-frame ${extraClass}" data-aspect="${esc(aspect)}"><iframe sandbox="" referrerpolicy="no-referrer" loading="lazy" tabindex="-1" ${attrs}></iframe></span>`;
}

/* ---------------------------------------------------------------- the flow */

/**
 * @param {HTMLElement} container
 * @param {{ simple?: boolean, device?: string|null, from?: string|null, batch?: Array|null, aspect?: string, onBack?: Function }} opts
 *
 * 3.0 Private AI: `batch` is a starter set from "Set up my screens with AI" (views/ai-setup.js),
 * [{template, values}] already checked by the server against each template's fields. Each one opens
 * in this same fill step, one after another — the person reads and edits every sign — and then one
 * screens step puts them all on the chosen screens.
 */
export async function renderSign(container, { simple = false, device: presetId = null, from = null, batch = null, aspect: startAspect = '16:9', onBack = null } = {}) {
  cleanup();
  const run = ++alive;
  const fromSlides = from === 'slides';
  const fromGuide = from === 'onboarding' || from === 'add';
  const home = simple ? '#/' : (fromSlides ? '#/slides' : '#/');
  const again = simple ? '#/simple/sign' : '#/signs';
  const brandHref = simple ? '#/simple/brand' : '#/settings';
  const paint = (inner) => {
    if (simple) shell(container, inner);
    else container.innerHTML = `<div class="sign-page">${inner}</div>`;
  };
  const wireBack = (fn) => container.querySelector('[data-guide-back]')?.addEventListener('click', fn);

  if (!simpleCanChange()) {
    paint(guideFrame({ step: 0, total: 1, icon: '&#128065;', title: t('signs.title'), back: false, cancelHref: home,
      body: `<p class="simple-lead">${esc(t('simple.home.viewer_note'))}</p>` }));
    return;
  }

  paint(`<p class="simple-muted" style="text-align:center">${esc(t('common.loading'))}</p>`);
  let cat = null;
  let devices = [];
  let playlists = [];
  let installed = [];
  try {
    [cat, devices, playlists, installed] = await Promise.all([
      api.getSignTemplates(),
      api.getDevices().catch(() => []),
      api.getPlaylists().catch(() => []),
      // Community templates installed from a catalog: offered next to the built-in designs. A
      // server with none (the catalog is off by default) simply shows the built-in ones.
      api.getInstalledTemplates().then((r) => (r && r.templates) || []).catch(() => []),
    ]);
  } catch (err) {
    if (run !== alive) return;
    paint(guideFrame({ step: 0, total: 1, icon: '&#9888;', title: t('signs.title'), back: false, cancelHref: home,
      body: `<p class="simple-lead">${esc((err && err.message) || t('signs.err.load'))}</p>` }));
    return;
  }
  if (run !== alive) return;

  const templates = (cat && cat.templates) || [];
  const brand = (cat && cat.brand) || {};
  devices = devices || [];
  const preset = devices.find((d) => d.id === presetId) || null;
  // pick, fill, [screens], done — or, for an AI starter set, one fill step per sign
  const withScreens = devices.length > 0 && !preset;
  const queue = Array.isArray(batch) ? batch.filter((b) => b && templates.some((x) => x.id === b.template)) : null;
  const total = queue ? queue.length + (withScreens ? 2 : 1) : (withScreens ? 4 : 3);
  const screensAt = queue ? queue.length : 2;

  let aspect = startAspect === '9:16' ? '9:16' : '16:9';
  let tplId = null;
  let batchIdx = 0;
  const skipped = new Set();
  let communityWidget = null;  // a community template, already created by its own dialog
  const community = (installed || []).filter((x) => x && x.usable && (!x.status || x.status === 'active'));
  const fitsAspect = (x) => !Array.isArray(x.orientation) || !x.orientation.length
    || x.orientation.includes(aspect === '9:16' ? 'portrait' : 'landscape');
  let me = null;
  try { me = JSON.parse(localStorage.getItem('user') || 'null'); } catch { me = null; }
  const canInstall = isPlatformAdmin(me);
  const values = {};       // per template, once touched
  const gallery = {};      // aspect -> { id: html }

  const byId = (id) => templates.find((x) => x.id === id);
  const valuesOf = (tp) => (values[tp.id] ||= defaults(tp, brand));
  /** The values as the server wants them: rows without blank lines. */
  const payload = (tp) => {
    const v = { ...valuesOf(tp) };
    for (const f of tp.fields) if (f.type === 'rows') v[f.key] = (v[f.key] || []).filter((r) => r.label || r.value);
    return v;
  };

  function wireAspect(onChange) {
    container.querySelectorAll('[data-aspect-pick]').forEach((b) => b.addEventListener('click', () => {
      if (aspect === b.dataset.aspectPick) return;
      aspect = b.dataset.aspectPick;
      onChange();
    }));
  }

  function brandNote() {
    const has = brand.business_name || brand.logo_content_id || (brand.colors || []).some(Boolean);
    const text = has ? t('signs.brand.using', { name: brand.business_name || t('signs.brand.your_brand') }) : t('signs.brand.none');
    return `<p class="simple-muted sign-brand-note">${esc(text)} <a href="${esc(brandHref)}">${esc(t(has ? 'signs.brand.edit' : 'signs.brand.set_up'))}</a></p>`;
  }

  // ---------------------------------------------------------------- 1. pick
  function pickStep() {
    paint(guideFrame({ step: 0, total, icon: '&#127991;&#65039;', title: t('signs.pick_title'), back: false, cancelHref: home, wide: true,
      body: `
        <p class="simple-lead sign-lead">${esc(t('signs.pick_lead'))}</p>
        ${aspectToggle(aspect)}
        <div class="sign-grid ${aspect === '9:16' ? 'is-portrait' : ''}" data-grid>
          ${templates.map((tp) => `
            <button type="button" class="sign-card" data-tpl="${esc(tp.id)}">
              ${frameHtml(aspect, `data-prev="${esc(tp.id)}" title="${esc(tplName(tp))}"`)}
              <span class="sign-card-name">${esc(tplName(tp))}</span>
            </button>`).join('')}
        </div>
        ${brandNote()}
        ${communityHtml()}` }));
    wireAspect(pickStep);
    container.querySelectorAll('[data-tpl]').forEach((b) => b.addEventListener('click', () => {
      tplId = b.dataset.tpl;
      communityWidget = null;
      fillStep();
    }));
    container.querySelectorAll('[data-community]').forEach((b) => b.addEventListener('click', () => {
      const tpl = community.find((x) => x.key === b.dataset.community);
      if (!tpl) return;
      // The template's own fill-in dialog (its parameters, its preview); then the same screens step.
      openUseModal({ tpl, onCreated: (w) => {
        if (run !== alive) return;
        communityWidget = w;
        if (withScreens) screensStep();
        else make(preset ? [preset.id] : [], 'add', container.querySelector('[data-status]') || document.createElement('p'));
      } });
    }));
    container.querySelectorAll('img[data-community-thumb]').forEach((img) => img.addEventListener('error', () => { img.replaceWith(document.createTextNode('\u{1F5BC}\uFE0F')); }));
    loadGallery();
  }

  /** Installed community templates (and, for a platform admin, where to get more). */
  function communityHtml() {
    const list = community.filter(fitsAspect);
    if (!list.length && !canInstall) return '';
    const thumb = (x) => (typeof x.thumbnail === 'string' && /^\/api\/templates\/thumb\/[0-9a-f]{64}$/.test(x.thumbnail))
      ? `<img data-community-thumb src="${esc(x.thumbnail)}" alt="" loading="lazy">` : '&#128444;&#65039;';
    return `
      <h3 class="sign-section-title">${esc(t('signs.community_title'))}</h3>
      ${list.length ? `<div class="sign-grid sign-grid--community">${list.map((x) => `
        <button type="button" class="sign-card" data-community="${esc(x.key)}">
          <span class="sign-community-thumb">${thumb(x)}</span>
          <span class="sign-card-name">${esc(x.name || x.id)}</span>
        </button>`).join('')}</div>` : `<p class="simple-muted">${esc(t('signs.community_none'))}</p>`}
      ${canInstall ? `<p class="simple-muted"><a href="#/templates">${esc(t('signs.community_browse'))} &rarr;</a></p>` : ''}
      <p class="simple-status" data-status role="status"></p>`;
  }

  async function loadGallery() {
    const a = aspect;
    const paintGallery = (map) => {
      container.querySelectorAll('[data-prev]').forEach((f) => {
        const html = map[`${f.dataset.prev}:${a}`];
        if (html && f.srcdoc !== html) f.srcdoc = html;
      });
    };
    if (gallery[a]) { paintGallery(gallery[a]); return; }
    try {
      const r = await api.previewSigns({ aspect: a, items: templates.map((tp) => ({ template: tp.id, aspect: a, values: payload(tp) })) });
      gallery[a] = (r && r.previews) || {};
      if (run === alive && a === aspect) paintGallery(gallery[a]);
    } catch { /* the names are still there; a preview is a courtesy */ }
  }

  // ---------------------------------------------------------------- 2. fill
  function fillStep() {
    const tp = byId(tplId);
    if (!tp) { pickStep(); return; }
    const v = valuesOf(tp);
    const moreInBatch = queue && batchIdx < queue.length - 1;
    const nextLabel = moreInBatch ? t('ai_setup.next_sign')
      : withScreens ? t('signs.next_screens')
      : preset ? t('signs.show_on', { name: preset.name }) : t('signs.save_btn');
    paint(guideFrame({ step: queue ? batchIdx : 1, total, icon: '&#9998;', title: tplName(tp), cancelHref: home, wide: true, next: true, nextLabel,
      body: `
        ${queue ? `<p class="simple-muted ai-setup-progress">${esc(t('ai_setup.sign_of', { n: batchIdx + 1, total: queue.length }))}
          <button type="button" class="btn btn-secondary btn-sm" data-skip>${esc(t(skipped.has(batchIdx) ? 'ai_setup.include' : 'ai_setup.skip'))}</button></p>` : ''}
        <div class="sign-fill">
          <div class="sign-preview-col">
            ${aspectToggle(aspect)}
            ${frameHtml(aspect, `data-live title="${esc(t('signs.preview'))}"`, 'sign-frame--big')}
          </div>
          <div class="sign-form" data-form>${formHtml(tp, v, brand)}</div>
        </div>
        <div class="sign-a11y" data-a11y role="status" hidden></div>
        ${brandNote()}
        <p class="simple-status" data-status role="status"></p>` }));
    wireBack(queue ? () => {
      if (batchIdx > 0) { batchIdx--; tplId = queue[batchIdx].template; fillStep(); }
      else if (typeof onBack === 'function') onBack();
      else window.location.hash = home;
    } : pickStep);
    const nextInBatch = () => {
      batchIdx++;
      tplId = queue[batchIdx].template;
      fillStep();
    };
    container.querySelector('[data-skip]')?.addEventListener('click', () => {
      if (skipped.has(batchIdx)) { skipped.delete(batchIdx); fillStep(); return; }
      skipped.add(batchIdx);
      if (moreInBatch) nextInBatch();
      else if (withScreens) screensStep();
      else make(preset ? [preset.id] : [], 'add', container.querySelector('[data-status]'));
    });
    wireAspect(() => {
      container.querySelectorAll('[data-aspect-pick]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.aspectPick === aspect)));
      const fr = container.querySelector('.sign-frame--big');
      if (fr) fr.dataset.aspect = aspect;
      preview(0);
    });

    const form = container.querySelector('[data-form]');
    const status = container.querySelector('[data-status]');
    const onEdit = (e) => {
      const el = e.target;
      if (el.dataset.key) {
        const f = tp.fields.find((x) => x.key === el.dataset.key);
        if (!f) return;
        if (f.type === 'toggle') v[f.key] = el.checked;
        else if (f.type === 'datetime') { const d = new Date(el.value); v[f.key] = Number.isNaN(d.getTime()) ? '' : d.toISOString(); }
        else v[f.key] = el.value;
      } else if (el.dataset.rowLabel != null || el.dataset.rowValue != null) {
        const host = el.closest('[data-rows]');
        const rows = v[host.dataset.rows] ||= [];
        const i = Number(el.dataset.rowLabel ?? el.dataset.rowValue);
        rows[i] = rows[i] || { label: '', value: '' };
        if (el.dataset.rowLabel != null) rows[i].label = el.value; else rows[i].value = el.value;
      } else return;
      status.textContent = '';
      preview();
    };
    // Both: a checkbox, a colour picker or a date picker reports through `change` on some browsers
    // (older Android WebViews among them), and handling an edit twice only re-reads the same value.
    form.addEventListener('input', onEdit);
    form.addEventListener('change', onEdit);
    form.addEventListener('click', (e) => {
      const add = e.target.closest('[data-row-add]');
      const del = e.target.closest('[data-row-del]');
      const reset = e.target.closest('[data-reset-colors]');
      if (reset) {
        for (const f of tp.fields.filter((x) => x.type === 'color')) {
          v[f.key] = f.default;
          const inp = form.querySelector(`[data-key="${f.key}"]`);
          if (inp) inp.value = f.default;
        }
        preview(0);
        return;
      }
      if (!add && !del) return;
      const host = e.target.closest('[data-rows]');
      const f = tp.fields.find((x) => x.key === host.dataset.rows);
      const rows = v[f.key] ||= [];
      if (add && rows.length < (Number(f.max_rows) || 6)) rows.push({ label: '', value: '' });
      if (del) rows.splice(Number(del.dataset.rowDel), 1);
      host.innerHTML = rowsHtml(tp, f, rows);
      if (add) host.querySelector(`[data-row-label="${rows.length - 1}"]`)?.focus();
      preview(0);
    });

    container.querySelector('[data-guide-next]').addEventListener('click', () => {
      const missing = tp.fields.find((f) => f.required && isEmpty(v[f.key]));
      if (missing) {
        status.textContent = t('signs.err.required', { field: fieldLabel(tp, missing.key) });
        form.querySelector(`[data-key="${missing.key}"]`)?.focus();
        return;
      }
      if (queue) skipped.delete(batchIdx);
      if (moreInBatch) nextInBatch();
      else if (withScreens) screensStep();
      else make(preset ? [preset.id] : [], 'add', status);
    });
    preview(0);
  }

  function preview(delay = PREVIEW_DEBOUNCE_MS) {
    timers.forEach(clearTimeout);
    timers = [setTimeout(async () => {
      const tp = byId(tplId);
      const frame = container.querySelector('[data-live]');
      if (!tp || !frame) return;
      const a = aspect;
      try {
        const r = await api.previewSigns({ template: tp.id, aspect: a, values: payload(tp) });
        if (run !== alive || !document.contains(frame) || a !== aspect) return;
        frame.srcdoc = r.html;
        // The gallery's thumbnail of this template follows the edits too.
        if (gallery[a]) gallery[a][`${tp.id}:${a}`] = r.html;
      } catch { /* keep the last good preview */ }
      readability(tp, a);
    }, delay)];
  }

  /*
   * 3.0 accessibility: one plain sentence when the sign may be hard to read, with a one-tap fix.
   *
   * The sign itself always uses readable text colours (the server adjusts a colour that would not
   * read), so what this tells the person is that the colour they PICKED was changed, and offers to
   * make the picker say what the screen will show. Text too small for the workspace's viewing
   * distance gets its own sentence. A failed check says nothing: it is advice, not a gate.
   */
  async function readability(tp, a) {
    const box = container.querySelector('[data-a11y]');
    if (!box) return;
    let r;
    try { r = await api.checkSignAccessibility({ template: tp.id, aspect: a, values: payload(tp) }); } catch { return; }
    if (run !== alive || !document.contains(box) || a !== aspect || !r || Array.isArray(r)) return;
    const chosen = Array.isArray(r.chosen) ? r.chosen[0] : null;
    const small = (r.issues || []).find((i) => i.code === 'text_small' && i.severity !== 'note');
    if (chosen && /^#[0-9A-Fa-f]{6}$/.test(chosen.suggested || '')) {
      box.innerHTML = `<p><span class="a11y-swatch" style="background:${esc(chosen.suggested)}" aria-hidden="true"></span>${esc(t('a11y.sign.hard_to_read'))}</p>
        <button type="button" class="btn btn-secondary" data-a11y-fix>${esc(t('a11y.sign.use_suggested'))}</button>`;
      box.hidden = false;
      box.querySelector('[data-a11y-fix]').addEventListener('click', () => {
        const v = valuesOf(tp);
        v[chosen.key] = chosen.suggested.toLowerCase();
        const inp = container.querySelector(`[data-form] [data-key="${chosen.key}"]`);
        if (inp) inp.value = v[chosen.key];
        box.hidden = true;
        preview(0);
      });
    } else if (small) {
      const distance = r.view && r.view.distance_m ? r.view.distance_m : '';
      box.innerHTML = `<p>${esc(t('a11y.sign.too_small', { distance }))}</p>`;
      box.hidden = false;
    } else {
      box.hidden = true;
      box.innerHTML = '';
    }
  }

  // ---------------------------------------------------------------- 3. screens
  function screensStep() {
    let how = 'add';
    paint(guideFrame({ step: screensAt, total, icon: '&#128250;', title: t('signs.where_title'), cancelHref: home,
      next: true, nextLabel: t('signs.show_btn'),
      body: `
        <div class="simple-checks">${devices.map((d) => `
          <label><input type="checkbox" value="${esc(d.id)}" checked> <span>${esc(d.name)}</span>
          <small class="simple-screen-status ${d.status === 'online' ? 'on' : 'off'}">${esc(d.status === 'online' ? t('simple.status.online') : t('simple.status.offline'))}</small></label>`).join('')}</div>
        <div class="simple-choice" role="radiogroup" aria-label="${esc(t('simple.change.how_label'))}">
          <label><input type="radio" name="signHow" value="add" checked> <span><strong>${esc(t('simple.change.add'))}</strong><small>${esc(t('signs.how_add_desc'))}</small></span></label>
          <label><input type="radio" name="signHow" value="replace"> <span><strong>${esc(t('simple.change.replace'))}</strong><small>${esc(t('signs.how_replace_desc'))}</small></span></label>
        </div>
        <p class="simple-muted">${esc(t('signs.where_hint'))}</p>
        <p class="simple-status" data-status role="status"></p>` }));
    wireBack(communityWidget ? pickStep : fillStep);
    // A starter set with every sign left out has nothing to show.
    if (queue && skipped.size >= queue.length) container.querySelector('[data-status]').textContent = t('ai_setup.all_skipped');
    container.querySelectorAll('input[name="signHow"]').forEach((r) => r.addEventListener('change', () => { how = r.value; }));
    container.querySelector('[data-guide-next]').addEventListener('click', () => {
      const ids = [...container.querySelectorAll('.simple-checks input:checked')].map((i) => i.value);
      make(ids, how, container.querySelector('[data-status]'));
    });
  }

  // ---------------------------------------------------------------- create + publish
  async function make(deviceIds, how, status) {
    if (queue) return makeBatch(deviceIds, how, status);
    const tp = byId(tplId);
    const buttons = [...container.querySelectorAll('button, input, select, textarea')];
    buttons.forEach((b) => { b.disabled = true; });
    status.textContent = t('simple.working');
    let sign;
    try {
      sign = communityWidget
        // Already created by the template's own dialog; it plays for the playlist's usual time.
        ? { widget_id: communityWidget.id, dwell_sec: 15, name: communityWidget.name }
        : await api.createSign({ template: tp.id, aspect, values: payload(tp) });
    } catch (err) {
      buttons.forEach((b) => { b.disabled = false; });
      const first = err && err.body && Array.isArray(err.body.errors) ? err.body.errors[0] : null;
      status.textContent = first
        ? t(`signs.err.${first.code}`, { field: fieldLabel(tp, first.field) })
        : ((err && err.message) || t('signs.err.save'));
      return;
    }
    if (run !== alive) return;

    let review = false;
    let shown = 0;
    try {
      // Screens that share one list are updated once, not once per screen (as Upload does).
      const seen = new Set();
      for (const id of deviceIds) {
        const d = devices.find((x) => x.id === id);
        if (!d) continue;
        if (how === 'add' && d.playlist_id && seen.has(d.playlist_id)) { shown++; continue; }
        if (d.playlist_id) seen.add(d.playlist_id);
        const r = await showOnScreen(d, [{ widget_id: sign.widget_id, duration_sec: sign.dwell_sec }], how,
          { devices, playlists, note: `Make a sign: ${sign.name}` });
        review = review || !!r.review;
        shown++;
      }
    } catch (err) {
      // The sign exists (it is in Slides); only putting it on a screen failed. Say exactly that.
      buttons.forEach((b) => { b.disabled = false; });
      const reason = (err && err.message) || '';
      status.textContent = t('signs.err.assign', { reason });
      return;
    }
    if (run !== alive) return;
    if (shown && !review) api.trackEvent('first_publish', { from: 'make_sign' });
    doneStep({ shown, review });
  }

  /*
   * The AI starter set: every sign the person kept is created through the ordinary endpoint (the
   * server validates each again), then all of them go on the chosen screens in ONE publish per
   * screen — so a workspace that reviews changes gets one review, not six.
   */
  async function makeBatch(deviceIds, how, status) {
    const keep = queue.map((b, i) => ({ ...b, i })).filter((b) => !skipped.has(b.i));
    if (!keep.length) { status.textContent = t('ai_setup.all_skipped'); return; }
    const buttons = [...container.querySelectorAll('button, input, select, textarea')];
    buttons.forEach((b) => { b.disabled = true; });
    status.textContent = t('simple.working');
    const items = [];
    for (const b of keep) {
      const tp = byId(b.template);
      try {
        const sign = await api.createSign({ template: tp.id, aspect, values: payload(tp) });
        items.push({ widget_id: sign.widget_id, duration_sec: sign.dwell_sec, name: sign.name });
      } catch (err) {
        buttons.forEach((x) => { x.disabled = false; });
        const first = err && err.body && Array.isArray(err.body.errors) ? err.body.errors[0] : null;
        status.textContent = `${tplName(tp)}: ${first ? t(`signs.err.${first.code}`, { field: fieldLabel(tp, first.field) }) : ((err && err.message) || t('signs.err.save'))}`;
        return;
      }
      if (run !== alive) return;
    }
    let review = false;
    let shown = 0;
    try {
      const seen = new Set();
      for (const id of deviceIds) {
        const d = devices.find((x) => x.id === id);
        if (!d) continue;
        if (how === 'add' && d.playlist_id && seen.has(d.playlist_id)) { shown++; continue; }
        if (d.playlist_id) seen.add(d.playlist_id);
        const r = await showOnScreen(d, items.map((x) => ({ widget_id: x.widget_id, duration_sec: x.duration_sec })), how,
          { devices, playlists, note: `Set up with AI: ${items.length} signs` });
        review = review || !!r.review;
        shown++;
      }
    } catch (err) {
      buttons.forEach((b) => { b.disabled = false; });
      const reason = (err && err.message) || '';
      status.textContent = t('signs.err.assign', { reason });
      return;
    }
    if (run !== alive) return;
    if (shown && !review) api.trackEvent('first_publish', { from: 'ai_setup' });
    doneStep({ shown, review, count: items.length });
  }

  // ---------------------------------------------------------------- 4. done
  function doneStep({ shown, review, count = 0 }) {
    const saved = shown === 0;
    const title = saved ? t(count > 1 ? 'ai_setup.saved_title' : 'signs.done.saved_title') : t(review ? 'simple.done.review_title' : 'onboarding.step.done.title');
    const lead = saved ? t('signs.done.saved')
      : review ? tn('simple.upload.review_on', shown) : tn('signs.done.live', shown);
    const hint = saved ? (devices.length ? '' : t('signs.done.no_screens')) : t(review ? 'simple.done.review_hint' : 'simple.done.seconds');
    paint(guideFrame({ step: total - 1, total, icon: saved ? '&#9989;' : review ? '&#9203;' : '&#127881;', title, back: false, cancelHref: home,
      body: `${count ? `<p class="simple-lead">${esc(tn('ai_setup.made', count))}</p>` : ''}${count > 1 && saved ? '' : `<p class="simple-lead">${esc(lead)}</p>`}${hint ? `<p class="simple-muted">${esc(hint)}</p>` : ''}
        <p class="simple-muted">${esc(t(communityWidget ? 'signs.done.edit_later_widget' : 'signs.done.edit_later'))}</p>
        <div class="simple-done-actions">
          <a class="btn btn-primary" href="${esc(fromGuide || fromSlides ? (fromSlides ? '#/slides' : '#/') : home)}">${esc(fromGuide ? t('onboarding.go_to_dashboard') : fromSlides ? t('signs.done.back_slides') : t('simple.done.home'))}</a>
          <a class="btn btn-secondary" href="${esc(again)}">${esc(t('signs.done.another'))}</a>
          ${!devices.length ? `<a class="btn btn-secondary" href="#/add-screen">${esc(t('simple.task.add'))}</a>` : ''}
          ${!simple && !fromSlides ? `<a class="btn btn-secondary" href="#/slides">${esc(t('signs.done.open_slides'))}</a>` : ''}
        </div>` }));
    // "Make another" on the same hash does not fire hashchange; re-render explicitly.
    container.querySelector(`.simple-done-actions a[href="${again}"]`)?.addEventListener('click', (e) => {
      if (window.location.hash === again) { e.preventDefault(); renderSign(container, { simple }); }
    });
  }

  if (queue && queue.length) {
    /*
     * What the AI wrote, on top of the template's defaults — but a field it left out starts EMPTY,
     * not with the sample text: "Corner Café" on a hospital's sign would be a fact nobody gave.
     * Labels under More options keep theirs ("Network", "Password"); they are words, not facts.
     */
    for (const b of queue) {
      const tp = byId(b.template);
      const given = b.values || {};
      const v = defaults(tp, brand);
      for (const f of tp.fields) {
        if (f.more || Object.prototype.hasOwnProperty.call(given, f.key)) continue;
        if (f.type === 'text' || f.type === 'url' || f.type === 'multiline') v[f.key] = (f.brand && brand[f.brand]) || '';
        else if (f.type === 'rows') v[f.key] = [];
      }
      values[tp.id] = { ...v, ...given };
    }
    tplId = queue[0].template;
    fillStep();
  } else pickStep();
}

/* ---------------------------------------------------------------- brand kit page (Simple) */

export function renderBrand(container, { simple = true } = {}) {
  cleanup();
  const inner = `
    <div class="simple-help-top"><a href="#/" class="btn btn-secondary btn-sm">&larr; ${esc(t('simple.done.home'))}</a></div>
    <h1 class="simple-h1">${esc(t('signs.brand.title'))}</h1>
    <p class="simple-lead sign-lead">${esc(t('signs.brand.intro'))}</p>
    <div class="simple-card" data-brand-kit></div>
    ${simpleCanChange() ? `<div class="simple-card sign-brand-cta"><span>${esc(t('signs.brand.cta'))}</span>
      <a class="btn btn-primary" href="#/simple/sign">${esc(t('signs.task'))}</a></div>` : ''}`;
  if (simple) shell(container, inner); else container.innerHTML = `<div class="simple-page">${inner}</div>`;
  mountBrandKit(container.querySelector('[data-brand-kit]'));
}

/* ---------------------------------------------------------------- Advanced route (#/signs) */

export function render(container, hash = window.location.hash || '') {
  const q = new URLSearchParams(hash.split('?')[1] || '');
  return renderSign(container, { simple: false, device: q.get('device'), from: q.get('from') });
}

export function cleanup() {
  timers.forEach(clearTimeout);
  timers = [];
  alive++;
}
