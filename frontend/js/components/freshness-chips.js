/*
 * 3.0 content freshness: the "Stale" / "Mentions a past date" chips on screen cards, playlist cards
 * and content library items (server: lib/freshness.js chipsFrom, GET /api/freshness/chips).
 *
 * ⚠️ DECORATION, NOT RENDERING. The three views own their markup and re-render it often (search,
 * paging, a socket update). Rather than thread freshness through each template, one observer on the
 * app container notices cards as they appear and appends the chips to them. A view that never
 * learns about freshness keeps working exactly as before, and a failed or empty chips fetch simply
 * leaves the cards bare.
 *
 * Every word is translated here from the structured reason the server sends (code, date, days...);
 * values from the server reach the DOM through esc() only.
 */
import { api } from '../api.js';
import { t, tn } from '../i18n.js';
import { esc } from '../utils.js';
import { isSimpleMode } from './ui-mode.js';

const TTL_MS = 60 * 1000;
let cached = null;
let cachedAt = 0;
let inflight = null;
let observer = null;
let timer = null;

/** The chips map, cached for a minute. Never throws: no data means no chips. */
export async function loadFreshnessChips({ fresh = false } = {}) {
  if (!fresh && cached && Date.now() - cachedAt < TTL_MS) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const r = await api.getFreshnessChips();
      // A remote org (api.js remoteRoute) answers [] for routes it cannot read: no chips.
      cached = r && !Array.isArray(r) && typeof r === 'object' ? r : { devices: {}, playlists: {}, content: {}, widgets: {} };
    } catch (_) {
      cached = { devices: {}, playlists: {}, content: {}, widgets: {} };
    }
    cachedAt = Date.now();
    inflight = null;
    return cached;
  })();
  return inflight;
}

/** Forget the cache (after a snooze, an expiry, a settings change). */
export function invalidateFreshnessChips() { cached = null; cachedAt = 0; }

/** One reason, as a sentence in the viewer's language. */
export function freshnessWhy(r) {
  if (!r) return '';
  switch (r.code) {
    case 'past_date':
      if (r.count) return tn('fresh.why.past_date_count', r.count);
      return r.inferred
        ? t('fresh.why.past_date_inferred', { match: r.match || '', date: r.date || '', changed: r.changed || '' })
        : t('fresh.why.past_date', { match: r.match || '', date: r.date || '' });
    case 'out_of_season': return t('fresh.why.out_of_season', { holiday: r.holiday || '' });
    case 'expired_assigned':
      return r.count ? tn('fresh.why.expired_count', r.count) : t('fresh.why.expired', { date: r.date || '' });
    case 'stale':
    case 'very_stale':
      if (r.basis === 'plays') return t('fresh.why.screen_plays', { n: r.days, window: r.window, mark: r.mark });
      if (r.basis === 'assigned' || r.basis === 'playlist') return t('fresh.why.screen_assigned', { n: r.days, mark: r.mark });
      return tn('fresh.why.unchanged', r.days || 0);
    default: return '';
  }
}

const LABEL = {
  stale: 'fresh.chip.stale', very_stale: 'fresh.chip.very_stale', past_date: 'fresh.chip.past_date',
  out_of_season: 'fresh.chip.out_of_season', expired_assigned: 'fresh.chip.expired',
};

/** Chip markup for one entry ({ status, reasons }), one chip per reason. */
export function freshnessChipsHtml(entry) {
  if (!entry || !Array.isArray(entry.reasons)) return '';
  return entry.reasons.filter((r) => LABEL[r.code]).map((r) => `<span class="fresh-chip fresh-chip-${esc(r.code)}" title="${esc(freshnessWhy(r))}">${esc(t(LABEL[r.code]))}</span>`).join('');
}

/*
 * The cards each view draws, and where on them the chips go. Matched by the attributes the views
 * already put there, so nothing in those templates had to change.
 */
const TARGETS = [
  { sel: '.device-card[data-device-id]', id: (el) => el.dataset.deviceId, kind: 'devices', into: (el) => el.querySelector('.device-card-name') },
  // Below the playlist card's header row, not inside it: the name shares that row with its badges
  // and would be squeezed onto two lines.
  { sel: 'a.playlist-card[href^="#/playlists/"]', id: (el) => decodeURIComponent((el.getAttribute('href') || '').slice('#/playlists/'.length)), kind: 'playlists', into: (el) => el.firstElementChild, after: true },
  { sel: '.lib-card[data-id]', id: (el) => el.dataset.id, kind: 'content', into: (el) => el.querySelector('.lib-card-meta') },
  { sel: '.lib-row[data-id]', id: (el) => el.dataset.id, kind: 'content', into: (el) => el.querySelector('.lib-col-name') },
];

/** Append chips to every not-yet-decorated card under `root`. */
export async function decorateFreshness(root = document) {
  if (!root || !root.querySelector) return;
  if (!TARGETS.some((tg) => root.querySelector(`${tg.sel}:not([data-fresh])`))) return;
  const chips = await loadFreshnessChips();
  for (const tg of TARGETS) {
    root.querySelectorAll(`${tg.sel}:not([data-fresh])`).forEach((el) => {
      el.setAttribute('data-fresh', '1');
      const entry = (chips[tg.kind] || {})[tg.id(el)];
      const html = freshnessChipsHtml(entry);
      const host = tg.into(el);
      if (!html || !host) return;
      const span = document.createElement('span');
      span.className = tg.after ? 'fresh-chips fresh-chips-row' : 'fresh-chips';
      span.innerHTML = html;
      // A chip inside a clickable card must not swallow the card's click: it is a span with a
      // title (the reason), nothing more.
      if (tg.after) host.insertAdjacentElement('afterend', span);
      else host.appendChild(span);
    });
  }
}

/**
 * Watch the app container and decorate cards as views draw them. Advanced view only: the Simple
 * view has its own, gentler line (views/simple-home.js).
 */
export function installFreshnessChips(container) {
  if (observer || !container || typeof MutationObserver !== 'function') return;
  observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (isSimpleMode() || !localStorage.getItem('token')) return;
      decorateFreshness(container).catch(() => {});
    }, 150);
  });
  observer.observe(container, { childList: true, subtree: true });
}
