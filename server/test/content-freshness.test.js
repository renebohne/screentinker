'use strict';

/*
 * Content freshness (lib/freshness.js, routes/freshness.js, services/freshness-digest.js and the
 * freshness branch of routes/unsubscribe.js), against a real migrated database.
 *
 *   - scoring on fixtures: play-time weighting, the assigned-playlist fallback, "arrived recently"
 *     counting as fresh, live items carrying no age, thresholds, snoozes, dark workspaces;
 *   - the HTTP surface: tenancy (another workspace's ids are invisible and unsnoozable), a viewer is
 *     read-only, settings are admin-only;
 *   - the weekly digest: who gets it, who never does, what it says, once a week, nothing without
 *     email or APP_URL, and nothing for a scale-out COPY (the primary sends those);
 *   - the unsubscribe link: bound to its list, GET never writes, POST opts out of the digest only.
 */

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-fresh-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { db } = require('../db/database');
const freshness = require('../lib/freshness');
const digest = require('../services/freshness-digest');
const unsubToken = require('../lib/unsubscribe-token');

const DAY = 86400;
const NOW = Math.floor(Date.now() / 1000);
const ago = (days) => NOW - Math.round(days * DAY);
const id = (p) => `${p}-${crypto.randomBytes(4).toString('hex')}`;

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

function user(email, { lastLogin = ago(1), alerts = 1, verified = 1 } = {}) {
  const uid = id('u');
  db.prepare('INSERT INTO users (id, email, name, email_alerts, email_verified, last_login, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(uid, email, email.split('@')[0], alerts, verified, lastLogin, ago(400));
  return uid;
}
function org(ownerId) {
  const oid = id('org');
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?,?,?)').run(oid, 'Org ' + oid, ownerId);
  db.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?,?, 'org_owner')").run(oid, ownerId);
  return oid;
}
function workspace(orgId, name, { createdAt = ago(400), origin = null } = {}) {
  const wid = id('ws');
  db.prepare('INSERT INTO workspaces (id, organization_id, name, created_at, origin_node_id) VALUES (?,?,?,?,?)').run(wid, orgId, name, createdAt, origin);
  return wid;
}
function member(wsId, userId, role) {
  db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?,?,?)').run(wsId, userId, role);
}
function content(wsId, filename, { created = ago(1), updated = created, mime = 'image/png', remote = null, expires = null } = {}) {
  const cid = id('c');
  db.prepare('INSERT INTO content (id, filename, mime_type, remote_url, created_at, updated_at, expires_at, workspace_id) VALUES (?,?,?,?,?,?,?,?)')
    .run(cid, filename, mime, remote, created, updated, expires, wsId);
  return cid;
}
function slide(wsId, name, fields, { updated = ago(1) } = {}) {
  const wid = id('w');
  db.prepare("INSERT INTO widgets (id, widget_type, name, config, created_at, updated_at, workspace_id) VALUES (?, 'slide', ?, ?, ?, ?, ?)")
    .run(wid, name, JSON.stringify({ fields }), updated, updated, wsId);
  return wid;
}
function playlist(wsId, ownerId, name, rows, { status = 'published' } = {}) {
  const pid = id('pl');
  db.prepare('INSERT INTO playlists (id, user_id, name, status, workspace_id) VALUES (?,?,?,?,?)').run(pid, ownerId, name, status, wsId);
  for (const r of rows) {
    db.prepare('INSERT INTO playlist_items (playlist_id, content_id, widget_id, duration_sec, created_at) VALUES (?,?,?,?,?)')
      .run(pid, r.content || null, r.widget || null, r.dur || 10, r.added || ago(500));
  }
  return pid;
}
function device(wsId, name, playlistId) {
  const did = id('d');
  db.prepare("INSERT INTO devices (id, name, status, playlist_id, playlist_source, workspace_id) VALUES (?, ?, 'online', ?, 'device', ?)")
    .run(did, name, playlistId, wsId);
  return did;
}
function play(wsId, deviceId, { content: cid = null, widget = null, secs, when = ago(1) }) {
  db.prepare('INSERT INTO play_logs (device_id, content_id, widget_id, started_at, ended_at, duration_sec, workspace_id) VALUES (?,?,?,?,?,?,?)')
    .run(deviceId, cid, widget, when, when + secs, secs, wsId);
}

