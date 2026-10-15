'use strict';

/*
 * Make a sign and the brand kit, through the real routers: tenancy, the view-only gate, and the
 * whole path a sign takes to a screen — created here, added to the screen's playlist and published
 * through the ordinary endpoints, or sent for review where the workspace requires it.
 */
process.env.DATA_DIR = require('path').join(require('os').tmpdir(), 'st-signs-' + process.pid + '-' + Date.now());
process.env.JWT_SECRET = 'test-secret-signs';
process.env.NODE_ENV = 'test';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const express = require('express');
const { db } = require('../db/database');
const { requireAuth, generateToken } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');

const O = 'org-sign', WS = 'ws-sign', WS2 = 'ws-sign-2';
const users = { admin: 'u-sign-admin', editor: 'u-sign-editor', viewer: 'u-sign-viewer', other: 'u-sign-other' };
for (const [k, id] of Object.entries(users)) {
  db.prepare("INSERT OR IGNORE INTO users (id,email,password_hash,role,name) VALUES (?,?,'x','user',?)").run(id, `${k}@sign.local`, k);
}
db.prepare('INSERT OR IGNORE INTO organizations (id,name,owner_user_id) VALUES (?,?,?)').run(O, 'Org', users.admin);
db.prepare('INSERT OR IGNORE INTO workspaces (id,organization_id,name) VALUES (?,?,?)').run(WS, O, 'Shop A');
db.prepare('INSERT OR IGNORE INTO workspaces (id,organization_id,name) VALUES (?,?,?)').run(WS2, O, 'Shop B');
const mem = db.prepare('INSERT OR IGNORE INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)');
mem.run(WS, users.admin, 'workspace_admin'); mem.run(WS, users.editor, 'workspace_editor'); mem.run(WS, users.viewer, 'workspace_viewer');
mem.run(WS2, users.other, 'workspace_admin');

db.prepare("INSERT OR IGNORE INTO content (id,user_id,workspace_id,filename,filepath,mime_type,file_size) VALUES ('logo-a',?,?,'logo.png','logo-a.png','image/png',10)").run(users.editor, WS);
db.prepare("INSERT OR IGNORE INTO content (id,user_id,workspace_id,filename,filepath,mime_type,file_size) VALUES ('clip-a',?,?,'clip.mp4','clip-a.mp4','video/mp4',10)").run(users.editor, WS);
db.prepare("INSERT OR IGNORE INTO content (id,user_id,workspace_id,filename,filepath,mime_type,file_size) VALUES ('logo-b',?,?,'b.png','logo-b.png','image/png',10)").run(users.other, WS2);
db.prepare("INSERT OR IGNORE INTO devices (id, name, workspace_id) VALUES ('dev-sign-a', 'Counter', ?)").run(WS);
db.prepare("INSERT OR IGNORE INTO devices (id, name, workspace_id) VALUES ('dev-sign-b', 'Other shop', ?)").run(WS2);

const app = express();
app.use(express.json());
const nsp = { adapter: { rooms: new Map() }, to: () => ({ emit() {} }), emit() {} };
app.set('io', { of: () => nsp });
for (const p of ['signs', 'brand-kit', 'assignments', 'playlists', 'slide-decks', 'approvals', 'widgets']) {
  app.use(`/api/${p}`, requireAuth, resolveTenancy, require(`../routes/${p}`));
}
// The device render is public in server.js (a player has no session); the same router, unauthenticated.
app.use('/public/widgets', require('../routes/widgets'));
const server = app.listen(0);
after(() => { server.close(); try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* */ } });

const row = (id) => db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(id);
async function call(method, pathname, who, body, ws = WS) {
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  const res = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${generateToken(row(users[who]), ws)}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null; try { json = await res.json(); } catch { /* */ }
  return { status: res.status, json };
}

const SIGN = { template: 'specials', aspect: '16:9', values: { title: 'Soup & <b>bread</b>', business: 'Rosa', items: [{ label: 'Tea', value: '2.50' }] } };

// ─── brand kit ──────────────────────────────────────────────────────────────────────────────

test('brand kit: empty until saved; an editor saves it; a viewer reads it but cannot write', async () => {
  let r = await call('GET', '/api/brand-kit', 'editor');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.kit.colors, []);
  assert.equal(r.json.can_edit, true);
  assert.ok(r.json.fonts.some((f) => f.id === 'archivo'));

  r = await call('PUT', '/api/brand-kit', 'editor', { business_name: 'Rosa\'s', colors: ['#fce7f3', '#9D174D', '#abc'], font: 'bitter', logo_content_id: 'logo-a' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.kit.colors, ['#FCE7F3', '#9D174D', '#AABBCC']);
  assert.equal(r.json.kit.logo_content_id, 'logo-a');
  assert.equal(r.json.kit.font, 'bitter');

  r = await call('GET', '/api/brand-kit', 'viewer');
  assert.equal(r.status, 200);
  assert.equal(r.json.can_edit, false);
  assert.equal(r.json.kit.business_name, "Rosa's");

  r = await call('PUT', '/api/brand-kit', 'viewer', { business_name: 'Hijacked' });
  assert.equal(r.status, 403);
  assert.equal((await call('GET', '/api/brand-kit', 'editor')).json.kit.business_name, "Rosa's");
});

