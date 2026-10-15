/*
 * 3.0 accessibility checker, the dashboard half that several views share
 * (server: lib/a11y, routes/accessibility.js, docs/accessibility.md):
 *
 *   a11yWhy(issue) / a11yHow(issue)   the plain-language reason and fix for one finding
 *   confirmAccessibility(type, id)    the non-blocking warning before a publish ("Publish anyway")
 *   installA11yBadges(container)      badges on content items, playlists and slide decks
 *   applyA11yFix(source, issue)       the one-click fixes, through the ordinary edit endpoints
 *
 * Every sentence is translated here from the structured finding the server sends (a code and its
 * numbers). Values from the server reach the DOM through esc() only.
 */
import { api } from '../api.js';
import { t, tn } from '../i18n.js';
import { esc } from '../utils.js';
import { isSimpleMode } from './ui-mode.js';

/* ---------------------------------------------------------------- words */

const num = (v, d = 1) => (Number.isFinite(Number(v)) ? String(Math.round(Number(v) * 10 ** d) / 10 ** d) : '?');

/** One finding as a sentence: what is wrong. */
export function a11yWhy(i) {
  const v = (i && i.values) || {};
  switch (i && i.code) {
    case 'contrast': return t('a11y.why.contrast', { ratio: num(v.ratio, 2), need: num(v.required, 1) });
    case 'contrast_image': return t('a11y.why.contrast_image', { ratio: num(v.ratio, 2), need: num(v.required, 1) });
    case 'contrast_unverified': return t(`a11y.why.unverified_${['video', 'image', 'pending', 'transparent'].includes(v.why) ? v.why : 'image'}`);
    case 'text_small': return t('a11y.why.text_small', { distance: num(v.distance_m), cap: num(v.cap_mm), min: num(v.min_font_mm) });
    case 'flashing': return t('a11y.why.flashing', { n: v.per_sec, at: num(v.at_sec) });
    case 'red_flashing': return t('a11y.why.red_flashing', { n: v.per_sec, at: num(v.at_sec) });
    case 'flash_partial': return t('a11y.why.flash_partial', { sec: Math.round(Number(v.analysed_sec) || 0) });
    case 'no_captions': return t('a11y.why.no_captions');
    case 'youtube_captions_off': return t('a11y.why.youtube_captions_off');
    case 'media_pending': return t('a11y.why.media_pending');
    case 'media_remote': return t('a11y.why.media_remote');
    case 'media_unchecked': return t(v.why === 'not_local' ? 'a11y.why.media_not_local' : 'a11y.why.media_unreadable');
    case 'text_in_image': return t('a11y.why.text_in_image');
    case 'unverifiable': return t('a11y.why.unverifiable');
    default: return '';
  }
}

/** One finding as a sentence: what to do about it. */
export function a11yHow(i) {
  const v = (i && i.values) || {};
  switch (i && i.code) {
    case 'contrast': return v.suggested ? t('a11y.how.contrast', { color: v.suggested }) : t('a11y.how.contrast_plain');
    case 'contrast_image': return t('a11y.how.contrast_image');
    case 'contrast_unverified': return t('a11y.how.unverified');
    case 'text_small': return i.fix && i.fix.scale ? t('a11y.how.text_small', { scale: num(i.fix.scale, 1) }) : t('a11y.how.text_small_plain');
    case 'flashing':
    case 'red_flashing': return t('a11y.how.flashing');
    case 'no_captions': return t('a11y.how.no_captions');
    case 'youtube_captions_off': return t('a11y.how.youtube_captions_off');
    case 'text_in_image': return t('a11y.how.text_in_image');
    default: return '';
  }
}

const PART = {
  time: 'a11y.part.time', date: 'a11y.part.date', temperature: 'a11y.part.temperature', location: 'a11y.part.location',
  description: 'a11y.part.description', ticker: 'a11y.part.ticker', title: 'a11y.part.title', subtitle: 'a11y.part.subtitle',
  section: 'a11y.part.section', item: 'a11y.part.item', tag: 'a11y.part.tag', entries: 'a11y.part.entries',
};

