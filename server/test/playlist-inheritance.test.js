'use strict';

/*
 * Which playlist a screen plays. See docs/playlist-inheritance-design.md.
 *
 * devices.playlist_id had ONE reader and TWELVE writers (fifteen, once the scheduler and the group
 * sync queries were counted), so there was no precedence at all — only whoever wrote last. These
 * tests pin the rule the resolver applies and, more importantly, the migration invariant: no device
 * may change what it plays.
 *
 * ⚠️ Every test here is mutation-checked. A precedence test that passes against a broken ORDER BY
 * is worth nothing, and this project has already shipped three tests that could not fail.
 */
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-inherit-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const { resolveDevicePlaylist, clearInheritedCopy } = require('../lib/resolve-device-playlist');
const { backfillPlaylistSource, verifyNoDeviceChanged } = require('../lib/playlist-source-backfill');

const id = () => crypto.randomUUID();
let userId;

const mkPlaylist = (name) => {
  const p = id();
  db.prepare('INSERT INTO playlists (id, user_id, name) VALUES (?, ?, ?)').run(p, userId, name);
  return p;
};
const mkDevice = (opts = {}) => {
  const d = id();
  db.prepare('INSERT INTO devices (id, user_id, name, pairing_code, playlist_id, playlist_source, wall_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(d, userId, opts.name || 'dev', id().slice(0, 6), opts.playlist_id || null, opts.playlist_source || null, opts.wall_id || null);
  return d;
};
const mkGroup = (playlistId, { priority = 0, created_at = 1000 } = {}) => {
  const g = id();
  db.prepare('INSERT INTO device_groups (id, user_id, name, playlist_id, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(g, userId, 'g-' + g.slice(0, 4), playlistId, priority, created_at);
  return g;
};
const join = (deviceId, groupId) =>
  db.prepare('INSERT INTO device_group_members (device_id, group_id) VALUES (?, ?)').run(deviceId, groupId);
const mkWall = (playlistId) => {
  const w = id();
  db.prepare('INSERT INTO video_walls (id, user_id, name, playlist_id) VALUES (?, ?, ?, ?)').run(w, userId, 'wall', playlistId);
  return w;
};

before(() => {
  userId = id();
  db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)')
    .run(userId, `inherit-${userId}@example.com`, 'Inherit', 'x');
});

test('a device with nothing resolves to nothing', () => {
  assert.deepEqual(resolveDevicePlaylist(mkDevice()), { playlist_id: null, source: null });
});

test('group only', () => {
  const pl = mkPlaylist('grp'); const d = mkDevice(); join(d, mkGroup(pl));
  assert.deepEqual(resolveDevicePlaylist(d), { playlist_id: pl, source: 'group' });
});

test('wall only', () => {
  const pl = mkPlaylist('wall'); const d = mkDevice({ wall_id: mkWall(pl) });
  assert.deepEqual(resolveDevicePlaylist(d), { playlist_id: pl, source: 'wall' });
});

test('⚠️ a WALL beats a group — a torn picture is the failure an operator can see', () => {
  const wallPl = mkPlaylist('w-wins'); const grpPl = mkPlaylist('g-loses');
  const d = mkDevice({ wall_id: mkWall(wallPl) });
  join(d, mkGroup(grpPl));
  assert.deepEqual(resolveDevicePlaylist(d), { playlist_id: wallPl, source: 'wall' },
    'a wall member playing the group playlist tears the image across the seam, and nothing in the '
    + 'UI would explain why');
});

test('a device override beats both', () => {
  const own = mkPlaylist('mine'); const wallPl = mkPlaylist('w'); const grpPl = mkPlaylist('g');
  const d = mkDevice({ playlist_id: own, playlist_source: 'device', wall_id: mkWall(wallPl) });
  join(d, mkGroup(grpPl));
  assert.deepEqual(resolveDevicePlaylist(d), { playlist_id: own, source: 'device' });
});

test('⚠️ two groups: higher PRIORITY wins, not whatever SQLite returned first', () => {
  const lo = mkPlaylist('lo'); const hi = mkPlaylist('hi');
  const d = mkDevice();
  join(d, mkGroup(lo, { priority: 0, created_at: 1 }));   // older, so join-order would pick it
  join(d, mkGroup(hi, { priority: 5, created_at: 9 }));
  assert.equal(resolveDevicePlaylist(d).playlist_id, hi,
    'the old leave-handler picked "any remaining group with a playlist" — a query-order accident '
    + 'no operator could see or fix');
});

test('equal priority falls back to the OLDEST group, deterministically', () => {
  const older = mkPlaylist('older'); const newer = mkPlaylist('newer');
  const d = mkDevice();
  join(d, mkGroup(newer, { priority: 3, created_at: 5000 }));
  join(d, mkGroup(older, { priority: 3, created_at: 100 }));
  assert.equal(resolveDevicePlaylist(d).playlist_id, older);
});

test('a group with no playlist is skipped rather than winning with NULL', () => {
  const pl = mkPlaylist('real'); const d = mkDevice();
  join(d, mkGroup(null, { priority: 9 }));     // highest priority, nothing to give
  join(d, mkGroup(pl, { priority: 0 }));
  assert.equal(resolveDevicePlaylist(d).playlist_id, pl);
});

test("an override whose id was cleared falls back to inherited, it does not go dark", () => {
  const grpPl = mkPlaylist('fallback'); const d = mkDevice({ playlist_source: 'device' });
  join(d, mkGroup(grpPl));
  assert.deepEqual(resolveDevicePlaylist(d), { playlist_id: grpPl, source: 'group' },
    'clearing means "stop being special", not "go blank" — a clear that blanks a screen is a '
    + 'destructive action wearing the costume of an undo');
});

test("playlist_source 'none' means deliberately nothing, and outranks the group", () => {
  const grpPl = mkPlaylist('unwanted'); const d = mkDevice({ playlist_source: 'none' });
  join(d, mkGroup(grpPl));
  assert.deepEqual(resolveDevicePlaylist(d), { playlist_id: null, source: null });
});

test('⚠️ THE MIGRATION INVARIANT: no device changes what it plays', () => {
  // A spread that covers every classification branch, built the way the old writers left rows:
  // copies indistinguishable from choices, and a cleared row inside a group.
  const gPl = mkPlaylist('m-grp'); const wPl = mkPlaylist('m-wall'); const oPl = mkPlaylist('m-own');
  const g = mkGroup(gPl); const w = mkWall(wPl);

  const copied = mkDevice({ playlist_id: gPl });          // a group copy
  const chosen = mkDevice({ playlist_id: oPl });          // a hand-set override
  const wallMember = mkDevice({ playlist_id: wPl, wall_id: w });
  const clearedInGroup = mkDevice();                      // in a group, plays nothing today
  const lonely = mkDevice();
  join(copied, g); join(chosen, g); join(clearedInGroup, g);

  const before = new Map(db.prepare('SELECT id, playlist_id FROM devices').all().map((r) => [r.id, r.playlist_id]));
  db.prepare('UPDATE devices SET playlist_source = NULL').run();   // pretend nothing was classified
  backfillPlaylistSource(db);

  assert.deepEqual(verifyNoDeviceChanged(db), [],
    'a device resolved to a different playlist than it held before — during an upgrade that is an '
    + 'estate-wide restart at item 1, the #234 shape');

  for (const [devId, was] of before) {
    assert.equal(resolveDevicePlaylist(devId).playlist_id, was, `device ${devId} changed`);
  }

  // And the classifications are the ones that make the model work afterwards.
  const src = (x) => db.prepare('SELECT playlist_source AS s FROM devices WHERE id = ?').get(x).s;
  assert.equal(src(copied), null, 'a copy must keep inheriting, or group edits stop propagating');
  assert.equal(src(chosen), 'device', 'a chosen playlist must survive the next group edit');
  assert.equal(src(wallMember), null, 'the wall member was a copy too');
  assert.equal(src(clearedInGroup), 'none',
    'this screen is dark today; letting it simply inherit would light it up during an upgrade');
  assert.equal(src(lonely), null);
});

test('⚠️ a fan-out reaches devices that INHERIT, not just those holding a copy', () => {
  const pl = mkPlaylist('fanout');
  const g = mkGroup(pl);
  const inheriting = mkDevice();          // no copy on the row at all
  const pinned = mkDevice({ playlist_id: pl, playlist_source: 'device' });
  join(inheriting, g);

  const reached = db.prepare('SELECT device_id FROM device_resolved_playlist WHERE playlist_id = ?')
    .all(pl).map((r) => r.device_id);

  assert.ok(reached.includes(inheriting),
    'a fan-out keyed on devices.playlist_id skips exactly the devices the change is for — the '
    + 'device inheriting the playlist holds no copy of its id');
  assert.ok(reached.includes(pinned));
});

test('clearing an override leaves the device reachable by the group publish that follows', () => {
  const grpPl = mkPlaylist('after-clear'); const own = mkPlaylist('was-mine');
  const d = mkDevice({ playlist_id: own, playlist_source: 'device' });
  join(d, mkGroup(grpPl));

  // What routes/devices.js DELETE /:id/playlist now writes.
  db.prepare('UPDATE devices SET playlist_id = NULL, playlist_source = NULL WHERE id = ?').run(d);

  assert.equal(resolveDevicePlaylist(d).playlist_id, grpPl);
  const reached = db.prepare('SELECT device_id FROM device_resolved_playlist WHERE playlist_id = ?')
    .all(grpPl).map((r) => r.device_id);
  assert.ok(reached.includes(d),
    'the cleared device inherits the group playlist but holds no copy, so publishing that playlist '
    + 'would have skipped the one screen that just started using it');
});

/*
 * ─── The writers, now that they no longer copy ─────────────────────────────────────────────
 *
 * These assert the three defects named at the top of the design doc, each of which was a direct
 * consequence of copy-on-assign rather than a bug in any single route.
 */

test('⚠️ joining a group does NOT destroy a playlist chosen for that screen', () => {
  const own = mkPlaylist('chosen'); const grpPl = mkPlaylist('group-wants');
  const d = mkDevice({ playlist_id: own, playlist_source: 'device' });
  const g = mkGroup(grpPl);

  join(d, g);   // the route writes only the membership row

  assert.deepEqual(resolveDevicePlaylist(d), { playlist_id: own, source: 'device' },
    'the join used to stamp the group playlist onto the device, and a copied id cannot say whether '
    + 'it was chosen or inherited — so the choice was simply gone');
});

test('a group playlist change reaches a member that joined afterwards', () => {
  const first = mkPlaylist('v1'); const g = mkGroup(first);
  const d = mkDevice();
  join(d, g);
  assert.equal(resolveDevicePlaylist(d).playlist_id, first);

  // What assign-playlist now writes: ONE row, the group's.
  const second = mkPlaylist('v2');
  db.prepare('UPDATE device_groups SET playlist_id = ? WHERE id = ?').run(second, g);

  assert.equal(resolveDevicePlaylist(d).playlist_id, second,
    'members follow the group because nothing was copied, not because a fan-out loop remembered '
    + 'to visit them');
});

test('⚠️ leaving a group does not strand the device on the group playlist', () => {
  const grpPl = mkPlaylist('leaving'); const g = mkGroup(grpPl);
  const d = mkDevice({ playlist_id: grpPl });   // the stale copy the old join left behind
  join(d, g);

  db.prepare('DELETE FROM device_group_members WHERE device_id = ? AND group_id = ?').run(d, g);
  clearInheritedCopy(d);   // the helper the routes call — inlining the SQL here would test nothing

  assert.equal(resolveDevicePlaylist(d).playlist_id, null,
    "the view's last-resort branch would otherwise resurrect the stale copy, so a device removed "
    + 'from a wall or group would keep playing its content');
});

test("leaving a group keeps the device's OWN playlist", () => {
  const own = mkPlaylist('still-mine'); const g = mkGroup(mkPlaylist('g'));
  const d = mkDevice({ playlist_id: own, playlist_source: 'device' });
  join(d, g);

  db.prepare('DELETE FROM device_group_members WHERE device_id = ? AND group_id = ?').run(d, g);
  clearInheritedCopy(d);   // the helper the routes call — inlining the SQL here would test nothing

  assert.equal(resolveDevicePlaylist(d).playlist_id, own,
    'clearing the inherited copy must never take an operator\'s choice with it');
});

test('a wall playlist change reaches its panels without touching a device row', () => {
  const v1 = mkPlaylist('wall-v1'); const w = mkWall(v1);
  const panel = mkDevice({ wall_id: w });
  assert.equal(resolveDevicePlaylist(panel).playlist_id, v1);

  const v2 = mkPlaylist('wall-v2');
  db.prepare('UPDATE video_walls SET playlist_id = ? WHERE id = ?').run(v2, w);

  assert.equal(resolveDevicePlaylist(panel).playlist_id, v2);
  assert.equal(db.prepare('SELECT playlist_id FROM devices WHERE id = ?').get(panel).playlist_id, null,
    'the wall edit should not have written to any device row at all');
});

test('the resolver views come from ONE definition, shared with any hand-built fixture', () => {
  const { applyResolverViews } = require('../lib/playlist-resolver-sql');
  assert.equal(typeof applyResolverViews, 'function');
  // Re-applying is idempotent: the migration does exactly this on every boot, so a definition
  // change ships with the code instead of being pinned at first-create.
  applyResolverViews(db);
  const pl = mkPlaylist('after-reapply'); const d = mkDevice();
  join(d, mkGroup(pl));
  assert.equal(resolveDevicePlaylist(d).playlist_id, pl);
});
