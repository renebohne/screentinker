'use strict';

/*
 * 3.0 accessibility checker over HTTP, against a real migrated database and real media files:
 *
 *   - the report and badges: what is found, worst first, and only in the caller's workspace;
 *   - tenancy: another workspace's ids are 404 everywhere, and a deck naming a foreign photo never
 *     gets that photo measured;
 *   - roles: a viewer reads and never writes (settings, screens, captions, speech-to-text);
 *   - the opt-in publish policy on the real playlist and deck publish routes;
 *   - videos: a 5 Hz flashing clip and a talking clip with no captions, analysed by the worker;
 *   - captions end to end through a fake speech-to-text transport: nothing is sent unless an admin
 *     configured an endpoint, the key is stored encrypted and never returned, what comes back is
 *     cleaned before it is stored, and the result is editable.
 */

process.env.DATA_DIR = require('path').join(require('os').tmpdir(), 'st-a11y-' + process.pid + '-' + Date.now());
process.env.JWT_SECRET = 'test-secret-a11y';
process.env.NODE_ENV = 'test';
process.env.SELF_HOSTED = 'true';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const express = require('express');
const { db } = require('../db/database');
const config = require('../config');
const { requireAuth, generateToken } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');
const media = require('../lib/a11y/media');
const captions = require('../lib/a11y/captions');

let FFMPEG = true;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { FFMPEG = false; }

const O = 'org-a11y', WS = 'ws-a11y', WS2 = 'ws-a11y-other';
const U = { admin: 'u-a11y-admin', editor: 'u-a11y-editor', viewer: 'u-a11y-viewer', other: 'u-a11y-other' };
for (const [k, id] of Object.entries(U)) {
  db.prepare("INSERT OR IGNORE INTO users (id,email,password_hash,role,name) VALUES (?,?,'x','user',?)").run(id, `${k}@a11y.local`, k);
}
db.prepare('INSERT OR IGNORE INTO organizations (id,name,owner_user_id) VALUES (?,?,?)').run(O, 'Org', U.other);
db.prepare('INSERT OR IGNORE INTO workspaces (id,organization_id,name) VALUES (?,?,?)').run(WS, O, 'Shop');
db.prepare('INSERT OR IGNORE INTO workspaces (id,organization_id,name) VALUES (?,?,?)').run(WS2, O, 'Elsewhere');
const mem = db.prepare('INSERT OR IGNORE INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)');
mem.run(WS, U.admin, 'workspace_admin'); mem.run(WS, U.editor, 'workspace_editor'); mem.run(WS, U.viewer, 'workspace_viewer');
mem.run(WS2, U.other, 'workspace_admin');

const app = express();
app.use(express.json({ limit: '4mb' }));
const nsp = { adapter: { rooms: new Map() }, to: () => ({ emit: () => {} }), emit: () => {} };
app.set('io', { of: () => nsp });
for (const [p, m] of [['playlists', 'playlists'], ['slide-decks', 'slide-decks'], ['accessibility', 'accessibility']]) {
  app.use(`/api/${p}`, requireAuth, resolveTenancy, require(`../routes/${m}`));
}
const server = app.listen(0);
after(async () => {
  server.close();
  captions._setTransport(null);
  await media.shutdown();
  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* */ }
});

const userRow = (id) => db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(id);
async function call(method, pathname, who, body, ws = WS) {
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  const res = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${generateToken(userRow(U[who]), ws)}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null; try { json = await res.json(); } catch { /* */ }
  return { status: res.status, json };
}

/* ---------------------------------------------------------------- fixtures */