/** Where on the item a finding is ("Slide 2 · “Weekend sale”"). */
export function a11yWhere(i) {
  const w = (i && i.where) || {};
  const parts = [];
  if (Number.isInteger(w.slide_index)) parts.push(t('a11y.where.slide', { n: w.slide_index + 1 }));
  if (w.part) parts.push(PART[w.part] ? t(PART[w.part]) : w.part);
  if (i && i.text) parts.push(`“${i.text}”`);
  return parts.join(' · ');
}

export const SEVERITY_LABEL = { error: 'a11y.sev.error', warning: 'a11y.sev.warning', note: 'a11y.sev.note' };

/** A finding as a list item (reason, where, how). */
export function a11yIssueHtml(i, actions = '') {
  const where = a11yWhere(i);
  const how = a11yHow(i);
  const swatch = i.values && i.values.suggested && /^#[0-9A-Fa-f]{6}$/.test(i.values.suggested)
    ? `<span class="a11y-swatch" style="background:${esc(i.values.suggested)}" aria-hidden="true"></span>` : '';
  return `<li class="a11y-issue a11y-issue-${esc(i.severity)}">
    <span class="a11y-sev a11y-sev-${esc(i.severity)}">${esc(t(SEVERITY_LABEL[i.severity] || 'a11y.sev.note'))}</span>
    <span class="a11y-issue-body"><span>${esc(a11yWhy(i))}</span>
      ${where ? `<small class="a11y-where">${esc(where)}</small>` : ''}
      ${how ? `<small class="a11y-how">${swatch}${esc(how)}</small>` : ''}
      ${actions}</span></li>`;
}

/* ---------------------------------------------------------------- before publishing */

function modal(inner) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.display = 'flex';
  overlay.innerHTML = `<div class="modal a11y-modal" role="dialog" aria-modal="true" aria-labelledby="a11yGateTitle" style="max-width:560px;width:95vw">${inner}</div>`;
  document.body.appendChild(overlay);
  return overlay;
}

/**
 * Before a publish: if the thing has accessibility errors or warnings, say so and let the person
 * decide. Resolves true to go ahead, false to stop.
 *
 * ⚠️ NEVER A REASON NOT TO PUBLISH ON ITS OWN ACCOUNT. If the check itself fails (offline, an old
 * server without the route), this resolves true: the warning is a courtesy, and the server's own
 * policy (when a workspace switched it on) is what actually refuses.
 */
export async function confirmAccessibility(type, id) {
  if (!id) return true;
  let r;
  try { r = await api.checkAccessibility(type, id); } catch { return true; }
  if (!r || Array.isArray(r) || !Array.isArray(r.sources)) return true;
  const blocked = r.block && r.block.code;
  if (!blocked && !r.errors && !r.warnings) return true;
  const items = r.sources.flatMap((s) => (s.issues || []).filter((i) => i.severity !== 'note').map((i) => ({ s, i }))).slice(0, 12);
  const more = (r.errors + r.warnings) - items.length;
  return new Promise((resolve) => {
    const overlay = modal(`
      <div class="modal-header"><h3 id="a11yGateTitle">${esc(t(blocked ? 'a11y.gate.blocked_title' : 'a11y.gate.title'))}</h3></div>
      <div class="modal-body">
        <p>${esc(blocked === 'accessibility_pending' ? t('a11y.gate.pending') : blocked ? t('a11y.gate.blocked') : t('a11y.gate.lead', { errors: r.errors, warnings: r.warnings }))}</p>
        <ul class="a11y-issues">${items.map(({ s, i }) => a11yIssueHtml({ ...i, text: i.text || s.name })).join('')}</ul>
        ${more > 0 ? `<p class="corp-help" style="font-size:12px">${esc(tn('a11y.gate.more', more))}</p>` : ''}
        <p class="corp-help" style="font-size:12px"><a href="#/accessibility" data-a11y-report>${esc(t('a11y.gate.open_report'))}</a></p>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" data-a11y-cancel>${esc(t(blocked ? 'common.close' : 'a11y.gate.fix_first'))}</button>
        ${blocked ? '' : `<button type="button" class="btn btn-primary" data-a11y-go>${esc(t('a11y.gate.publish_anyway'))}</button>`}
      </div>`);
    const done = (v) => { overlay.remove(); resolve(v); };
    overlay.querySelector('[data-a11y-cancel]').addEventListener('click', () => done(false));
    overlay.querySelector('[data-a11y-go]')?.addEventListener('click', () => done(true));
    overlay.querySelector('[data-a11y-report]').addEventListener('click', () => done(false));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(false); });
    (overlay.querySelector('[data-a11y-go]') || overlay.querySelector('[data-a11y-cancel]')).focus();
  });
}

