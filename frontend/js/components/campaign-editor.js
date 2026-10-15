/*
 * 3.0 campaigns (docs/layouts-and-campaigns.md): a playlist whose items can be WHOLE LAYOUTS.
 *
 * The playlist editor's "Add layout" dialog (pick a layout, choose what each zone plays, set how
 * long the layout stays up), the row summary for a layout item, the zone picker for items placed in
 * a layout's zone, and the banner that says which screens will play the simplified version.
 */
import { api } from '../api.js';
import { showToast } from './toast.js';
import { esc } from '../utils.js';
import { t, tn } from '../i18n.js';

/** A small drawing of a layout's zones, for the item row. */
export function layoutThumbHtml(layout) {
  if (!layout || !Array.isArray(layout.zones)) return '<div style="color:var(--text-muted)">▦</div>';
  const portrait = Number(layout.height) > Number(layout.width);
  return `<div style="position:relative;width:${portrait ? 20 : 44}px;height:${portrait ? 34 : 26}px;border:1px solid var(--border);background:var(--bg-primary)">${
    layout.zones.map((z) => `<div style="position:absolute;left:${Number(z.x_percent) || 0}%;top:${Number(z.y_percent) || 0}%;width:${Number(z.width_percent) || 0}%;height:${Number(z.height_percent) || 0}%;box-sizing:border-box;border:1px solid var(--accent)"></div>`).join('')
  }</div>`;
}

/** "Main → Menu, Side → items placed here" for a layout item row. */
export function layoutItemSummary(item) {
  if (!item.layout) return t('campaign.layout_missing');
  return item.layout.zones.map((z) => {
    const src = item.zone_sources && item.zone_sources[z.id];
    const what = src ? (item.zone_source_names && item.zone_source_names[z.id]) || t('campaign.zone_playlist') : t('campaign.zone_items_here');
    return `${z.name} → ${what}`;
  }).join(' · ');
}

/** Zone options for an item placed inside one of this campaign's layouts. */
export function campaignZoneOptions(items) {
  const out = [];
  const seen = new Set();
  for (const it of items || []) {
    if (!it.layout_ref_id || !it.layout || seen.has(it.layout.id)) continue;
    seen.add(it.layout.id);
    for (const z of it.layout.zones) out.push({ id: z.id, label: `${it.layout.name} › ${z.name}` });
  }
  return out;
}

