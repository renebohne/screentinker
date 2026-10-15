/*
 * 3.0 "Import an organization" (#/org-import) — and, for platform admins, "Import the whole server"
 * (#/org-import?kind=instance). docs/move-server.md; server: routes/org-import.js.
 *
 * A guide, one question at a time:
 *   1 bring it in   pull from the old server (its download link), upload the file (resumable), or —
 *                   platform admins — pick a file already in this server's imports folder
 *   2 check         what is in it, what fits, what will not come across and why
 *   3 choose        a new organization (default) or an empty one; which history to bring
 *   4 import        progress; on failure it rolls back by itself
 *   5 people        invites (links to copy, or emails when this server can send them)
 *   6 screens       hand them over from the old server, or link / pair them here
 *   7 reconnect     the integrations whose secrets never travel
 *
 * The page is driven by the job's status, so a reload (or another tab) lands on the right step.
 */
import { api } from '../api.js';
import { esc } from '../utils.js';
import { t } from '../i18n.js';
import { showToast } from '../components/toast.js';
import { fmtBytes } from '../components/trust-report.js';
import { copy, sendChunk } from '../components/org-move.js';

let timer = null;
let uploading = null;      // { jobId, file } while this tab is sending chunks

function tk(key, fallback) { const v = t(key); return v === key ? fallback : v; }
const params = () => new URLSearchParams((window.location.hash.split('?')[1]) || '');
const when = (sec) => (sec ? new Date(sec * 1000).toLocaleString() : '—');

const STEPS = ['bring', 'check', 'choose', 'import', 'people', 'screens', 'reconnect'];
function stepOf(job) {
  if (!job) return 'bring';
  if (['receiving', 'fetching', 'interrupted'].includes(job.status)) return 'bring';
  if (['scanning', 'refused'].includes(job.status)) return 'check';
  if (job.status === 'scanned') return 'choose';
  if (['restoring', 'failed', 'partial'].includes(job.status)) return 'import';
  return 'people';
}
function stepper(current, instance) {
  const steps = instance ? ['bring', 'check', 'choose', 'import', 'people'] : STEPS;
  const at = steps.indexOf(current);
  return `<ol class="imp-steps">${steps.map((s, i) => `<li class="${i < at ? 'done' : i === at ? 'now' : ''}">${esc(t(`imp.step.${s}`))}</li>`).join('')}</ol>`;
}

export async function render(container) {
  stop();
  const instance = params().get('kind') === 'instance';
  container.innerHTML = `
    <div class="page-header">
      <div><h1>${esc(instance ? t('imp.title_server') : t('imp.title'))}</h1>
        <div class="subtitle">${esc(instance ? t('imp.subtitle_server') : t('imp.subtitle'))}</div></div>
      <div><a class="btn btn-secondary" href="${instance ? '#/platform/privacy' : '#/privacy'}">${esc(t('imp.back'))}</a></div>
    </div>
    <div id="impBody"><p class="trust-muted">${esc(t('common.loading'))}</p></div>`;
  const body = container.querySelector('#impBody');
  let ctx;
  try { ctx = await api.get('/org-import/context'); } catch (e) { body.innerHTML = `<p class="trust-muted">${esc(e.message)}</p>`; return; }
  if (!ctx.can_import || (instance && !ctx.platform_admin)) {
    body.innerHTML = `<div class="settings-section"><p class="trust-desc">${esc(instance ? t('imp.platform_only') : t('imp.admins_only'))}</p></div>`;
    return;
  }
  const jobId = params().get('job');
  if (jobId) return showJob(body, ctx, jobId, instance);
  return showStart(body, ctx, instance);
}

export function cleanup() { stop(); }
function stop() { if (timer) { clearTimeout(timer); timer = null; } }

/* ───────────── step 1: bring it in ───────────── */