/** The error a publish path throws when the person chose to fix things first. */
export function a11yCancelled() {
  const e = new Error(t('a11y.gate.cancelled'));
  e.code = 'a11y_cancelled';
  return e;
}

/* ---------------------------------------------------------------- one-click fixes */

function setElementStyle(template, idx, fix) {
  const el = template && Array.isArray(template.elements) ? template.elements[idx] : null;
  if (!el) return false;
  el.style = el.style || {};
  if (fix.color) el.style.color = fix.color;
  if (fix.opacity) el.style.opacity = fix.opacity;
  return true;
}

/**
 * Apply a finding's fix through the endpoint a person would have used by hand: the deck save (then
 * its publish, when the deck already has slides on screens), the widget save, the content save. So
 * review, drafts, corporate locks and history apply exactly as they would to a manual edit.
 * @returns {Promise<string>} a sentence to show
 */
export async function applyA11yFix(source, issue) {
  const fix = issue.fix || {};
  const where = issue.where || {};
  if (source.type === 'slide_deck') {
    const deck = await api.get(`/slide-decks/${encodeURIComponent(source.id)}`);
    const doc = deck.doc;
    const s = doc && doc.slides && doc.slides[where.slide_index];
    if (!s) throw new Error(t('a11y.fix.gone'));
    if (fix.kind === 'dim') s.template.background_dim = fix.dim;
    else if (!setElementStyle(s.template, where.element, fix)) throw new Error(t('a11y.fix.gone'));
    await api.put(`/slide-decks/${encodeURIComponent(source.id)}`, { doc });
    const live = deck.playlist_id || doc.slides.some((x) => x.widget_id);
    if (!live) return t('a11y.fix.saved');
    try {
      await api.post(`/slide-decks/${encodeURIComponent(source.id)}/publish`, {});
      return t('a11y.fix.published');
    } catch (e) {
      const reason = e && e.message ? e.message : '';
      return t('a11y.fix.saved_not_published', { reason });
    }
  }
  if (source.type === 'widget') {
    const w = await api.getWidget(source.id);
    let config = w && w.config;
    if (typeof config === 'string') { try { config = JSON.parse(config || '{}'); } catch { config = {}; } }
    config = config || {};
    if (w.widget_type === 'slide') {
      if (fix.kind === 'dim') { config.template = config.template || {}; config.template.background_dim = fix.dim; }
      else if (!setElementStyle(config.template, where.element, fix)) throw new Error(t('a11y.fix.gone'));
    } else if (where.key && fix.color) {
      config[where.key] = fix.color;
    } else throw new Error(t('a11y.fix.gone'));
    const r = await api.put(`/widgets/${encodeURIComponent(source.id)}`, { config });
    return t(r && (r.pending_review || r.draft) ? 'a11y.fix.review' : 'a11y.fix.saved_live');
  }
  if (source.type === 'content' && fix.kind === 'youtube_captions') {
    const r = await api.updateContent(source.id, { captions_enabled: true });
    return t(r && r.pending_review ? 'a11y.fix.review' : 'a11y.fix.saved_live');
  }
  throw new Error(t('a11y.fix.gone'));
}

