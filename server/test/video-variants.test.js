'use strict';

// 3.0 TV-safe video copies (lib/video-variants.js, docs/tv-safe-video.md).
//
// A Samsung Tizen TV cannot decode a 1080x1920 stream: black on a landscape TV, an AVPlay prepare
// error on a portrait one. The server makes a copy the decoder accepts — turned for a portrait
// screen, fitted for a landscape one — and the operator's rule is that CPU is only spent when a
// screen actually needs it. These pin:
//   - need-gating: no screen declaring playback.video_variants -> no job; only the kind each
//     screen's orientation calls for; tall videos only; never one marked pre-rotated;
//   - the payload half: ready copies by kind, "preparing" while queued, lazy queueing for a needing
//     screen, nothing queued by the forecast preview;
//   - the worker's gates: CPU over the threshold for the last minute defers, the HH-HH window
//     defers, the monthly per-organization allowance denies (and re-queues next month);
//   - a replaced file never plays from an old copy, a delete leaves no file behind;
//   - with a real ffmpeg: the turn DIRECTION (a marker at the top of the source must end up on the
//     right edge for 'portrait' = 90° clockwise, on the left for 'portrait-flipped'), and the fit
//     copy stays upright and inside 1920x1080.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-vv-' + crypto.randomBytes(4).toString('hex'));
process.env.NODE_ENV = 'test';
delete process.env.VIDEO_VARIANTS_ENABLED;
delete process.env.VIDEO_VARIANTS_WINDOW;
delete process.env.VIDEO_VARIANTS_ORG_MONTHLY_MINUTES;

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const config = require('../config');
const vv = require('../lib/video-variants');
const appSettings = require('../lib/app-settings');

let FFMPEG = true;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); } catch { FFMPEG = false; }

fs.mkdirSync(config.contentDir, { recursive: true });
db.prepare("INSERT INTO users (id, email, name, password_hash, auth_provider, role) VALUES ('u1', 'u1@t.test', 'u1', 'x', 'local', 'user')").run();
for (const tag of ['a', 'b', 'c']) {
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(`org-${tag}`, `Org ${tag}`, 'u1');
  db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(`ws-${tag}`, `org-${tag}`, `WS ${tag}`);
}