async function showStart(body, ctx, instance) {
  let jobs = [];
  try { jobs = (await api.get(`/org-import/jobs${instance ? '?scope=instance' : ''}`)).jobs || []; } catch { jobs = []; }
  const recent = jobs.length ? `
    <div class="settings-section"><h3>${esc(t('imp.recent'))}</h3>
      <div class="table-wrap"><table class="att-table"><tbody>
      ${jobs.map((j) => `<tr><td>${esc((j.scan && j.scan.organization && j.scan.organization.name) || j.file_name || j.source_host || j.id.slice(0, 8))}</td>
        <td><span class="trust-pill">${esc(tk(`imp.status.${j.status}`, j.status))}</span></td><td>${esc(when(j.created_at))}</td>
        <td><a class="btn btn-secondary btn-sm" href="#/org-import?${instance ? 'kind=instance&' : ''}job=${encodeURIComponent(j.id)}">${esc(t('imp.open'))}</a></td></tr>`).join('')}
      </tbody></table></div></div>` : '';
  body.innerHTML = `
    ${stepper('bring', instance)}
    <div class="settings-section">
      <h3>${esc(t('imp.bring.title'))}</h3>
      <p class="trust-desc">${esc(instance ? t('imp.bring.desc_server') : t('imp.bring.desc'))}</p>
      <div class="imp-choices">
        <button type="button" class="imp-choice" data-src="pull"><strong>${esc(t('imp.bring.pull'))}</strong><span>${esc(t('imp.bring.pull_desc'))}</span></button>
        <button type="button" class="imp-choice" data-src="upload"><strong>${esc(t('imp.bring.upload'))}</strong><span>${esc(t('imp.bring.upload_desc'))}</span></button>
        ${ctx.platform_admin ? `<button type="button" class="imp-choice" data-src="disk"><strong>${esc(t('imp.bring.disk'))}</strong><span>${esc(t('imp.bring.disk_desc'))}</span></button>` : ''}
      </div>
      <div id="impSource"></div>
      <p class="trust-muted">${esc(t('imp.bring.recovery'))}</p>
    </div>
    ${recent}`;
  const src = body.querySelector('#impSource');
  body.querySelectorAll('[data-src]').forEach((b) => b.addEventListener('click', () => {
    body.querySelectorAll('[data-src]').forEach((x) => x.classList.toggle('active', x === b));
    if (b.dataset.src === 'pull') pullForm(src, instance);
    else if (b.dataset.src === 'upload') uploadForm(src, instance);
    else diskForm(src, ctx, instance);
  }));
}

function goJob(id, instance) {
  const next = `#/org-import?${instance ? 'kind=instance&' : ''}job=${encodeURIComponent(id)}`;
  // Already there (a resumed upload): the router only runs on a change, so ask it to.
  if (window.location.hash === next) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else window.location.hash = next;
}

function pullForm(el, instance) {
  el.innerHTML = `
    <div class="imp-card">
      <label for="impUrl">${esc(t('imp.pull.label'))}</label>
      <input id="impUrl" class="input" type="url" autocomplete="off" placeholder="https://old.example.com/api/public/${instance ? 'instance' : 'trust'}-export/…?key=…" style="width:100%">
      <p class="trust-muted">${esc(instance ? t('imp.pull.help_server') : t('imp.pull.help'))}</p>
      <button type="button" class="btn btn-primary" id="impPullGo">${esc(t('imp.pull.go'))}</button>
    </div>`;
  el.querySelector('#impPullGo').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const job = await api.post('/org-import/jobs', { source: 'pull', kind: instance ? 'instance' : 'org', url: el.querySelector('#impUrl').value.trim() });
      goJob(job.id, instance);
    } catch (err) { showToast(err.message, 'error'); e.target.disabled = false; }
  });
}

function uploadForm(el, instance, resumeJob = null) {
  el.innerHTML = `
    <div class="imp-card">
      <p class="trust-desc">${esc(resumeJob ? t('imp.upload.resume', { name: resumeJob.file_name || '' }) : t('imp.upload.desc'))}</p>
      <label class="btn btn-primary">${esc(t('imp.upload.choose'))}<input type="file" accept=".zip,application/zip" hidden id="impFile"></label>
      <div id="impUpProgress"></div>
    </div>`;
  el.querySelector('#impFile').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      let job = resumeJob;
      if (job && (file.size !== job.declared_bytes)) { showToast(t('imp.upload.not_same'), 'error'); return; }
      if (!job) job = await api.post('/org-import/jobs', { source: 'upload', kind: instance ? 'instance' : 'org', bytes: file.size, file_name: file.name });
      await sendFile(job.id, file, el.querySelector('#impUpProgress'), job.offset || 0);
      goJob(job.id, instance);
    } catch (err) { showToast(err.message, 'error'); }
  });
}

