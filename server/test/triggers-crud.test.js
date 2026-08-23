'use strict';

/*
 * Trigger definitions: the CRUD surface. docs/triggers-design.md.
 *
 * The assertions that matter here are not "does POST return 200". They are the four constraints
 * that are invisible until they cost someone a site visit:
 *
 *   - a token containing a space is unparseable on the wire and must be refused at save time
 *   - a target playlist in ANOTHER workspace must be refused, or a trigger pins and displays another
 *     tenant's content and no device-side check can catch it
 *   - two triggers must not share a match_token, or one token resolves to whichever row is read first
 *   - lease_sec on a `once` trigger is a field that can never apply
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const { freePort } = require('./helpers/free-port');
const DATA_DIR = path.join(os.tmpdir(), 'st-trig-' + crypto.randomBytes(4).toString('hex'));
const LOG = DATA_DIR + '.log';
let PORT, BASE, proc, jwt, workspaceId, playlistId, deviceId;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const J = (tok, body, method = 'POST') => ({
  method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
  body: body === undefined ? undefined : JSON.stringify(body),
});

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ }
    await sleep(250);
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));

  // First user on a self-hosted install is the admin.
  const reg = await (await fetch(BASE + '/api/auth/register', J(null, {
    email: `trig${Date.now()}@example.com`, password: 'Passw0rd123', name: 'Trig',
  }))).json();
  jwt = reg.token;
  workspaceId = reg.current_workspace_id;

  const pl = await (await fetch(BASE + '/api/playlists', J(jwt, { name: 'Alarm loop' }))).json();
  playlistId = pl.id;

  /*
   * ⚠️ A device is created by PAIRING, not by an API call — POST /api/devices is a 404. So the
   * harness inserts one the way the other suites do, with a direct handle on the same file. The
   * server holds the db open; WAL makes a second writer fine.
   */
  const Database = require('better-sqlite3');
  const raw = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));
  deviceId = crypto.randomUUID();
  raw.prepare('INSERT INTO devices (id, name, workspace_id, status) VALUES (?, ?, ?, ?)')
    .run(deviceId, 'Lobby', workspaceId, 'offline');
  /*
   * ⚠️ The fixture playlist must be PUBLISHED with pinnable media. The offline-playability guard
   * now fails closed on an unpublished playlist — a trigger pointing at one could never render, so
   * accepting it was a green save on something permanently broken. Every test here creates a
   * trigger against this playlist, so an empty one would 400 them all.
   */
  raw.prepare('UPDATE playlists SET published_snapshot = ? WHERE id = ?')
    .run(JSON.stringify([{ content_id: 'seed', filename: 'Evac notice', filepath: 'uploads/evac.mp4' }]), playlistId);
  raw.close();
});
after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } });

/*
 * ⚠️ A DISTINCT clear_token per call. This used to hardcode 'EVAC_CLR', and since every test
 * overrides only match_token, they all created triggers sharing one clear token — which is exactly
 * the ambiguity the namespace rule now rejects: fire and clear tokens live in ONE namespace, and a
 * duplicate resolves to whichever row the database returned first. The fixture was quietly relying
 * on the bug. Tests that care about a specific clear_token still pass one explicitly.
 */
let _tok = 0;
const base = () => ({
  name: 'Evacuate', match_token: 'EVAC', clear_token: `CLR_${++_tok}`,
  mode: 'until_cleared', target_kind: 'playlist', target_ref: playlistId,
  priority: 100, source_udp: true,
});

test('a trigger is created, read back, and carries its assignments', async () => {
  const r = await fetch(BASE + '/api/triggers', J(jwt, { ...base(), match_token: 'CREATE_OK',
    assignments: [{ target_type: 'device', target_id: deviceId }] }));
  assert.equal(r.status, 200);
  const t = await r.json();
  assert.equal(t.mode, 'until_cleared');
  assert.equal(t.target_kind, 'playlist');
  assert.equal(t.target_ref, playlistId);
  assert.deepEqual(t.assignments, [{ target_type: 'device', target_id: deviceId }]);

  const got = await (await fetch(BASE + '/api/triggers/' + t.id,
    { headers: { Authorization: `Bearer ${jwt}` } })).json();
  assert.equal(got.id, t.id);
});

/*
 * ⚠️ THE WIRE FORMAT DECIDES THE CHARSET. The UDP payload is `ST1 <secret> <token>` — space
 * separated, one line, because that is what a Crestron SendString can emit. A token with a space in
 * it is unparseable on arrival and a token with a newline lets one datagram look like two. Save time
 * is the only place this can be refused with an error anyone can act on.
 */
