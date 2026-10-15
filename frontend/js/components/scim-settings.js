/*
 * Settings > User provisioning (SCIM): server/routes/org-scim.js, docs/scim.md.
 *
 * Org owners and admins only; the server answers 404 to anyone else and this card then stays hidden.
 * What an admin needs to connect Okta or Entra ID is all here: the on/off switch, the base URL to
 * paste, a token shown exactly once, which IdP group grants which workspace role, and what the IdP
 * has been doing.
 *
 * ⚠️ THE TOKEN IS SHOWN ONCE. It is in the mint response and nowhere else — the server keeps only its
 * hash — so the box that shows it says so, and it is gone on the next reload.
 *
 * Escaping follows the SPA rule: values are stored raw and esc()'d where they are rendered. Group
 * names, user names and event details all come from the identity provider, i.e. from outside.
 */
import { api } from '../api.js';
import { esc } from '../utils.js';
import { t } from '../i18n.js';
import { showToast } from './toast.js';

// Literal keys (the i18n-keys-exist test reads them).
const ROLE_LABEL = {
  workspace_admin: () => t('members.role.workspace_admin'),
  workspace_editor: () => t('members.role.workspace_editor'),
  workspace_viewer: () => t('members.role.workspace_viewer'),
};
const ACTION_LABEL = {
  'user.create': () => t('scim.ev_user_create'),
  'user.replace': () => t('scim.ev_user_update'),
  'user.patch': () => t('scim.ev_user_update'),
  'user.delete': () => t('scim.ev_user_delete'),
  'user.post': () => t('scim.ev_user_create'),
  'user.put': () => t('scim.ev_user_update'),
  'group.create': () => t('scim.ev_group_create'),
  'group.replace': () => t('scim.ev_group_update'),
  'group.patch': () => t('scim.ev_group_update'),
  'group.delete': () => t('scim.ev_group_delete'),
  'group.post': () => t('scim.ev_group_create'),
  'group.put': () => t('scim.ev_group_update'),
  'token.created': () => t('scim.ev_token_created'),
  'token.revoked': () => t('scim.ev_token_revoked'),
  'mapping.set': () => t('scim.ev_mapping_set'),
  'mapping.removed': () => t('scim.ev_mapping_removed'),
  'settings.enabled': () => t('scim.ev_enabled'),
  'settings.disabled': () => t('scim.ev_disabled'),
};
const DETAIL_LABEL = {
  deactivated: () => t('scim.detail_deactivated'),
  reactivated: () => t('scim.detail_reactivated'),
  'created inactive': () => t('scim.detail_deactivated'),
  account_deleted: () => t('scim.detail_account_deleted'),
  account_disabled: () => t('scim.detail_account_disabled'),
  access_removed: () => t('scim.detail_access_removed'),
};
const when = (s) => (s ? new Date(s * 1000).toLocaleString() : t('scim.never'));
const muted = 'color:var(--text-muted);font-size:12px';
const box = 'border:1px solid var(--border);border-radius:var(--radius);padding:12px;margin-bottom:8px';