/** The per-item select for a campaign: "a full-screen step" or one of its layouts' zones. */
export function campaignZoneSelectHtml(item, options) {
  if (!options.length || item.layout_ref_id || item.child_playlist_id || item.slot_id) return '';
  const known = options.some((o) => o.id === item.zone_id);
  return `<select class="input item-zone" data-item-id="${esc(String(item.id))}" aria-label="${esc(t('campaign.zone_for_item'))}" title="${esc(t('campaign.zone_for_item'))}" style="width:170px;padding:4px 6px;font-size:12px;background:var(--bg-input)">
    <option value="" ${!item.zone_id ? 'selected' : ''}>${esc(t('campaign.zone_full_step'))}</option>
    ${options.map((o) => `<option value="${esc(o.id)}" ${o.id === item.zone_id ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
    ${item.zone_id && !known ? `<option value="${esc(item.zone_id)}" selected>${esc(t('layoutpl.zone_other_layout'))}</option>` : ''}
  </select>`;
}

/** Which screens play the whole campaign, and which the simplified version. */
export function campaignBannerHtml(playlist) {
  const screens = playlist && playlist.campaign_screens;
  if (!screens) return '';
  const simple = screens.filter((s) => !s.full);
  return `
    <div id="campaignBanner" style="background:var(--bg-card);border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:var(--radius);padding:10px 14px;margin-bottom:12px;font-size:13px">
      <div style="font-weight:600;margin-bottom:2px">${esc(t('campaign.banner_title'))}</div>
      <div style="color:var(--text-muted)">${esc(screens.length ? tn('campaign.banner_screens', screens.length) : t('campaign.banner_no_screens'))}</div>
      ${simple.length ? `<div style="color:var(--warning);margin-top:4px">${esc(tn('campaign.banner_simple', simple.length))} ${esc(simple.slice(0, 6).map((s) => s.name).join(', '))}${simple.length > 6 ? '…' : ''}</div>
        <div style="color:var(--text-muted);font-size:12px">${esc(t('campaign.banner_simple_hint'))}</div>` : ''}
    </div>`;
}

/**
 * Add a layout item, or edit one (item set): pick the layout, how long it stays up, and what each
 * zone plays. Resolves true when saved.
 */
export async function openLayoutItemDialog(playlist, item = null) {
  let layouts = [];
  let lists = [];
  try {
    [layouts, lists] = await Promise.all([api.getLayouts(), api.getPlaylists()]);
  } catch (err) { showToast(err.message, 'error'); return false; }
  // A zone plays a plain list: not this playlist, not head office's, not one holding playlists.
  lists = (lists || []).filter((p) => p.id !== playlist.id && !p.corporate && !p.has_children);
  return new Promise((resolve) => {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:1000';
    const current = item ? item.layout_ref_id : '';
    modal.innerHTML = `
      <div role="dialog" aria-modal="true" aria-labelledby="layoutItemTitle" style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:24px;width:560px;max-width:94vw;max-height:88vh;overflow:auto">
        <h3 id="layoutItemTitle" style="margin:0 0 6px;color:var(--text-primary)">${esc(item ? t('campaign.edit_title') : t('campaign.add_title'))}</h3>
        <p style="font-size:13px;color:var(--text-muted);margin:0 0 14px">${esc(t('campaign.add_intro'))}</p>
        <div class="form-group"><label for="liLayout">${esc(t('layoutpl.label'))}</label>
          <select id="liLayout" class="input" style="background:var(--bg-input)" ${item ? 'disabled' : ''}>
            ${item ? '' : `<option value="">${esc(t('campaign.pick_layout'))}</option>`}
            ${layouts.map((l) => `<option value="${esc(l.id)}" ${l.id === current ? 'selected' : ''}>${esc(l.is_template ? t('layoutpl.template_name', { name: l.name }) : l.name)} (${esc(tn('playlist.zones_count', (l.zones || []).length))})</option>`).join('')}
          </select></div>
        <div class="form-group"><label for="liDuration">${esc(t('campaign.duration'))}</label>
          <input id="liDuration" type="number" class="input" min="1" max="43200" value="${esc(String(item ? item.duration_sec : 30))}" style="width:120px" ${item ? 'disabled' : ''}>
          ${item ? `<div style="font-size:12px;color:var(--text-muted);margin-top:4px">${esc(t('campaign.duration_in_row'))}</div>` : ''}</div>
        <div id="liZones"></div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:18px">
          <button class="btn btn-secondary" id="liCancel">${esc(t('common.cancel'))}</button>
          <button class="btn btn-primary" id="liSave">${esc(item ? t('common.save') : t('campaign.add_btn'))}</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    const $ = (s) => modal.querySelector(s);
    const drawZones = () => {
      const l = layouts.find((x) => x.id === $('#liLayout').value);
      if (!l) { $('#liZones').innerHTML = ''; return; }
      const src = (item && item.zone_sources) || {};
      $('#liZones').innerHTML = `<div style="font-size:13px;font-weight:600;margin-bottom:6px">${esc(t('campaign.zones_heading'))}</div>
        ${l.zones.map((z) => `<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;flex-wrap:wrap">
          <div style="flex:1;min-width:140px;font-size:13px">${esc(z.name)} <span style="color:var(--text-muted)">${Math.round(z.width_percent)}% × ${Math.round(z.height_percent)}%</span></div>
          <select class="input li-zone" data-zone="${esc(z.id)}" aria-label="${esc(t('campaign.zone_plays', { name: z.name }))}" style="width:230px;background:var(--bg-input)">
            <option value="">${esc(t('campaign.zone_items_here'))}</option>
            ${lists.map((p) => `<option value="${esc(p.id)}" ${src[z.id] === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
          </select></div>`).join('')}
        <div style="font-size:12px;color:var(--text-muted)">${esc(t('campaign.zone_items_hint'))}</div>`;
    };
    drawZones();
    $('#liLayout').addEventListener('change', drawZones);
    const close = (v) => { modal.remove(); resolve(v); };
    $('#liCancel').addEventListener('click', () => close(false));
    modal.addEventListener('click', (e) => { if (e.target === modal) close(false); });
    modal.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(false); });
    $('#liSave').addEventListener('click', async () => {
      const layoutId = $('#liLayout').value;
      if (!layoutId) { $('#liLayout').focus(); return; }
      const zone_sources = {};
      modal.querySelectorAll('.li-zone').forEach((s) => { zone_sources[s.dataset.zone] = s.value || null; });
      try {
        $('#liSave').disabled = true;
        if (item) await api.updatePlaylistItem(playlist.id, item.id, { zone_sources });
        else await api.addPlaylistItem(playlist.id, { layout_ref_id: layoutId, duration_sec: Math.max(1, parseInt($('#liDuration').value, 10) || 30), zone_sources });
        showToast(t('campaign.toast_saved'), 'info');
        close(true);
      } catch (err) {
        $('#liSave').disabled = false;
        showToast(err.message, 'error');
      }
    });
    $('#liLayout').focus();
  });
}