const CAPS = JSON.stringify(['playback.video', 'playback.video_variants']);
function device(id, ws, orientation, caps = CAPS) {
  db.prepare("INSERT INTO devices (id, name, status, workspace_id, created_at, capabilities, orientation, platform) VALUES (?, ?, 'online', ?, 0, ?, ?, 'tizen')")
    .run(id, id, ws, caps, orientation);
}
let n = 0;
function video(ws, { w = 1080, h = 1920, prerotated = 0, duration = 30, mime = 'video/mp4' } = {}) {
  const id = `c${++n}`;
  const file = `${id}.mp4`;
  fs.writeFileSync(path.join(config.contentDir, file), 'not really a video');
  db.prepare('INSERT INTO content (id, workspace_id, filename, filepath, mime_type, file_size, width, height, duration_sec, video_prerotated) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, ws, file, file, mime, 18, w, h, duration, prerotated);
  return db.prepare('SELECT * FROM content WHERE id = ?').get(id);
}
const rows = (id) => db.prepare('SELECT kind, status, error FROM content_video_variants WHERE content_id = ? ORDER BY kind').all(id);
const devRow = (id) => db.prepare('SELECT * FROM devices WHERE id = ?').get(id);

// A fake host: CPU readings we choose, at times we choose.
function fakeCpu() {
  const s = { at: 1e9, idle: 0, total: 0 };
  return {
    read: () => ({ idle: s.idle, total: s.total, at: s.at }),
    pass(ms, busyPct) { const t = ms; s.total += t; s.idle += t * (1 - busyPct / 100); s.at += ms; },
  };
}
const encodeOk = async ({ out }) => { fs.writeFileSync(out, 'encoded'); return { width: 1920, height: 1080, encoder: 'fake' }; };

beforeEach(() => {
  vv._resetForTest({});
  db.prepare('DELETE FROM content_video_variants').run();   // the queue is the table: each test starts empty
  for (const k of ['video_variants_enabled', 'video_variants_window', 'video_variants_org_monthly_minutes', 'video_variants_max_cpu', 'video_variants_concurrency']) {
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(k);
  }
  appSettings.__reload();
});

// ------------------------------------------------------------------ pure rules

test('orientation picks the copy: portrait -> 90° clockwise, flipped -> counter-clockwise, else fit', () => {
  assert.equal(vv.kindForOrientation('portrait'), 'rot_cw');
  assert.equal(vv.kindForOrientation('portrait-flipped'), 'rot_ccw');
  assert.equal(vv.kindForOrientation('landscape'), 'fit');
  assert.equal(vv.kindForOrientation('landscape-flipped'), 'fit');
  assert.equal(vv.kindForOrientation(undefined), 'fit');
  // and the ffmpeg filter matches: transpose=1 is clockwise, transpose=2 counter-clockwise
  assert.match(vv.scaleFilter('rot_cw'), /^transpose=1,/);
  assert.match(vv.scaleFilter('rot_ccw'), /^transpose=2,/);
  assert.doesNotMatch(vv.scaleFilter('fit'), /transpose/);
});

test('only tall uploaded videos qualify, never one marked pre-rotated or a stream', () => {
  const base = { id: 'x', filepath: 'x.mp4', mime_type: 'video/mp4', width: 1080, height: 1920 };
  assert.equal(vv.isTallVideo(base), true);
  assert.equal(vv.isTallVideo({ ...base, width: 1920, height: 1080 }), false, 'wide');
  assert.equal(vv.isTallVideo({ ...base, width: 1080, height: 1080 }), false, 'square');
  assert.equal(vv.isTallVideo({ ...base, video_prerotated: 1 }), false, 'operator says already turned');
  assert.equal(vv.isTallVideo({ ...base, remote_url: 'https://x/y.mp4' }), false, 'no bytes here');
  assert.equal(vv.isTallVideo({ ...base, mime_type: 'video/hls' }), false);
  assert.equal(vv.isTallVideo({ ...base, mime_type: 'image/jpeg' }), false);
  assert.equal(vv.isTallVideo({ ...base, width: null }), false, 'unknown size: do nothing');
});

test('the ffmpeg command is the gentle one: 2 threads, veryfast, no rotation metadata, faststart, audio kept', () => {
  const a = vv.ffmpegArgs({ src: 'in.mp4', out: 'out.mp4', kind: 'rot_cw' }).join(' ');
  assert.match(a, /-threads 2 .*-i in\.mp4/);
  assert.match(a, /-preset veryfast/);
  assert.match(a, /-c:v libx264/);
  assert.match(a, /-map 0:a:0\?/, 'audio kept when there is some');
  assert.match(a, /-metadata:s:v:0 rotate=0/);
  assert.match(a, /\+faststart/);
  assert.match(a, /min\(1920,iw\).*min\(1080,ih\)/, 'never larger than 1920x1080');
});

test('time window: "22-6" wraps midnight; empty means any time; junk is refused', () => {
  const w = vv.parseWindow('22-6');
  const at = (h) => new Date(2026, 9, 14, h, 30);
  assert.equal(vv.inWindow(w, at(23)), true);
  assert.equal(vv.inWindow(w, at(3)), true);
  assert.equal(vv.inWindow(w, at(12)), false);
  assert.equal(vv.inWindow(vv.parseWindow('9-17'), at(12)), true);
  assert.equal(vv.inWindow(vv.parseWindow(''), at(12)), true);
  assert.equal(vv.parseWindow('noon'), false);
  assert.equal(vv.saveSettings({ window: 'noon' }).error.length > 0, true);
});

// ------------------------------------------------------------------ need-gating

test('NEED-GATING: a workspace with no screen that uses copies gets no job at upload', () => {
  device('plain-web', 'ws-a', 'portrait', JSON.stringify(['playback.video']));   // web player: rotates fine itself
  const c = video('ws-a');
  vv.onContentIngested(c);
  assert.deepEqual(rows(c.id), [], 'no screen needs it -> no CPU spent');
});

test('NEED-GATING: only the kind each needing screen calls for, and only for tall videos', () => {
  device('tv-portrait', 'ws-b', 'portrait');
  const tall = video('ws-b');
  vv.onContentIngested(tall);
  assert.deepEqual(rows(tall.id).map((r) => r.kind), ['rot_cw'], 'portrait screen only -> no fit copy');

  device('tv-landscape', 'ws-b', 'landscape');
  const tall2 = video('ws-b');
  vv.onContentIngested(tall2);
  assert.deepEqual(rows(tall2.id).map((r) => r.kind), ['fit', 'rot_cw']);

  const wide = video('ws-b', { w: 1920, h: 1080 });
  vv.onContentIngested(wide);
  assert.deepEqual(rows(wide.id), [], 'a wide video plays fine everywhere');

  const marked = video('ws-b', { prerotated: 1 });
  vv.onContentIngested(marked);
  assert.deepEqual(rows(marked.id), [], 'marked pre-rotated: played as-is, no copy');
});

test('payload: a needing screen queues its copy lazily and is told "preparing"; others queue nothing', () => {
  device('tv-flip', 'ws-c', 'portrait-flipped');
  device('web-c', 'ws-c', 'portrait', JSON.stringify(['playback.video']));
  const c = video('ws-c');

  const forWeb = [{ content_id: c.id, mime_type: 'video/mp4' }];
  vv.stampItems(forWeb, devRow('web-c'));
  assert.deepEqual(rows(c.id), [], 'a screen that does not use copies never queues one');
  assert.equal(forWeb[0].video_variant_state, undefined);

  const forecast = [{ content_id: c.id, mime_type: 'video/mp4' }];
  vv.stampItems(forecast, devRow('tv-flip'), { lazy: false });
  assert.deepEqual(rows(c.id), [], 'the forecast preview spends no CPU');

  const items = [{ content_id: c.id, mime_type: 'video/mp4' }];
  vv.stampItems(items, devRow('tv-flip'));
  assert.deepEqual(rows(c.id).map((r) => [r.kind, r.status]), [['rot_ccw', 'queued']]);
  assert.equal(items[0].video_variant_state, 'preparing');
  assert.equal(items[0].video_variants, undefined, 'nothing to play yet');

  db.prepare("UPDATE content_video_variants SET status = 'ready', filepath = ?, updated_at = 1234 WHERE content_id = ?").run(`stv_${c.id}_rot_ccw_0000abcd.mp4`, c.id);
  const again = [{ content_id: c.id, mime_type: 'video/mp4', video_variant_state: 'preparing' }];
  vv.stampItems(again, devRow('tv-flip'));
  assert.deepEqual(again[0].video_variants, { rot_ccw: 1234 });
  assert.equal(again[0].video_variant_state, undefined, 'a stale "preparing" never survives');
});

test('payload: switched off -> the screen is told "unavailable / disabled", and nothing queues', () => {
  vv.saveSettings({ enabled: false });
  const c = video('ws-c');
  const items = [{ content_id: c.id, mime_type: 'video/mp4' }];
  vv.stampItems(items, devRow('tv-flip'));
  assert.deepEqual(rows(c.id), []);
  assert.equal(items[0].video_variant_state, 'unavailable');
  assert.equal(items[0].video_variant_reason, 'disabled');
});

// ------------------------------------------------------------------ the worker's gates

test('CPU gate: a busy host defers the job; it runs once the last minute was quiet', async () => {
  const cpu = fakeCpu();
  let encoded = 0;
  vv._resetForTest({ cpuFn: cpu.read, encodeFn: async (j) => { encoded++; return encodeOk(j); } });
  const c = video('ws-b');
  vv.ensure(c, 'fit');

  await vv.tick();                                   // first look: start measuring
  assert.equal(encoded, 0);
  assert.equal(vv.stats().waiting, 'cpu');

  cpu.pass(61000, 95);                               // a busy minute
  await vv.tick();
  assert.equal(encoded, 0, 'busy host -> deferred');
  assert.equal(rows(c.id)[0].status, 'queued');

  cpu.pass(61000, 20);                               // a quiet minute
  await vv.tick();
  await vv._drain();
  assert.equal(encoded, 1);
  assert.equal(rows(c.id)[0].status, 'ready');
  const r = db.prepare('SELECT filepath FROM content_video_variants WHERE content_id = ?').get(c.id);
  assert.ok(fs.existsSync(path.join(config.contentDir, r.filepath)), 'the copy is on disk');
  assert.match(r.filepath, vv.FILE_RE);
});

test('time window: outside "22-6" nothing runs; inside it does', async () => {
  const cpu = fakeCpu();
  let now = new Date(2026, 9, 14, 12, 0);
  let encoded = 0;
  vv._resetForTest({ clockFn: () => now, cpuFn: cpu.read, encodeFn: async (j) => { encoded++; return encodeOk(j); } });
  vv.saveSettings({ window: '22-6' });
  const c = video('ws-b');
  vv.ensure(c, 'rot_cw');
  await vv.tick(); cpu.pass(61000, 0); await vv.tick(); await vv._drain();
  assert.equal(encoded, 0);
  assert.equal(vv.stats().waiting, 'window');

  now = new Date(2026, 9, 14, 23, 0);
  await vv.tick(); cpu.pass(61000, 0); await vv.tick(); await vv._drain();
  assert.equal(encoded, 1);
  assert.equal(rows(c.id)[0].status, 'ready');
});

test('allowance: over the org\'s monthly minutes the copy is denied (player told why); a new month re-queues it', async () => {
  const cpu = fakeCpu();
  let now = new Date(Date.UTC(2026, 9, 14, 12));
  let encoded = 0;
  vv._resetForTest({ clockFn: () => now, cpuFn: cpu.read, encodeFn: async (j) => { encoded++; return encodeOk(j); } });
  vv.saveSettings({ org_monthly_minutes: 1 });
  const first = video('ws-a', { duration: 50 });
  const second = video('ws-a', { duration: 50 });
  vv.ensure(first, 'fit');
  vv.ensure(second, 'fit');
  await vv.tick(); cpu.pass(61000, 0); await vv.tick(); await vv._drain();
  cpu.pass(61000, 0); await vv.tick(); cpu.pass(61000, 0); await vv.tick(); await vv._drain();
  assert.equal(encoded, 1, '50 s fits in the minute, 100 s does not');
  assert.equal(rows(first.id)[0].status, 'ready');
  assert.equal(rows(second.id)[0].status, 'denied');
  const p = vv.variantsForPayload(second.id, 'fit');
  assert.equal(p.state, 'unavailable');
  assert.equal(p.reason, 'allowance');

  // Same month: ensure() leaves it denied (no busy loop of re-queue and refuse).
  assert.equal(vv.ensure(second, 'fit', { now }), 'denied');
  // Next month it gets another chance.
  db.prepare('UPDATE content_video_variants SET updated_at = ? WHERE content_id = ?').run(Math.floor(now.getTime() / 1000), second.id);
  now = new Date(Date.UTC(2026, 10, 2, 12));
  assert.equal(vv.ensure(second, 'fit', { now }), 'queued');
});

test('a failed encode is recorded, not retried by itself; Retry re-queues it', async () => {
  const cpu = fakeCpu();
  vv._resetForTest({ cpuFn: cpu.read, encodeFn: async () => { throw new Error('moov atom not found'); } });
  const c = video('ws-b');
  vv.ensure(c, 'fit');
  await vv.tick(); cpu.pass(61000, 0); await vv.tick(); await vv._drain();
  assert.equal(rows(c.id)[0].status, 'failed');
  assert.match(rows(c.id)[0].error, /moov/);
  assert.equal(vv.ensure(c, 'fit'), 'failed', 'the payload path does not re-queue a failure forever');
  assert.equal(vv.retry(c.id), 1);
  assert.equal(rows(c.id)[0].status, 'queued');
});

test('no ffmpeg on the host: jobs wait, and a needing screen is told so', async () => {
  vv._resetForTest({ ffmpeg: false, cpuFn: fakeCpu().read });
  const media = require('../lib/media-tools');
  media._setExecForTest((bin, args, opts, cb) => { const e = new Error('ENOENT'); e.code = 'ENOENT'; cb(e); });
  try {
    const c = video('ws-b');
    vv.ensure(c, 'rot_cw');
    await vv.tick();
    assert.equal(vv.stats().waiting, 'no_ffmpeg');
    const p = vv.variantsForPayload(c.id, 'rot_cw');
    assert.equal(p.state, 'unavailable');
    assert.equal(p.reason, 'no_ffmpeg');
  } finally { media._setExecForTest(null); }
});

test('a replaced file never plays from the old copy; delete leaves no file behind', async () => {
  const cpu = fakeCpu();
  vv._resetForTest({ cpuFn: cpu.read, encodeFn: encodeOk });
  const c = video('ws-b');
  vv.ensure(c, 'fit');
  await vv.tick(); cpu.pass(61000, 0); await vv.tick(); await vv._drain();
  const old = db.prepare('SELECT filepath FROM content_video_variants WHERE content_id = ?').get(c.id).filepath;
  assert.ok(fs.existsSync(path.join(config.contentDir, old)));

  // Replace: new bytes, new file name.
  fs.writeFileSync(path.join(config.contentDir, 'replaced.mp4'), 'new bytes');
  db.prepare("UPDATE content SET filepath = 'replaced.mp4' WHERE id = ?").run(c.id);
  const now = db.prepare('SELECT * FROM content WHERE id = ?').get(c.id);
  assert.equal(vv.variantsForPayload(c.id, 'fit').variants && vv.ensure(now, 'fit'), 'queued');
  assert.equal(fs.existsSync(path.join(config.contentDir, old)), false, 'the stale copy is removed');
  assert.equal(vv.variantsForPayload(c.id, 'fit').variants, null, 'and is never offered');

  // Delete: the trigger (or, after a table rebuild dropped it, the sweep) takes the row; the sweep takes any file.
  fs.writeFileSync(path.join(config.contentDir, `stv_${c.id}_fit_deadbeef.mp4`), 'orphan');
  db.prepare('DELETE FROM content WHERE id = ?').run(c.id);
  vv.sweepOrphans();
  assert.deepEqual(rows(c.id), [], 'no row outlives its content');
  assert.equal(fs.existsSync(path.join(config.contentDir, `stv_${c.id}_fit_deadbeef.mp4`)), false);
});

test('the public copy route uses the same player gate as /file (no new way to read content)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const route = src.slice(src.indexOf("app.get('/api/content/:id/variant/:kind'"));
  const body = route.slice(0, route.indexOf('\n});'));
  assert.match(body, /isReferencedForPlayers\(db, content\) && !requesterCanAccessContent\(req, content\)/);
  assert.match(body, /vv\.KINDS\.includes\(req\.params\.kind\)/, 'kind is allow-listed');
  assert.match(body, /source_file = \?/, 'only a copy of the CURRENT bytes');
  assert.match(body, /FILE_RE\.test/, 'only a file name this module made');
  assert.ok(src.indexOf("app.get('/api/content/:id/variant/:kind'") < src.indexOf('const { requireAuth } = require'), 'mounted with the public content routes');
});