async function sendFile(jobId, file, progressEl, start) {
  const ctxChunk = 8 * 1024 * 1024;
  let offset = start;
  uploading = { jobId };
  const draw = () => { progressEl.innerHTML = bar(offset, file.size, t('imp.upload.sending', { done: fmtBytes(offset), total: fmtBytes(file.size) })); };
  draw();
  let failures = 0;
  while (offset < file.size) {
    try {
      const r = await sendChunk(jobId, offset, file.slice(offset, Math.min(offset + ctxChunk, file.size)));
      offset = r.offset;
      failures = 0;
      draw();
    } catch (err) {
      // A dropped request costs one chunk: ask again from where the server says the file ends.
      if (++failures > 5 || (err.status && err.status < 500 && err.status !== 409)) { uploading = null; throw err; }
      await new Promise((r) => setTimeout(r, 1500 * failures));
    }
  }
  uploading = null;
}

async function diskForm(el, ctx, instance) {
  el.innerHTML = `<p class="trust-muted">${esc(t('common.loading'))}</p>`;
  let d;
  try { d = await api.get('/org-import/disk'); } catch (e) { el.innerHTML = `<p class="trust-muted">${esc(e.message)}</p>`; return; }
  el.innerHTML = `
    <div class="imp-card">
      <p class="trust-desc">${esc(t('imp.disk.desc'))} <code>${esc(d.folder)}</code></p>
      ${d.files.length ? `<div class="table-wrap"><table class="att-table"><tbody>
        ${d.files.map((f) => `<tr><td><code>${esc(f.name)}</code></td><td>${esc(fmtBytes(f.bytes))}</td><td>${esc(when(f.modified_at))}</td>
          <td><button type="button" class="btn btn-primary btn-sm" data-disk="${esc(f.name)}">${esc(t('imp.disk.use'))}</button></td></tr>`).join('')}
      </tbody></table></div>` : `<p class="trust-muted">${esc(t('imp.disk.none'))}</p>`}
    </div>`;
  el.querySelectorAll('[data-disk]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try { goJob((await api.post('/org-import/jobs', { source: 'disk', kind: instance ? 'instance' : 'org', disk_name: b.dataset.disk })).id, instance); }
    catch (err) { showToast(err.message, 'error'); b.disabled = false; }
  }));
}

function bar(done, total, label) {
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return `<div class="imp-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${pct}%"></span></div>
    <p class="trust-muted">${esc(label)}</p>`;
}

/* ───────────── the job, at whatever step it is ───────────── */

