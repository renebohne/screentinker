/*
 * 3.0 "Your data, provably" — Settings → Data & privacy (#/privacy). docs/trust.md.
 *
 * Organization owners and admins see their organization's data handling report (built from the
 * running configuration), the hosts this server contacted on the organization's behalf, the
 * complete organization export, and — owners only — "delete everything". Everyone else sees the
 * personal export, which is theirs whatever their role.
 */
import { api } from '../api.js';
import { esc } from '../utils.js';
import { t } from '../i18n.js';
import { reportHtml, mountOutbound, mountExports, mountDeletion, stopPolling, section } from '../components/trust-report.js';
import { mountMoveSection } from '../components/org-move.js';

export async function render(container) {
  container.innerHTML = `
    <div class="page-header">
      <div><h1>${esc(t('trust.title'))}</h1><div class="subtitle">${esc(t('trust.subtitle'))}</div></div>
      <div><a class="btn btn-secondary" href="#/settings">${esc(t('trust.back_settings'))}</a></div>
    </div>
    <div id="trustBody"><p class="trust-muted">${esc(t('common.loading'))}</p></div>`;
  const body = container.querySelector('#trustBody');

  let report = null;
  try { report = await api.get('/trust/report'); } catch (e) { report = null; }

  if (!report) {
    // Not an organization admin (or no organization): their own data is still theirs to take.
    body.innerHTML = `
      ${section(t('trust.exp.title'), '<div id="trustExports"></div>', t('trust.exp.personal_desc'))}
      <p class="trust-muted">${esc(t('trust.org_admins_only'))}</p>`;
    await mountExports(body.querySelector('#trustExports'), { canOrg: false });
    return;
  }

  const orgName = report.organization ? String(report.organization.name || '') : '';
  body.innerHTML = `
    <p class="trust-desc">${esc(t('trust.org_intro', { name: orgName }))}</p>
    ${reportHtml(report)}
    ${section(t('trust.out.title'), '<div id="trustOutbound"></div>', t('trust.out.desc_org'))}
    ${section(t('trust.exp.title'), '<div id="trustExports"></div>', t('trust.exp.desc'))}
    ${section(t('imp.move.title'), '<div id="trustMove"></div>')}
    ${section(t('trust.del.title'), '<div id="trustDeletion"></div>')}`;
  // 3.0 move an organization to another server (components/org-move.js, docs/move-server.md).
  mountMoveSection(body.querySelector('#trustMove'));
  await Promise.all([
    mountOutbound(body.querySelector('#trustOutbound')),
    mountExports(body.querySelector('#trustExports'), { canOrg: true }),
    mountDeletion(body.querySelector('#trustDeletion'), report),
  ]);
}

export function cleanup() { stopPolling(); }
