import { api } from '../api.js';
import { esc } from '../utils.js';
import { t } from '../i18n.js';
import { showToast } from './toast.js';

/*
 * Screen verification in the dashboard (server: lib/screen-verify, docs/screen-verification.md).
 *
 * One small vocabulary shared by every place a screen appears:
 *   verified | blank | frozen | unexpected | panel_off | unknown   (+ since when)
 *
 *   - Advanced device cards: a compact badge under the name (nothing at all while "unknown", so a
 *     fleet that has not been checked yet does not turn into a wall of grey labels)
 *   - device detail: the state, the panel's power/input where the player reports it, "Check now",
 *     and the screen's recent incidents
 *   - Simple view: the same state in plain words ("Showing a blank screen")
 *   - Alerts page: the workspace settings and the incident history
 *
 * Every string a player or another user could have influenced (screen names) goes through esc().
 */

const PROBLEM = new Set(['blank', 'frozen', 'unexpected', 'panel_off']);
const COLOR = { verified: 'var(--success)', blank: 'var(--danger)', frozen: 'var(--danger)', unexpected: 'var(--warning)', panel_off: 'var(--warning)', unknown: 'var(--text-muted)' };

function cachedUser() { try { return JSON.parse(localStorage.getItem('user') || 'null'); } catch { return null; } }
function currentWorkspace() {
  const u = cachedUser() || {};
  return (u.accessible_workspaces || []).find((w) => w.id === u.current_workspace_id) || null;
}
/** The server enforces both; these only decide which controls are worth drawing. */
export function canChangeVerification() {
  const u = cachedUser();
  return !(u && u.current_workspace_role === 'workspace_viewer' && !u.acting_as);
}
function canAdminVerification() { const w = currentWorkspace(); return !!(w && w.can_admin); }

export function stateLabel(s) {
  if (!s) return t('sv.state.unknown');
  if (s.state === 'panel_off' && s.scheduled) return t('sv.state.panel_off_scheduled');
  return t(`sv.state.${s.state}`);
}

/** Plain words for Simple view. null = say nothing beyond online/offline. */
export function plainStatus(s) {
  if (!s || !PROBLEM.has(s.state)) return null;
  if (s.state === 'panel_off' && s.scheduled) return t('sv.plain.asleep');
  return t(`sv.plain.${s.state}`);
}

export function ago(sec) {
  if (!sec) return '';
  const d = Math.max(0, Math.floor(Date.now() / 1000) - sec);
  if (d < 90) return t('sv.ago_now');
  if (d < 5400) return t('sv.ago_m', { n: Math.round(d / 60) });
  if (d < 172800) return t('sv.ago_h', { n: Math.round(d / 3600) });
  return t('sv.ago_d', { n: Math.round(d / 86400) });
}

/** The card badge. Empty while unknown — see the header. */
export function badgeHtml(s) {
  if (!s || s.state === 'unknown') return '';
  const icon = s.state === 'verified' ? '&#10003;' : s.state === 'panel_off' ? '&#9211;' : '&#9888;';
  const title = s.since ? `${stateLabel(s)} · ${t('sv.since', { when: ago(s.since) })}` : stateLabel(s);
  return `<span class="sv-badge" data-sv-state="${esc(s.state)}" title="${esc(title)}" style="display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:600;color:${COLOR[s.state] || COLOR.unknown}">${icon} ${esc(stateLabel(s))}</span>`;
}

/** { device_id -> state } for the current workspace; empty on any failure (a courtesy, never a blocker). */
export async function loadStates() {
  try {
    const r = await api.get('/screen-verification/states');
    return new Map((r && Array.isArray(r.states) ? r.states : []).map((s) => [s.device_id, s]));
  } catch { return new Map(); }
}

/** Fill every `[data-sv-device]` slot under root. */
export async function decorateCards(root) {
  const slots = (root || document).querySelectorAll('[data-sv-device]');
  if (!slots.length) return;
  const states = await loadStates();
  slots.forEach((el) => { el.innerHTML = badgeHtml(states.get(el.dataset.svDevice)); });
}

/** Live update from the dashboard socket ('verification-state'). */
export function applyLiveState(data) {
  if (!data || !data.device_id) return;
  document.querySelectorAll(`[data-sv-device="${CSS.escape(data.device_id)}"]`).forEach((el) => { el.innerHTML = badgeHtml(data); });
}

/* ------------------------------------------------------------------ device detail */