test('a match_token containing a space is refused', async () => {
  const r = await fetch(BASE + '/api/triggers', J(jwt, { ...base(), match_token: 'FIRE ALARM' }));
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /no spaces/);
});

test('a match_token containing a newline is refused', async () => {
  const r = await fetch(BASE + '/api/triggers', J(jwt, { ...base(), match_token: 'A\nB' }));
  assert.equal(r.status, 400);
});

test('fire and clear tokens must differ', async () => {
  const r = await fetch(BASE + '/api/triggers', J(jwt, { ...base(), match_token: 'SAME', clear_token: 'SAME' }));
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /must differ/);
});

test('⚠️ two triggers cannot share a match_token', async () => {
  // Otherwise one datagram resolves to whichever row is read first, which is a coin toss that looks
  // like a flaky trigger rather than a configuration error.
  const a = await fetch(BASE + '/api/triggers', J(jwt, { ...base(), match_token: 'DUP' }));
  assert.equal(a.status, 200);
  const b = await fetch(BASE + '/api/triggers', J(jwt, { ...base(), name: 'Other', match_token: 'DUP' }));
  assert.equal(b.status, 400);
  assert.match((await b.json()).error, /already used/);
});

test('the target playlist must exist in this workspace', async () => {
  const r = await fetch(BASE + '/api/triggers', J(jwt, {
    ...base(), match_token: 'BADREF', target_ref: crypto.randomUUID() }));
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /playlist in this workspace/);
});

test("v1 refuses target_kind 'url' rather than storing something it cannot pin", async () => {
  // 'url' is designed (schema hook is there) and deliberately not built: an arbitrary URL cannot be
  // pinned in the offline cache, which is the guarantee the whole feature exists for.
  const r = await fetch(BASE + '/api/triggers', J(jwt, {
    ...base(), match_token: 'URLKIND', target_kind: 'url', target_url: 'https://example.com/x.png' }));
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /not built/);
});

test('lease_sec is refused on a once trigger, where it could never apply', async () => {
  const r = await fetch(BASE + '/api/triggers', J(jwt, {
    ...base(), match_token: 'ONCELEASE', mode: 'once', lease_sec: 90 }));
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /until_cleared/);
});

test('lease_sec is stored on an until_cleared trigger', async () => {
  const t = await (await fetch(BASE + '/api/triggers', J(jwt, {
    ...base(), match_token: 'LEASED', lease_sec: 90 }))).json();
  assert.equal(t.lease_sec, 90);
});

test('assigning a device from another workspace is refused', async () => {
  const r = await fetch(BASE + '/api/triggers', J(jwt, {
    ...base(), match_token: 'XWS',
    assignments: [{ target_type: 'device', target_id: crypto.randomUUID() }] }));
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /not found in this workspace/);
  // ...and the trigger row must not survive a rejected assignment.
  const list = await (await fetch(BASE + '/api/triggers',
    { headers: { Authorization: `Bearer ${jwt}` } })).json();
  assert.equal(list.triggers.filter(t => t.match_token === 'XWS').length, 0,
    'a trigger was left behind after its assignments were rejected');
});

test('delete removes the trigger and its assignments cascade', async () => {
  const t = await (await fetch(BASE + '/api/triggers', J(jwt, {
    ...base(), match_token: 'DELME',
    assignments: [{ target_type: 'device', target_id: deviceId }] }))).json();
  const d = await fetch(BASE + '/api/triggers/' + t.id, J(jwt, undefined, 'DELETE'));
  assert.equal(d.status, 200);
  const after = await fetch(BASE + '/api/triggers/' + t.id, { headers: { Authorization: `Bearer ${jwt}` } });
  assert.equal(after.status, 404);
});

test('⚠️ reserved geometry is refused with a reason, not accepted and ignored', async () => {
  /*
   * position/width/height/opacity/border_radius were copied from the PiP contract and wired to
   * nothing: the renderer hardcodes a fullscreen opaque box, the shared cross-platform contract
   * never had them, and they are no longer projected to devices. Accepting them with a 200 tells
   * an API client the overlay was positioned when it was not — and that lie only surfaces during
   * an emergency, which is the worst possible moment to discover it.
   */
  for (const [k, v] of [['width', 640], ['height', 480], ['opacity', 0.5], ['border_radius', 12]]) {
    const r = await fetch(BASE + '/api/triggers', J(jwt, { ...base(), match_token: 'GEO_' + k, [k]: v }));
    assert.equal(r.status, 400, `${k} was silently accepted`);
    assert.match((await r.json()).error, /reserved/, `${k} must say WHY it was refused`);
  }
  const r = await fetch(BASE + '/api/triggers', J(jwt, { ...base(), match_token: 'GEOPOS', position: 'top-left' }));
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /position .*reserved|reserved/);
});

