/*
 * 3.0 "Set up my screens with AI" (docs/private-ai.md).
 *
 *   #/simple/ai-setup[?step=pick]   in Simple view (guide-style, simple-home.js shell)
 *   #/ai-setup[?step=pick]          in Advanced view (Slides → Set up with AI)
 *
 * One sentence about the place → the workspace's AI proposes 3–6 signs from the Make-a-sign
 * templates → the person ticks the ones they want → each opens in Make a sign's own fill step to be
 * read and edited → one screens step puts them all on screens (views/make-sign.js `batch`).
 *
 * ⚠️ THE AI WRITES WORDS INTO TEMPLATE FIELDS, NOTHING ELSE. The server checks every value against
 * the template's field schema (lib/ai-starter.js); previews are the slide renderer's own HTML in an
 * iframe with an empty sandbox, exactly as Make a sign shows them.
 *
 * With no AI set up the page explains that and, for an admin, opens AI settings — never an error.
 */
import { api } from '../api.js';
import { t, tn } from '../i18n.js';
import { esc } from '../utils.js';
import { shell, guideFrame, simpleCanChange } from './simple-home.js';
import { renderSign, cleanup as cleanupSign } from './make-sign.js';
import { getPrivateAiStatus, privateBadge, notConfiguredHtml, wireOpenSettings } from '../components/private-ai.js';

let alive = 0;
// The last suggestions, so Back from the first sign returns to the list instead of asking again.
let last = null;

