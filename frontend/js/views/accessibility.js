/*
 * 3.0 accessibility checker: the workspace report (server: lib/a11y, routes/accessibility.js).
 *
 *   #/accessibility   what on the screens may be hard to read or unsafe, worst first
 *
 * The one-click fixes are the product's ordinary edits, not new writes: "Use the suggested colour"
 * saves the deck (and re-publishes it when it is already on screens) or the widget through their own
 * endpoints, so review, drafts, corporate locks and history apply exactly as for a hand edit.
 * "Generate captions" sends the video's audio to the workspace's speech-to-text endpoint, and is
 * offered only when an admin set one up.
 *
 * Values from the server reach the page through esc() only.
 */
import { api } from '../api.js';
import { t, tn } from '../i18n.js';
import { esc } from '../utils.js';
import { showToast } from '../components/toast.js';
import { a11yIssueHtml, applyA11yFix, a11yEditHref, invalidateA11yBadges } from '../components/accessibility.js';
import { generateCaptions, openCaptionsEditor } from '../components/captions.js';
import { openAiSettingsModal } from '../components/ai-settings-modal.js';

let report = null;
let alive = 0;

const TYPE_LABEL = { content: 'a11y.type.content', widget: 'a11y.type.widget', slide_deck: 'a11y.type.slide_deck' };

export async function render(app) {
  const run = ++alive;
  app.innerHTML = `
    <div class="page-header"><div><h1>${esc(t('nav.accessibility'))}</h1><div class="subtitle">${esc(t('a11y.intro'))}</div></div></div>
    <div id="a11yBody"><p style="color:var(--text-muted)">${esc(t('common.loading'))}</p></div>`;
  await load(app, run);
}

async function load(app, run = alive) {
  const body = document.getElementById('a11yBody');
  if (!body) return;
  try {
    const r = await api.getAccessibility();
    report = r && !Array.isArray(r) ? r : null;
  } catch (e) {
    body.innerHTML = `<p class="corp-notice corp-notice-danger">${esc(e.message)}</p>`;
    return;
  }
  if (run !== alive || !document.contains(body)) return;
  if (!report) { body.innerHTML = `<div class="corp-empty">${esc(t('a11y.unavailable'))}</div>`; return; }
  body.innerHTML = summaryHtml() + issuesHtml() + notesHtml() + settingsHtml() + screensHtml() + captionsHtml();
  wire(app, body);
  // Videos still being read: look again shortly, once, without a full page flash.
  if (report.pending) setTimeout(() => { if (run === alive && document.contains(body)) load(app, run); }, 15000);
}

function tile(label, value, tone = '') {
  return `<div class="fresh-tile${tone ? ` fresh-tile-${tone}` : ''}"><div class="fresh-tile-value">${esc(value)}</div><div class="fresh-tile-label">${esc(label)}</div></div>`;
}

function summaryHtml() {
  const c = report.counts;
  const s = report.settings;
  return `
    <div class="fresh-tiles">
      ${tile(t('a11y.tile.errors'), String(c.errors), c.errors ? 'bad' : '')}
      ${tile(t('a11y.tile.warnings'), String(c.warnings), c.warnings ? 'warn' : '')}
      ${tile(t('a11y.tile.notes'), String(c.notes))}
      ${report.pending ? tile(t('a11y.tile.pending'), String(report.pending)) : ''}
    </div>
    <p class="corp-help" style="font-size:12px;margin:6px 0 18px">${esc(t('a11y.assumes', { distance: s.viewing_distance_m, size: s.screen_diagonal_in }))}
      ${s.block_on_errors ? ` <strong>${esc(t('a11y.policy_on'))}</strong>` : ''}</p>`;
}

