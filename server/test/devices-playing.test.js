'use strict';

/*
 * "Which devices are actually playing X?"
 *
 * ⚠️ This question has been answered wrongly five separate times, always the same way: a
 * hand-written `JOIN playlist_items pi ON pi.playlist_id = d.playlist_id`. routes/playlists.js
 * carries a comment calling it "the THIRD time this exact shape has bitten" — directly above a
 * fourth instance. The two cases every caller has to handle:
 *
 *   INHERITANCE — devices.playlist_id is NULL for a screen that inherits from its group or wall,
 *   so joining the raw column skips exactly those screens.
 *
 *   NESTING — a parent's rows hold a CHILD REFERENCE, not the child's items, so a widget or file
 *   inside a nested playlist appears nowhere in the parent's playlist_items even though the
 *   parent's flattened snapshot plays it.
 *
 * Found while researching slide templates: the widget-edit push is the exact path a template's
 * "edit the text later" would ride on, and it was broken for both cases.
 */
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-devplay-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const { devicesOnPlaylist, devicesPlayingWidget, devicesPlayingContent } = require('../lib/devices-playing');

const id = () => crypto.randomUUID();
let userId, wsId;

const mkPlaylist = (n) => { const p = id(); db.prepare('INSERT INTO playlists (id, user_id, workspace_id, name) VALUES (?,?,?,?)').run(p, userId, wsId, n); return p; };
const mkWidget = (n) => { const w = id(); db.prepare("INSERT INTO widgets (id, user_id, workspace_id, widget_type, name, config) VALUES (?,?,?,'text',?,'{}')").run(w, userId, wsId, n); return w; };
const mkContent = (n) => { const c = id(); db.prepare('INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type) VALUES (?,?,?,?,?,?)').run(c, userId, wsId, n, `uploads/${n}`, 'video/mp4'); return c; };
const addItem = (pl, cols) => db.prepare(`INSERT INTO playlist_items (playlist_id, content_id, widget_id, child_playlist_id, sort_order, duration_sec) VALUES (?,?,?,?,0,10)`)
  .run(pl, cols.content_id || null, cols.widget_id || null, cols.child_playlist_id || null);
const mkDevice = (n, cols = {}) => {
  const d = id();
  db.prepare('INSERT INTO devices (id, user_id, workspace_id, name, pairing_code, playlist_id, playlist_source) VALUES (?,?,?,?,?,?,?)')
    .run(d, userId, wsId, n, id().slice(0, 6), cols.playlist_id || null, cols.playlist_source || null);
  return d;
};
const mkGroupWith = (playlistId, deviceId) => {
  const g = id();
  db.prepare('INSERT INTO device_groups (id, user_id, workspace_id, name, playlist_id) VALUES (?,?,?,?,?)').run(g, userId, wsId, 'g-' + g.slice(0, 4), playlistId);
  db.prepare('INSERT INTO device_group_members (device_id, group_id) VALUES (?, ?)').run(deviceId, g);
  return g;
};

before(() => {
  userId = id();
  db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)').run(userId, `dp-${userId}@example.com`, 'DP', 'x');
  /*
   * ⚠️ Real organization + workspace rows. `triggers.workspace_id` is NOT NULL and joins to
   * `devices.workspace_id`, so a NULL (what "whatever workspace exists" returns on a fresh DB)
   * cannot set up the trigger case at all — and a synthetic id cannot either, because this
   * database runs with `foreign_keys = ON`.
   */
  wsId = db.prepare('SELECT id FROM workspaces LIMIT 1').get()?.id;
  if (!wsId) {
    const orgId = id(); wsId = id();
    db.prepare(`INSERT INTO organizations (id, name, owner_user_id, created_at, updated_at)
                VALUES (?, ?, ?, strftime('%s','now'), strftime('%s','now'))`).run(orgId, 'dp-org', userId);
    db.prepare(`INSERT INTO workspaces (id, organization_id, name, created_at, updated_at)
                VALUES (?, ?, ?, strftime('%s','now'), strftime('%s','now'))`).run(wsId, orgId, 'dp-ws');
  }
});