export async function renderAiSetup(container, { simple = false, hash = '' } = {}) {
  const run = ++alive;
  const base = simple ? '#/simple/ai-setup' : '#/ai-setup';
  const home = simple ? '#/' : '#/slides';
  const paint = (inner) => {
    if (simple) shell(container, inner);
    else container.innerHTML = `<div class="sign-page">${inner}</div>`;
  };
  const frame = (o) => paint(guideFrame({ cancelHref: home, ...o }));

  if (!simpleCanChange()) {
    frame({ step: 0, total: 1, icon: '&#128065;', title: t('ai_setup.title'), back: false,
      body: `<p class="simple-lead">${esc(t('simple.home.viewer_note'))}</p>` });
    return;
  }
  paint(`<p class="simple-muted" style="text-align:center">${esc(t('common.loading'))}</p>`);
  const st = await getPrivateAiStatus(true);
  if (run !== alive) return;
  if (!st.configured) {
    frame({ step: 0, total: 1, icon: '&#10024;', title: t('ai_setup.title'), back: false, body: notConfiguredHtml(st) });
    wireOpenSettings(container, () => renderAiSetup(container, { simple, hash }));
    return;
  }

  const q = new URLSearchParams(String(hash).split('?')[1] || '');
  if (q.get('step') === 'pick' && last && last.workspace === currentWorkspaceId()) { pickStep(); return; }
  describeStep();

  // ---------------------------------------------------------------- 1. describe
  function describeStep(prev = '') {
    let aspect = (last && last.aspect) || '16:9';
    frame({ step: 0, total: 2, icon: '&#10024;', title: t('ai_setup.title'), back: false, next: true, nextLabel: t('ai_setup.suggest'),
      body: `
        <p class="simple-lead">${esc(t('ai_setup.lead'))}</p>
        <div data-badge>${privateBadge(st)}</div>
        <label class="simple-label" for="aiDescribe">${esc(t('ai_setup.describe_label'))}</label>
        <textarea id="aiDescribe" class="input sign-input" rows="3" maxlength="400" placeholder="${esc(t('ai_setup.describe_ph'))}">${esc(prev || (last && last.description) || '')}</textarea>
        <div class="sign-aspect" role="group" aria-label="${esc(t('signs.shape'))}">
          <button type="button" data-aspect-pick="16:9" aria-pressed="${aspect === '16:9'}"><span class="ico ico-land" aria-hidden="true"></span>${esc(t('signs.landscape'))}</button>
          <button type="button" data-aspect-pick="9:16" aria-pressed="${aspect === '9:16'}"><span class="ico ico-port" aria-hidden="true"></span>${esc(t('signs.portrait'))}</button>
        </div>
        <p class="simple-muted">${esc(t(st.kind === 'local' ? 'ai_setup.slow_local' : 'ai_setup.privacy_cloud'))}</p>
        <p class="simple-status" data-status role="status"></p>` });
    container.querySelectorAll('[data-aspect-pick]').forEach((b) => b.addEventListener('click', () => {
      aspect = b.dataset.aspectPick;
      container.querySelectorAll('[data-aspect-pick]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    }));
    const next = container.querySelector('[data-guide-next]');
    const status = container.querySelector('[data-status]');
    next.addEventListener('click', async () => {
      const description = container.querySelector('#aiDescribe').value.trim();
      if (!description) { status.textContent = t('ai_setup.need_description'); return; }
      next.disabled = true;
      status.textContent = t('ai_setup.thinking');
      try {
        const r = await api.aiStarterSet(description);
        if (run !== alive) return;
        last = { workspace: currentWorkspaceId(), description, aspect, proposals: r.proposals || [], picked: new Set((r.proposals || []).map((_, i) => i)) };
        pickStep();
      } catch (err) {
        if (run !== alive) return;
        next.disabled = false;
        status.textContent = (err && err.message) || t('ai_setup.failed');
      }
    });
  }

  // ---------------------------------------------------------------- 2. pick
  function pickStep() {
    const { proposals, picked, aspect } = last;
    let names = {};
    frame({ step: 1, total: 2, icon: '&#127991;&#65039;', title: t('ai_setup.pick_title'), next: true, nextLabel: t('ai_setup.check_each'), wide: true,
      body: `
        <p class="simple-lead">${esc(tn('ai_setup.pick_lead', proposals.length))}</p>
        <div class="sign-grid ${aspect === '9:16' ? 'is-portrait' : ''}">
          ${proposals.map((p, i) => `
            <label class="sign-card ai-setup-card">
              <span class="sign-frame" data-aspect="${esc(aspect)}"><iframe sandbox="" referrerpolicy="no-referrer" loading="lazy" tabindex="-1" data-prev="${i}"></iframe></span>
              <span class="ai-setup-pick"><input type="checkbox" data-pick="${i}" ${picked.has(i) ? 'checked' : ''}> <span data-name="${i}">${esc(p.template)}</span></span>
            </label>`).join('')}
        </div>
        <div data-badge>${privateBadge(st)}</div>
        <p class="simple-muted">${esc(t('ai_setup.pick_hint'))}</p>
        <p class="simple-status" data-status role="status"></p>` });
    container.querySelector('[data-guide-back]')?.addEventListener('click', () => describeStep(last.description));
    container.querySelectorAll('[data-pick]').forEach((c) => c.addEventListener('change', () => {
      const i = Number(c.dataset.pick);
      if (c.checked) picked.add(i); else picked.delete(i);
    }));
    container.querySelector('[data-guide-next]').addEventListener('click', () => {
      const batch = proposals.filter((_, i) => picked.has(i)).map((p) => ({ template: p.template, values: p.values }));
      if (!batch.length) { container.querySelector('[data-status]').textContent = t('ai_setup.pick_one'); return; }
      renderSign(container, { simple, batch, aspect, from: 'ai', onBack: () => renderAiSetup(container, { simple, hash: `${base}?step=pick` }) });
    });
    // Template names in the person's language, and live previews from the slide renderer.
    api.getSignTemplates().then((cat) => {
      if (run !== alive) return;
      names = Object.fromEntries(((cat && cat.templates) || []).map((x) => [x.id, x.name]));
      container.querySelectorAll('[data-name]').forEach((el) => {
        const id = proposals[Number(el.dataset.name)].template;
        const key = `signs.tpl.${id}.name`;
        const tr = t(key);
        el.textContent = tr === key ? (names[id] || id) : tr;
      });
    }).catch(() => {});
    api.previewSigns({ aspect, items: proposals.map((p) => ({ template: p.template, aspect, values: p.values })) }).then((r) => {
      if (run !== alive) return;
      const map = (r && r.previews) || {};
      container.querySelectorAll('[data-prev]').forEach((f) => {
        const html = map[`${proposals[Number(f.dataset.prev)].template}:${aspect}`];
        if (html) f.srcdoc = html;
      });
    }).catch(() => { /* the names are still there */ });
  }
}

function currentWorkspaceId() {
  try { return (JSON.parse(localStorage.getItem('user') || 'null') || {}).current_workspace_id || null; } catch { return null; }
}

/* ---------------------------------------------------------------- Advanced route (#/ai-setup) */

export function render(container, hash = window.location.hash || '') {
  return renderAiSetup(container, { simple: false, hash });
}

export function cleanup() {
  alive++;
  cleanupSign();
}
