/*
 * 3.0 "Your data, provably" — the public, printable data handling page (/trust). Server:
 * routes/trust.js publicJson, from lib/trust/report.js publicView (an allowlist of non-sensitive
 * facts). Everything the server sends is rendered through esc() or textContent.
 */
import { t } from './i18n.js';
import { esc } from './utils.js';

const root = document.getElementById('root');

function tk(key, fallback) { const v = t(key); return v === key ? fallback : v; }
const card = (title, body, cls = '') => `<section class="card ${cls}"><h2>${esc(title)}</h2>${body}</section>`;
const dl = (rows) => `<dl>${rows.filter(Boolean).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;

function render(p) {
  const res = p.residency || {};
  const statement = res.all_on_server
    ? `<section class="card statement"><strong>${esc(t('trust.residency.all_here'))}</strong><div>${esc(t('trust.residency.all_here_desc'))}</div></section>`
    : `<section class="card statement leaves"><strong>${esc(t('trust.residency.some_leaves'))}</strong>
        <div>${esc(t('trust.pub.leaves_list'))}</div><ul>${(res.reasons || []).map((id) => `<li>${esc(tk(`trust.int.${id}`, id))}</li>`).join('')}</ul></section>`;
  const st = p.storage || {};
  const where = dl([
    [t('trust.storage.media'), tk(`trust.storage.provider.${st.provider}`, st.provider || '') + (st.region ? ` · ${t('trust.storage.region', { region: st.region })}` : '')],
    [t('trust.db.title'), t('trust.db.value')],
  ]);
  const enc = dl([
    [t('trust.enc.secrets'), t('trust.enc.secrets_value')],
    [t('trust.enc.passwords'), t('trust.enc.passwords_value')],
    [t('trust.enc.tokens'), t('trust.enc.tokens_value')],
    [t('trust.enc.media'), t('trust.enc.media_value')],
  ]);
  const ints = (p.integrations || []);
  const third = ints.length
    ? `<table>${ints.map((i) => `<tr><td><strong>${esc(tk(`trust.int.${i.id}`, i.id))}</strong></td><td>${esc(tk(`trust.int.${i.id}.sends`, ''))}</td></tr>`).join('')}</table>`
    : `<p>${esc(t('trust.int.none_on'))}</p>`;
  const tel = p.telemetry || {};
  const retVal = (x) => (x.days != null ? t('trust.ret.days', { n: x.days }) : x.hours != null ? t('trust.ret.hours', { n: x.hours }) : x.keep != null ? t('trust.ret.keep', { n: x.keep }) : '—');
  const ret = `<table>${(p.retention || []).map((x) => `<tr><td>${esc(tk(`trust.ret.${x.id}`, x.id))}</td><td>${esc(retVal(x))}</td></tr>`).join('')}</table>`;
  const b = p.backups || {};
  root.innerHTML = [
    statement,
    card(t('trust.where.title'), where),
    card(t('trust.enc.title'), enc + `<p class="muted">${esc(t('trust.enc.desc'))}</p>`),
    card(t('trust.pub.third_parties'), third + `<p class="muted">${esc(t('trust.pub.org_integrations'))}</p>`),
    card(t('trust.tel.title'), `<p>${esc(tel.state === 'on' ? t('trust.pub.tel_on', { fields: (tel.fields || []).join(', ') }) : t('trust.pub.tel_off'))}</p>`),
    card(t('trust.ret.title'), ret),
    card(t('trust.bak.title'), dl([
      [t('trust.bak.snapshots'), t('trust.pub.snapshots', { n: b.upgrade_snapshots_keep || 0 })],
      [t('trust.bak.offsite'), t('trust.bak.offsite_value')],
    ])),
    card(t('trust.id.title'), `<ul>
      <li>${esc(t('trust.pub.id_passkeys'))}</li><li>${esc(t('trust.pub.id_totp'))}</li>
      <li>${esc(t('trust.pub.id_sso'))}</li><li>${esc(t('trust.pub.id_scim'))}</li></ul>`),
  ].join('');
  document.getElementById('footer').textContent = t('trust.pub.footer', { when: new Date((p.generated_at || 0) * 1000).toLocaleString() });
}

async function main() {
  document.getElementById('title').textContent = t('trust.pub.title');
  document.title = t('trust.pub.title');
  document.getElementById('subtitle').textContent = t('trust.pub.subtitle');
  const btn = document.getElementById('printBtn');
  btn.textContent = t('trust.pub.print');
  btn.addEventListener('click', () => window.print());
  try {
    const res = await fetch('/api/public/trust', { credentials: 'omit', cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    render(await res.json());
  } catch (_) {
    root.textContent = t('trust.pub.unavailable');
  }
}
main();