test('⚠️ a screen that INHERITS its playlist is found — the raw column is NULL for it', () => {
  const pl = mkPlaylist('inherit-pl'); const w = mkWidget('wa');
  addItem(pl, { widget_id: w });
  const inheriting = mkDevice('inheriting');
  mkGroupWith(pl, inheriting);

  assert.equal(db.prepare('SELECT playlist_id FROM devices WHERE id = ?').get(inheriting).playlist_id, null,
    'precondition: no copy on the row');
  assert.deepEqual(devicesPlayingWidget(w), [inheriting],
    'the old join was on devices.playlist_id, so editing this widget never pushed to this screen');
  assert.deepEqual(devicesOnPlaylist(pl), [inheriting]);
});

test('⚠️ a widget inside a NESTED playlist is found through the parent', () => {
  const child = mkPlaylist('child-pl'); const parent = mkPlaylist('parent-pl');
  const w = mkWidget('nested-w');
  addItem(child, { widget_id: w });
  addItem(parent, { child_playlist_id: child });
  const d = mkDevice('nested-screen', { playlist_id: parent, playlist_source: 'device' });

  assert.deepEqual(devicesPlayingWidget(w), [d],
    "the parent's rows hold a child REFERENCE, not the child's items — but its flattened snapshot "
    + 'plays the widget, so the screen is showing it and must be told when it changes');
});

test('replaced CONTENT reaches inheriting and nested screens alike', () => {
  const child = mkPlaylist('c-child'); const parent = mkPlaylist('c-parent');
  const c = mkContent('clip.mp4');
  addItem(child, { content_id: c });
  addItem(parent, { child_playlist_id: child });
  const viaNest = mkDevice('via-nest', { playlist_id: parent, playlist_source: 'device' });

  const direct = mkPlaylist('c-direct');
  addItem(direct, { content_id: c });
  const viaInherit = mkDevice('via-inherit');
  mkGroupWith(direct, viaInherit);

  const found = devicesPlayingContent(c).sort();
  assert.deepEqual(found, [viaNest, viaInherit].sort(),
    'a screen kept playing the OLD bytes after a replace — the failure the push exists to prevent');
});

test('a device playing something else is not swept in', () => {
  const pl = mkPlaylist('unrelated'); const w = mkWidget('unrelated-w');
  addItem(pl, { widget_id: w });
  const other = mkPlaylist('other-pl');
  const d = mkDevice('bystander', { playlist_id: other, playlist_source: 'device' });
  assert.ok(!devicesPlayingWidget(w).includes(d));
});

test('a device with an explicit override is still found the ordinary way', () => {
  const pl = mkPlaylist('own-pl'); const w = mkWidget('own-w');
  addItem(pl, { widget_id: w });
  const d = mkDevice('owner', { playlist_id: pl, playlist_source: 'device' });
  assert.deepEqual(devicesPlayingWidget(w), [d]);
});

test('⚠️ a device that reaches the item only through a TRIGGER is found', () => {
  const target = mkPlaylist('trigger-target'); const w = mkWidget('trig-w');
  addItem(target, { widget_id: w });

  // The device's own playlist has nothing to do with the target — it can only ever show this
  // widget when its trigger fires.
  const base = mkPlaylist('base-pl');
  const d = mkDevice('trigger-screen', { playlist_id: base, playlist_source: 'device' });

  const trig = id();
  db.prepare(`INSERT INTO triggers (id, workspace_id, name, match_token, target_kind, target_ref, enabled)
              VALUES (?, ?, ?, ?, 'playlist', ?, 1)`).run(trig, wsId, 'evac', 'tok-' + trig.slice(0, 6), target);
  db.prepare("INSERT INTO trigger_assignments (trigger_id, target_type, target_id) VALUES (?, 'device', ?)").run(trig, d);

  assert.ok(devicesPlayingWidget(w).includes(d),
    'the trigger case is the one every hand-written fan-out forgot — this screen shows the widget '
    + 'when the trigger fires, so it must be told when the widget changes');
});
