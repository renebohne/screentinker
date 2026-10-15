/*
 * 3.0 Private AI (docs/private-ai.md): the "Local / private" provider setup inside the AI settings
 * dialog, the organization's "only allow private AI" switch, and the badge every AI feature shows
 * when its requests go to a server on the customer's own network.
 *
 * ⚠️ THE BADGE MAKES A CLAIM, SO ONLY THE SERVER MAKES IT. It is drawn from /api/ai/private/status
 * `private`, which is true only for a local provider whose address resolved to private addresses
 * when it was saved. A local provider on a public address gets no badge: its requests do leave the
 * network, and the page must not say otherwise.
 *
 * Every server value reaches the page through esc() or .value/.textContent.
 */
import { api } from '../api.js';
import { t, tn } from '../i18n.js';
import { esc } from '../utils.js';
import { showToast } from './toast.js';

let statusPromise = null;

/** The workspace's AI status, fetched once per page view unless `force`. Never throws. */
export function getPrivateAiStatus(force = false) {
  if (force || !statusPromise) {
    statusPromise = api.privateAiStatus().catch(() => ({ configured: false, private: false }));
  }
  return statusPromise;
}

/** "Private: data stays on your network", or nothing. */
export function privateBadge(st) {
  if (!st || !st.private) return '';
  return `<span class="private-ai-badge" title="${esc(t('private_ai.badge_tip'))}"><span aria-hidden="true">&#128274;</span> ${esc(t('private_ai.badge'))}</span>`;
}

/** Fill every [data-private-ai-badge] under `root` once the status is known. */
export async function decoratePrivateBadges(root = document) {
  const hosts = [...root.querySelectorAll('[data-private-ai-badge]')];
  if (!hosts.length) return;
  const st = await getPrivateAiStatus();
  for (const h of hosts) if (document.contains(h)) h.innerHTML = privateBadge(st);
}

/**
 * The provider choice and the local-server form, mounted at the top of the AI settings dialog.
 * `legacy` are the dialog's own bring-your-own fields, hidden while "Local / private" is chosen.
 * Returns { isActive(), save() } so the dialog's Save button saves whichever form is showing.
 */
