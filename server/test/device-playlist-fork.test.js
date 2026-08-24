'use strict';

/*
 * "Add content to THIS screen" on a device that inherits its playlist.
 *
 * Before inheritance existed, every device held a COPY of its group's playlist id, so a per-device
 * edit silently edited the group's playlist and therefore every other screen using it. The resolver
 * did not change that — it made it visible, because the device page now says "Inherited from Lobby"
 * next to the Add Content button.
 *
 * A per-device edit now FORKS. These tests pin what the fork must preserve, which is the part that
 * can go wrong quietly: the screen must not go dark, lose its nesting, or un-mute itself.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { freePort } = require('./helpers/free-port');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let proc, BASE, DATA_DIR, jwt, workspaceId, PORT, contentA, contentB;

const J = (t, b, m = 'POST') => ({
  method: m,
  headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) },
  ...(b === undefined ? {} : { body: JSON.stringify(b) }),
});
const api = async (p, ...a) => { const r = await fetch(BASE + p, ...a); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const dbh = () => new (require('better-sqlite3'))(path.join(DATA_DIR, 'db', 'remote_display.db'));

const mkContent = (name) => {
  const raw = dbh(); const id = crypto.randomUUID();
  const u = raw.prepare('SELECT id FROM users LIMIT 1').get();
  raw.prepare(`INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, duration_sec)
               VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, u.id, workspaceId, name, `uploads/${name}`, 'video/mp4', 10);
  raw.close(); return id;
};
const mkDevice = (name) => {
  const raw = dbh(); const id = crypto.randomUUID();
  const u = raw.prepare('SELECT id FROM users LIMIT 1').get();
  raw.prepare('INSERT INTO devices (id, user_id, workspace_id, name, pairing_code) VALUES (?, ?, ?, ?, ?)')
    .run(id, u.id, workspaceId, name, crypto.randomUUID().slice(0, 6));
  raw.close(); return id;
};
const devRow = (id) => { const r = dbh(); const v = r.prepare('SELECT playlist_id, playlist_source FROM devices WHERE id = ?').get(id); r.close(); return v; };
const itemsOf = (pl) => { const r = dbh(); const v = r.prepare('SELECT * FROM playlist_items WHERE playlist_id = ? ORDER BY sort_order').all(pl); r.close(); return v; };
const plRow = (pl) => { const r = dbh(); const v = r.prepare('SELECT * FROM playlists WHERE id = ?').get(pl); r.close(); return v; };

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-'));
  const logFd = fs.openSync(path.join(DATA_DIR, 'server.log'), 'a');
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ }
    await sleep(250);
  }
  if (!up) throw new Error('server did not boot');
  const reg = await (await fetch(BASE + '/api/auth/register', J(null, {
    email: `fork${Date.now()}@example.com`, password: 'Passw0rd123', name: 'Fork',
  }))).json();
  jwt = reg.token; workspaceId = reg.current_workspace_id;
  contentA = mkContent('a.mp4'); contentB = mkContent('b.mp4');
});
after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } });

async function groupWithTwoScreens(label) {
  const group = (await api('/api/groups', J(jwt, { name: label }))).body;
  const shared = (await api('/api/playlists', J(jwt, { name: `${label} playlist` }))).body;
  await api(`/api/playlists/${shared.id}/items`, J(jwt, { content_id: contentA, duration_sec: 10 }));
  await api(`/api/playlists/${shared.id}/publish`, J(jwt, {}));
  const mine = mkDevice(`${label}-mine`); const other = mkDevice(`${label}-other`);
  await api(`/api/groups/${group.id}/assign-playlist`, J(jwt, { playlist_id: shared.id }));
  await api(`/api/groups/${group.id}/devices`, J(jwt, { device_id: mine }));
  await api(`/api/groups/${group.id}/devices`, J(jwt, { device_id: other }));
  return { group, shared, mine, other };
}

test('⚠️ adding content to an inheriting screen does not touch the OTHER screens', async () => {
  const { shared, mine, other } = await groupWithTwoScreens('lobby');
  assert.equal(devRow(mine).playlist_source, null, 'precondition: this screen inherits');

  const r = await api(`/api/assignments/device/${mine}`, J(jwt, { content_id: contentB, duration_sec: 10 }));
  assert.equal(r.status, 201, JSON.stringify(r.body));

  const row = devRow(mine);
  assert.equal(row.playlist_source, 'device', 'the screen must now own its playlist');
  assert.notEqual(row.playlist_id, shared.id, 'it still points at the SHARED playlist — every other screen just changed too');

  assert.equal(itemsOf(shared.id).length, 1,
    "the group's playlist gained an item, so a per-screen edit reached every screen in the group");
  assert.equal(devRow(other).playlist_id, null, 'the other screen must be untouched');
});

test('the fork KEEPS what the screen was already showing, and appends', async () => {
  const { mine } = await groupWithTwoScreens('atrium');
  await api(`/api/assignments/device/${mine}`, J(jwt, { content_id: contentB, duration_sec: 10 }));

  const items = itemsOf(devRow(mine).playlist_id);
  assert.deepEqual(items.map((i) => i.content_id), [contentA, contentB],
    'forking must copy what was inherited before appending — starting empty would silently drop '
    + 'everything the screen was showing');
});

test('⚠️ the fork carries the PUBLISHED SNAPSHOT, or the screen goes dark on an add', async () => {
  const { shared, mine } = await groupWithTwoScreens('foyer');
  await api(`/api/assignments/device/${mine}`, J(jwt, { content_id: contentB, duration_sec: 10 }));

  const fork = plRow(devRow(mine).playlist_id);
  assert.ok(fork.published_snapshot, 'a brand-new playlist has no snapshot, and devices play the '
    + 'snapshot — the screen would have gone blank the instant someone added an image');
  assert.deepEqual(JSON.parse(fork.published_snapshot).map((i) => i.content_id),
    JSON.parse(plRow(shared.id).published_snapshot).map((i) => i.content_id),
    'until the operator publishes, the screen must keep playing exactly what it played before');
});

test('nesting, mute and per-item schedules survive the fork', async () => {
  const group = (await api('/api/groups', J(jwt, { name: 'nested-grp' }))).body;
  const child = (await api('/api/playlists', J(jwt, { name: 'child-pl' }))).body;
  await api(`/api/playlists/${child.id}/items`, J(jwt, { content_id: contentA, duration_sec: 10 }));
  await api(`/api/playlists/${child.id}/publish`, J(jwt, {}));

  const shared = (await api('/api/playlists', J(jwt, { name: 'parent-pl' }))).body;
  const it = (await api(`/api/playlists/${shared.id}/items`, J(jwt, { content_id: contentA, duration_sec: 10 }))).body;
  await api(`/api/playlists/${shared.id}/items/${it.id}`, J(jwt, { muted: true }, 'PUT'));
  await api(`/api/playlists/${shared.id}/items`, J(jwt, { child_playlist_id: child.id }));
  await api(`/api/playlists/${shared.id}/publish`, J(jwt, {}));

  const mine = mkDevice('nested-screen');
  await api(`/api/groups/${group.id}/assign-playlist`, J(jwt, { playlist_id: shared.id }));
  await api(`/api/groups/${group.id}/devices`, J(jwt, { device_id: mine }));

  await api(`/api/assignments/device/${mine}`, J(jwt, { content_id: contentB, duration_sec: 10 }));

  const items = itemsOf(devRow(mine).playlist_id);
  assert.equal(items.length, 3);
  assert.equal(items[0].muted, 1, 'a fork that un-mutes an item is not a copy of what was playing');
  assert.ok(items.some((i) => i.child_playlist_id === child.id),
    'the nested reference was flattened or dropped, so editing the child would stop reaching this screen');
});

test('a screen that already owns its playlist is edited in place, not forked again', async () => {
  const d = mkDevice('solo-screen');
  const first = await api(`/api/assignments/device/${d}`, J(jwt, { content_id: contentA, duration_sec: 10 }));
  assert.equal(first.status, 201);
  const pl = devRow(d).playlist_id;

  await api(`/api/assignments/device/${d}`, J(jwt, { content_id: contentB, duration_sec: 10 }));
  assert.equal(devRow(d).playlist_id, pl, 'a second add must not spawn another playlist');
  assert.equal(itemsOf(pl).length, 2);
});

test('⚠️ adding content to the GROUP still edits the shared playlist — it must NOT fork', async () => {
  const { shared, mine, other } = await groupWithTwoScreens('shared-add');

  assert.equal((await api(`/api/groups/${(await api('/api/groups', { headers: { Authorization: `Bearer ${jwt}` } })).body.find((g) => g.name === 'shared-add').id}/assign-content`,
    J(jwt, { content_id: contentB }))).status, 200);

  assert.equal(itemsOf(shared.id).length, 2,
    'the group-level add must reach the shared playlist; forking each member would end the group\'s '
    + 'ability to update them all, which is the opposite of what was asked');
  assert.equal(devRow(mine).playlist_source, null, 'no member should have been forked');
  assert.equal(devRow(other).playlist_source, null);
});

/*
 * ─── The item-scoped half ──────────────────────────────────────────────────────────────────
 *
 * PUT and DELETE /api/assignments/:id are addressed by ITEM, so they cannot know whose screen is
 * being edited — a shared playlist has many. Editing or removing an item on a screen that inherits
 * therefore changed it for every screen in the group. The device page now passes device_id.
 */