function actionsFor(src, issue, idx) {
  if (!report.can_write) return '';
  const a = [];
  const fix = issue.fix || {};
  if (issue.code === 'contrast' && fix.color && (src.type === 'slide_deck' || src.type === 'widget')) {
    a.push(`<button type="button" class="btn btn-primary btn-sm" data-act="fix" data-i="${idx}">${esc(t('a11y.act.use_color'))}</button>`);
  }
  if (issue.code === 'contrast_image' && (src.type === 'slide_deck' || (src.type === 'widget' && src.widget_type === 'slide'))) {
    a.push(`<button type="button" class="btn btn-primary btn-sm" data-act="fix" data-i="${idx}">${esc(t('a11y.act.dim'))}</button>`);
  }
  if (issue.code === 'youtube_captions_off') {
    a.push(`<button type="button" class="btn btn-primary btn-sm" data-act="fix" data-i="${idx}">${esc(t('a11y.act.youtube_captions'))}</button>`);
  }
  if (issue.code === 'no_captions') {
    if (report.stt && report.stt.configured) a.push(`<button type="button" class="btn btn-primary btn-sm" data-act="captions">${esc(t('a11y.act.generate_captions'))}</button>`);
    else a.push(`<small class="corp-help">${esc(t(report.can_admin ? 'a11y.captions.not_set_admin' : 'a11y.captions.not_set'))}</small>`);
  }
  return a.length ? `<span class="a11y-actions">${a.join('')}</span>` : '';
}

function sourceCard(src, issues) {
  return `
    <div class="corp-card a11y-source" data-type="${esc(src.type)}" data-id="${esc(src.id)}">
      <div class="a11y-source-head">
        <strong>${esc(src.name || '')}</strong>
        <span class="corp-help" style="font-size:12px">${esc(t(TYPE_LABEL[src.type] || 'a11y.type.content'))}${src.screens ? ` · ${esc(tn('a11y.on_screens', src.screens))}` : ''}</span>
        <a class="btn btn-secondary btn-sm" href="${esc(a11yEditHref(src))}">${esc(t('a11y.act.open'))}</a>
      </div>
      <ul class="a11y-issues">${issues.map((i) => a11yIssueHtml(i, actionsFor(src, i, src.issues.indexOf(i)))).join('')}</ul>
    </div>`;
}

function issuesHtml() {
  const list = report.sources.filter((s) => s.errors || s.warnings);
  return `<h2 class="fresh-h2">${esc(t('a11y.issues'))}</h2>
    ${list.length ? list.map((s) => sourceCard(s, s.issues.filter((i) => i.severity !== 'note'))).join('')
      : `<div class="corp-empty">${esc(t('a11y.nothing'))}</div>`}`;
}

function notesHtml() {
  const list = report.sources.filter((s) => s.notes);
  if (!list.length) return '';
  return `<details class="fresh-snoozed"><summary>${esc(tn('a11y.notes', list.reduce((n, s) => n + s.notes, 0)))}</summary>
    <p class="corp-help" style="font-size:12px;margin:6px 0">${esc(t('a11y.notes_help'))}</p>
    ${list.map((s) => sourceCard(s, s.issues.filter((i) => i.severity === 'note'))).join('')}</details>`;
}

function settingsHtml() {
  const s = report.settings;
  const dis = report.can_admin ? '' : 'disabled';
  return `<h2 class="fresh-h2">${esc(t('a11y.settings'))}</h2>
    <div class="corp-card" style="padding:16px">
      <div class="fresh-settings">
        <label>${esc(t('a11y.set.distance'))}<input type="number" class="input" min="0.3" max="100" step="0.1" id="a11yDistance" value="${esc(s.viewing_distance_m)}" ${dis}></label>
        <label>${esc(t('a11y.set.size'))}<input type="number" class="input" min="7" max="400" step="1" id="a11ySize" value="${esc(s.screen_diagonal_in)}" ${dis}></label>
        <label class="fresh-check"><input type="checkbox" id="a11yBlock" ${s.block_on_errors ? 'checked' : ''} ${dis}> ${esc(t('a11y.set.block'))}</label>
      </div>
      <p class="corp-help" style="font-size:12px;margin-top:8px">${esc(t('a11y.set.help'))}</p>
      ${report.can_admin ? `<button type="button" class="btn btn-primary btn-sm" id="a11ySave" style="margin-top:10px">${esc(t('common.save'))}</button>`
        : `<p class="corp-help" style="font-size:12px;margin-top:8px">${esc(t('a11y.set.admin_only'))}</p>`}
    </div>`;
}

