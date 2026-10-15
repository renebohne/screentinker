/*
 * 3.0 Free stock photos and videos: one picker, used by the Simple view (Change and Upload), the
 * setup guide's upload step, and the content library's Add content dialog.
 *
 * The server does everything that needs the provider key (server/routes/stock-media.js): this only
 * searches through it, shows the results with the credit the provider's API guidelines ask for
 * ("Photos provided by Pexels", "Photo by <name> on Pexels"), and asks the server to add the chosen
 * items to the library. What comes back are ordinary library items, handed to onAdded.
 *
 * Hidden entirely when stock is off or the person cannot add (view-only). A platform admin gets one
 * line saying where to add a key instead; nobody else is told keys exist.
 *
 * Every value from a provider reaches the page through esc() or textContent.
 */
import { api } from '../api.js';
import { t, tn } from '../i18n.js';
import { esc, inManagerApp, isPlatformAdmin } from '../utils.js';

// Quick searches: the English term goes to the provider (their catalogues are tagged in English),
// the label is shown in the viewer's language.
const QUICK = [
  ['coffee', 'stock.quick.coffee'], ['food', 'stock.quick.food'], ['retail store', 'stock.quick.retail'],
  ['office', 'stock.quick.office'], ['nature', 'stock.quick.nature'], ['abstract background', 'stock.quick.abstract'],
  ['city', 'stock.quick.city'], ['fitness', 'stock.quick.fitness'], ['restaurant', 'stock.quick.restaurant'],
  ['healthcare', 'stock.quick.health'], ['holiday', 'stock.quick.holiday'], ['texture', 'stock.quick.texture'],
];

let uidSeq = 0;
let statusPromise = null;
let statusAt = 0;
/** What the server says about stock, asked at most once a minute per page. Never rejects. */
export function stockStatus() {
  if (!statusPromise || Date.now() - statusAt > 60000) {
    statusAt = Date.now();
    statusPromise = api.stockStatus().then((s) => (s && typeof s === 'object' && !Array.isArray(s) ? s : { enabled: false }))
      .catch(() => ({ enabled: false }));
  }
  return statusPromise;
}

function cachedUser() { try { return JSON.parse(localStorage.getItem('user') || 'null'); } catch { return null; } }

/** "Photo by Ana on Pexels" for a library item that came from a stock provider, or ''. */
export function creditLine(c) {
  let a = null;
  try { a = c && c.attribution ? (typeof c.attribution === 'string' ? JSON.parse(c.attribution) : c.attribution) : null; } catch { a = null; }
  if (!a || !a.provider_name) return '';
  return a.author
    ? t(a.type === 'video' ? 'stock.credit_video' : 'stock.credit_photo', { author: a.author, provider: a.provider_name })
    : t('stock.credit_provider', { provider: a.provider_name });
}

/*
 * Links to the provider and the photographer leave the dashboard. In the Manager app a plain
 * target=_blank would open inside the WebView, with no way back; the app's bridge opens them in
 * the phone's browser instead.
 */
function wireExternalLinks(root) {
  root.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-ext]');
    if (!a) return;
    const bridge = window.STManager;
    if (inManagerApp() && bridge && typeof bridge.openInBrowser === 'function') {
      e.preventDefault();
      bridge.openInBrowser(a.href);
    }
  });
}

/**
 * Mount the picker in `host`. Resolves false when there is nothing to show (host stays hidden).
 *   types        ['photo'] or ['photo', 'video'] (a toggle when both)
 *   collapsed    start as one "Free photos" button that opens the search (Simple view)
 *   addLabel     (n) => button text for n selected
 *   folderId     where added items go (library root when null)
 *   onAdded(rows)  the library items created, in the order picked
 */