function incidentLine(i) {
  const dur = (i.resolved_at || Math.floor(Date.now() / 1000)) - i.opened_at;
  const mins = Math.max(1, Math.round(dur / 60));
  const end = i.resolved_at ? t(`sv.resolved.${i.resolved_reason || 'recovered'}`) : t('sv.ongoing');
  return `<div style="display:flex;gap:8px;align-items:center;font-size:12px;padding:4px 0;border-bottom:1px solid var(--border)">
    <span style="flex:none;width:9px;height:9px;border-radius:50%;background:${COLOR[i.kind] || COLOR.unknown}"></span>
    <span style="flex:1;min-width:0">${esc(t(`sv.state.${i.kind}`))}${i.device_name && i.showDevice ? ` · <strong>${esc(i.device_name)}</strong>` : ''}</span>
    <span style="color:var(--text-muted);flex:none">${esc(t('sv.incident_when', { when: ago(i.opened_at), mins }))} · ${esc(end)}</span></div>`;
}

function panelLine(p) {
  if (!p || !p.reporting) return esc(t('sv.panel.not_reporting'));
  const parts = [];
  if (p.power) parts.push(t(`sv.panel.power_${p.power}`));
  if (p.input) parts.push(t('sv.panel.input', { input: p.input }));
  if (p.source) parts.push(t(`sv.panel.source_${p.source}`));
  return esc(parts.join(' · ') || t('sv.panel.not_reporting'));
}

/** The device-detail section. `host` is an empty element; device is the detail page's device. */
export async function mountDeviceSection(host, device) {
  if (!host || !device) return;
  let data;
  try { data = await api.get(`/screen-verification/devices/${encodeURIComponent(device.id)}`); } catch { host.innerHTML = ''; return; }
  if (!document.contains(host)) return;
  const reason = data.state === 'unknown' && data.reason ? t(`sv.reason.${data.reason}`) : '';
  const canCheck = canChangeVerification() && data.reason !== 'disabled' && data.reason !== 'no_capture' && data.reason !== 'offline';
  host.innerHTML = `<div style="margin-top:20px">
    <h4 style="font-size:13px;margin-bottom:8px">${esc(t('sv.title'))}</h4>
    <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:center">
      <span style="font-size:14px;font-weight:600;color:${COLOR[data.state] || COLOR.unknown}" data-sv-device-state>${esc(stateLabel(data))}</span>
      ${data.since && data.state !== 'unknown' ? `<span style="font-size:12px;color:var(--text-muted)">${esc(t('sv.since', { when: ago(data.since) }))}</span>` : ''}
      ${reason ? `<span style="font-size:12px;color:var(--text-muted)">${esc(reason)}</span>` : ''}
      ${canCheck ? `<button class="btn btn-secondary btn-sm" id="svCheckNow">${esc(t('sv.check_now'))}</button>` : ''}
    </div>
    <div style="font-size:12px;color:var(--text-secondary);margin-top:6px">${esc(t('sv.explain.' + data.state))}</div>
    <div style="font-size:12px;color:var(--text-muted);margin-top:6px">${esc(t('sv.panel.label'))}: ${panelLine(data.panel)}${data.last_check_at ? ` · ${esc(t('sv.last_check', { when: ago(data.last_check_at) }))}` : ''}</div>
    <div style="margin-top:8px">${(data.incidents || []).length
      ? data.incidents.slice(0, 8).map(incidentLine).join('')
      : `<div style="font-size:12px;color:var(--text-muted)">${esc(t('sv.no_incidents'))}</div>`}</div>
  </div>`;
  const btn = host.querySelector('#svCheckNow');
  if (btn) {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try { await api.post(`/screen-verification/devices/${encodeURIComponent(device.id)}/check`, {}); showToast(t('sv.check_requested'), 'info'); }
      catch (e) { showToast((e && e.message) || t('common.error'), 'error'); }
      setTimeout(() => { if (document.contains(host)) mountDeviceSection(host, device); }, 8000);
    });
  }
}

/* ------------------------------------------------------------------ settings + history (Alerts page) */