async function showJob(body, ctx, jobId, instance) {
  stop();
  let job;
  try { job = await api.get(`/org-import/jobs/${encodeURIComponent(jobId)}`); }
  catch (e) { body.innerHTML = `<p class="trust-muted">${esc(e.message)}</p>`; return; }
  const isInstance = job.kind === 'instance';
  const step = stepOf(job);
  const head = stepper(step, isInstance);
  const again = () => { timer = setTimeout(() => { if (document.body.contains(body)) showJob(body, ctx, jobId, instance); }, 2000); };
  const p = job.progress || {};

  if (job.status === 'receiving') {
    if (uploading && uploading.jobId === job.id) { again(); return; }
    body.innerHTML = `${head}<div class="settings-section" id="impResume"></div>`;
    uploadForm(body.querySelector('#impResume'), isInstance, job);
    return;
  }
  if (job.status === 'fetching' || job.status === 'scanning') {
    const label = job.status === 'fetching'
      ? t('imp.fetch.progress', { done: fmtBytes(p.bytes || 0), total: p.total ? fmtBytes(p.total) : '?', host: job.source_host || '' })
      : t('imp.scan.progress', { done: p.done || 0, total: p.total || '?' });
    body.innerHTML = `${head}<div class="settings-section"><h3>${esc(job.status === 'fetching' ? t('imp.fetch.title') : t('imp.scan.title'))}</h3>
      ${bar(job.status === 'fetching' ? (p.bytes || 0) : (p.done || 0), job.status === 'fetching' ? (p.total || 0) : (p.total || 0), label)}
      <p class="trust-muted">${esc(t('imp.scan.desc'))}</p>${cancelBtn()}</div>`;
    wireCancel(body, job, instance);
    again();
    return;
  }
  if (job.status === 'interrupted') {
    body.innerHTML = `${head}<div class="settings-section"><h3>${esc(t('imp.interrupted.title'))}</h3>
      <p class="trust-desc">${esc(job.error || '')}</p><p class="trust-desc">${esc(t('imp.interrupted.desc'))}</p>
      <input id="impRelink" class="input" type="url" autocomplete="off" style="width:100%">
      <div class="trust-toolbar" style="margin-top:8px"><button type="button" class="btn btn-primary" id="impRelinkGo">${esc(t('imp.interrupted.go'))}</button>${cancelBtn()}</div></div>`;
    body.querySelector('#impRelinkGo').addEventListener('click', async () => {
      try { await api.post(`/org-import/jobs/${encodeURIComponent(job.id)}/link`, { url: body.querySelector('#impRelink').value.trim() }); showJob(body, ctx, jobId, instance); }
      catch (err) { showToast(err.message, 'error'); }
    });
    wireCancel(body, job, instance);
    return;
  }
  if (job.status === 'refused' || job.status === 'cancelled') {
    body.innerHTML = `${head}<div class="settings-section"><h3>${esc(job.status === 'refused' ? t('imp.refused.title') : t('imp.cancelled.title'))}</h3>
      ${job.error ? `<div class="trust-residency leaves"><div>${esc(job.error)}</div></div>` : ''}
      <p class="trust-desc">${esc(t('imp.refused.desc'))}</p>
      <a class="btn btn-primary" href="#/org-import${isInstance ? '?kind=instance' : ''}">${esc(t('imp.start_again'))}</a></div>`;
    return;
  }
  if (job.status === 'scanned') return isInstance ? showBundleChoice(body, head, job, instance) : showChoice(body, head, ctx, job, instance);
  if (job.status === 'restoring') {
    const label = isInstance ? t('imp.restore.server_progress', { done: p.done || 0 })
      : t('imp.restore.progress', { done: p.rows_done || 0, total: p.rows_total || '?', table: p.table || '' });
    body.innerHTML = `${head}<div class="settings-section"><h3>${esc(t('imp.restore.title'))}</h3>
      ${bar(p.rows_done || 0, p.rows_total || 0, label)}<p class="trust-muted">${esc(t('imp.restore.desc'))}</p></div>`;
    again();
    return;
  }
  if (job.status === 'failed' || job.status === 'partial') {
    body.innerHTML = `${head}<div class="settings-section"><h3>${esc(job.status === 'failed' ? t('imp.failed.title') : t('imp.partial.title'))}</h3>
      <div class="trust-residency leaves"><div>${esc(job.error || '')}</div></div>
      <p class="trust-desc">${esc(job.status === 'failed' ? t('imp.failed.desc') : t('imp.partial.desc'))}</p>
      ${job.status === 'partial' ? `<button type="button" class="btn btn-danger" id="impDiscard">${esc(t('imp.partial.delete'))}</button>` : ''}
      <a class="btn btn-secondary" href="#/org-import${isInstance ? '?kind=instance' : ''}">${esc(t('imp.start_again'))}</a></div>`;
    body.querySelector('#impDiscard')?.addEventListener('click', async () => {
      try { await api.post(`/org-import/jobs/${encodeURIComponent(job.id)}/discard-partial`); showJob(body, ctx, jobId, instance); }
      catch (err) { showToast(err.message, 'error'); }
    });
    return;
  }
  if (job.status === 'done') return isInstance ? showBundleDone(body, head, job) : showDone(body, ctx, job);
}

const cancelBtn = () => `<button type="button" class="btn btn-secondary btn-sm" id="impCancel">${esc(t('imp.cancel'))}</button>`;
function wireCancel(body, job, instance) {
  body.querySelector('#impCancel')?.addEventListener('click', async () => {
    try { await api.post(`/org-import/jobs/${encodeURIComponent(job.id)}/cancel`); window.location.hash = `#/org-import${instance ? '?kind=instance' : ''}`; }
    catch (err) { showToast(err.message, 'error'); }
  });
}

/* ───────────── steps 2 and 3: what is in it, and where it goes ───────────── */

