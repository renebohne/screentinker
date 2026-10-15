/*
 * 3.0 accessibility: "Generate captions" and the caption editor, used by the Accessibility page and
 * the content library's item dialog (server: lib/a11y/captions.js, routes/accessibility.js).
 *
 * Generating sends the video's AUDIO to the speech-to-text endpoint a workspace admin configured
 * under AI settings, and nowhere else; with none configured the button is not offered and the
 * person is told why. The result is an ordinary subtitle track, editable here afterwards.
 *
 * Caption text reaches the page only as a textarea's .value, never as markup.
 */
import { api } from '../api.js';
import { t } from '../i18n.js';
import { esc } from '../utils.js';
import { showToast } from './toast.js';

const POLL_MS = 2000;
const MAX_POLLS = 600; // 20 minutes; the server gives up on an endpoint after 10

/**
 * Start captions for a video and wait for the result.
 * @param {string} id content id
 * @param {(state: 'running'|'done'|'failed', error?: string) => void} [onState]
 * @returns {Promise<boolean>} true when captions were attached
 */
export async function generateCaptions(id, onState = () => {}, lang) {
  try {
    await api.generateCaptions(id, lang);
  } catch (e) {
    onState('failed', (e && e.message) || '');
    showToast((e && e.message) || t('a11y.captions.failed'), 'error');
    return false;
  }
  onState('running');
  showToast(t('a11y.captions.started'), 'info');
  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    let st;
    try { st = await api.getCaptionsJob(id); } catch { continue; }
    const job = st && st.job;
    if (!job || job.status === 'running') continue;
    if (job.status === 'done') {
      onState('done');
      showToast(t('a11y.captions.done'), 'success');
      return true;
    }
    onState('failed', job.error || '');
    showToast(t('a11y.captions.failed_reason', { reason: job.error || '' }), 'error');
    return false;
  }
  onState('failed', '');
  return false;
}

/** The caption editor: the WebVTT text in a textarea, saved through the server's normaliser. */
export async function openCaptionsEditor(id, { canWrite = true, onSaved = () => {} } = {}) {
  let cur;
  try { cur = await api.getCaptionsText(id); } catch (e) { showToast(e.message, 'error'); return; }
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.display = 'flex';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="capEdTitle" style="max-width:720px;width:95vw">
      <div class="modal-header"><h3 id="capEdTitle">${esc(t('a11y.captions.edit_title'))}</h3>
        <button class="btn-icon" data-cap-close aria-label="${esc(t('common.close'))}">&times;</button></div>
      <div class="modal-body">
        <p class="corp-help" style="font-size:12px;margin-bottom:8px">${esc(t('a11y.captions.edit_help'))}</p>
        <textarea class="input a11y-vtt" rows="16" spellcheck="true" ${canWrite ? '' : 'readonly'} aria-label="${esc(t('a11y.captions.edit_title'))}"></textarea>
        <p class="a11y-cap-err" role="alert" style="color:var(--danger);font-size:13px;margin-top:6px" hidden></p>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" data-cap-close>${esc(t('common.cancel'))}</button>
        ${canWrite ? `<button class="btn btn-primary" data-cap-save>${esc(t('common.save'))}</button>` : ''}
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const ta = overlay.querySelector('textarea');
  ta.value = (cur && cur.vtt) || 'WEBVTT\n\n00:00:00.000 --> 00:00:03.000\n';
  const close = () => overlay.remove();
  overlay.querySelectorAll('[data-cap-close]').forEach((b) => b.addEventListener('click', close));
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('[data-cap-save]')?.addEventListener('click', async () => {
    const err = overlay.querySelector('.a11y-cap-err');
    err.hidden = true;
    try {
      await api.saveCaptionsText(id, ta.value, cur && cur.lang);
      showToast(t('a11y.captions.saved'), 'success');
      close();
      onSaved();
    } catch (e) {
      err.textContent = (e && e.message) || t('a11y.captions.save_failed');
      err.hidden = false;
    }
  });
  ta.focus();
}