const F = {};

before(() => {
  F.admin = user('admin@a.test');
  F.editor = user('editor@a.test');
  F.viewer = user('viewer@a.test');
  F.org = org(F.admin);
  F.wsA = workspace(F.org, 'Shop A');
  member(F.wsA, F.admin, 'workspace_admin');
  member(F.wsA, F.editor, 'workspace_editor');
  member(F.wsA, F.viewer, 'workspace_viewer');

  // Screen 1 plays an old promo for 90% of the time and a fresh one for 10%.
  F.oldPromo = content(F.wsA, 'Old promo.png', { created: ago(200) });
  F.newPromo = content(F.wsA, 'New promo.png', { created: ago(2) });
  F.christmas = content(F.wsA, 'Christmas 2025 menu.png', { created: ago(5) });
  F.expired = content(F.wsA, 'Summer deal.png', { created: ago(3), expires: ago(2) });
  F.web = content(F.wsA, 'News page', { created: ago(900), mime: 'text/html', remote: 'https://example.com' });
  F.saleSlide = slide(F.wsA, 'Sale slide', { headline: 'Sale ends Oct 3', body: 'Everything 20% off' }, { updated: Date.UTC(2026, 8, 20) / 1000 });
  F.pl1 = playlist(F.wsA, F.admin, 'Window', [
    { content: F.oldPromo, dur: 30 }, { content: F.newPromo, dur: 10 }, { content: F.christmas }, { content: F.expired }, { widget: F.saleSlide },
  ]);
  F.scr1 = device(F.wsA, 'Window screen', F.pl1);
  play(F.wsA, F.scr1, { content: F.oldPromo, secs: 900 });
  play(F.wsA, F.scr1, { content: F.newPromo, secs: 100 });

  // Screen 2: no plays at all; its playlist has an old photo that was ADDED yesterday, and a live page.
  F.oldPhoto = content(F.wsA, 'Team photo.jpg', { created: ago(700) });
  F.pl2 = playlist(F.wsA, F.admin, 'Lobby', [{ content: F.oldPhoto, added: ago(1) }, { content: F.web }]);
  F.scr2 = device(F.wsA, 'Lobby screen', F.pl2);

  // Screen 3: only a live web page.
  F.pl3 = playlist(F.wsA, F.admin, 'Live', [{ content: F.web }]);
  F.scr3 = device(F.wsA, 'Live screen', F.pl3);

  // Another tenant entirely.
  F.otherAdmin = user('admin@b.test');
  F.orgB = org(F.otherAdmin);
  F.wsB = workspace(F.orgB, 'Shop B');
  member(F.wsB, F.otherAdmin, 'workspace_admin');
  F.bContent = content(F.wsB, 'B secret plan.png', { created: ago(300) });
  F.plB = playlist(F.wsB, F.otherAdmin, 'B list', [{ content: F.bContent }]);
  F.scrB = device(F.wsB, 'B screen', F.plB);
});

// ---------------------------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------------------------

test('a screen is aged by what PLAYED, weighted by play time', () => {
  const r = freshness.computeWorkspace(db, F.wsA, { useCache: false });
  const s1 = r.devices.find((d) => d.id === F.scr1);
  assert.equal(s1.basis, 'plays');
  // 900s of a 200-day-old item + 100s of a 2-day-old one ≈ 180 days.
  assert.ok(s1.age_days > 175 && s1.age_days < 185, `weighted age ${s1.age_days}`);
  assert.equal(s1.status, 'very_stale');
  assert.match(s1.explain, /weighted by play time/);
  assert.match(s1.explain, /very stale/);
});

test('no plays: the screen falls back to its playlist, and an item that ARRIVED yesterday is fresh to it', () => {
  const r = freshness.computeWorkspace(db, F.wsA, { useCache: false });
  const s2 = r.devices.find((d) => d.id === F.scr2);
  assert.equal(s2.basis, 'assigned');
  assert.ok(s2.age_days < 2, `a 700-day-old photo added yesterday is new on this screen (got ${s2.age_days})`);
  assert.equal(s2.status, 'fresh');
});