export async function mountSettings(host) {
  if (!host) return;
  let s, incidents;
  try { [s, incidents] = await Promise.all([api.get('/screen-verification/settings'), api.get('/screen-verification/incidents?limit=25')]); }
  catch (e) { host.innerHTML = `<p class="corp-notice corp-notice-danger">${esc((e && e.message) || t('common.error'))}</p>`; return; }
  if (!document.contains(host)) return;
  const admin = canAdminVerification();
  const dis = admin ? '' : 'disabled';
  const cadences = [0, 15, 30, 60, 120, 240];
  if (!cadences.includes(s.cadence_minutes)) cadences.push(s.cadence_minutes);
  const ch = s.channels || { total: 0, subscribed: 0 };
  host.innerHTML = `<div class="corp-card" style="margin-bottom:16px;padding:16px">
    <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center">
      <strong>${esc(t('sv.title'))}</strong>
      <label style="display:flex;gap:8px;align-items:center;font-size:13px"><input type="checkbox" id="svEnabled" ${s.enabled ? 'checked' : ''} ${dis}> ${esc(t('sv.f.enabled'))}</label>
    </div>
    <div class="corp-help" style="font-size:12px;margin-top:6px">${esc(t('sv.intro'))}</div>
    <div style="display:flex;flex-wrap:wrap;gap:16px;margin-top:12px">
      <div class="form-group" style="margin:0;min-width:200px"><label>${esc(t('sv.f.cadence'))}</label>
        <select id="svCadence" class="input" ${dis}>${cadences.sort((a, b) => a - b).map((m) => `<option value="${m}" ${m === s.cadence_minutes ? 'selected' : ''}>${esc(m === 0 ? t('sv.f.cadence_off') : t('sv.f.cadence_every', { n: m }))}</option>`).join('')}</select></div>
      <div class="form-group" style="margin:0;min-width:160px"><label>${esc(t('sv.f.sensitivity'))}</label>
        <select id="svSens" class="input" ${dis}>${(s.sensitivities || ['low', 'normal', 'high']).map((v) => `<option value="${esc(v)}" ${v === s.sensitivity ? 'selected' : ''}>${esc(t(`sv.f.sens_${v}`))}</option>`).join('')}</select></div>
      <div class="form-group" style="margin:0;min-width:160px"><label>${esc(t('sv.f.persist'))}</label>
        <input id="svPersist" type="number" min="2" max="240" class="input" value="${esc(s.persist_minutes)}" style="width:100px" ${dis}></div>
    </div>
    <div class="form-group" style="margin-top:12px"><label>${esc(t('sv.f.alert_checks'))}</label>
      <div style="display:flex;flex-wrap:wrap;gap:12px">${(s.checks || []).map((c) => `<label style="display:flex;gap:6px;font-size:13px"><input type="checkbox" class="sv-check" value="${esc(c)}" ${s.alert_checks.includes(c) ? 'checked' : ''} ${dis}> ${esc(t(`sv.state.${c}`))}</label>`).join('')}</div>
      <div class="corp-help" style="font-size:12px;margin-top:4px">${esc(ch.subscribed ? t('sv.f.channels', { n: ch.subscribed, total: ch.total }) : t('sv.f.no_channels'))}</div></div>
    <div class="corp-help" style="font-size:12px">${esc(t('sv.f.privacy'))}</div>
    ${admin ? `<div style="display:flex;justify-content:flex-end;margin-top:8px"><button class="btn btn-primary btn-sm" id="svSave">${esc(t('common.save'))}</button></div>`
      : `<div class="corp-help" style="font-size:12px;margin-top:8px">${esc(t('sv.f.admin_only'))}</div>`}
  </div>
  <div class="corp-card" style="margin-bottom:16px;padding:16px">
    <strong>${esc(t('sv.history'))}</strong>
    <div style="margin-top:8px">${(incidents || []).length ? incidents.map((i) => incidentLine({ ...i, showDevice: true })).join('') : `<div class="corp-help" style="font-size:12px">${esc(t('sv.no_incidents'))}</div>`}</div>
  </div>`;
  const save = host.querySelector('#svSave');
  if (save) {
    save.addEventListener('click', async () => {
      save.disabled = true;
      const body = {
        enabled: host.querySelector('#svEnabled').checked,
        cadence_minutes: Number(host.querySelector('#svCadence').value),
        sensitivity: host.querySelector('#svSens').value,
        persist_minutes: Number(host.querySelector('#svPersist').value),
        alert_checks: [...host.querySelectorAll('.sv-check:checked')].map((i) => i.value),
      };
      try { await api.put('/screen-verification/settings', body); showToast(t('sv.saved'), 'success'); mountSettings(host); }
      catch (e) { showToast((e && e.message) || t('common.error'), 'error'); save.disabled = false; }
    });
  }
}