test('⚠️ REMOVING an item from an inheriting screen does not remove it from the group', async () => {
  const { shared, mine, other } = await groupWithTwoScreens('remove-grp');
  const sharedItem = itemsOf(shared.id)[0];

  const r = await api(`/api/assignments/${sharedItem.id}?device_id=${mine}`, J(jwt, undefined, 'DELETE'));
  assert.equal(r.status, 200, JSON.stringify(r.body));

  assert.equal(itemsOf(shared.id).length, 1,
    'the item vanished from the shared playlist, so it vanished from every screen in the group');
  assert.equal(devRow(mine).playlist_source, 'device', 'the screen should now own its playlist');
  assert.equal(itemsOf(devRow(mine).playlist_id).length, 0, 'and the removal should apply to it');
  assert.equal(devRow(other).playlist_id, null, 'the other screen must be untouched');
});

test('⚠️ EDITING an item on an inheriting screen does not edit it for the group', async () => {
  const { shared, mine } = await groupWithTwoScreens('edit-grp');
  const sharedItem = itemsOf(shared.id)[0];

  const r = await api(`/api/assignments/${sharedItem.id}`, J(jwt, { duration_sec: 99, device_id: mine }, 'PUT'));
  assert.equal(r.status, 200, JSON.stringify(r.body));

  assert.equal(itemsOf(shared.id)[0].duration_sec, 10, "the group's copy must keep its own duration");
  assert.equal(itemsOf(devRow(mine).playlist_id)[0].duration_sec, 99,
    'the edit must land on the forked item, not be silently dropped');
});