function roomHtml(room) {
  if (!room) return '';
  const rows = [];
  rows.push(`<dt>${esc(t('imp.check.media'))}</dt><dd>${esc(fmtBytes(room.need_bytes || 0))}</dd>`);
  if (room.plan_room_bytes != null) rows.push(`<dt>${esc(t('imp.check.plan_room'))}</dt><dd>${esc(fmtBytes(Math.max(0, room.plan_room_bytes)))}</dd>`);
  if (room.disk_free_bytes != null) rows.push(`<dt>${esc(t('imp.check.disk_free'))}</dt><dd>${esc(fmtBytes(room.disk_free_bytes))}</dd>`);
  if (room.device_limit != null) rows.push(`<dt>${esc(t('imp.check.screens_room'))}</dt><dd>${esc(t('imp.check.screens_value', { now: room.devices_now, add: room.devices, limit: room.device_limit }))}</dd>`);
  const verdict = room.ok
    ? `<div class="trust-residency ok"><strong>${esc(t('imp.check.fits'))}</strong></div>`
    : `<div class="trust-residency leaves"><strong>${esc(t('imp.check.no_fit'))}</strong><div>${(room.reasons || []).map((r) => esc(tk(`imp.check.reason.${r}`, r))).join('<br>')}</div></div>`;
  return `${verdict}<dl class="trust-kv">${rows.join('')}</dl>`;
}

function checklistItems(scan) {
  const items = [];
  for (const i of scan.integrations || []) items.push(t(`imp.reconnect.${i.kind}`, { name: i.name || '' }));
  for (const d of scan.data_sources || []) if (d.needs_secret) items.push(t('imp.reconnect.data_source', { name: d.name, type: d.type }));
  items.push(t('imp.reconnect.passkeys'));
  return items;
}

function showChoice(body, head, ctx, job, instance) {
  const s = job.scan || {};
  const cat = s.categories || {};
  const empties = (ctx.targets || []).filter((o) => o.empty);
  const hist = s.history || {};
  const orgName = s.organization ? String(s.organization.name || '') : '';
  body.innerHTML = `${head}
    <div class="settings-section"><h3>${esc(t('imp.check.title', { name: orgName }))}</h3>
      <p class="trust-desc">${esc(t('imp.check.exported', { when: s.exported_at ? new Date(s.exported_at).toLocaleString() : '—' }))}</p>
      <dl class="trust-kv">
        <dt>${esc(t('imp.check.workspaces'))}</dt><dd>${esc((s.workspaces || []).map((w) => w.name).join(', '))}</dd>
        <dt>${esc(t('imp.check.screens'))}</dt><dd>${esc(String((s.devices || []).length))}</dd>
        <dt>${esc(t('imp.check.members'))}</dt><dd>${esc(String((s.members || []).length))}</dd>
        <dt>${esc(t('imp.check.items'))}</dt><dd>${esc(Object.entries(cat).filter(([, n]) => n).map(([k, n]) => `${tk(`imp.cat.${k}`, k)} ${n}`).join(' · '))}</dd>
      </dl>
      ${roomHtml(s.room)}
    </div>
    <div class="settings-section"><h3>${esc(t('imp.check.not_title'))}</h3>
      <p class="trust-desc">${esc(t('imp.check.not_desc'))}</p>
      <ul class="imp-list">${(s.not_restored || []).map((n) => `<li><code>${esc(n.table)}</code>${n.rows ? ` (${esc(String(n.rows))})` : ''} — ${esc(n.reason || '')}</li>`).join('')}
        <li>${esc(t('imp.check.passkeys'))}</li><li>${esc(t('imp.check.secrets'))}</li></ul>
    </div>
    <div class="settings-section"><h3>${esc(t('imp.check.reconnect_title'))}</h3>
      <ul class="imp-list">${checklistItems(s).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
    </div>
    <div class="settings-section"><h3>${esc(t('imp.choose.title'))}</h3>
      <label class="trust-switch"><input type="radio" name="impTarget" value="new" checked> ${esc(t('imp.choose.new'))}</label>
      <input id="impNewName" class="input" type="text" maxlength="120" value="${esc((s.organization && s.organization.name) || '')}" style="max-width:360px;margin:4px 0 10px 24px">
      <label class="trust-switch"><input type="radio" name="impTarget" value="existing" ${empties.length ? '' : 'disabled'}> ${esc(t('imp.choose.existing'))}</label>
      <select id="impExisting" class="input" style="max-width:360px;margin:4px 0 10px 24px" ${empties.length ? '' : 'disabled'}>
        ${empties.map((o) => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('')}</select>
      ${empties.length ? '' : `<p class="trust-muted" style="margin-left:24px">${esc(t('imp.choose.no_empty'))}</p>`}
      <h4 style="margin:14px 0 6px;font-size:13px">${esc(t('imp.choose.history'))}</h4>
      <label class="trust-switch"><input type="checkbox" id="impOptPlay" checked> ${esc(t('imp.choose.proof', { n: hist.proof_of_play || 0 }))}</label>
      <label class="trust-switch"><input type="checkbox" id="impOptHist" checked> ${esc(t('imp.choose.versions', { n: hist.history || 0 }))}</label>
      <label class="trust-switch"><input type="checkbox" id="impOptAudit" checked> ${esc(t('imp.choose.audit', { n: hist.audit || 0 }))}</label>
      <p class="trust-muted">${esc(t('imp.choose.never_overwrites'))}</p>
      <div class="trust-toolbar"><button type="button" class="btn btn-primary" id="impGo" ${s.room && !s.room.ok ? 'disabled' : ''}>${esc(t('imp.choose.go'))}</button>${cancelBtn()}</div>
    </div>`;
  wireCancel(body, job, instance);
  body.querySelector('#impGo').addEventListener('click', async (e) => {
    e.target.disabled = true;
    const mode = body.querySelector('input[name="impTarget"]:checked').value;
    const target = mode === 'existing' ? { mode, organization_id: body.querySelector('#impExisting').value } : { mode: 'new', name: body.querySelector('#impNewName').value.trim() };
    try {
      await api.post(`/org-import/jobs/${encodeURIComponent(job.id)}/restore`, {
        target,
        options: { include_proof_of_play: body.querySelector('#impOptPlay').checked, include_history: body.querySelector('#impOptHist').checked, include_audit: body.querySelector('#impOptAudit').checked },
      });
      showJob(body, ctx, job.id, instance);
    } catch (err) { showToast(err.message, 'error'); e.target.disabled = false; }
  });
}