const F = {};
function ff(name, args) {
  const out = path.join(config.contentDir, name);
  execFileSync('ffmpeg', ['-y', '-v', 'error', ...args, out]);
  return name;
}
function content(id, ws, filename, filepath, mime, extra = {}) {
  db.prepare(`INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size, updated_at, duration_sec)
              VALUES (?,?,?,?,?,?,?,?,?)`).run(id, U.editor, ws, filename, filepath, mime, 1000, 100, extra.duration || null);
  return id;
}
const slideDoc = (elements, fields, tpl = {}) => JSON.stringify({ aspect: '16:9', slides: [{ id: 's1', name: 'One', dwell_sec: 10, template: { background: '#FFFFFF', aspect: '16:9', elements, ...tpl }, fields }] });

before(() => {
  fs.mkdirSync(config.contentDir, { recursive: true });
  if (FFMPEG) {
    const sq = "if(lt(mod(T,0.2),0.1),255,0)";
    ff('flash5.mp4', ['-f', 'lavfi', '-i', `color=black:s=160x90:r=30:d=2,format=rgb24,geq=r='${sq}':g='${sq}':b='${sq}'`, '-pix_fmt', 'yuv420p']);
    ff('talk.mp4', ['-f', 'lavfi', '-i', 'color=gray:s=160x90:r=30:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-shortest', '-pix_fmt', 'yuv420p', '-c:a', 'aac']);
  } else {
    fs.writeFileSync(path.join(config.contentDir, 'flash5.mp4'), 'x');
    fs.writeFileSync(path.join(config.contentDir, 'talk.mp4'), 'x');
  }
  F.flash = content('c-a11y-flash', WS, 'Promo.mp4', 'flash5.mp4', 'video/mp4');
  F.talk = content('c-a11y-talk', WS, 'Welcome talk.mp4', 'talk.mp4', 'video/mp4', { duration: 2 });
  F.menu = content('c-a11y-menu', WS, 'Lunch menu.png', 'nofile.png', 'image/png');
  F.photo = content('c-a11y-photo', WS, 'Beach.jpg', 'nofile.jpg', 'image/jpeg');
  F.foreign = content('c-a11y-foreign', WS2, 'Their photo.png', 'theirs.png', 'image/png');
  fs.writeFileSync(path.join(config.contentDir, 'theirs.png'), 'not really a png');
  F.foreignVideo = content('c-a11y-foreign-v', WS2, 'Their video.mp4', 'talk.mp4', 'video/mp4');

  F.ticker = 'w-a11y-ticker';
  db.prepare("INSERT INTO widgets (id,user_id,workspace_id,widget_type,name,config) VALUES (?,?,?,?,?,?)")
    .run(F.ticker, U.editor, WS, 'rss', 'News ticker', JSON.stringify({ color: '#FFFFFF', background: '#FFEE00', font_size: 40 }));

  F.deck = 'd-a11y-sale';
  db.prepare('INSERT INTO slide_decks (id, workspace_id, user_id, name, doc, created_at, updated_at) VALUES (?,?,?,?,?,100,100)')
    .run(F.deck, WS, U.editor, 'Sale deck', slideDoc([{ kind: 'head', slot: 'title', box: { x: 10, y: 10, w: 80 }, style: { color: '#FFE14D', size_cqw: 2 } }], { title: 'Weekend sale' }));
  F.sneaky = 'd-a11y-sneaky';
  db.prepare('INSERT INTO slide_decks (id, workspace_id, user_id, name, doc, created_at, updated_at) VALUES (?,?,?,?,?,100,100)')
    .run(F.sneaky, WS, U.editor, 'Sneaky deck', slideDoc([{ kind: 'body', slot: 'b', box: { x: 10, y: 10, w: 80 }, style: { color: '#FFFFFF', size_cqw: 4 } }], { b: 'Over their photo' }, { background_content_id: F.foreign }));

  F.pl = 'pl-a11y';
  db.prepare("INSERT INTO playlists (id,user_id,workspace_id,name,status) VALUES (?,?,?,?,'draft')").run(F.pl, U.editor, WS, 'Window loop');
  db.prepare('INSERT INTO playlist_items (playlist_id,content_id,sort_order,duration_sec) VALUES (?,?,0,10)').run(F.pl, F.flash);
  db.prepare('INSERT INTO playlist_items (playlist_id,widget_id,sort_order,duration_sec) VALUES (?,?,1,10)').run(F.pl, F.ticker);
  F.plClean = 'pl-a11y-clean';
  db.prepare("INSERT INTO playlists (id,user_id,workspace_id,name,status) VALUES (?,?,?,?,'draft')").run(F.plClean, U.editor, WS, 'Clean loop');
  db.prepare('INSERT INTO playlist_items (playlist_id,content_id,sort_order,duration_sec) VALUES (?,?,0,10)').run(F.plClean, F.photo);
  F.pl2 = 'pl-a11y-other';
  db.prepare("INSERT INTO playlists (id,user_id,workspace_id,name,status) VALUES (?,?,?,?,'draft')").run(F.pl2, U.other, WS2, 'Their loop');

  F.dev = 'dev-a11y';
  db.prepare('INSERT INTO devices (id,name,workspace_id,playlist_id,screen_width,screen_height) VALUES (?,?,?,?,1920,1080)').run(F.dev, 'Window screen', WS, F.pl);
  F.dev2 = 'dev-a11y-other';
  db.prepare('INSERT INTO devices (id,name,workspace_id) VALUES (?,?,?)').run(F.dev2, 'Their screen', WS2);
});