test('without device_id the item is edited where it lives — the group page still works', async () => {
  const { shared, mine } = await groupWithTwoScreens('nodev-grp');
  const sharedItem = itemsOf(shared.id)[0];

  assert.equal((await api(`/api/assignments/${sharedItem.id}`, J(jwt, { duration_sec: 42 }, 'PUT'))).status, 200);

  assert.equal(itemsOf(shared.id)[0].duration_sec, 42,
    'a caller that did not name a screen means the playlist itself — forking there would break the '
    + 'playlist and group pages');
  assert.equal(devRow(mine).playlist_source, null, 'and nothing should have been forked');
});

test('⚠️ REORDERING an inheriting screen works at all, and forks', async () => {
  const { shared, mine, other } = await groupWithTwoScreens('reorder-grp');
  await api(`/api/playlists/${shared.id}/items`, J(jwt, { content_id: contentB, duration_sec: 10 }));
  await api(`/api/playlists/${shared.id}/publish`, J(jwt, {}));
  const before = itemsOf(shared.id);
  assert.equal(before.length, 2);

  const r = await api(`/api/assignments/device/${mine}/reorder`, J(jwt, { order: [before[1].id, before[0].id] }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.length, 2,
    'this read devices.playlist_id, which is NULL for an inheriting screen once the copies were '
    + 'removed — so a drag-and-drop returned an empty list and reordered nothing');

  assert.deepEqual(itemsOf(devRow(mine).playlist_id).map((i) => i.content_id), [contentB, contentA],
    'the ids sent belong to the SHARED playlist; without translating them to the fork the UPDATE '
    + 'matches nothing and the reorder silently does nothing');
  assert.deepEqual(itemsOf(shared.id).map((i) => i.content_id), [contentA, contentB],
    'the group order must be untouched');
  assert.equal(devRow(other).playlist_id, null);
});

test('a caller who cannot write the item is refused, and nothing is forked', async () => {
  const { shared, mine } = await groupWithTwoScreens('authz-grp');
  const sharedItem = itemsOf(shared.id)[0];

  const reg2 = await (await fetch(BASE + '/api/auth/register', J(null, {
    email: `forkauth${Date.now()}@example.com`, password: 'Passw0rd123', name: 'Other',
  }))).json();

  const r = await api(`/api/assignments/${sharedItem.id}`, J(reg2.token, { duration_sec: 5, device_id: mine }, 'PUT'));
  assert.ok(r.status === 403 || r.status === 404, `expected a refusal, got ${r.status}`);
  assert.equal(devRow(mine).playlist_source, null, 'a refused call must not have forked anything');
});

/*
 * ⚠️ The device_id authorization check in the route is DEFENCE IN DEPTH and is deliberately not
 * claimed to be covered here. Mutation-testing it showed no test could fail: checkItemWrite already
 * refuses a caller who cannot write the item, and forkForItemEdit refuses to act unless the named
 * device actually resolves to that item's playlist — which cannot happen across workspaces. The
 * check stays because it turns a nonsense device_id into a 403 instead of a silent no-op, but a
 * test asserting it would be decorative, and this project has shipped enough of those.
 */

test('a device_id whose screen plays something ELSE does not fork, or edit anything of that screen\'s', async () => {
  const { shared } = await groupWithTwoScreens('unrelated-grp');
  const sharedItem = itemsOf(shared.id)[0];

  // A device INHERITING a DIFFERENT group's playlist. It is forkable — which is the point: the only
  // thing stopping it being forked here is that this item is not the one it plays.
  const otherGroup = await groupWithTwoScreens('unrelated-other');
  const bystander = otherGroup.mine;
  assert.equal(devRow(bystander).playlist_source, null, 'precondition: the bystander inherits');

  const r = await api(`/api/assignments/${sharedItem.id}`, J(jwt, { duration_sec: 77, device_id: bystander }, 'PUT'));
  assert.equal(r.status, 200, JSON.stringify(r.body));

  assert.equal(devRow(bystander).playlist_source, null,
    'naming a device that does not play this item must not fork it — that would sever an unrelated '
    + "screen from its group as a side effect of editing something else");
  assert.equal(devRow(bystander).playlist_id, null);
  assert.equal(itemsOf(shared.id)[0].duration_sec, 77,
    'with no applicable fork the edit lands where the item actually lives');
});