test('live items (web pages, streams, live widgets) carry no age', () => {
  const r = freshness.computeWorkspace(db, F.wsA, { useCache: false });
  const s3 = r.devices.find((d) => d.id === F.scr3);
  assert.equal(s3.age_days, null);
  assert.equal(s3.status, 'live');
  const web = r.items.find((i) => i.id === F.web);
  assert.equal(web.ageable, false);
  assert.ok(!web.flags.some((f) => f.code === 'stale' || f.code === 'very_stale'), 'a 900-day-old web page row is not stale');
});

test('detectors: past date in a name and on a slide, expired-but-assigned, unchanged', () => {
  const r = freshness.computeWorkspace(db, F.wsA, { useCache: false });
  const codes = (cid) => r.items.find((i) => i.id === cid).flags.map((f) => f.code);
  assert.ok(codes(F.christmas).includes('past_date'));
  assert.ok(codes(F.saleSlide).includes('past_date') || NOW < Date.UTC(2026, 9, 5) / 1000,
    'the slide says "Sale ends Oct 3" and was last changed 20 Sep 2026');
  assert.ok(codes(F.expired).includes('expired_assigned'));
  assert.ok(codes(F.oldPromo).includes('very_stale'));
  assert.deepEqual(codes(F.newPromo), []);
  const xmas = r.items.find((i) => i.id === F.christmas).flags.find((f) => f.code === 'past_date');
  assert.match(xmas.explain, /Christmas 2025/);
  // Worst first: dated problems outrank plain age.
  assert.ok(['past_date', 'expired_assigned'].includes(r.items[0].flags[0].code));
  assert.ok(r.counts.past_date_items >= 1);
  assert.equal(r.counts.very_stale_screens, 1);
});

test('the report never contains another workspace\'s screens or items', () => {
  const r = freshness.computeWorkspace(db, F.wsA, { useCache: false });
  assert.ok(!r.devices.some((d) => d.id === F.scrB));
  assert.ok(!r.items.some((i) => i.id === F.bContent));
  assert.ok(!r.playlists.some((p) => p.id === F.plB));
});

test('thresholds are per workspace and change the verdict; very stale must exceed stale', () => {
  const cur = freshness.getSettings(db, F.wsA);
  assert.deepEqual(cur, { stale_days: 30, very_stale_days: 90, window_days: 7, digest_enabled: 1 });
  assert.equal(freshness.validateSettings(cur, { stale_days: 90, very_stale_days: 90 }).ok, false);
  assert.equal(freshness.validateSettings(cur, { stale_days: 0 }).ok, false);
  assert.equal(freshness.validateSettings(cur, { window_days: 365 }).ok, false);
  const v = freshness.validateSettings(cur, { stale_days: 200, very_stale_days: 400 });
  assert.ok(v.ok);
  freshness.saveSettings(db, F.wsA, v.settings, F.admin);
  const r = freshness.computeWorkspace(db, F.wsA, { useCache: false });
  assert.equal(r.devices.find((d) => d.id === F.scr1).status, 'fresh', '~180 days is under a 200-day mark');
  freshness.saveSettings(db, F.wsA, cur, F.admin);
  assert.deepEqual(freshness.getSettings(db, F.wsB), cur, 'workspace B kept the defaults');
});