function showBundleChoice(body, head, job, instance) {
  const s = job.scan || {};
  body.innerHTML = `${head}
    <div class="settings-section"><h3>${esc(t('imp.server.check_title', { n: (s.organizations || []).length }))}</h3>
      <p class="trust-desc">${esc(t('imp.server.accounts', { n: s.accounts || 0, admins: s.platform_admins || 0 }))}</p>
      <div class="table-wrap"><table class="att-table"><tbody>
        ${(s.organizations || []).map((o) => `<tr><td>${esc(o.name)}</td><td><span class="trust-pill${o.status === 'scanned' ? '' : ' warn'}">${esc(tk(`imp.status.${o.status}`, o.status))}</span>${o.error ? `<div class="trust-muted">${esc(o.error)}</div>` : ''}</td>
          <td>${o.status === 'scanned' ? esc(t('imp.server.org_line', { ws: o.workspaces, screens: o.screens, members: o.members, size: fmtBytes(o.media_bytes || 0) })) : ''}</td></tr>`).join('')}
      </tbody></table></div>
      ${roomHtml(s.room)}
      <label class="trust-switch"><input type="checkbox" id="impSettings" checked> ${esc(t('imp.server.restore_settings'))}</label>
      <p class="trust-muted">${esc(t('imp.server.users_note'))}</p>
      <div class="trust-toolbar"><button type="button" class="btn btn-primary" id="impGo">${esc(t('imp.server.go'))}</button>${cancelBtn()}</div>
    </div>`;
  wireCancel(body, job, instance);
  body.querySelector('#impGo').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try { await api.post(`/org-import/jobs/${encodeURIComponent(job.id)}/restore`, { options: { include_settings: body.querySelector('#impSettings').checked } }); showJob(body, null, job.id, instance); }
    catch (err) { showToast(err.message, 'error'); e.target.disabled = false; }
  });
}

/* ───────────── steps 5-7: people, screens, reconnect ───────────── */