export async function mountScimSettings(host, orgId) {
  if (!host || !orgId) return;
  const base = `/organizations/${encodeURIComponent(orgId)}/scim`;
  let data;
  try { data = await api.get(base); } catch (_) { host.style.display = 'none'; return; }
  host.style.display = '';
  let freshToken = null;   // the one-time plaintext, held only until the next reload of the card

  async function reload(next) {
    if (next) { data = next; render(); return; }
    try { data = await api.get(base); } catch (err) { showToast(err.message, 'error'); return; }
    render();
  }

  const roleOptions = (sel) => data.roles.map((r) => `<option value="${esc(r)}" ${r === sel ? 'selected' : ''}>${esc(ROLE_LABEL[r] ? ROLE_LABEL[r]() : r)}</option>`).join('');
  const wsOptions = (sel, blank) => `${blank ? `<option value="">${esc(blank)}</option>` : ''}${data.workspaces.map((w) => `<option value="${esc(w.id)}" ${w.id === sel ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}`;

  function render() {
    const ready = data.verified_domains.length > 0;
    const live = data.tokens.filter((tk) => !tk.revoked_at);
    host.innerHTML = `
      <h3>${esc(t('scim.title'))}</h3>
      <p style="${muted};margin-bottom:8px">${esc(t('scim.blurb'))}</p>
      ${ready ? '' : `<div style="${box};font-size:13px">⚠️ ${esc(t('scim.needs_sso'))}</div>`}
      <label style="display:flex;align-items:center;gap:8px;margin:8px 0">
        <input type="checkbox" data-scim="enabled" ${data.enabled ? 'checked' : ''} ${!ready && !data.enabled ? 'disabled' : ''}>
        <span>${esc(t('scim.enable'))}</span>
      </label>
      <p style="${muted}">${esc(data.enabled ? t('scim.status_on') : t('scim.status_off'))}</p>

      <div style="margin-top:12px">
        <div style="font-weight:600;font-size:13px">${esc(t('scim.base_url'))}</div>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:4px">
          <code style="user-select:all;word-break:break-all;font-size:12px">${esc(data.base_url)}</code>
          <button class="btn btn-secondary btn-sm" data-scim="copy-url">${esc(t('scim.copy'))}</button>
        </div>
        <div style="${muted};margin-top:4px">${esc(t('scim.base_url_hint'))}</div>
        ${ready ? `<div style="${muted};margin-top:4px">${esc(t('scim.domains'))}: ${esc(data.verified_domains.join(', '))}</div>` : ''}
      </div>

      <div style="margin-top:16px">
        <div style="font-weight:600;font-size:13px">${esc(t('scim.tokens'))}</div>
        ${freshToken ? `
          <div style="${box};margin-top:6px;border-color:var(--warning,#b45309)">
            <div style="font-size:13px;margin-bottom:6px">${esc(t('scim.token_once'))}</div>
            <code style="user-select:all;word-break:break-all;font-size:12px" data-scim="fresh">${esc(freshToken)}</code>
            <div style="margin-top:6px"><button class="btn btn-secondary btn-sm" data-scim="copy-token">${esc(t('scim.copy'))}</button></div>
          </div>` : ''}
        ${data.tokens.length ? data.tokens.map((tk) => `
          <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px">
            <div style="min-width:0">
              <code>${esc(tk.prefix)}…</code> · ${esc(tk.name)}
              <div style="${muted}">${esc(t('scim.token_created'))} ${esc(when(tk.created_at))}${tk.created_by_email ? ` · ${esc(tk.created_by_email)}` : ''}
                · ${esc(t('scim.token_last_used'))} ${esc(when(tk.last_used_at))}</div>
            </div>
            ${tk.revoked_at
    ? `<span style="${muted}">${esc(t('scim.token_revoked'))} ${esc(when(tk.revoked_at))}</span>`
    : `<button class="btn btn-danger btn-sm" data-scim-revoke="${esc(tk.id)}">${esc(t('scim.revoke'))}</button>`}
          </div>`).join('') : `<p style="${muted}">${esc(t('scim.no_tokens'))}</p>`}
        <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;align-items:center">
          <input class="input" data-scim="token-name" placeholder="${esc(t('scim.token_name_ph'))}" style="max-width:240px" maxlength="100">
          <button class="btn btn-primary btn-sm" data-scim="mint" ${live.length >= 5 ? 'disabled' : ''}>${esc(t('scim.create_token'))}</button>
        </div>
      </div>

      <div style="margin-top:16px">
        <div style="font-weight:600;font-size:13px">${esc(t('scim.default_access'))}</div>
        <div style="${muted};margin-bottom:6px">${esc(t('scim.default_access_hint'))}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <select class="input" data-scim="default-ws" style="max-width:240px">${wsOptions(data.default_workspace_id, t('scim.no_default'))}</select>
          <select class="input" data-scim="default-role" style="max-width:200px">${roleOptions(data.default_role || 'workspace_viewer')}</select>
          <button class="btn btn-secondary btn-sm" data-scim="save-default">${esc(t('scim.save'))}</button>
        </div>
      </div>

      <div style="margin-top:16px">
        <div style="font-weight:600;font-size:13px">${esc(t('scim.groups'))}</div>
        <div style="${muted};margin-bottom:6px">${esc(t('scim.groups_hint'))}</div>
        ${data.groups.length ? data.groups.map((g) => `
          <div style="${box}">
            <div><strong>${esc(g.display_name)}</strong> <span style="${muted}">· ${esc(t('scim.members_count', { n: g.member_count }))}</span></div>
            ${g.mappings.map((m) => `
              <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;font-size:13px;margin-top:6px">
                <span>${esc(m.workspace_name)} — ${esc(ROLE_LABEL[m.role] ? ROLE_LABEL[m.role]() : m.role)}</span>
                <button class="btn btn-secondary btn-sm" data-scim-unmap="${esc(m.id)}">${esc(t('scim.remove'))}</button>
              </div>`).join('') || `<div style="${muted};margin-top:6px">${esc(t('scim.no_mappings'))}</div>`}
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
              <select class="input" data-scim-map-ws="${esc(g.id)}" style="max-width:220px">${wsOptions(null)}</select>
              <select class="input" data-scim-map-role="${esc(g.id)}" style="max-width:180px">${roleOptions('workspace_viewer')}</select>
              <button class="btn btn-secondary btn-sm" data-scim-map="${esc(g.id)}">${esc(t('scim.add_mapping'))}</button>
            </div>
          </div>`).join('') : `<p style="${muted}">${esc(t('scim.no_groups'))}</p>`}
      </div>

      <details style="margin-top:12px" data-scim="users-box">
        <summary style="cursor:pointer;font-size:13px">${esc(t('scim.users', { n: data.counts.users, active: data.counts.active_users }))}</summary>
        <div data-scim="users" style="margin-top:8px;font-size:13px"></div>
      </details>
      <details style="margin-top:8px" data-scim="events-box">
        <summary style="cursor:pointer;font-size:13px">${esc(t('scim.activity'))}</summary>
        <div data-scim="events" style="margin-top:8px;font-size:12px"></div>
      </details>`;
    wire();
  }

  function wire() {
    const q = (sel) => host.querySelector(sel);
    q('[data-scim="enabled"]').addEventListener('change', async (e) => {
      try { await reload(await api.put(base, { enabled: e.target.checked })); } catch (err) { showToast(err.message, 'error'); e.target.checked = !e.target.checked; }
    });
    const copy = async (text) => { try { await navigator.clipboard.writeText(text); showToast(t('scim.copied'), 'success'); } catch { /* user-select:all is the fallback */ } };
    q('[data-scim="copy-url"]').addEventListener('click', () => copy(data.base_url));
    const ct = q('[data-scim="copy-token"]');
    if (ct) ct.addEventListener('click', () => copy(freshToken));
    q('[data-scim="mint"]').addEventListener('click', async () => {
      try {
        const r = await api.post(`${base}/tokens`, { name: q('[data-scim="token-name"]').value.trim() });
        freshToken = r.token;
      } catch (err) { showToast(err.message, 'error'); return; }
      reload();
    });
    host.querySelectorAll('[data-scim-revoke]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm(t('scim.confirm_revoke'))) return;
      try { await api.delete(`${base}/tokens/${encodeURIComponent(b.dataset.scimRevoke)}`); } catch (err) { showToast(err.message, 'error'); return; }
      freshToken = null;
      reload();
    }));
    q('[data-scim="save-default"]').addEventListener('click', async () => {
      const ws = q('[data-scim="default-ws"]').value;
      try {
        await reload(await api.put(base, { default_workspace_id: ws || null, default_role: ws ? q('[data-scim="default-role"]').value : null }));
        showToast(t('scim.saved'), 'success');
      } catch (err) { showToast(err.message, 'error'); }
    });
    host.querySelectorAll('[data-scim-map]').forEach((b) => b.addEventListener('click', async () => {
      const gid = b.dataset.scimMap;
      const ws = host.querySelector(`[data-scim-map-ws="${CSS.escape(gid)}"]`).value;
      const role = host.querySelector(`[data-scim-map-role="${CSS.escape(gid)}"]`).value;
      if (!ws) return;
      try { await reload(await api.post(`${base}/mappings`, { group_id: gid, workspace_id: ws, role })); } catch (err) { showToast(err.message, 'error'); }
    }));
    host.querySelectorAll('[data-scim-unmap]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm(t('scim.confirm_unmap'))) return;
      try { await reload(await api.delete(`${base}/mappings/${encodeURIComponent(b.dataset.scimUnmap)}`)); } catch (err) { showToast(err.message, 'error'); }
    }));
    q('[data-scim="users-box"]').addEventListener('toggle', async (e) => {
      if (!e.target.open) return;
      const out = q('[data-scim="users"]');
      try {
        const { users } = await api.get(`${base}/users`);
        out.innerHTML = users.length ? users.map((u) => `
          <div style="padding:4px 0;border-bottom:1px solid var(--border)">
            ${esc(u.user_name)}${u.email && u.email !== u.user_name ? ` <span style="${muted}">${esc(u.email)}</span>` : ''}
            <span style="${muted}"> · ${esc(u.active ? t('scim.user_active') : t('scim.user_inactive'))}</span>
          </div>`).join('') : `<p style="${muted}">${esc(t('scim.no_users'))}</p>`;
      } catch (err) { out.textContent = err.message; }
    });
    q('[data-scim="events-box"]').addEventListener('toggle', async (e) => {
      if (!e.target.open) return;
      const out = q('[data-scim="events"]');
      try {
        const { events } = await api.get(`${base}/events?limit=100`);
        out.innerHTML = events.length ? events.map((ev) => {
          const failed = ev.status >= 400;
          const what = ACTION_LABEL[ev.action] ? ACTION_LABEL[ev.action]() : ev.action;
          const label = failed ? t('scim.ev_failed', { what }) : what;
          const detail = ev.detail ? (DETAIL_LABEL[ev.detail] ? DETAIL_LABEL[ev.detail]() : ev.detail) : '';
          return `<div style="padding:4px 0;border-bottom:1px solid var(--border)">
            <span style="color:var(--text-muted)">${esc(when(ev.created_at))}</span>
            ${failed ? '❌' : '✓'} ${esc(label)}${ev.resource ? ` — ${esc(ev.resource)}` : ''}
            ${detail ? `<span style="color:${failed ? 'var(--danger,#b91c1c)' : 'var(--text-muted)'}"> · ${esc(detail)}</span>` : ''}
          </div>`;
        }).join('') : `<p style="${muted}">${esc(t('scim.no_activity'))}</p>`;
      } catch (err) { out.textContent = err.message; }
    });
  }

  render();
}