test('⚠️ brand kit tenancy: another workspace\'s kit is invisible, and its images cannot be the logo', async () => {
  let r = await call('GET', '/api/brand-kit', 'other', null, WS2);
  assert.equal(r.status, 200);
  assert.equal(r.json.kit.business_name, '', 'workspace B must not see workspace A\'s kit');

  // A's editor naming B's image: refused, and nothing stored.
  r = await call('PUT', '/api/brand-kit', 'editor', { logo_content_id: 'logo-b' });
  assert.equal(r.status, 400);
  assert.equal((await call('GET', '/api/brand-kit', 'editor')).json.kit.logo_content_id, 'logo-a');

  // A video is not a logo either.
  assert.equal((await call('PUT', '/api/brand-kit', 'editor', { logo_content_id: 'clip-a' })).status, 400);

  // A user of B cannot reach A's kit by putting A's workspace in their token: tenancy resolves them
  // to a workspace they belong to, so whatever the answer, A's kit is untouched.
  await call('PUT', '/api/brand-kit', 'other', { business_name: 'Not Rosa' }, WS);
  assert.equal((await call('GET', '/api/brand-kit', 'editor')).json.kit.business_name, "Rosa's");
});

test('brand kit: bad colours, unknown fonts and over-long names are refused', async () => {
  for (const body of [{ colors: ['red'] }, { colors: ['#000', '#111', '#222', '#333'] }, { colors: 'x' }, { font: 'comic-sans' }, { business_name: 'x'.repeat(81) }]) {
    const r = await call('PUT', '/api/brand-kit', 'editor', body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
});

test('brand colours are positional: clearing the background does not promote the accent into it', async () => {
  const r = await call('PUT', '/api/brand-kit', 'editor', { colors: [null, '#123456', ''] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.kit.colors, [null, '#123456']);
  const t = await call('GET', '/api/signs/templates', 'editor');
  assert.deepEqual(t.json.brand.colors, [null, '#123456']);
  await call('PUT', '/api/brand-kit', 'editor', { colors: ['#FCE7F3', '#9D174D', '#AABBCC'] });
});

test('a logo deleted from the library simply drops out of the kit', async () => {
  db.prepare("INSERT OR IGNORE INTO content (id,user_id,workspace_id,filename,filepath,mime_type,file_size) VALUES ('logo-tmp',?,?,'t.png','t.png','image/png',1)").run(users.editor, WS);
  await call('PUT', '/api/brand-kit', 'editor', { logo_content_id: 'logo-tmp' });
  db.prepare("DELETE FROM content WHERE id = 'logo-tmp'").run();
  assert.equal((await call('GET', '/api/brand-kit', 'editor')).json.kit.logo_content_id, null);
  await call('PUT', '/api/brand-kit', 'editor', { logo_content_id: 'logo-a' });
});

// ─── templates and previews ─────────────────────────────────────────────────────────────────

test('templates come with the workspace brand kit; previews render escaped text, one or many', async () => {
  let r = await call('GET', '/api/signs/templates', 'viewer');
  assert.equal(r.status, 200);
  assert.ok(r.json.templates.length >= 12);
  assert.equal(r.json.brand.business_name, "Rosa's");

  r = await call('POST', '/api/signs/preview', 'viewer', SIGN);
  assert.equal(r.status, 200);
  assert.match(r.json.html, /Soup &amp; &lt;b&gt;bread&lt;\/b&gt;/);
  assert.doesNotMatch(r.json.html, /<b>bread/);
  // The brand logo resolves inside this workspace.
  assert.match(r.json.html, /\/uploads\/content\/logo-a\.png/);

  r = await call('POST', '/api/signs/preview', 'editor', { items: [{ template: 'sale', aspect: '16:9' }, { template: 'sale', aspect: '9:16' }, { template: 'nope' }] });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.json.previews).sort(), ['sale:16:9', 'sale:9:16']);

  r = await call('POST', '/api/signs/preview', 'editor', { template: 'nope' });
  assert.equal(r.status, 400);
});

// ─── create + publish ────────────────────────────────────────────────────────────────────────

test('a viewer cannot make a sign; invalid fields are refused with the field named', async () => {
  assert.equal((await call('POST', '/api/signs', 'viewer', SIGN)).status, 403);
  const r = await call('POST', '/api/signs', 'editor', { template: 'specials', values: { title: '' } });
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.some((e) => e.field === 'title' && e.code === 'required'));
  assert.equal((await call('POST', '/api/signs', 'editor', { template: 'x' })).status, 400);
});