async function showDone(body, ctx, job) {
  const [inv, scr] = await Promise.all([
    api.get(`/org-import/jobs/${encodeURIComponent(job.id)}/invites`).catch(() => ({ invites: [] })),
    api.get(`/org-import/jobs/${encodeURIComponent(job.id)}/screens`).catch(() => ({ screens: [] })),
  ]);
  const r = job.result || {};
  const ws = (r.workspaces || [])[0];
  const screens = scr.screens || [];
  body.innerHTML = `${stepper('people', false)}
    <div class="settings-section">
      <div class="trust-residency ok"><strong>${esc(t('imp.done.title'))}</strong>
        <div>${esc(t('imp.done.summary', { screens: r.screens || 0, invites: r.invites || 0 }))}</div></div>
      ${ws ? `<button type="button" class="btn btn-primary btn-sm" id="impOpen">${esc(t('imp.done.open'))}</button>` : ''}
    </div>
    <div class="settings-section"><h3>${esc(t('imp.people.title'))}</h3>
      <p class="trust-desc">${esc(t('imp.people.desc'))}</p>
      ${ctx.email_configured && inv.invites.length ? `<button type="button" class="btn btn-secondary btn-sm" id="impSend">${esc(t('imp.people.send'))}</button>` : `<p class="trust-muted">${esc(t('imp.people.no_email'))}</p>`}
      ${inv.invites.length ? `<div class="table-wrap"><table class="att-table"><tbody>
        ${inv.invites.map((i) => `<tr><td>${esc(i.email)}</td><td>${esc(i.workspace_name)}</td>
          <td>${esc(tk(`imp.role.${i.org_only ? i.org_role : i.role}`, i.org_only ? i.org_role : i.role))}${i.org_role && !i.org_only ? ` · ${esc(tk(`imp.role.${i.org_role}`, i.org_role))}` : ''}</td>
          <td><button type="button" class="btn btn-secondary btn-sm" data-copy="${esc(i.accept_url)}">${esc(t('imp.copy_link'))}</button></td></tr>`).join('')}
      </tbody></table></div>` : `<p class="trust-muted">${esc(t('imp.people.none'))}</p>`}
    </div>
    <div class="settings-section"><h3>${esc(t('imp.screens.title'))}</h3>
      <p class="trust-desc">${esc(t('imp.screens.desc'))}</p>
      <ol class="imp-list">
        <li>${esc(t('imp.screens.way_handover'))} <button type="button" class="btn btn-secondary btn-sm" id="impHandover">${esc(t('imp.screens.download'))}</button></li>
        <li>${esc(t('imp.screens.way_dns'))}</li>
        <li>${esc(t('imp.screens.way_link'))}</li>
        <li>${esc(t('imp.screens.way_pair'))}</li>
      </ol>
      ${screens.length ? `<div class="table-wrap"><table class="att-table">
        <thead><tr><th>${esc(t('imp.screens.col.name'))}</th><th>${esc(t('imp.screens.col.status'))}</th><th>${esc(t('imp.screens.col.link'))}</th><th>${esc(t('imp.screens.col.pair'))}</th></tr></thead>
        <tbody>${screens.map((d) => `<tr>
          <td>${esc(d.name)}<div class="trust-muted">${esc(d.workspace)}${d.rematches_by_fingerprint ? ` · ${esc(t('imp.screens.fingerprint'))}` : ''}</div></td>
          <td><span class="trust-pill${d.moved ? '' : ' warn'}">${esc(d.moved ? t('imp.screens.moved') : t('imp.screens.waiting'))}</span></td>
          <td>${d.enrol_url && !d.moved ? `<button type="button" class="btn btn-secondary btn-sm" data-copy="${esc(d.enrol_url)}">${esc(t('imp.copy_link'))}</button>` : ''}</td>
          <td>${d.moved ? '' : `<input class="input" inputmode="numeric" maxlength="6" placeholder="123456" style="width:90px" data-code="${esc(d.id)}">
            <button type="button" class="btn btn-secondary btn-sm" data-pair="${esc(d.id)}">${esc(t('imp.screens.pair'))}</button>`}</td>
        </tr>`).join('')}</tbody></table></div>` : `<p class="trust-muted">${esc(t('imp.screens.none'))}</p>`}
    </div>
    <div class="settings-section"><h3>${esc(t('imp.reconnect.title'))}</h3>
      <p class="trust-desc">${esc(t('imp.reconnect.desc'))}</p>
      <ul class="imp-list imp-checklist">${checklistItems(job.scan || {}).map((x) => `<li><label class="trust-switch"><input type="checkbox"> ${esc(x)}</label></li>`).join('')}</ul>
    </div>`;
  body.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => { await copy(b.dataset.copy); showToast(t('imp.copied'), 'success'); }));
  body.querySelector('#impOpen')?.addEventListener('click', async () => {
    try { const { switchWorkspaceTo } = await import('../components/corporate-ui.js'); await switchWorkspaceTo(ws.id, '#/'); }
    catch (err) { showToast(err.message, 'error'); }
  });
  body.querySelector('#impSend')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try { const r2 = await api.post(`/org-import/jobs/${encodeURIComponent(job.id)}/invites/send`); showToast(t('imp.people.sent', { n: r2.sent }), r2.failed ? 'error' : 'success'); }
    catch (err) { showToast(err.message, 'error'); e.target.disabled = false; }
  });
  body.querySelector('#impHandover').addEventListener('click', async () => {
    try {
      const doc = await api.get(`/org-import/jobs/${encodeURIComponent(job.id)}/handover`);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }));
      a.download = 'screentinker-screen-handover.json';
      document.body.appendChild(a); a.click(); a.remove();
      showToast(t('imp.screens.downloaded'), 'success');
    } catch (err) { showToast(err.message, 'error'); }
  });
  body.querySelectorAll('[data-pair]').forEach((b) => b.addEventListener('click', async () => {
    const code = body.querySelector(`[data-code="${CSS.escape(b.dataset.pair)}"]`).value.trim();
    try {
      await api.post(`/org-import/jobs/${encodeURIComponent(job.id)}/screens/${encodeURIComponent(b.dataset.pair)}/pair`, { pairing_code: code });
      showToast(t('imp.screens.paired'), 'success');
      showDone(body, ctx, await api.get(`/org-import/jobs/${encodeURIComponent(job.id)}`));
    } catch (err) { showToast(err.message, 'error'); }
  }));
}