test('omitting geometry entirely still creates a trigger', async () => {
  // The refusal must be about VALUES SENT, not about the fields existing — every existing client
  // omits them, and none of them may break.
  const r = await fetch(BASE + '/api/triggers', J(jwt, { ...base(), match_token: 'NOGEO' }));
  assert.equal(r.status, 200, 'the common case must be unaffected');
});

test('an explicit position:"center" is accepted — it is the value the column already holds', async () => {
  const r = await fetch(BASE + '/api/triggers', J(jwt, { ...base(), match_token: 'CTR', position: 'center' }));
  assert.equal(r.status, 200, 'refusing the stored default would break round-tripping a GET into a PUT');
});

test('⚠️ a clear_token may not collide with another trigger\'s match_token', async () => {
  /*
   * evaluate() walks triggers in query order and tests match_token then clear_token PER TRIGGER.
   * So a clear token that equals another trigger's fire token makes that trigger silently
   * unfirable — the resolver matches, returns 'clear' for the wrong row, and nothing logs an
   * error because from its point of view the token was known. Arbitrary order decides which.
   */
  await fetch(BASE + '/api/triggers', J(jwt, { ...base(), match_token: 'NS_FIRE', clear_token: 'NS_CLR' }));
  const r = await fetch(BASE + '/api/triggers', J(jwt, { ...base(), match_token: 'NS_CLR' }));
  assert.equal(r.status, 400, "a fire token shadowed by another trigger's clear token was accepted");
  assert.match((await r.json()).error, /namespace|already used/);
});

test('⚠️ two triggers may not share a clear_token', async () => {
  await fetch(BASE + '/api/triggers', J(jwt, { ...base(), match_token: 'SH_A', clear_token: 'SHARED_CLR' }));
  const r = await fetch(BASE + '/api/triggers', J(jwt, { ...base(), match_token: 'SH_B', clear_token: 'SHARED_CLR' }));
  assert.equal(r.status, 400, 'an ambiguous clear would stop whichever trigger lost the race');
});

/*
 * ⚠️ These use a DIRECT db handle to give the playlist a published_snapshot, the same way the
 * harness inserts a device: there is no API for publishing a snapshot with arbitrary item shapes,
 * and without a snapshot the offline-playability guard has nothing to inspect — the earlier tests
 * passed it only because their playlist was empty, which proves nothing.
 */
function playlistWithItems(items, name) {
  const Database = require('better-sqlite3');
  const raw = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));
  const id = crypto.randomUUID();
  // user_id is NOT NULL; borrow the owner of the playlist the API already created for us.
  const owner = raw.prepare('SELECT user_id FROM playlists WHERE id = ?').get(playlistId);
  raw.prepare('INSERT INTO playlists (id, name, workspace_id, user_id, published_snapshot) VALUES (?, ?, ?, ?, ?)')
    .run(id, name, workspaceId, owner.user_id, JSON.stringify(items));
  raw.close();
  return id;
}

test('⚠️ a trigger playlist containing a remote URL is refused — it cannot be pinned', async () => {
  /*
   * The whole reason this feature targets a playlist rather than a URL (§1) is that playlist items
   * are library content and therefore pinnable. requestOfflineCache pins `filepath && !remote_url`,
   * so a remote_url item is never held on the device — such a trigger passes every structural check
   * and still fires against nothing with the WAN down, which is the failure the playlist rule was
   * written to prevent, arriving through the front door.
   */
  const pid = playlistWithItems(
    [{ content_id: 'c1', filename: 'Live feed', remote_url: 'https://example.com/a.mp4' }], 'Remote loop');
  const r = await fetch(BASE + '/api/triggers', J(jwt, { ...base(), match_token: 'RU', target_ref: pid }));
  assert.equal(r.status, 400, 'an unpinnable trigger playlist was accepted');
  const err = (await r.json()).error;
  assert.match(err, /offline/, 'the reason must name the offline guarantee, not just say invalid');
  assert.match(err, /Live feed/, 'it must name WHICH item, or the operator cannot act on it');
});