let made;
test('making a sign creates an editable deck and its widget — and puts nothing on a screen by itself', async () => {
  const before = db.prepare('SELECT COUNT(*) n FROM playlists').get().n;
  const r = await call('POST', '/api/signs', 'editor', SIGN);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  made = r.json;
  const w = db.prepare('SELECT * FROM widgets WHERE id = ?').get(made.widget_id);
  assert.equal(w.workspace_id, WS);
  assert.equal(w.widget_type, 'slide');
  const cfg = JSON.parse(w.config);
  assert.equal(cfg.template.aspect, '16:9');
  assert.equal(cfg.fields.title, 'Soup & <b>bread</b>', 'stored as typed; escaping is the renderer\'s job');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM playlists').get().n, before, 'no playlist is created');

  // The deck opens in Slides like any other, and knows its widget.
  const d = await call('GET', `/api/slide-decks/${made.deck_id}`, 'editor');
  assert.equal(d.status, 200);
  assert.equal(d.json.doc.slides[0].widget_id, made.widget_id);
  assert.equal(d.json.doc.aspect, '16:9');
  // Another workspace cannot open it.
  assert.equal((await call('GET', `/api/slide-decks/${made.deck_id}`, 'other', null, WS2)).status, 403);
});

test('⚠️ the publish path: the sign goes onto the screen\'s playlist and is published through the normal endpoint', async () => {
  const add = await call('POST', '/api/assignments/device/dev-sign-a', 'editor', { widget_id: made.widget_id, duration_sec: made.dwell_sec });
  assert.equal(add.status, 201, JSON.stringify(add.json));
  const pl = add.json.playlist_id;
  const pub = await call('POST', `/api/playlists/${pl}/publish`, 'editor');
  assert.equal(pub.status, 200, JSON.stringify(pub.json));
  const snap = JSON.parse(db.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get(pl).published_snapshot);
  assert.ok(JSON.stringify(snap).includes(made.widget_id), 'the sign is in what the screen plays');

  // What the screen renders: the widget's public render, with the text escaped.
  const res = await fetch(`http://127.0.0.1:${server.address().port}/public/widgets/${made.widget_id}/render`);
  const html = await res.text();
  assert.match(html, /Soup &amp; &lt;b&gt;bread/);

  // ⚠️ Another workspace's screen cannot be given this sign.
  const cross = await call('POST', '/api/assignments/device/dev-sign-b', 'other', { widget_id: made.widget_id }, WS2);
  assert.equal(cross.status, 403);
});

test('⚠️ a workspace that reviews changes: publish refuses with a review code, and the change can be submitted', async () => {
  db.prepare('UPDATE workspaces SET require_approval = 1 WHERE id = ?').run(WS);
  try {
    const s = await call('POST', '/api/signs', 'editor', { template: 'welcome', values: { title: 'Hello' } });
    assert.equal(s.status, 201);
    const add = await call('POST', '/api/assignments/device/dev-sign-a', 'editor', { widget_id: s.json.widget_id });
    assert.equal(add.status, 201);
    const pub = await call('POST', `/api/playlists/${add.json.playlist_id}/publish`, 'editor');
    assert.equal(pub.status, 409);
    assert.equal(pub.json.code, 'approval_required', 'components/release.js keys "sent for review" on this code');
    const sub = await call('POST', '/api/approvals/submit', 'editor', { resource_type: 'playlist', resource_id: add.json.playlist_id, note: 'sign' });
    assert.ok(sub.status === 200 || sub.status === 201, JSON.stringify(sub.json));
    // Nothing reached the screen: the published snapshot does not have the new sign.
    const snap = db.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get(add.json.playlist_id).published_snapshot || '';
    assert.ok(!snap.includes(s.json.widget_id));
  } finally {
    db.prepare('UPDATE workspaces SET require_approval = 0 WHERE id = ?').run(WS);
  }
});

test('editing the sign later in Slides and publishing updates the SAME widget the screen plays', async () => {
  const d = (await call('GET', `/api/slide-decks/${made.deck_id}`, 'editor')).json;
  d.doc.slides[0].fields.title = 'Soup of the day';
  assert.equal((await call('PUT', `/api/slide-decks/${made.deck_id}`, 'editor', { doc: d.doc })).status, 200);
  const widgetsBefore = db.prepare("SELECT COUNT(*) n FROM widgets WHERE widget_type = 'slide' AND workspace_id = ?").get(WS).n;
  const pub = await call('POST', `/api/slide-decks/${made.deck_id}/publish`, 'editor');
  assert.equal(pub.status, 200, JSON.stringify(pub.json));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM widgets WHERE widget_type = 'slide' AND workspace_id = ?").get(WS).n, widgetsBefore, 'no second widget');
  assert.equal(JSON.parse(db.prepare('SELECT config FROM widgets WHERE id = ?').get(made.widget_id).config).fields.title, 'Soup of the day');
});