export async function mountStockPicker(host, opts = {}) {
  if (!host) return false;
  host.hidden = true;
  const s = await stockStatus();
  if (!document.contains(host)) return false;
  if (!s.enabled || !s.can_add) {
    if (s.setup_hint && isPlatformAdmin(cachedUser())) {
      host.innerHTML = `<p class="stock-hint">${esc(t('stock.setup_hint'))} <a href="#/platform/system">${esc(t('stock.setup_link'))}</a></p>`;
      host.hidden = false;
    }
    return false;
  }

  const types = (opts.types || ['photo']).filter((x) => x === 'photo' || x === 'video');
  const providers = s.providers || [];
  const state = {
    type: types[0] || 'photo',
    provider: providers[0] ? providers[0].id : '',
    orientation: '',
    q: '', page: 1, items: [], hasMore: false, attribution: null,
    picked: [],          // keys "type:id", in the order picked
    byKey: new Map(),    // key -> item
    added: new Map(),    // key -> library row, so a retry after a failure does not add twice
    busy: false,
  };
  const keyOf = (it) => `${it.provider}:${it.type}:${it.id}`;
  const uid = ++uidSeq;
  const addLabel = opts.addLabel || ((n) => (n ? tn('stock.add_n', n) : t('stock.add')));

  host.hidden = false;
  host.classList.add('stock-host');
  if (opts.collapsed) {
    host.innerHTML = `<button type="button" class="stock-open" data-stock-open aria-expanded="false">
      <span class="stock-open-icon" aria-hidden="true">&#128444;</span>
      <span><strong>${esc(t(types.includes('video') ? 'stock.open_title_media' : 'stock.open_title'))}</strong><small>${esc(t('stock.open_desc'))}</small></span>
    </button>`;
    host.querySelector('[data-stock-open]').addEventListener('click', () => { renderShell(); host.querySelector('[data-stock-q]')?.focus(); });
  } else {
    renderShell();
  }
  wireExternalLinks(host);
  return true;

  function renderShell() {
    host.innerHTML = `
      <div class="stock-picker">
        <div class="stock-bar">
          ${types.length > 1 ? `<div class="stock-toggle" role="radiogroup" aria-label="${esc(t('stock.type_label'))}">
            ${types.map((ty) => `<button type="button" role="radio" data-stock-type="${ty}" aria-checked="${ty === state.type}">${esc(t(ty === 'video' ? 'stock.type_video' : 'stock.type_photo'))}</button>`).join('')}
          </div>` : ''}
          ${providers.length > 1 ? `<label class="stock-select"><span class="stock-vh">${esc(t('stock.provider_label'))}</span>
            <select class="input" data-stock-provider>${providers.map((p) => `<option value="${esc(p.id)}" ${p.id === state.provider ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>` : ''}
          ${opts.orientation ? `<label class="stock-select"><span class="stock-vh">${esc(t('stock.orientation_label'))}</span>
            <select class="input" data-stock-orient>
              <option value="">${esc(t('stock.orientation_any'))}</option>
              <option value="landscape">${esc(t('stock.orientation_landscape'))}</option>
              <option value="portrait">${esc(t('stock.orientation_portrait'))}</option>
            </select></label>` : ''}
        </div>
        <form class="stock-search" data-stock-form role="search">
          <label class="stock-vh" for="stockQ-${uid}">${esc(t('stock.search_label'))}</label>
          <input id="stockQ-${uid}" class="input" type="search" data-stock-q maxlength="100" enterkeyhint="search" placeholder="${esc(t(state.type === 'video' ? 'stock.search_ph_video' : 'stock.search_ph'))}" autocomplete="off">
          <button type="submit" class="btn btn-primary">${esc(t('stock.search'))}</button>
        </form>
        <div class="stock-quick" aria-label="${esc(t('stock.quick_label'))}">
          ${QUICK.map(([q, key]) => `<button type="button" class="stock-chip" data-stock-quick="${esc(q)}">${esc(t(key))}</button>`).join('')}
        </div>
        <div class="stock-results" data-stock-results aria-live="polite"></div>
        <div class="stock-foot">
          <a class="stock-attrib" data-stock-attrib data-ext target="_blank" rel="noopener noreferrer" hidden></a>
          <button type="button" class="btn btn-primary" data-stock-add disabled>${esc(addLabel(0))}</button>
        </div>
        <p class="stock-status" data-stock-status role="status"></p>
      </div>`;
    const form = host.querySelector('[data-stock-form]');
    const qInput = host.querySelector('[data-stock-q]');
    form.addEventListener('submit', (e) => { e.preventDefault(); runSearch(qInput.value, 1); });
    host.querySelectorAll('[data-stock-quick]').forEach((b) => b.addEventListener('click', () => {
      qInput.value = b.textContent;
      runSearch(b.dataset.stockQuick, 1);
    }));
    host.querySelectorAll('[data-stock-type]').forEach((b) => b.addEventListener('click', () => {
      if (state.type === b.dataset.stockType || state.busy) return;
      state.type = b.dataset.stockType;
      host.querySelectorAll('[data-stock-type]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
      qInput.placeholder = t(state.type === 'video' ? 'stock.search_ph_video' : 'stock.search_ph');
      if (state.q) runSearch(state.q, 1);
    }));
    host.querySelector('[data-stock-provider]')?.addEventListener('change', (e) => { state.provider = e.target.value; if (state.q) runSearch(state.q, 1); });
    host.querySelector('[data-stock-orient]')?.addEventListener('change', (e) => { state.orientation = e.target.value; if (state.q) runSearch(state.q, 1); });
    host.querySelector('[data-stock-results]').addEventListener('click', onResultClick);
    host.querySelector('[data-stock-add]').addEventListener('click', addPicked);
    paintFoot();
  }

  function setStatus(msg) { const el = host.querySelector('[data-stock-status]'); if (el) el.textContent = msg || ''; }

  async function runSearch(q, page) {
    q = String(q || '').trim();
    if (!q || state.busy) return;
    const results = host.querySelector('[data-stock-results]');
    state.busy = true;
    if (page === 1) results.innerHTML = `<p class="stock-muted">${esc(t('stock.searching'))}</p>`;
    setStatus('');
    try {
      const r = await api.stockSearch({ provider: state.provider, type: state.type, q, page, orientation: state.orientation });
      if (!document.contains(results)) return;
      state.q = q; state.page = r.page || page; state.hasMore = !!r.has_more; state.attribution = r.attribution || null;
      const fresh = Array.isArray(r.items) ? r.items : [];
      state.items = page === 1 ? fresh : state.items.concat(fresh.filter((it) => !state.byKey.has(keyOf(it))));
      for (const it of fresh) state.byKey.set(keyOf(it), it);
      renderResults();
    } catch (err) {
      if (page === 1) results.innerHTML = '';
      setStatus(err.message || t('stock.search_failed'));
    } finally { state.busy = false; }
  }

  function tileHtml(it) {
    const k = keyOf(it);
    const on = state.picked.includes(k);
    const by = it.author ? t(it.type === 'video' ? 'stock.credit_video' : 'stock.credit_photo', { author: it.author, provider: providerName(it.provider) }) : providerName(it.provider);
    return `<div class="stock-tile" role="listitem">
      <button type="button" class="stock-item" data-stock-key="${esc(k)}" aria-pressed="${on}" aria-label="${esc(it.title || by)}" ${it.color ? `style="background-color:${esc(it.color)}"` : ''}>
        ${it.thumb ? `<img src="${esc(it.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}
        ${it.type === 'video' && it.duration ? `<span class="stock-dur">${esc(fmtDur(it.duration))}</span>` : ''}
        <span class="stock-check" aria-hidden="true">&#10003;</span>
      </button>
      ${it.page_url ? `<a class="stock-credit" href="${esc(it.page_url)}" data-ext target="_blank" rel="noopener noreferrer" title="${esc(by)}">${esc(by)}</a>`
        : `<span class="stock-credit">${esc(by)}</span>`}
    </div>`;
  }

  function renderResults() {
    const results = host.querySelector('[data-stock-results]');
    if (!state.items.length) {
      results.innerHTML = `<p class="stock-muted">${esc(t('stock.no_results', { q: state.q }))}</p>`;
    } else {
      results.innerHTML = `<div class="stock-grid" role="list">${state.items.map(tileHtml).join('')}</div>
        ${state.hasMore ? `<div class="stock-more"><button type="button" class="btn btn-secondary btn-sm" data-stock-more>${esc(t('stock.more'))}</button></div>` : ''}`;
      results.querySelector('[data-stock-more]')?.addEventListener('click', () => runSearch(state.q, state.page + 1));
    }
    paintFoot();
  }

  function onResultClick(e) {
    const b = e.target.closest('[data-stock-key]');
    if (!b || state.busy) return;
    const k = b.dataset.stockKey;
    const i = state.picked.indexOf(k);
    // The order picked is the order they are added (and so the order they play in).
    if (i === -1) state.picked.push(k); else state.picked.splice(i, 1);
    b.setAttribute('aria-pressed', String(i === -1));
    paintFoot();
  }

  function providerName(id) { const p = providers.find((x) => x.id === id); return p ? p.name : id; }

  function paintFoot() {
    const btn = host.querySelector('[data-stock-add]');
    if (btn) { btn.disabled = state.busy || !state.picked.length; btn.textContent = addLabel(state.picked.length); }
    const a = host.querySelector('[data-stock-attrib]');
    if (a) {
      const attr = state.attribution || (providers.find((p) => p.id === state.provider) ? { text: t('stock.provided_by', { provider: providerName(state.provider) }), url: providers.find((p) => p.id === state.provider).home } : null);
      if (attr && attr.url) { a.textContent = attr.text; a.href = attr.url; a.hidden = false; } else a.hidden = true;
    }
  }

  async function addPicked() {
    if (state.busy || !state.picked.length) return;
    state.busy = true;
    paintFoot();
    const keys = state.picked.slice();
    const rows = [];
    try {
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        setStatus(t('stock.adding', { n: i + 1, total: keys.length }));
        if (!state.added.has(k)) {
          const it = state.byKey.get(k);
          const row = await api.stockImport({ provider: it.provider, type: it.type, id: it.id, folderId: opts.folderId || null });
          state.added.set(k, row);
        }
        rows.push(state.added.get(k));
      }
    } catch (err) {
      state.busy = false;
      paintFoot();
      // A plan-limit prompt may already have explained it; do not say it twice.
      setStatus(err && err.planPromptShown ? '' : ((err && err.message) || t('stock.add_failed')));
      return;
    }
    setStatus('');
    state.busy = false;
    state.picked = [];
    host.querySelectorAll('[data-stock-key]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
    paintFoot();
    if (opts.onAdded) await opts.onAdded(rows);
  }
}

function fmtDur(sec) {
  const s = Math.round(Number(sec) || 0);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