// ------------------------------------------------------------------ real ffmpeg

/** Average RGB of a small box of the first frame. */
function pixel(file, x, y) {
  const raw = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', file, '-frames:v', '1', '-vf', `crop=8:8:${x}:${y},scale=1:1`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 20 });
  return { r: raw[0], g: raw[1], b: raw[2] };
}
const isRed = (p) => p.r > 150 && p.g < 90 && p.b < 90;
const isBlue = (p) => p.b > 150 && p.r < 90;
function probe(file) {
  const s = JSON.parse(execFileSync('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_streams', file], { encoding: 'utf8' })).streams;
  return { v: s.find((x) => x.codec_type === 'video'), a: s.find((x) => x.codec_type === 'audio') };
}

test('REAL ffmpeg: turn direction and size of every copy (marker at the TOP of a tall clip)', { skip: !FFMPEG && 'ffmpeg not installed' }, async () => {
  // 360x640 tall clip: blue, with a red band across the top. With sound, so audio is kept.
  const src = path.join(config.contentDir, 'tall-src.mp4');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=360x640:d=1:r=10', '-f', 'lavfi', '-i', 'sine=d=1',
    '-vf', 'drawbox=x=0:y=0:w=360:h=80:color=red:t=fill', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src]);
  vv._resetForTest({});

  const out = (k) => path.join(config.contentDir, `out-${k}.mp4`);
  for (const kind of ['rot_cw', 'rot_ccw', 'fit']) await vv.encodeWithFfmpeg({ src, out: out(kind), kind, durationSec: 1 });

  // portrait = the screen turns content 90° clockwise (tizen app.js orientEl): the top of the
  // picture is at the RIGHT of the panel, so the copy must carry the red band on its right edge.
  const cw = probe(out('rot_cw'));
  assert.equal(cw.v.width, 640); assert.equal(cw.v.height, 360);
  assert.ok(isRed(pixel(out('rot_cw'), 640 - 20, 180)), 'rot_cw: top of source -> right edge');
  assert.ok(isBlue(pixel(out('rot_cw'), 20, 180)), 'rot_cw: left edge is the bottom of the source');
  assert.ok(cw.a, 'audio kept');
  assert.equal(cw.v.codec_name, 'h264');
  assert.equal(cw.v.pix_fmt, 'yuv420p');

  // portrait-flipped = 270° clockwise: the top of the picture is at the LEFT.
  assert.ok(isRed(pixel(out('rot_ccw'), 12, 180)), 'rot_ccw: top of source -> left edge');
  assert.ok(isBlue(pixel(out('rot_ccw'), 640 - 20, 180)));

  // fit: upright, unchanged size (it already fits 1920x1080), red still on top.
  const fit = probe(out('fit'));
  assert.equal(fit.v.width, 360); assert.equal(fit.v.height, 640);
  assert.ok(isRed(pixel(out('fit'), 180, 12)));
  const rotTag = (fit.v.side_data_list || []).find((d) => d.rotation) || (fit.v.tags && fit.v.tags.rotate && Number(fit.v.tags.rotate));
  assert.ok(!rotTag, 'no rotation metadata survives');
});

test('REAL ffmpeg: a 1080x1920 clip comes out inside 1920x1080 for every kind', { skip: !FFMPEG && 'ffmpeg not installed' }, async () => {
  const src = path.join(config.contentDir, 'tall-hd.mp4');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=green:s=1080x1920:d=0.3:r=10', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', src]);
  vv._resetForTest({});
  const dims = {};
  for (const kind of ['rot_cw', 'fit']) {
    const out = path.join(config.contentDir, `hd-${kind}.mp4`);
    const r = await vv.encodeWithFfmpeg({ src, out, kind, durationSec: 1 });
    dims[kind] = [r.width, r.height];
  }
  assert.deepEqual(dims.rot_cw, [1920, 1080], 'the turned copy is exactly a landscape HD frame');
  assert.ok(dims.fit[1] <= 1080 && dims.fit[0] < dims.fit[1] && dims.fit[0] % 2 === 0, `fit stays upright and decodable (${dims.fit})`);
});
