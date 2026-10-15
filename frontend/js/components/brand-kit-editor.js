/*
 * 3.0 The workspace brand kit editor: business name, logo, three colours, headline font.
 *
 * Mounted in two places with one implementation: Simple view's "Your brand" page
 * (views/make-sign.js renderBrand, #/simple/brand) and the Brand kit card in Advanced → Settings.
 * The kit pre-fills and themes every built-in sign template (server/lib/sign-templates.js).
 *
 * A view-only member sees the kit with every control disabled; the server refuses their writes
 * regardless (routes/brand-kit.js denyReadOnly).
 *
 * Values from the server reach the page through esc() or .value only.
 */
import { api } from '../api.js';
import { t } from '../i18n.js';
import { esc, hydrateAuthImages } from '../utils.js';
import { showToast } from './toast.js';

const COLOR_KEYS = ['signs.brand.color1', 'signs.brand.color2', 'signs.brand.color3'];

/** The bundled faces, declared once so the font picker can show each one in itself. */
function ensureFaces(fonts) {
  if (document.getElementById('brandKitFaces')) return;
  const style = document.createElement('style');
  style.id = 'brandKitFaces';
  // Every value here is a server constant (lib/slide-fonts.js); filtered anyway so a surprise cannot
  // become CSS syntax.
  const safe = (s) => String(s || '').replace(/[^A-Za-z0-9 _-]/g, '');
  style.textContent = (fonts || []).map((f) => `@font-face{font-family:'${safe(f.css)}';font-display:swap;`
    + `font-weight:${Number(f.weights && f.weights[0]) || 400} ${Number(f.weights && f.weights[1]) || 800};`
    + `src:url(/fonts/${safe(f.file)}.woff2) format('woff2')}`).join('\n');
  document.head.appendChild(style);
}

function stackFor(fonts, id) {
  const f = (fonts || []).find((x) => x.id === id) || (fonts || []).find((x) => x.id === 'archivo');
  if (!f) return 'sans-serif';
  const safe = (s) => String(s || '').replace(/[^A-Za-z0-9 _-]/g, '');
  return `'${safe(f.css)}', ${safe(f.stack) || 'sans-serif'}`;
}

/**
 * @param {HTMLElement} host
 * @param {{ onSaved?: (kit: object) => void }} [opts]
 */