const findSource = (r, type, id) => (r.json.sources || []).find((s) => s.type === type && s.id === id);

/* ---------------------------------------------------------------- the report */

test('report: any member may read it; it lists this workspace only, worst first', async () => {
  const v = await call('GET', '/api/accessibility', 'viewer');
  assert.equal(v.status, 200);
  assert.equal(v.json.can_write, false);
  assert.equal(v.json.can_admin, false);
  const ids = v.json.sources.map((s) => s.id);
  assert.ok(ids.includes(F.ticker));
  assert.ok(ids.includes(F.deck));
  assert.ok(!ids.includes(F.foreign) && !ids.includes(F.foreignVideo), 'nothing from another workspace');
  // Worst first: errors are sorted ahead of sources with only notes.
  const firstNoteOnly = v.json.sources.findIndex((s) => !s.errors && !s.warnings);
  const lastError = v.json.sources.map((s) => s.errors > 0).lastIndexOf(true);
  assert.ok(firstNoteOnly === -1 || lastError < firstNoteOnly);
  // The ticker's issue carries a suggested colour.
  const t = findSource(v, 'widget', F.ticker).issues.find((i) => i.code === 'contrast');
  assert.ok(t.fix && /^#[0-9A-F]{6}$/.test(t.fix.color));
  // A picture whose name says it is mostly words gets the soft note.
  assert.ok(findSource(v, 'content', F.menu).issues.some((i) => i.code === 'text_in_image' && i.severity === 'note'));
  // The other workspace's admin, in their own workspace, sees none of ours.
  const theirs = await call('GET', '/api/accessibility', 'other', null, WS2);
  assert.equal(theirs.status, 200);
  assert.ok(!theirs.json.sources.some((s) => s.id === F.ticker || s.id === F.deck || s.id === F.flash));
});

test('videos: a 5 Hz flash and a talking video without captions are found once the worker has looked', { skip: !FFMPEG && 'ffmpeg not installed' }, async () => {
  const first = await call('GET', '/api/accessibility', 'editor');
  const pending = findSource(first, 'content', F.flash);
  assert.ok(pending.issues.some((i) => i.code === 'media_pending') || pending.issues.some((i) => i.code === 'flashing'));
  await media.drain(60000);
  // The talking video may have been queued by the same report; make sure it ran too.
  await call('GET', '/api/accessibility', 'editor');
  await media.drain(60000);
  const r = await call('GET', '/api/accessibility', 'editor');
  const flash = findSource(r, 'content', F.flash);
  const f = flash.issues.find((i) => i.code === 'flashing');
  assert.ok(f, JSON.stringify(flash.issues));
  assert.equal(f.severity, 'error');
  assert.equal(f.values.per_sec, 5);
  assert.ok(!flash.issues.some((i) => i.code === 'no_captions'), 'no audio track: nothing to caption');
  const talk = findSource(r, 'content', F.talk);
  assert.ok(talk.issues.some((i) => i.code === 'no_captions' && i.severity === 'error'));
  assert.ok(!talk.issues.some((i) => i.code === 'flashing'));
  // Cached per revision; a replaced file (new updated_at) is checked again.
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM a11y_media_checks WHERE content_id = ? AND kind = 'video'").get(F.flash).n, 1);
  // The other workspace's video is checked only as THEIRS (their admin opened their report above),
  // never attributed to this workspace.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM a11y_media_checks WHERE content_id = ? AND workspace_id = ?').get(F.foreignVideo, WS).n, 0);
});

test('badges: the compact per-id map for content, widgets, decks and playlists', async () => {
  const b = await call('GET', '/api/accessibility/badges', 'viewer');
  assert.equal(b.status, 200);
  assert.ok(b.json.widgets[F.ticker].errors >= 1);
  assert.ok(b.json.decks[F.deck].errors >= 1);
  assert.ok(b.json.playlists[F.pl].errors >= 1);
  assert.equal(b.json.playlists[F.plClean], undefined);
});

/* ---------------------------------------------------------------- tenancy */

test('tenancy: another workspace\'s ids are 404 everywhere', async () => {
  for (const [type, id] of [['playlist', F.pl2], ['content', F.foreign], ['slide_deck', 'nope'], ['widget', 'nope']]) {
    const r = await call('GET', `/api/accessibility/check/${type}/${id}`, 'admin');
    assert.equal(r.status, 404, `${type} ${id}`);
  }
  assert.equal((await call('GET', `/api/accessibility/check/bogus/${F.pl}`, 'admin')).status, 400);
  assert.equal((await call('PUT', `/api/accessibility/screens/${F.dev2}`, 'admin', { viewing_distance_m: 5 })).status, 404);
  assert.equal((await call('POST', `/api/accessibility/captions/${F.foreignVideo}`, 'admin')).status, 404);
  assert.equal((await call('GET', `/api/accessibility/captions/${F.foreignVideo}/vtt`, 'admin')).status, 404);
  // And the other workspace's admin cannot see ours.
  assert.equal((await call('GET', `/api/accessibility/check/playlist/${F.pl}`, 'other', null, WS2)).status, 404);
});

test('tenancy: a deck naming another workspace\'s photo gets "could not check", and the photo is never read', async () => {
  const r = await call('GET', `/api/accessibility/check/slide_deck/${F.sneaky}`, 'editor');
  assert.equal(r.status, 200);
  const issue = r.json.sources[0].issues.find((i) => i.code === 'contrast_unverified');
  assert.ok(issue);
  assert.equal(issue.values.why, 'image');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM a11y_media_checks WHERE content_id = ?').get(F.foreign).n, 0);
});

test('text over a photo: the photo is measured on the image worker, then the text under it is checked', { skip: !FFMPEG && 'ffmpeg not installed' }, async () => {
  // A photo whose top half is white and bottom half black, behind white text at the top.
  ff('halves.png', ['-f', 'lavfi', '-i', "color=black:s=160x90,format=rgb24,geq=r='if(lt(Y,45),255,0)':g='if(lt(Y,45),255,0)':b='if(lt(Y,45),255,0)'", '-frames:v', '1']);
  const photo = content('c-a11y-halves', WS, 'Halves.png', 'halves.png', 'image/png');
  const deck = 'd-a11y-photo';
  db.prepare('INSERT INTO slide_decks (id, workspace_id, user_id, name, doc, created_at, updated_at) VALUES (?,?,?,?,?,100,100)')
    .run(deck, WS, U.editor, 'Photo deck', slideDoc([{ kind: 'head', slot: 'h', box: { x: 10, y: 10, w: 80 }, style: { color: '#FFFFFF', size_cqw: 4 } }], { h: 'Welcome' }, { background_content_id: photo }));
  const first = await call('GET', `/api/accessibility/check/slide_deck/${deck}`, 'editor');
  assert.equal(first.json.sources[0].issues[0].values.why, 'pending');
  for (let i = 0; i < 100 && !db.prepare("SELECT 1 FROM a11y_media_checks WHERE content_id = ? AND kind = 'grid'").get(photo); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const r = await call('GET', `/api/accessibility/check/slide_deck/${deck}`, 'editor');
  const issue = r.json.sources[0].issues.find((i) => i.code === 'contrast_image');
  assert.ok(issue, JSON.stringify(r.json.sources[0].issues));
  assert.equal(issue.severity, 'error');
  assert.equal(issue.fix.kind, 'dim');
  await require('../lib/image-ops').shutdown();
});

/* ---------------------------------------------------------------- roles */

test('a viewer is read-only: no settings, no screens, no captions, no speech-to-text', async () => {
  assert.equal((await call('GET', '/api/accessibility/settings', 'viewer')).status, 200);
  assert.equal((await call('PUT', '/api/accessibility/settings', 'viewer', { viewing_distance_m: 5 })).status, 403);
  assert.equal((await call('PUT', `/api/accessibility/screens/${F.dev}`, 'viewer', { viewing_distance_m: 5 })).status, 403);
  assert.equal((await call('POST', `/api/accessibility/captions/${F.talk}`, 'viewer')).status, 403);
  assert.equal((await call('PUT', `/api/accessibility/captions/${F.talk}/vtt`, 'viewer', { vtt: 'WEBVTT\n\n00:00.000 --> 00:01.000\nhi' })).status, 403);
  assert.equal((await call('PUT', '/api/accessibility/stt', 'viewer', { base_url: 'http://x' })).status, 403);
  assert.equal((await call('GET', '/api/accessibility/stt', 'viewer')).status, 200);
  // An editor may caption but not change workspace settings.
  assert.equal((await call('PUT', '/api/accessibility/settings', 'editor', { viewing_distance_m: 5 })).status, 403);
  assert.equal((await call('PUT', '/api/accessibility/stt', 'editor', { base_url: 'http://x' })).status, 403);
});

test('settings and screen overrides: validated, admin-only, and they change what is checked', async () => {
  assert.equal((await call('PUT', '/api/accessibility/settings', 'admin', { viewing_distance_m: 0 })).status, 400);
  assert.equal((await call('PUT', '/api/accessibility/settings', 'admin', { screen_diagonal_in: 'big' })).status, 400);
  const ok = await call('PUT', '/api/accessibility/settings', 'admin', { viewing_distance_m: 4.5, screen_diagonal_in: 43 });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.viewing_distance_m, 4.5);
  assert.equal(ok.json.block_on_errors, false);
  const s = await call('PUT', `/api/accessibility/screens/${F.dev}`, 'admin', { viewing_distance_m: 25 });
  assert.equal(s.status, 200);
  assert.equal(s.json.viewing_distance_m, 25);
  // The playlist on that screen is now checked at 25 m: the ticker's 40px text is too small there.
  const c = await call('GET', `/api/accessibility/check/playlist/${F.pl}`, 'viewer');
  assert.equal(c.json.view.distance_m, 25);
  const ticker = c.json.sources.find((x) => x.id === F.ticker);
  assert.ok(ticker.issues.some((i) => i.code === 'text_small'));
  assert.equal((await call('PUT', `/api/accessibility/screens/${F.dev}`, 'admin', { viewing_distance_m: null })).json.viewing_distance_m, null);
  const audit = db.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE action IN ('accessibility_settings_updated','accessibility_screen_updated') AND workspace_id = ?").get(WS);
  assert.ok(audit.n >= 2);
});

/* ---------------------------------------------------------------- the publish policy */

test('policy off (the default): publishing goes ahead with errors, and the check says what they are', async () => {
  const c = await call('GET', `/api/accessibility/check/playlist/${F.pl}`, 'editor');
  assert.ok(c.json.errors >= 1);
  assert.equal(c.json.block, null);
  assert.equal(c.json.policy, false);
  const p = await call('POST', `/api/playlists/${F.pl}/publish`, 'editor');
  assert.equal(p.status, 200, JSON.stringify(p.json));
});

test('policy on: publishing a playlist or deck with errors is refused; a clean one still publishes', async () => {
  assert.equal((await call('PUT', '/api/accessibility/settings', 'admin', { block_on_errors: true })).json.block_on_errors, true);
  const p = await call('POST', `/api/playlists/${F.pl}/publish`, 'editor');
  assert.equal(p.status, 409);
  assert.equal(p.json.code, 'accessibility_errors');
  const d = await call('POST', `/api/slide-decks/${F.deck}/publish`, 'editor');
  assert.equal(d.status, 409);
  assert.equal(d.json.code, 'accessibility_errors');
  const c = await call('GET', `/api/accessibility/check/playlist/${F.pl}`, 'editor');
  assert.equal(c.json.block.code, 'accessibility_errors');
  assert.equal((await call('POST', `/api/playlists/${F.plClean}/publish`, 'editor')).status, 200);
  // Off again: the same publish goes through.
  await call('PUT', '/api/accessibility/settings', 'admin', { block_on_errors: false });
  assert.equal((await call('POST', `/api/playlists/${F.pl}/publish`, 'editor')).status, 200);
});

/* ---------------------------------------------------------------- Make a sign */

test('Make a sign check: a hard-to-read accent is reported with the colour the sign really uses', async () => {
  // The design's own default accent is part of the design and is not reported.
  const dflt = await call('POST', '/api/accessibility/check/sign', 'viewer', { template: 'sale', aspect: '16:9', values: { big: '20%', title: 'Sale' } });
  assert.deepEqual(dflt.json.chosen, []);
  const r = await call('POST', '/api/accessibility/check/sign', 'viewer', { template: 'sale', aspect: '16:9', values: { big: '20%', title: 'Sale', bg: '#FFFFFF', accent: '#FFF59D' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.errors, 0, JSON.stringify(r.json.issues));
  assert.equal(r.json.chosen.length, 1);
  assert.equal(r.json.chosen[0].key, 'accent');
  const C = require('../lib/a11y/contrast');
  assert.ok(C.contrast(r.json.chosen[0].suggested, '#FFFFFF') >= 4.5);
  const fine = await call('POST', '/api/accessibility/check/sign', 'viewer', { template: 'sale', aspect: '16:9', values: { big: '20%', title: 'Sale', bg: '#FFFFFF', accent: '#1D4ED8' } });
  assert.deepEqual(fine.json.chosen, []);
  assert.equal((await call('POST', '/api/accessibility/check/sign', 'viewer', { template: 'nope' })).status, 400);
});

/* ---------------------------------------------------------------- captions */

test('captions: off until an admin configures an endpoint, and nothing is sent before that', async () => {
  let sent = 0;
  captions._setTransport(async () => { sent++; return { ok: true, status: 200, headers: { get: () => 'text/vtt' }, text: async () => 'WEBVTT\n\n00:00.000 --> 00:01.000\nhi' }; });
  const st = await call('GET', `/api/accessibility/captions/${F.talk}`, 'editor');
  assert.equal(st.json.stt_configured, false);
  const r = await call('POST', `/api/accessibility/captions/${F.talk}`, 'editor');
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'stt_not_configured');
  assert.equal(sent, 0);
});

test('speech-to-text settings: admin only, URL vetted, key encrypted at rest and never returned', async () => {
  assert.equal((await call('PUT', '/api/accessibility/stt', 'admin', { base_url: 'ftp://nope' })).status, 400);
  const r = await call('PUT', '/api/accessibility/stt', 'admin', { base_url: 'http://whisper.local:8000/v1/', model: 'Systran/faster-whisper-small', api_key: 'sk-test-secret' });
  assert.equal(r.status, 200);
  assert.equal(r.json.base_url, 'http://whisper.local:8000/v1');
  assert.equal(r.json.has_key, true);
  assert.ok(!JSON.stringify(r.json).includes('sk-test-secret'));
  const g = await call('GET', '/api/accessibility/stt', 'viewer');
  assert.ok(!JSON.stringify(g.json).includes('sk-test-secret'));
  const row = db.prepare('SELECT stt_api_key_enc FROM ai_settings WHERE workspace_id = ?').get(WS);
  assert.ok(row.stt_api_key_enc && !row.stt_api_key_enc.includes('sk-test-secret'));
  const a = db.prepare("SELECT details FROM activity_log WHERE action = 'stt_settings_updated' AND workspace_id = ? ORDER BY id DESC").get(WS);
  assert.ok(a && !a.details.includes('sk-test-secret'));
  // The existing AI settings row is untouched by this section.
  assert.equal(db.prepare('SELECT base_url FROM ai_settings WHERE workspace_id = ?').get(WS).base_url, null);
});

test('captions end to end: audio extracted, sent once to the configured endpoint, cleaned, attached, editable', { skip: !FFMPEG && 'ffmpeg not installed' }, async () => {
  const calls = [];
  captions._setTransport(async (url, opts) => {
    calls.push({ url, opts });
    // A hostile answer: markup, a script tag, an arrow in the text.
    return {
      ok: true, status: 200, headers: { get: () => 'text/vtt; charset=utf-8' },
      text: async () => 'WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.500\n<script>alert(1)</script>Hello <b>there</b>\n\n00:00:01.500 --> 00:00:02.000\nA --> B\n',
    };
  });
  const r = await call('POST', `/api/accessibility/captions/${F.talk}`, 'editor', { lang: 'en' });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  // A second press while it runs is refused rather than queued twice.
  const again = await call('POST', `/api/accessibility/captions/${F.talk}`, 'editor');
  assert.ok([409, 202].includes(again.status));
  let st;
  for (let i = 0; i < 100; i++) {
    st = await call('GET', `/api/accessibility/captions/${F.talk}`, 'viewer');
    if (st.json.job && st.json.job.status !== 'running') break;
    await new Promise((res) => setTimeout(res, 100));
  }
  assert.equal(st.json.job.status, 'done', JSON.stringify(st.json));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://whisper.local:8000/v1/audio/transcriptions');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers.authorization, 'Bearer sk-test-secret');
  assert.match(calls[0].opts.headers['content-type'], /^multipart\/form-data; boundary=/);
  const body = calls[0].opts.body.toString('latin1');
  assert.match(body, /name="model"\r\n\r\nSystran\/faster-whisper-small/);
  assert.match(body, /name="response_format"\r\n\r\nvtt/);
  assert.match(body, /name="language"\r\n\r\nen/);
  assert.match(body, /name="file"; filename="audio\.(mp3|wav)"/);
  // Only audio was sent: the part is an audio file, not the video's bytes.
  assert.match(body, /Content-Type: audio\/(mpeg|wav)\r\n/);
  assert.ok(!body.includes(fs.readFileSync(path.join(config.contentDir, 'talk.mp4')).subarray(0, 64).toString('latin1')));
  const row = db.prepare('SELECT subtitle_url, subtitle_lang FROM content WHERE id = ?').get(F.talk);
  assert.ok(/^[0-9a-f-]+\.vtt$/.test(row.subtitle_url));
  assert.equal(row.subtitle_lang, 'en');
  const vtt = fs.readFileSync(path.join(config.contentDir, row.subtitle_url), 'utf8');
  assert.ok(vtt.startsWith('WEBVTT'));
  assert.ok(!/<script|<b>/.test(vtt), vtt);
  assert.match(vtt, /alert\(1\)Hello there/);
  assert.match(vtt, /A → B/);
  assert.ok(db.prepare("SELECT 1 FROM activity_log WHERE action = 'captions_generated' AND workspace_id = ?").get(WS));
  // The no-captions error is gone.
  const rep = await call('GET', '/api/accessibility', 'editor');
  const talk = findSource(rep, 'content', F.talk);
  assert.ok(!talk || !talk.issues.some((i) => i.code === 'no_captions'));
  // Editable afterwards: read, change, save; garbage is refused.
  const got = await call('GET', `/api/accessibility/captions/${F.talk}/vtt`, 'viewer');
  assert.equal(got.json.vtt, vtt);
  const edited = await call('PUT', `/api/accessibility/captions/${F.talk}/vtt`, 'editor', { vtt: 'WEBVTT\n\n00:00.000 --> 00:01.000\nHello, welcome <i>in</i>\n', lang: 'en' });
  assert.equal(edited.status, 200);
  assert.match(edited.json.vtt, /00:00:00\.000 --> 00:00:01\.000\nHello, welcome in/);
  const bad = await call('PUT', `/api/accessibility/captions/${F.talk}/vtt`, 'editor', { vtt: 'nothing here' });
  assert.equal(bad.status, 400);
});

test('captions: an endpoint failure is reported on the job, not stored', { skip: !FFMPEG && 'ffmpeg not installed' }, async () => {
  const before = db.prepare('SELECT subtitle_url FROM content WHERE id = ?').get(F.talk).subtitle_url;
  captions._setTransport(async () => ({ ok: false, status: 401, headers: { get: () => 'application/json' }, text: async () => '{"error":"bad key"}' }));
  assert.equal((await call('POST', `/api/accessibility/captions/${F.talk}`, 'editor')).status, 202);
  let st;
  for (let i = 0; i < 100; i++) {
    st = await call('GET', `/api/accessibility/captions/${F.talk}`, 'editor');
    if (st.json.job && st.json.job.status !== 'running') break;
    await new Promise((res) => setTimeout(res, 100));
  }
  assert.equal(st.json.job.status, 'failed');
  assert.match(st.json.job.error, /401/);
  assert.equal(db.prepare('SELECT subtitle_url FROM content WHERE id = ?').get(F.talk).subtitle_url, before);
});

test('transcripts: WebVTT, SRT and JSON answers all become clean WebVTT', () => {
  const srt = '1\r\n00:00:01,000 --> 00:00:02,500\r\nHello\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nWorld\r\n';
  assert.equal(captions.normalizeTranscript(srt, 'text/plain'), 'WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nHello\n\n00:00:03.000 --> 00:00:04.000\nWorld\n\n');
  const json = JSON.stringify({ text: 'Hi all', segments: [{ start: 0, end: 1.2, text: ' Hi' }, { start: 1.2, end: 2, text: ' all' }] });
  assert.equal(captions.normalizeTranscript(json, 'application/json'), 'WEBVTT\n\n00:00:00.000 --> 00:00:01.200\nHi\n\n00:00:01.200 --> 00:00:02.000\nall\n\n');
  assert.match(captions.normalizeTranscript('{"text":"Just text"}', 'application/json', 8), /00:00:00\.000 --> 00:00:08\.000\nJust text/);
  assert.equal(captions.normalizeTranscript('', 'text/vtt'), null);
  assert.equal(captions.normalizeTranscript('<html>nope</html>', 'text/html'), null);
});