test('⚠️ a trigger playlist containing YouTube is refused', async () => {
  // Doubly disqualified: unpinnable, AND createYoutubeEmbed is a singleton shared with the base
  // playlist, so a YouTube item in a trigger destroys the base player with no rebuild path.
  const pid = playlistWithItems(
    [{ content_id: 'c2', filename: 'Promo clip', mime_type: 'video/youtube' }], 'YT loop');
  const r = await fetch(BASE + '/api/triggers', J(jwt, { ...base(), match_token: 'YT', target_ref: pid }));
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /YouTube/);
});

test('a trigger playlist of uploaded media is accepted', async () => {
  // The guard must be about UNPINNABLE items, not about snapshots existing — ordinary playlists
  // are the common case and none of them may break.
  const pid = playlistWithItems(
    [{ content_id: 'c3', filename: 'Evac notice', filepath: 'uploads/evac.mp4' }], 'Good loop');
  const r = await fetch(BASE + '/api/triggers', J(jwt, { ...base(), match_token: 'OKPL', target_ref: pid }));
  assert.equal(r.status, 200, 'a normal uploaded-media playlist must still work');
});

test('⚠️ a trigger playlist containing a WIDGET is refused — widgets cannot be cached offline', async () => {
  /*
   * The gap a hand-written denylist missed, and the most likely one in practice: an HTML
   * "Evacuation — proceed to Exit B" widget is the natural thing to build, because it is text you
   * edit without re-uploading a video. A widget snapshot item has widget_id set and
   * filepath/remote_url/mime_type all NULL, so it matched neither original branch. It is fetched
   * live from serverUrl at render time and sw.js documents it CANNOT be service-worker cached (the
   * sandboxed iframe is an opaque origin the worker never sees), and serves a black page when that
   * fetch fails. Accepted before this: fullscreen black box during a fire alarm with the WAN down.
   */
  const pid = playlistWithItems([{ widget_id: 'w1', filename: 'Exit B notice' }], 'Widget loop');
  const r = await fetch(BASE + '/api/triggers', J(jwt, { ...base(), match_token: 'WGT', target_ref: pid }));
  assert.equal(r.status, 400, 'a widget trigger playlist was accepted');
  assert.match((await r.json()).error, /widget/i);
});

test('⚠️ a dangling content item is refused — no local file means nothing to pin', async () => {
  // A content row deleted after publish leaves the item in the snapshot with every joined column
  // NULL. Not YouTube, not remote, not a widget — and previously accepted.
  const pid = playlistWithItems([{ content_id: 'gone', filename: 'Deleted clip' }], 'Dangling loop');
  const r = await fetch(BASE + '/api/triggers', J(jwt, { ...base(), match_token: 'DANG', target_ref: pid }));
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /no local file/);
});

test('⚠️ an UNPUBLISHED target playlist is refused, not silently accepted', async () => {
  // Fails closed now. Before, the whole check was skipped for a NULL snapshot and the trigger
  // saved green — then synced to the device with items: [] and rendered nothing, forever.
  const un = await (await fetch(BASE + '/api/playlists', J(jwt, { name: 'Never published' }))).json();
  const r = await fetch(BASE + '/api/triggers', J(jwt, { ...base(), match_token: 'UNPUB', target_ref: un.id }));
  assert.equal(r.status, 400, 'a trigger that could never render was accepted');
  assert.match((await r.json()).error, /never been published/);
});

test('a malformed snapshot is a 400, not a 500', async () => {
  // JSON.parse('5') succeeds and then for..of throws; with no error middleware that is a 500.
  const Database = require('better-sqlite3');
  const raw = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));
  const id = crypto.randomUUID();
  const owner = raw.prepare('SELECT user_id FROM playlists WHERE id = ?').get(playlistId);
  raw.prepare('INSERT INTO playlists (id, name, workspace_id, user_id, published_snapshot) VALUES (?, ?, ?, ?, ?)')
    .run(id, 'Corrupt', workspaceId, owner.user_id, '5');
  raw.close();
  const r = await fetch(BASE + '/api/triggers', J(jwt, { ...base(), match_token: 'CORRUPT', target_ref: id }));
  assert.equal(r.status, 400, 'a corrupt snapshot crashed the handler instead of being refused');
  assert.match((await r.json()).error, /unreadable/);
});