export async function mountBrandKit(host, { onSaved } = {}) {
  if (!host) return;
  host.innerHTML = `<p class="simple-muted">${esc(t('common.loading'))}</p>`;
  let data;
  try { data = await api.getBrandKit(); } catch (err) {
    host.innerHTML = `<p class="simple-muted">${esc((err && err.message) || t('signs.err.load'))}</p>`;
    return;
  }
  if (!document.contains(host)) return;
  const fonts = data.fonts || [];
  const ro = !data.can_edit;
  const kit = {
    business_name: data.kit.business_name || '',
    logo_content_id: data.kit.logo_content_id || null,
    // The logo's own file (transparency intact); a fresh upload falls back to its library thumbnail.
    logo_url: data.logo_url || null,
    colors: [0, 1, 2].map((i) => (data.kit.colors || [])[i] || null),
    font: data.kit.font || '',
  };
  ensureFaces(fonts);
  const dis = ro ? 'disabled' : '';

  function draw(statusText = '') {
    host.innerHTML = `
      ${ro ? `<p class="simple-muted bk-ro">${esc(t('signs.brand.read_only'))}</p>` : ''}
      <label class="simple-label" for="bkName">${esc(t('signs.brand.name'))}</label>
      <input id="bkName" class="input sign-input" maxlength="80" autocomplete="organization" value="${esc(kit.business_name)}" ${dis}>

      <div class="bk-section">
        <span class="simple-label">${esc(t('signs.brand.logo'))}</span>
        <div class="bk-logo-row">
          <div class="bk-logo">${kit.logo_content_id
            ? (kit.logo_url && /^\/uploads\/content\//.test(kit.logo_url)
              ? `<img src="${esc(kit.logo_url)}" alt="${esc(t('signs.brand.logo'))}">`
              : `<img data-auth-src="/api/content/${esc(kit.logo_content_id)}/thumbnail" alt="${esc(t('signs.brand.logo'))}">`)
            : `<span class="bk-logo-empty">${esc(t('signs.brand.no_logo'))}</span>`}</div>
          ${ro ? '' : `<div class="bk-logo-actions">
            <button type="button" class="btn btn-secondary btn-sm" data-logo-pick>${esc(t(kit.logo_content_id ? 'signs.brand.logo_change' : 'signs.brand.logo_upload'))}</button>
            ${kit.logo_content_id ? `<button type="button" class="btn btn-secondary btn-sm" data-logo-remove>${esc(t('signs.brand.logo_remove'))}</button>` : ''}
            <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden data-logo-file>
          </div>`}
        </div>
        <small class="sign-hint">${esc(t('signs.brand.logo_hint'))}</small>
      </div>

      <div class="bk-section">
        <span class="simple-label">${esc(t('signs.brand.colors'))}</span>
        <div class="bk-colors">${kit.colors.map((c, i) => `
          <div class="bk-color">
            <input type="color" id="bkColor${i}" data-color="${i}" value="${esc(c || '#FFFFFF')}" ${dis} aria-label="${esc(t(COLOR_KEYS[i]))}">
            <label for="bkColor${i}"><strong>${esc(t(COLOR_KEYS[i]))}</strong><small>${c ? esc(c) : esc(t('signs.brand.color_none'))}</small></label>
            ${!ro && c ? `<button type="button" class="bk-clear" data-clear="${i}" aria-label="${esc(t('signs.brand.color_clear'))}" title="${esc(t('signs.brand.color_clear'))}">&times;</button>` : ''}
          </div>`).join('')}
        </div>
        <small class="sign-hint">${esc(t('signs.brand.colors_hint'))}</small>
      </div>

      <div class="bk-section">
        <label class="simple-label" for="bkFont">${esc(t('signs.brand.font'))}</label>
        <select id="bkFont" class="input sign-input" ${dis}>
          <option value="">${esc(t('signs.brand.font_default'))}</option>
          ${fonts.map((f) => `<option value="${esc(f.id)}" ${kit.font === f.id ? 'selected' : ''}>${esc(f.label)}</option>`).join('')}
        </select>
        <div class="bk-font-sample" data-font-sample style="font-family:${esc(stackFor(fonts, kit.font))}">${esc(kit.business_name || t('signs.brand.font_sample'))}</div>
      </div>

      ${ro ? '' : `<div class="bk-actions"><button type="button" class="btn btn-primary" data-bk-save>${esc(t('signs.brand.save'))}</button></div>`}
      <p class="simple-status" data-bk-status role="status">${esc(statusText)}</p>`;
    hydrateAuthImages(host, { eager: true });
    if (ro) return;

    const status = host.querySelector('[data-bk-status]');
    host.querySelector('#bkName').addEventListener('input', (e) => {
      kit.business_name = e.target.value;
      host.querySelector('[data-font-sample]').textContent = kit.business_name || t('signs.brand.font_sample');
    });
    host.querySelector('#bkFont').addEventListener('change', (e) => {
      kit.font = e.target.value;
      host.querySelector('[data-font-sample]').style.fontFamily = stackFor(fonts, kit.font);
    });
    host.querySelectorAll('[data-color]').forEach((inp) => inp.addEventListener('input', () => {
      kit.colors[Number(inp.dataset.color)] = inp.value.toUpperCase();
      const small = inp.parentElement.querySelector('small');
      if (small) small.textContent = inp.value.toUpperCase();
    }));
    host.querySelectorAll('[data-color]').forEach((inp) => inp.addEventListener('change', () => draw()));
    host.querySelectorAll('[data-clear]').forEach((b) => b.addEventListener('click', () => {
      kit.colors[Number(b.dataset.clear)] = null;
      draw();
    }));
    const file = host.querySelector('[data-logo-file]');
    host.querySelector('[data-logo-pick]').addEventListener('click', () => file.click());
    host.querySelector('[data-logo-remove]')?.addEventListener('click', () => { kit.logo_content_id = null; kit.logo_url = null; draw(t('signs.brand.unsaved')); });
    file.addEventListener('change', async () => {
      const f = file.files && file.files[0];
      file.value = '';
      if (!f) return;
      status.textContent = t('signs.brand.uploading');
      try {
        const up = await api.uploadContent([f]);
        const item = (Array.isArray(up) ? up : [up]).find((c) => c && c.id);
        if (!item) throw new Error(t('onboarding.toast.upload_failed'));
        kit.logo_content_id = item.id;
        kit.logo_url = item.filepath && !item.remote_url ? `/uploads/content/${encodeURIComponent(item.filepath)}` : null;
        draw(t('signs.brand.unsaved'));
      } catch (err) {
        if (!(err && err.planPromptShown)) status.textContent = (err && err.message) || t('onboarding.toast.upload_failed');
      }
    });
    host.querySelector('[data-bk-save]').addEventListener('click', async (e) => {
      e.target.disabled = true;
      status.textContent = t('simple.working');
      try {
        const r = await api.saveBrandKit({
          business_name: kit.business_name.trim(),
          logo_content_id: kit.logo_content_id,
          colors: kit.colors,
          font: kit.font || null,
        });
        kit.logo_content_id = r.kit.logo_content_id;
        kit.logo_url = r.logo_url || null;
        draw(t('signs.brand.saved'));
        showToast(t('signs.brand.saved'), 'success');
        if (typeof onSaved === 'function') onSaved(r.kit);
      } catch (err) {
        e.target.disabled = false;
        status.textContent = (err && err.message) || t('signs.err.save');
      }
    });
  }
  draw();
}