function screensHtml() {
  if (!report.screens.length) return '';
  const dis = report.can_admin ? '' : 'disabled';
  return `<h2 class="fresh-h2">${esc(t('a11y.screens'))}</h2>
    <div class="corp-card" style="padding:4px 16px">
      <p class="corp-help" style="font-size:12px;margin:8px 0">${esc(t('a11y.screens_help'))}</p>
      ${report.screens.map((d) => `
      <div class="fresh-line a11y-screen" data-device="${esc(d.id)}">
        <strong style="min-width:160px">${esc(d.name)}</strong>
        <label class="a11y-inline">${esc(t('a11y.set.distance_short'))}
          <input type="number" class="input" min="0.3" max="100" step="0.1" data-k="viewing_distance_m" value="${d.viewing_distance_m == null ? '' : esc(d.viewing_distance_m)}" placeholder="${esc(report.settings.viewing_distance_m)}" ${dis}></label>
        <label class="a11y-inline">${esc(t('a11y.set.size_short'))}
          <input type="number" class="input" min="7" max="400" step="1" data-k="screen_diagonal_in" value="${d.screen_diagonal_in == null ? '' : esc(d.screen_diagonal_in)}" placeholder="${esc(d.edid_diagonal_in || report.settings.screen_diagonal_in)}" ${dis}></label>
        ${d.edid_diagonal_in ? `<small class="corp-help">${esc(t('a11y.edid', { size: d.edid_diagonal_in }))}</small>` : ''}
        ${report.can_admin ? `<button type="button" class="btn btn-secondary btn-sm" data-act="screen">${esc(t('common.save'))}</button>` : ''}
      </div>`).join('')}
    </div>`;
}

function captionsHtml() {
  const st = report.stt || {};
  return `<h2 class="fresh-h2">${esc(t('a11y.captions.title'))}</h2>
    <div class="corp-card" style="padding:16px">
      <p style="margin:0 0 6px">${esc(st.configured ? t('a11y.captions.on', { host: hostOf(st.base_url) }) : t('a11y.captions.off'))}</p>
      <p class="corp-help" style="font-size:12px;margin:0">${esc(t('a11y.captions.privacy'))}</p>
      ${report.can_admin ? `<button type="button" class="btn btn-secondary btn-sm" id="a11ySttSettings" style="margin-top:10px">${esc(t('a11y.captions.settings_btn'))}</button>` : ''}
    </div>`;
}

function hostOf(u) { try { return new URL(u).host; } catch { return u || ''; } }

function refresh(app) {
  invalidateA11yBadges();
  load(app);
}

function wire(app, body) {
  body.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const card = btn.closest('[data-type][data-id]');
    const act = btn.dataset.act;
    if (act === 'fix' && card) {
      const src = report.sources.find((s) => s.type === card.dataset.type && s.id === card.dataset.id);
      const issue = src && src.issues[Number(btn.dataset.i)];
      if (!issue) return;
      btn.disabled = true;
      try { showToast(await applyA11yFix(src, issue), 'success'); refresh(app); }
      catch (err) { btn.disabled = false; showToast(err.message, 'error'); }
    } else if (act === 'captions' && card) {
      btn.disabled = true;
      btn.textContent = t('a11y.captions.working');
      const ok = await generateCaptions(card.dataset.id);
      if (ok) {
        refresh(app);
        openCaptionsEditor(card.dataset.id, { canWrite: report && report.can_write });
      } else if (document.contains(btn)) { btn.disabled = false; btn.textContent = t('a11y.act.generate_captions'); }
    } else if (act === 'screen') {
      const row = btn.closest('[data-device]');
      const data = {};
      row.querySelectorAll('input[data-k]').forEach((i) => { data[i.dataset.k] = i.value === '' ? null : Number(i.value); });
      try { await api.updateAccessibilityScreen(row.dataset.device, data); showToast(t('a11y.saved'), 'success'); refresh(app); }
      catch (err) { showToast(err.message, 'error'); }
    }
  });

  document.getElementById('a11ySave')?.addEventListener('click', async () => {
    try {
      await api.updateAccessibilitySettings({
        viewing_distance_m: Number(document.getElementById('a11yDistance').value),
        screen_diagonal_in: Number(document.getElementById('a11ySize').value),
        block_on_errors: document.getElementById('a11yBlock').checked,
      });
      showToast(t('a11y.saved'), 'success');
      refresh(app);
    } catch (err) { showToast(err.message, 'error'); }
  });
  document.getElementById('a11ySttSettings')?.addEventListener('click', () => openAiSettingsModal());
}

export function cleanup() { report = null; alive++; }