async function showBundleDone(body, head, job) {
  const r = job.result || {};
  let accounts = [];
  try { accounts = (await api.get(`/org-import/jobs/${encodeURIComponent(job.id)}/accounts`)).accounts || []; } catch { accounts = []; }
  body.innerHTML = `${head}
    <div class="settings-section">
      <div class="trust-residency ${r.failed ? 'leaves' : 'ok'}"><strong>${esc(r.failed ? t('imp.server.done_some', { n: r.failed }) : t('imp.server.done_all'))}</strong></div>
      <div class="table-wrap"><table class="att-table"><tbody>
        ${(r.organizations || []).map((o) => `<tr><td>${esc(o.name || '')}</td><td><span class="trust-pill${o.status === 'done' ? '' : ' warn'}">${esc(tk(`imp.status.${o.status}`, o.status))}</span>${o.error ? `<div class="trust-muted">${esc(o.error)}</div>` : ''}</td>
          <td>${o.status !== 'done' && o.status !== 'refused' ? `<button type="button" class="btn btn-secondary btn-sm" data-retry="${esc(o.child_id)}">${esc(t('imp.server.retry'))}</button>` : ''}</td></tr>`).join('')}
      </tbody></table></div>
    </div>
    <div class="settings-section"><h3>${esc(t('imp.server.accounts_title'))}</h3>
      <p class="trust-desc">${esc(t('imp.server.accounts_desc'))}</p>
      <div class="table-wrap"><table class="att-table"><tbody>
        ${accounts.map((a) => `<tr><td>${esc(a.email)}</td><td>${esc(a.role)}</td><td>${a.needs_password && a.auth_provider === 'local' ? `<button type="button" class="btn btn-secondary btn-sm" data-pw="${esc(a.id)}">${esc(t('imp.server.password_link'))}</button>` : esc(a.auth_provider)}</td></tr>`).join('')}
      </tbody></table></div>
    </div>`;
  body.querySelectorAll('[data-pw]').forEach((b) => b.addEventListener('click', async () => {
    try { const l = await api.post(`/org-import/accounts/${encodeURIComponent(b.dataset.pw)}/password-link`); await copy(l.url); showToast(t('imp.server.password_copied'), 'success'); }
    catch (err) { showToast(err.message, 'error'); }
  }));
  body.querySelectorAll('[data-retry]').forEach((b) => b.addEventListener('click', async () => {
    try { await api.post(`/org-import/jobs/${encodeURIComponent(b.dataset.retry)}/restore`, { target: { mode: 'new' } }); showToast(t('imp.server.retrying'), 'success'); }
    catch (err) { showToast(err.message, 'error'); }
  }));
}