test('a snoozed item stops counting, and a snoozed screen leaves the counts', () => {
  db.prepare("INSERT INTO freshness_snoozes (workspace_id, resource_type, resource_id, until) VALUES (?, 'content', ?, ?)").run(F.wsA, F.oldPromo, NOW + 30 * DAY);
  freshness.invalidate(F.wsA);
  let r = freshness.computeWorkspace(db, F.wsA, { useCache: false });
  const s1 = r.devices.find((d) => d.id === F.scr1);
  assert.ok(s1.age_days < 5, 'with the old promo snoozed, only the new one is weighed');
  assert.ok(!freshness.chipsFrom(r).content[F.oldPromo], 'no chip for a snoozed item');
  db.prepare("DELETE FROM freshness_snoozes WHERE resource_id = ?").run(F.oldPromo);

  db.prepare("INSERT INTO freshness_snoozes (workspace_id, resource_type, resource_id, until) VALUES (?, 'device', ?, ?)").run(F.wsA, F.scr1, NOW + DAY);
  r = freshness.computeWorkspace(db, F.wsA, { useCache: false });
  assert.equal(r.counts.very_stale_screens, 0);
  assert.ok(!freshness.chipsFrom(r).devices[F.scr1]);
  // An expired snooze is no snooze.
  db.prepare('UPDATE freshness_snoozes SET until = ? WHERE resource_id = ?').run(NOW - 1, F.scr1);
  r = freshness.computeWorkspace(db, F.wsA, { useCache: false });
  assert.equal(r.counts.very_stale_screens, 1);
  db.prepare('DELETE FROM freshness_snoozes WHERE resource_id = ?').run(F.scr1);
});

test('dark workspace: no admin/editor sign-in for 90 days; a young workspace is never dark', () => {
  const u = user('sleepy@c.test', { lastLogin: ago(120) });
  const o = org(u);
  db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(ago(120), u);
  const w = workspace(o, 'Forgotten');
  member(w, u, 'workspace_admin');
  assert.equal(freshness.darkness(db, w, NOW).dark, true);
  const young = workspace(o, 'Brand new', { createdAt: ago(10) });
  assert.equal(freshness.darkness(db, young, NOW).dark, false);
  assert.equal(freshness.darkness(db, F.wsA, NOW).dark, false);
});

test('chips: a compact per-id map with a reason sentence each', () => {
  const chips = freshness.chipsFrom(freshness.computeWorkspace(db, F.wsA, { useCache: false }));
  assert.equal(chips.devices[F.scr1].status, 'very_stale');
  assert.ok(chips.devices[F.scr1].reasons[0].explain);
  assert.ok(chips.content[F.christmas].reasons.some((r) => r.code === 'past_date'));
  assert.ok(!chips.devices[F.scr2], 'a fresh screen gets no chip');
});

// ---------------------------------------------------------------------------------------------
// HTTP: tenancy and roles
// ---------------------------------------------------------------------------------------------

