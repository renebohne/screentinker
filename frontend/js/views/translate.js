/*
 * 3.0 Auto-translate (docs/private-ai.md) — #/translate[?deck=<id>], reached from Slides.
 *
 * Translate a sign or deck's words into other languages with the workspace's AI (local or cloud),
 * review every string next to its original, approve, then choose per screen: one language, or
 * rotate through them (each translated slide follows its original, so languages alternate).
 *
 * ⚠️ NOTHING REACHES A SCREEN UNTIL "APPROVE". Translating writes a draft; an edit makes it a draft
 * again; screens keep the last approved words until then (server: lib/sign-translate.js).
 *
 * Every server value — deck names, original text, translations — reaches the page via esc() or
 * .value only. Translations are written by a model and are untrusted text like any other.
 */
import { api } from '../api.js';
import { t, tn } from '../i18n.js';
import { esc } from '../utils.js';
import { showToast } from '../components/toast.js';
import { getPrivateAiStatus, privateBadge, notConfiguredHtml, wireOpenSettings } from '../components/private-ai.js';

const COMMON_LANGS = ['en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'pl', 'uk', 'ro', 'tr', 'ar', 'ur', 'hi', 'bn', 'pa', 'zh', 'ja', 'ko', 'vi', 'cy', 'ga', 'so', 'ti'];
const NOTE_KEYS = { kept_original: 'translate.note.kept_original', numbers_changed: 'translate.note.numbers_changed', lines_changed: 'translate.note.lines_changed' };
let alive = 0;

function langLabel(code) {
  try {
    const n = new Intl.DisplayNames([document.documentElement.lang || navigator.language || 'en'], { type: 'language' }).of(code);
    return n && n !== code ? `${n} (${code})` : code;
  } catch { return code; }
}

export async function render(container, hash = window.location.hash || '') {
  const run = ++alive;
  const q = new URLSearchParams(hash.split('?')[1] || '');
  const deckId = q.get('deck');
  container.innerHTML = `<div class="page-header"><div><h1>${esc(t('translate.title'))}</h1>
      <div class="subtitle">${esc(t('translate.subtitle'))}</div></div>
      <div class="translate-head-actions"><span data-badge></span><a class="btn btn-secondary" href="#/slides">${esc(t('translate.back_slides'))}</a></div></div>
    <div data-off></div>
    <div data-review></div>
    <h2 class="translate-h2">${esc(t('translate.decks'))}</h2>
    <div class="settings-section" data-decks><p class="simple-muted">${esc(t('common.loading'))}</p></div>
    <h2 class="translate-h2">${esc(t('translate.screens'))}</h2>
    <p class="simple-muted">${esc(t('translate.screens_hint'))}</p>
    <div class="settings-section" data-screens><p class="simple-muted">${esc(t('common.loading'))}</p></div>`;

  const st = await getPrivateAiStatus(true);
  if (run !== alive) return;
  container.querySelector('[data-badge]').innerHTML = privateBadge(st);
  const canEdit = !!st.can_use;
  if (!st.configured) {
    container.querySelector('[data-off]').innerHTML = `<div class="settings-section">${notConfiguredHtml(st)}</div>`;
    wireOpenSettings(container, () => render(container, hash));
  }

  let decks = [];
  let translations = [];
  try {
    [decks, translations] = await Promise.all([
      api.get('/slide-decks'),
      api.aiTranslations().then((r) => (r && r.translations) || []),
    ]);
  } catch (err) {
    container.querySelector('[data-decks]').innerHTML = `<p class="simple-status">${esc((err && err.message) || t('translate.load_failed'))}</p>`;
    return;
  }
  if (run !== alive) return;

  drawDecks();
  drawScreens();
  if (deckId && decks.some((d) => d.id === deckId)) drawReview(deckId);

  function drawDecks() {
    const host = container.querySelector('[data-decks]');
    if (!decks.length) { host.innerHTML = `<p class="simple-muted">${esc(t('translate.no_decks'))}</p>`; return; }
    host.innerHTML = decks.map((d) => {
      const mine = translations.filter((x) => x.deck_id === d.id);
      return `<div class="translate-deck">
        <div class="translate-deck-main"><strong>${esc(d.name)}</strong>
          <div class="translate-chips">${mine.map((x) => `<span class="translate-chip ${x.status === 'approved' ? 'is-on' : ''}">${esc(x.lang)} · ${esc(t(x.status === 'approved' ? 'translate.status.approved' : 'translate.status.draft'))}${x.stale ? ` · ${esc(t('translate.stale_short'))}` : ''}</span>`).join('') || `<span class="simple-muted">${esc(t('translate.none_yet'))}</span>`}</div></div>
        ${mine.length ? `<a class="btn btn-secondary btn-sm" href="#/translate?deck=${encodeURIComponent(d.id)}">${esc(t('translate.review'))}</a>` : ''}
        ${canEdit && st.configured ? `<button type="button" class="btn btn-primary btn-sm" data-translate="${esc(d.id)}">${esc(t('translate.translate_btn'))}</button>` : ''}
      </div>`;
    }).join('');
    host.querySelectorAll('[data-translate]').forEach((b) => b.addEventListener('click', () => openTranslate(b.dataset.translate)));
  }

  function openTranslate(id) {
    const deck = decks.find((d) => d.id === id);
    const have = new Set(translations.filter((x) => x.deck_id === id).map((x) => x.lang));
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.display = 'flex';
    overlay.innerHTML = `<div class="modal" style="max-width:560px;width:95vw">
      <div class="modal-header"><h3>${esc(t('translate.dialog_title', { name: deck ? deck.name : '' }))}</h3></div>
      <div class="modal-body">
        <p class="simple-muted">${esc(t('translate.dialog_lead'))}</p>
        <div class="translate-langs">${COMMON_LANGS.map((c) => `<label><input type="checkbox" value="${esc(c)}" ${have.has(c) ? 'checked' : ''}> ${esc(langLabel(c))}</label>`).join('')}</div>
        <label class="simple-label" for="trOther">${esc(t('translate.other_code'))}</label>
        <input id="trOther" class="input" maxlength="12" placeholder="pt-BR" autocomplete="off" spellcheck="false">
        <div data-badge>${privateBadge(st)}</div>
        <p class="simple-muted">${esc(t(st.kind === 'local' ? 'ai_setup.slow_local' : 'ai_setup.privacy_cloud'))}</p>
        <p class="simple-status" data-status role="status"></p>
      </div>
      <div class="modal-footer"><button class="btn btn-secondary" data-close>${esc(t('common.cancel'))}</button>
        <button class="btn btn-primary" data-go>${esc(t('translate.translate_btn'))}</button></div></div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('[data-close]').onclick = close;
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
    overlay.querySelector('[data-go]').onclick = async (e) => {
      const langs = [...overlay.querySelectorAll('.translate-langs input:checked')].map((i) => i.value);
      const other = overlay.querySelector('#trOther').value.trim();
      if (other) langs.push(other);
      const status = overlay.querySelector('[data-status]');
      if (!langs.length) { status.textContent = t('translate.pick_lang'); return; }
      e.target.disabled = true;
      status.textContent = t('translate.working');
      try {
        const r = await api.aiTranslate(id, langs);
        const failed = (r.translations || []).filter((x) => x.error);
        close();
        if (failed.length) showToast(t('translate.some_failed', { langs: failed.map((x) => x.lang).join(', ') }), 'error');
        window.location.hash = `#/translate?deck=${encodeURIComponent(id)}`;
        if (window.location.hash === hash) render(container, hash);
      } catch (err) {
        e.target.disabled = false;
        status.textContent = (err && err.message) || t('translate.failed');
      }
    };
  }

  async function drawReview(id) {
    const host = container.querySelector('[data-review]');
    const deck = decks.find((d) => d.id === id);
    let list = [];
    try { list = ((await api.aiTranslations(id)) || {}).translations || []; } catch { list = []; }
    if (run !== alive) return;
    if (!list.length) { host.innerHTML = ''; return; }
    host.innerHTML = `<div class="settings-section translate-review">
      <h2 class="translate-h2">${esc(t('translate.review_title', { name: deck ? deck.name : '' }))}</h2>
      <p class="simple-muted">${esc(t('translate.review_lead'))}</p>
      ${list.map((x) => `
        <section class="translate-lang" data-tid="${esc(x.id)}">
          <h3>${esc(langLabel(x.lang))} <span class="translate-chip ${x.status === 'approved' ? 'is-on' : ''}">${esc(t(x.status === 'approved' ? 'translate.status.approved' : 'translate.status.draft'))}</span></h3>
          ${x.stale ? `<p class="translate-warn">${esc(t('translate.stale'))}</p>` : ''}
          ${x.unpublished ? `<p class="translate-warn">${esc(t('translate.unpublished'))}</p>` : ''}
          <table class="translate-table"><thead><tr><th>${esc(t('translate.original'))}</th><th>${esc(t('translate.translation'))}</th></tr></thead><tbody>
            ${x.strings.map((s, i) => `<tr>
              <td class="translate-src">${esc(s.source)}</td>
              <td><textarea class="input" rows="${Math.min(4, s.source.split('\n').length + (s.source.length > 60 ? 1 : 0))}" data-i="${i}" ${canEdit ? '' : 'readonly'}>${esc(s.text)}</textarea>
                ${s.note ? `<small class="translate-warn">${esc(s.note.split(',').map((n) => t(NOTE_KEYS[n] || 'translate.note.check')).join(' · '))}</small>` : ''}</td></tr>`).join('')}
          </tbody></table>
          ${canEdit ? `<div class="translate-actions">
            <button type="button" class="btn btn-secondary btn-sm" data-save>${esc(t('translate.save'))}</button>
            <button type="button" class="btn btn-primary btn-sm" data-approve>${esc(t(x.status === 'approved' ? 'translate.approved_btn' : 'translate.approve'))}</button>
            <button type="button" class="btn btn-secondary btn-sm" data-delete>${esc(t('translate.delete'))}</button>
            <span class="simple-status" data-status role="status"></span></div>` : ''}
        </section>`).join('')}
    </div>`;
    host.querySelectorAll('[data-tid]').forEach((sec) => {
      const x = list.find((y) => y.id === sec.dataset.tid);
      const status = sec.querySelector('[data-status]');
      const edits = () => [...sec.querySelectorAll('textarea[data-i]')].map((ta) => {
        const s = x.strings[Number(ta.dataset.i)];
        return { slide_id: s.slide_id, slot: s.slot, text: ta.value };
      });
      const changed = () => edits().some((e, i) => e.text !== x.strings[i].text);
      sec.querySelector('[data-save]')?.addEventListener('click', async () => {
        try { await api.aiTranslationSave(x.id, edits()); showToast(t('translate.saved'), 'success'); drawReview(id); refresh(); }
        catch (err) { status.textContent = (err && err.message) || t('translate.failed'); }
      });
      sec.querySelector('[data-approve]')?.addEventListener('click', async () => {
        try {
          if (changed()) await api.aiTranslationSave(x.id, edits());
          await api.aiTranslationApprove(x.id);
          showToast(t('translate.approved_toast', { lang: langLabel(x.lang) }), 'success');
          drawReview(id); refresh();
        } catch (err) { status.textContent = (err && err.message) || t('translate.failed'); }
      });
      sec.querySelector('[data-delete]')?.addEventListener('click', async () => {
        if (!confirm(t('translate.delete_confirm', { lang: langLabel(x.lang) }))) return;   // eslint-disable-line no-alert
        try { await api.aiTranslationDelete(x.id); drawReview(id); refresh(); }
        catch (err) { status.textContent = (err && err.message) || t('translate.failed'); }
      });
    });
  }

  async function refresh() {
    try { translations = ((await api.aiTranslations()) || {}).translations || []; } catch { return; }
    if (run !== alive) return;
    drawDecks();
    drawScreens();
  }

  async function drawScreens() {
    const host = container.querySelector('[data-screens]');
    let r;
    try { r = await api.aiScreenLanguages(); } catch (err) { host.innerHTML = `<p class="simple-status">${esc((err && err.message) || '')}</p>`; return; }
    if (run !== alive) return;
    const langs = r.languages || [];
    if (!r.screens || !r.screens.length) { host.innerHTML = `<p class="simple-muted">${esc(t('translate.no_screens'))}</p>`; return; }
    if (!langs.length) { host.innerHTML = `<p class="simple-muted">${esc(t('translate.no_approved'))}</p>`; return; }
    const valueOf = (s) => (s.mode === 'fixed' && s.langs[0] ? `fixed:${s.langs[0]}` : s.mode === 'rotate' ? 'rotate' : 'original');
    host.innerHTML = r.screens.map((s) => `<div class="translate-screen">
      <label for="sl_${esc(s.id)}">${esc(s.name)}</label>
      <select id="sl_${esc(s.id)}" class="input" data-screen="${esc(s.id)}" ${canEdit ? '' : 'disabled'}>
        <option value="original">${esc(t('translate.screen_original'))}</option>
        ${langs.map((l) => `<option value="fixed:${esc(l)}">${esc(langLabel(l))}</option>`).join('')}
        <option value="rotate">${esc(tn('translate.screen_rotate', langs.length))}</option>
      </select></div>`).join('');
    host.querySelectorAll('[data-screen]').forEach((sel) => {
      const s = r.screens.find((x) => x.id === sel.dataset.screen);
      sel.value = valueOf(s);
      sel.addEventListener('change', async () => {
        const v = sel.value;
        const body = v === 'rotate' ? ['rotate', langs] : v.startsWith('fixed:') ? ['fixed', [v.slice(6)]] : ['original', []];
        try { await api.aiSetScreenLanguage(s.id, body[0], body[1]); showToast(t('translate.screen_saved', { name: s.name }), 'success'); }
        catch (err) { sel.value = valueOf(s); showToast((err && err.message) || t('translate.failed'), 'error'); }
      });
    });
  }
}

export function cleanup() {
  alive++;
}