/** Where to edit a source by hand. */
export function a11yEditHref(source) {
  if (source.type === 'slide_deck') return `#/slides?deck=${encodeURIComponent(source.id)}`;
  if (source.type === 'widget') return '#/widgets';
  if (source.type === 'content') return `#/content?open=${encodeURIComponent(source.id)}`;
  return '#/accessibility';
}

/* ---------------------------------------------------------------- badges */

const TTL_MS = 60 * 1000;
let cached = null;
let cachedAt = 0;
let inflight = null;
let observer = null;
let timer = null;

export async function loadA11yBadges({ fresh = false } = {}) {
  if (!fresh && cached && Date.now() - cachedAt < TTL_MS) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const r = await api.getAccessibilityBadges();
      cached = r && !Array.isArray(r) && typeof r === 'object' ? r : { content: {}, widgets: {}, decks: {}, playlists: {} };
    } catch {
      cached = { content: {}, widgets: {}, decks: {}, playlists: {} };
    }
    cachedAt = Date.now();
    inflight = null;
    return cached;
  })();
  return inflight;
}

export function invalidateA11yBadges() { cached = null; cachedAt = 0; }

export function a11yBadgeHtml(entry) {
  if (!entry || !(entry.errors || entry.warnings)) return '';
  const bad = entry.errors > 0;
  const label = bad ? tn('a11y.badge.errors', entry.errors) : tn('a11y.badge.warnings', entry.warnings);
  return `<a class="a11y-badge ${bad ? 'a11y-badge-error' : 'a11y-badge-warning'}" href="#/accessibility" title="${esc(label)}">${esc(t(bad ? 'a11y.badge.short_error' : 'a11y.badge.short_warning'))}</a>`;
}

const TARGETS = [
  { sel: '.lib-card[data-id]', id: (el) => el.dataset.id, kind: 'content', into: (el) => el.querySelector('.lib-card-meta') },
  { sel: '.lib-row[data-id]', id: (el) => el.dataset.id, kind: 'content', into: (el) => el.querySelector('.lib-col-name') },
  { sel: 'a.playlist-card[href^="#/playlists/"]', id: (el) => decodeURIComponent((el.getAttribute('href') || '').slice('#/playlists/'.length)), kind: 'playlists', into: (el) => el.firstElementChild, after: true },
  { sel: '[data-deck-row]', id: (el) => el.dataset.deckRow, kind: 'decks', into: (el) => el.querySelector('[data-deck-name]') },
];

export async function decorateA11y(root = document) {
  if (!root || !root.querySelector) return;
  if (!TARGETS.some((tg) => root.querySelector(`${tg.sel}:not([data-a11y])`))) return;
  const badges = await loadA11yBadges();
  for (const tg of TARGETS) {
    root.querySelectorAll(`${tg.sel}:not([data-a11y])`).forEach((el) => {
      el.setAttribute('data-a11y', '1');
      const html = a11yBadgeHtml((badges[tg.kind] || {})[tg.id(el)]);
      const host = tg.into(el);
      if (!html || !host) return;
      const span = document.createElement('span');
      span.className = tg.after ? 'a11y-badges a11y-badges-row' : 'a11y-badges';
      span.innerHTML = html;
      // The badge is a link to the report; inside a clickable card it must not also open the card.
      span.addEventListener('click', (e) => e.stopPropagation());
      if (tg.after) host.insertAdjacentElement('afterend', span);
      else host.appendChild(span);
    });
  }
}

/** Watch the app container and badge cards as views draw them (Advanced view only). */
export function installA11yBadges(container) {
  if (observer || !container || typeof MutationObserver !== 'function') return;
  observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (isSimpleMode() || !localStorage.getItem('token')) return;
      decorateA11y(container).catch(() => {});
    }, 200);
  });
  observer.observe(container, { childList: true, subtree: true });
}