let server, base;
before(async () => {
  const app = express();
  app.use(express.json());
  // Stand-in for requireAuth + resolveTenancy: the headers pick the caller, the workspace and role.
  app.use((req, _res, next) => {
    req.user = { id: req.headers['x-user'], role: 'user' };
    req.workspaceId = req.headers['x-ws'];
    req.workspaceRole = req.headers['x-role'];
    req.orgRole = null; req.actingAs = false; req.isPlatformAdmin = false; req.isPlatformStaff = false;
    next();
  });
  app.use('/api/freshness', require('../routes/freshness'));
  app.use('/unsubscribe', express.urlencoded({ extended: false }), require('../routes/unsubscribe'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

async function call(method, url, { as, ws = F.wsA, role, body, form } = {}) {
  const headers = { 'x-user': as || '', 'x-ws': ws || '', 'x-role': role || '' };
  let payload;
  if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form).toString(); }
  else if (body) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(base + url, { method, headers, body: payload });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (_) { /* html */ }
  return { status: r.status, json, text };
}

test('GET /api/freshness: any member may read; can_write tells the page what to offer', async () => {
  const v = await call('GET', '/api/freshness', { as: F.viewer, role: 'workspace_viewer' });
  assert.equal(v.status, 200);
  assert.equal(v.json.can_write, false);
  assert.ok(v.json.devices.length >= 3);
  const e = await call('GET', '/api/freshness', { as: F.editor, role: 'workspace_editor' });
  assert.equal(e.json.can_write, true);
  assert.equal(e.json.can_admin, false);
  const none = await call('GET', '/api/freshness', { as: F.viewer, ws: '', role: '' });
  assert.equal(none.status, 403);
});

test('a viewer is read-only: no snooze, no settings, no digest toggle', async () => {
  const s = await call('POST', '/api/freshness/snooze', { as: F.viewer, role: 'workspace_viewer', body: { type: 'content', id: F.oldPromo, days: 30 } });
  assert.equal(s.status, 403);
  const p = await call('PUT', '/api/freshness/settings', { as: F.viewer, role: 'workspace_viewer', body: { stale_days: 10, very_stale_days: 20 } });
  assert.equal(p.status, 403);
  const d = await call('PUT', '/api/freshness/digest', { as: F.viewer, role: 'workspace_viewer', body: { enabled: false } });
  assert.equal(d.status, 403);
});

test('settings are admin-only and validated', async () => {
  const ed = await call('PUT', '/api/freshness/settings', { as: F.editor, role: 'workspace_editor', body: { stale_days: 10, very_stale_days: 20 } });
  assert.equal(ed.status, 403);
  const bad = await call('PUT', '/api/freshness/settings', { as: F.admin, role: 'workspace_admin', body: { stale_days: 50, very_stale_days: 20 } });
  assert.equal(bad.status, 400);
  const ok = await call('PUT', '/api/freshness/settings', { as: F.admin, role: 'workspace_admin', body: { stale_days: 45, very_stale_days: 120 } });
  assert.equal(ok.status, 200);
  assert.equal(freshness.getSettings(db, F.wsA).stale_days, 45);
  const audit = db.prepare("SELECT workspace_id FROM activity_log WHERE action = 'freshness_settings_updated' ORDER BY id DESC").get();
  assert.equal(audit.workspace_id, F.wsA);
  await call('PUT', '/api/freshness/settings', { as: F.admin, role: 'workspace_admin', body: { stale_days: 30, very_stale_days: 90 } });
});

test('⚠️ tenancy: another workspace\'s id cannot be snoozed, and the answer is the same as for no such id', async () => {
  const foreign = await call('POST', '/api/freshness/snooze', { as: F.editor, role: 'workspace_editor', body: { type: 'content', id: F.bContent, days: 30 } });
  const missing = await call('POST', '/api/freshness/snooze', { as: F.editor, role: 'workspace_editor', body: { type: 'content', id: 'nope', days: 30 } });
  assert.equal(foreign.status, 404);
  assert.equal(missing.status, 404);
  assert.deepEqual(foreign.json, missing.json);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM freshness_snoozes WHERE resource_id = ?').get(F.bContent).n, 0);
  // And a device of B, through B's own type.
  const dev = await call('POST', '/api/freshness/snooze', { as: F.editor, role: 'workspace_editor', body: { type: 'device', id: F.scrB, days: 30 } });
  assert.equal(dev.status, 404);
});

test('snooze: an editor can, input is validated, and unsnooze is scoped to the workspace', async () => {
  const badType = await call('POST', '/api/freshness/snooze', { as: F.editor, role: 'workspace_editor', body: { type: 'users', id: F.admin, days: 30 } });
  assert.equal(badType.status, 400);
  const badDays = await call('POST', '/api/freshness/snooze', { as: F.editor, role: 'workspace_editor', body: { type: 'content', id: F.oldPromo, days: 9999 } });
  assert.equal(badDays.status, 400);
  const ok = await call('POST', '/api/freshness/snooze', { as: F.editor, role: 'workspace_editor', body: { type: 'content', id: F.oldPromo, days: 30 } });
  assert.equal(ok.status, 201);
  const chips = await call('GET', '/api/freshness/chips', { as: F.editor, role: 'workspace_editor' });
  assert.ok(!chips.json.content[F.oldPromo], 'the cache was invalidated by the snooze');
  // Workspace B's admin cannot remove A's snooze by naming it.
  const crossDel = await call('DELETE', `/api/freshness/snooze/content/${F.oldPromo}`, { as: F.otherAdmin, ws: F.wsB, role: 'workspace_admin' });
  assert.equal(crossDel.status, 404);
  const del = await call('DELETE', `/api/freshness/snooze/content/${F.oldPromo}`, { as: F.editor, role: 'workspace_editor' });
  assert.equal(del.status, 200);
});

test('digest preference: the caller\'s own, and the account-wide alert opt-out is reported beside it', async () => {
  const off = await call('PUT', '/api/freshness/digest', { as: F.editor, role: 'workspace_editor', body: { enabled: false } });
  assert.equal(off.json.enabled, false);
  assert.equal((await call('GET', '/api/freshness/digest', { as: F.admin, role: 'workspace_admin' })).json.enabled, true, 'only the caller changed');
  const on = await call('PUT', '/api/freshness/digest', { as: F.editor, role: 'workspace_editor', body: { enabled: true } });
  assert.equal(on.json.enabled, true);
  assert.equal(on.json.email_alerts_off, false);
});

// ---------------------------------------------------------------------------------------------
// The weekly digest
// ---------------------------------------------------------------------------------------------

function sink({ fail = false, devRestrict = false } = {}) {
  const sent = [];
  return {
    sent,
    isConfigured: () => true,
    sendEmail: async (m) => {
      if (fail) return { sent: false, reason: 'smtp_error' };
      if (devRestrict) return { sent: false, reason: 'dev_restricted' };
      sent.push(m); return { sent: true };
    },
  };
}
const resetDigest = () => db.prepare('DELETE FROM freshness_digest_prefs').run();

test('digest: admins and editors get one email covering what is stale, with deep links and a freshness unsubscribe', async () => {
  resetDigest();
  const mail = sink();
  const r = await digest.runDigestSweep({ db, email: mail, appUrl: 'https://signs.example.com/' });
  const to = mail.sent.map((m) => m.to).sort();
  assert.ok(to.includes('admin@a.test') && to.includes('editor@a.test'));
  assert.ok(!to.includes('viewer@a.test'), 'viewers never');
  assert.equal(new Set(to).size, to.length, 'one email per person');
  const m = mail.sent.find((x) => x.to === 'editor@a.test');
  assert.match(m.subject, /screen.* going stale/);
  assert.match(m.text, /Window screen/);
  assert.match(m.text, /Christmas 2025 menu\.png/);
  assert.match(m.text, new RegExp(`https://signs\\.example\\.com/app#/device/${F.scr1}`));
  assert.match(m.text, new RegExp(`https://signs\\.example\\.com/app#/freshness\\?ws=${F.wsA}`));
  assert.ok(!/B secret plan/.test(m.text) && !/B screen/.test(m.text), 'nothing from a workspace they are not in');
  assert.equal(m.unsubscribeUserId, F.editor);
  assert.equal(m.unsubscribeList, 'freshness');
  assert.ok(r.sent >= 2);
});

test('digest: the HTML escapes names that came from operators', async () => {
  resetDigest();
  const evil = content(F.wsA, '<img src=x onerror=alert(1)> Christmas 2024.png', { created: ago(3) });
  db.prepare('INSERT INTO playlist_items (playlist_id, content_id, duration_sec) VALUES (?,?,10)').run(F.pl1, evil);
  freshness.invalidate(F.wsA);
  const mail = sink();
  await digest.runDigestSweep({ db, email: mail, appUrl: 'https://signs.example.com' });
  const m = mail.sent.find((x) => x.to === 'admin@a.test');
  assert.ok(!m.html.includes('<img src=x'), 'raw markup must not reach the HTML body');
  assert.match(m.html, /&lt;img src=x/);
  db.prepare('DELETE FROM playlist_items WHERE content_id = ?').run(evil);
  db.prepare('DELETE FROM content WHERE id = ?').run(evil);
});

test('digest: once a week, and a failed send is retried rather than stamped', async () => {
  resetDigest();
  const failing = sink({ fail: true });
  await digest.runDigestSweep({ db, email: failing, appUrl: 'https://x.test' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM freshness_digest_prefs WHERE last_sent_at IS NOT NULL').get().n, 0);
  const first = sink();
  await digest.runDigestSweep({ db, email: first, appUrl: 'https://x.test' });
  assert.ok(first.sent.length >= 2);
  const again = sink();
  await digest.runDigestSweep({ db, email: again, appUrl: 'https://x.test', now: NOW + 3 * DAY });
  assert.equal(again.sent.length, 0, 'three days later: nothing');
  const week = sink();
  await digest.runDigestSweep({ db, email: week, appUrl: 'https://x.test', now: NOW + 7 * DAY });
  assert.ok(week.sent.length >= 2, 'a week later: again');
});

test('digest: dev email restriction counts as handled (stamped, not retried daily)', async () => {
  resetDigest();
  await digest.runDigestSweep({ db, email: sink({ devRestrict: true }), appUrl: 'https://x.test' });
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM freshness_digest_prefs WHERE last_sent_at IS NOT NULL').get().n >= 2);
});

test('digest: respects the digest opt-out, the account-wide alert opt-out, and the workspace switch', async () => {
  resetDigest();
  db.prepare('INSERT INTO freshness_digest_prefs (user_id, opted_out) VALUES (?, 1)').run(F.editor);
  db.prepare('UPDATE users SET email_alerts = 0 WHERE id = ?').run(F.admin);
  let mail = sink();
  await digest.runDigestSweep({ db, email: mail, appUrl: 'https://x.test' });
  assert.ok(!mail.sent.some((m) => m.to === 'editor@a.test' || m.to === 'admin@a.test'));
  db.prepare('UPDATE users SET email_alerts = 1 WHERE id = ?').run(F.admin);
  resetDigest();
  freshness.saveSettings(db, F.wsA, { ...freshness.getSettings(db, F.wsA), digest_enabled: 0 }, F.admin);
  mail = sink();
  await digest.runDigestSweep({ db, email: mail, appUrl: 'https://x.test' });
  assert.ok(!mail.sent.some((m) => m.to === 'admin@a.test'), 'workspace digest switched off: nothing about it');
  freshness.saveSettings(db, F.wsA, { ...freshness.getSettings(db, F.wsA), digest_enabled: 1 }, F.admin);
});

test('digest: self-hosted without email or without APP_URL simply sends nothing (no error)', async () => {
  resetDigest();
  const off = { isConfigured: () => false, sendEmail: async () => { throw new Error('must not send'); } };
  assert.deepEqual(await digest.runDigestSweep({ db, email: off, appUrl: 'https://x.test' }), { skipped: 'email_not_configured', sent: 0 });
  const mail = sink();
  assert.deepEqual(await digest.runDigestSweep({ db, email: mail, appUrl: '' }), { skipped: 'no_app_url', sent: 0 });
  assert.equal(mail.sent.length, 0);
  const prev = process.env.FRESHNESS_DIGEST;
  process.env.FRESHNESS_DIGEST = 'off';
  try { assert.equal((await digest.runDigestSweep({ db, email: mail, appUrl: 'https://x.test' })).skipped, 'disabled'); }
  finally { if (prev === undefined) delete process.env.FRESHNESS_DIGEST; else process.env.FRESHNESS_DIGEST = prev; }
});

test('⚠️ scale-out: a COPIED workspace and its users are the primary\'s to email, never a replica\'s', async () => {
  resetDigest();
  const u = user('replica-editor@r.test');
  const o = org(u);
  const copied = workspace(o, 'Copied shop', { origin: 'node-primary-1' });
  member(copied, u, 'workspace_editor');
  const old = content(copied, 'Christmas 2024 window.png', { created: ago(400) });
  const pl = playlist(copied, u, 'Copied list', [{ content: old }]);
  device(copied, 'Copied screen', pl);
  const mail = sink();
  await digest.runDigestSweep({ db, email: mail, appUrl: 'https://x.test' });
  assert.ok(!mail.sent.some((m) => m.to === 'replica-editor@r.test'));
  assert.ok(!mail.sent.some((m) => /Copied shop/.test(m.text)));
  // The same people on the primary (origin cleared) are mailed: the filter is the copy, not the data.
  db.prepare('UPDATE workspaces SET origin_node_id = NULL WHERE id = ?').run(copied);
  const mail2 = sink();
  await digest.runDigestSweep({ db, email: mail2, appUrl: 'https://x.test' });
  assert.ok(mail2.sent.some((m) => m.to === 'replica-editor@r.test'));
  // And the sweep is wired with the replica filters (the shape test_replica_never_runs_primary_sweeps uses).
  const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'services', 'freshness-digest.js'), 'utf8');
  assert.match(src, /LOCAL_USERS_SQL\(/);
  assert.match(src, /LOCAL_ROWS_SQL\(/);
});

test('digest content is pure and says nothing when nothing is stale', () => {
  const quiet = { workspace: { dark: false }, counts: { stale_screens: 0, very_stale_screens: 0, past_date_items: 0, expired_assigned_items: 0, out_of_season_items: 0 }, devices: [], items: [] };
  assert.equal(digest.composeDigest({ email: 'a@b.c' }, [{ ws: { id: 'w', name: 'W' }, report: quiet }], 'https://x/app'), null);
});

// ---------------------------------------------------------------------------------------------
// Unsubscribe
// ---------------------------------------------------------------------------------------------

test('⚠️ the digest link is bound to its list: it cannot switch off alert email, and vice versa', () => {
  const ft = unsubToken.tokenFor(F.admin, 'freshness');
  const at = unsubToken.tokenFor(F.admin);
  assert.notEqual(ft, at);
  assert.equal(unsubToken.verify(F.admin, ft, 'alerts'), false);
  assert.equal(unsubToken.verify(F.admin, at, 'freshness'), false);
  assert.equal(unsubToken.verify(F.admin, ft, 'freshness'), true);
  const prev = process.env.APP_URL;
  process.env.APP_URL = 'https://signs.example.com';
  try {
    assert.match(unsubToken.unsubscribeUrl(F.admin, 'freshness'), /&l=freshness$/);
    assert.ok(!/&l=/.test(unsubToken.unsubscribeUrl(F.admin)), 'alert links are unchanged');
    const parts = require('../services/email').unsubscribeParts(F.admin, 'freshness');
    assert.match(parts.footerHtml, /weekly digest/);
    assert.match(parts.headers['List-Unsubscribe'], /l=freshness/);
  } finally { if (prev === undefined) delete process.env.APP_URL; else process.env.APP_URL = prev; }
});

test('unsubscribe: GET shows a button and writes nothing; POST opts out of the digest ONLY', async () => {
  resetDigest();
  const t = unsubToken.tokenFor(F.admin, 'freshness');
  const q = `?u=${encodeURIComponent(F.admin)}&t=${t}&l=freshness`;
  const g = await call('GET', '/unsubscribe' + q);
  assert.equal(g.status, 200);
  assert.match(g.text, /weekly freshness digest/);
  assert.match(g.text, /name="l" value="freshness"/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM freshness_digest_prefs WHERE user_id = ?').get(F.admin).n, 0, 'GET never writes');

  const p = await call('POST', '/unsubscribe', { form: { u: F.admin, t, l: 'freshness' } });
  assert.equal(p.status, 200);
  assert.equal(db.prepare('SELECT opted_out FROM freshness_digest_prefs WHERE user_id = ?').get(F.admin).opted_out, 1);
  assert.equal(db.prepare('SELECT email_alerts FROM users WHERE id = ?').get(F.admin).email_alerts, 1, 'alert email untouched');
  assert.ok(db.prepare("SELECT 1 FROM activity_log WHERE action = 'freshness_digest_unsubscribed' AND user_id = ?").get(F.admin));

  // RFC 8058 one-click: the list rides in the URL's query, the body is List-Unsubscribe=One-Click.
  db.prepare('DELETE FROM freshness_digest_prefs WHERE user_id = ?').run(F.editor);
  const et = unsubToken.tokenFor(F.editor, 'freshness');
  const oc = await call('POST', `/unsubscribe?u=${encodeURIComponent(F.editor)}&t=${et}&l=freshness`, { form: { 'List-Unsubscribe': 'One-Click' } });
  assert.equal(oc.status, 200);
  assert.equal(db.prepare('SELECT opted_out FROM freshness_digest_prefs WHERE user_id = ?').get(F.editor).opted_out, 1);

  // A digest token with the list stripped is an ALERTS request now, and must not verify.
  const stripped = await call('POST', '/unsubscribe', { form: { u: F.admin, t } });
  assert.equal(stripped.status, 400);
  assert.equal(db.prepare('SELECT email_alerts FROM users WHERE id = ?').get(F.admin).email_alerts, 1);
  resetDigest();
});