export async function mountPrivateAiSettings(host, { legacy = [] } = {}) {
  const st = await getPrivateAiStatus(true);
  let mode = st.kind === 'local' || st.only_private ? 'local' : 'custom';
  let lastTest = null;

  host.innerHTML = `
    <div class="private-ai-setup">
      <div class="form-group">
        <label>${esc(t('private_ai.where'))}</label>
        <div class="private-ai-modes" role="radiogroup" aria-label="${esc(t('private_ai.where'))}">
          <label><input type="radio" name="aiMode" value="custom" ${mode === 'custom' ? 'checked' : ''} ${st.only_private ? 'disabled' : ''}>
            <span><strong>${esc(t('private_ai.mode_custom'))}</strong><small>${esc(t('private_ai.mode_custom_desc'))}</small></span></label>
          <label><input type="radio" name="aiMode" value="local" ${mode === 'local' ? 'checked' : ''}>
            <span><strong>${esc(t('private_ai.mode_local'))}</strong><small>${esc(t('private_ai.mode_local_desc'))}</small></span></label>
        </div>
        ${st.only_private ? `<p class="private-ai-note">${esc(t('private_ai.policy_on_note'))}</p>` : ''}
      </div>
      <div data-local hidden>
        <div data-badge>${privateBadge(st)}</div>
        <div class="form-group"><label for="paiBase">${esc(t('private_ai.base_url'))}</label>
          <input id="paiBase" class="input" style="width:100%" value="${esc(st.base_url || '')}" placeholder="http://ollama.lan:11434/v1" autocomplete="off" spellcheck="false">
          <small class="private-ai-hint">${esc(t('private_ai.base_url_hint'))}</small></div>
        <div class="form-group"><label for="paiKey">${esc(t('private_ai.api_key'))}</label>
          <input id="paiKey" class="input" type="password" autocomplete="off" style="width:100%" placeholder="${esc(st.has_key ? t('designer.ai.key_set') : t('private_ai.api_key_ph'))}"></div>
        <button type="button" class="btn btn-secondary btn-sm" data-test>${esc(t('private_ai.test'))}</button>
        <div class="private-ai-result" data-result role="status"></div>
        <div class="form-group"><label for="paiModel">${esc(t('private_ai.text_model'))}</label>
          <select id="paiModel" class="input" style="width:100%">${st.model && st.kind === 'local' ? `<option value="${esc(st.model)}" selected>${esc(st.model)}</option>` : `<option value="">${esc(t('private_ai.test_first'))}</option>`}</select></div>
        <div class="form-group"><label for="paiImage">${esc(t('private_ai.image_model'))}</label>
          <select id="paiImage" class="input" style="width:100%">
            <option value="">${esc(t('private_ai.image_none'))}</option>
            ${st.image_model ? `<option value="${esc(st.image_model)}" selected>${esc(st.image_model)}</option>` : ''}
          </select>
          <small class="private-ai-hint">${esc(t('private_ai.image_hint'))}</small></div>
      </div>
      ${st.can_set_policy ? `
        <label class="private-ai-policy"><input type="checkbox" data-policy ${st.only_private ? 'checked' : ''}>
          <span><strong>${esc(t('private_ai.policy'))}</strong><small>${esc(t('private_ai.policy_desc'))}</small></span></label>` : ''}
      <hr class="private-ai-sep" data-sep>
    </div>`;

  const local = host.querySelector('[data-local]');
  const result = host.querySelector('[data-result]');
  const show = () => {
    local.hidden = mode !== 'local';
    host.querySelector('[data-sep]').hidden = mode === 'local';
    for (const el of legacy) el.hidden = mode === 'local';
  };
  show();
  host.querySelectorAll('input[name="aiMode"]').forEach((r) => r.addEventListener('change', () => { mode = r.value; show(); }));

  host.querySelector('[data-policy]')?.addEventListener('change', async (e) => {
    const on = e.target.checked;
    try {
      await api.privateAiPolicy(on);
      showToast(t(on ? 'private_ai.policy_saved_on' : 'private_ai.policy_saved_off'), 'success');
      getPrivateAiStatus(true);
    } catch (err) {
      e.target.checked = !on;
      showToast((err && err.message) || t('private_ai.save_failed'), 'error');
    }
  });

  function fillModels(r) {
    const sel = host.querySelector('#paiModel');
    const cur = sel.value || st.model;
    const text = (r.text_models && r.text_models.length ? r.text_models : r.models) || [];
    sel.innerHTML = text.map((m) => `<option value="${esc(m)}" ${m === cur ? 'selected' : ''}>${esc(m)}</option>`).join('');
    const img = host.querySelector('#paiImage');
    const curImg = img.value || st.image_model || '';
    img.innerHTML = `<option value="">${esc(t('private_ai.image_none'))}</option>`
      + (r.image_models || []).map((m) => `<option value="${esc(m)}" ${m === curImg ? 'selected' : ''}>${esc(m)}</option>`).join('');
  }

  /** What to tell the admin when the address is private and not allowed yet. */
  function notAllowedHtml(r) {
    const h = r.host || '';
    return `<div class="private-ai-allow">
      <p><strong>${esc(t('private_ai.not_allowed_title', { host: h }))}</strong></p>
      <p>${esc(t('private_ai.not_allowed_body'))}</p>
      ${r.can_allow ? `<button type="button" class="btn btn-primary btn-sm" data-allow="${esc(h)}">${esc(t('private_ai.allow_btn', { host: h }))}</button>
        <p class="private-ai-hint">${esc(t('private_ai.allow_scope'))}</p>`
        : `<p>${esc(t('private_ai.ask_admin'))}</p>`}
      <p class="private-ai-hint">${esc(t('private_ai.env_hint'))} <code>${esc((r.how_to_allow && r.how_to_allow.env) || '')}</code></p>
    </div>`;
  }

  async function runTest() {
    const base_url = host.querySelector('#paiBase').value.trim();
    if (!base_url) { result.textContent = t('private_ai.need_url'); return; }
    const btn = host.querySelector('[data-test]');
    btn.disabled = true;
    result.className = 'private-ai-result';
    result.textContent = t('private_ai.testing');
    try {
      const r = await api.privateAiTest(base_url, host.querySelector('#paiKey').value || undefined);
      lastTest = r;
      if (!r.allowed) { result.innerHTML = notAllowedHtml(r); wireAllow(); return; }
      if (!r.policy_ok) { result.classList.add('is-error'); result.textContent = t('private_ai.policy_blocks'); return; }
      fillModels(r);
      result.classList.add('is-ok');
      result.innerHTML = `${esc(tn('private_ai.models_found', (r.models || []).length))}
        ${r.private ? privateBadge({ private: true }) : `<span class="private-ai-public">${esc(t('private_ai.public_address'))}</span>`}`;
    } catch (err) {
      result.classList.add('is-error');
      result.textContent = (err && err.message) || t('private_ai.test_failed');
    } finally { btn.disabled = false; }
  }
  function wireAllow() {
    host.querySelector('[data-allow]')?.addEventListener('click', async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      try {
        await api.privateAiAllowHost(b.dataset.allow);
        showToast(t('private_ai.allowed', { host: b.dataset.allow }), 'success');
        await runTest();
      } catch (err) {
        b.disabled = false;
        showToast((err && err.message) || t('private_ai.save_failed'), 'error');
      }
    });
  }
  host.querySelector('[data-test]').addEventListener('click', runTest);

  return {
    isActive: () => mode === 'local',
    /** Save the local provider. Resolves true when saved; shows the problem and resolves false otherwise. */
    async save() {
      const base_url = host.querySelector('#paiBase').value.trim();
      const model = host.querySelector('#paiModel').value;
      if (!base_url || !model) { result.className = 'private-ai-result is-error'; result.textContent = t('private_ai.need_model'); return false; }
      const body = { base_url, model, image_model: host.querySelector('#paiImage').value };
      const key = host.querySelector('#paiKey').value;
      if (key) body.api_key = key;
      try {
        const saved = await api.privateAiSave(body);
        getPrivateAiStatus(true);
        showToast(t(saved.private ? 'private_ai.saved_private' : 'private_ai.saved'), 'success');
        return true;
      } catch (err) {
        result.className = 'private-ai-result is-error';
        if (err && err.code === 'not_allowed' && err.body) { result.innerHTML = notAllowedHtml({ ...err.body, can_allow: lastTest && lastTest.can_allow }); wireAllow(); }
        else result.textContent = (err && err.message) || t('private_ai.save_failed');
        return false;
      }
    },
  };
}

/** The explanation shown in place of an AI feature when no provider is set up. */
export function notConfiguredHtml(st) {
  return `<div class="private-ai-off">
    <p class="simple-lead">${esc(t('private_ai.off_title'))}</p>
    <p class="simple-muted">${esc(t(st && st.can_configure ? 'private_ai.off_admin' : 'private_ai.off_member'))}</p>
    ${st && st.can_configure ? `<button type="button" class="btn btn-primary" data-open-ai-settings>${esc(t('private_ai.open_settings'))}</button>` : ''}
  </div>`;
}

/** Wire the "Open AI settings" button notConfiguredHtml draws; `after` runs once the dialog is closed. */
export function wireOpenSettings(root, after) {
  root.querySelector('[data-open-ai-settings]')?.addEventListener('click', async () => {
    const { openAiSettingsModal } = await import('./ai-settings-modal.js');
    await openAiSettingsModal({ onClose: after });
  });
}
