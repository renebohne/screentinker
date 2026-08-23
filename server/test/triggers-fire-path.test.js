'use strict';

/*
 * The fire path, EXECUTED — the player's trigger engine lifted out of index.html, wired to the real
 * shared resolver, and fired at over a real HTTP socket.
 *
 * ⚠️ Structural assertions about this code are worth something, but they cannot tell you whether a
 * datagram actually changes what is on a screen. This can. It caught a real bug on its first run:
 * startTriggerHttp() is called at boot AND on config change, and without an idempotence guard the
 * second call bound the same port, took EADDRINUSE, and its error handler marked the listener DOWN
 * while the first one was up and serving — so `listeners.http` reported false with a working
 * listener behind it. That is the single diagnostic an installer trusts, reporting the opposite of
 * the truth.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const TR = require('../lib/trigger-resolve.js');
const { freePort } = require('./helpers/free-port');
const { makeDocument, makeBox } = require('./helpers/fake-overlay-dom');

const PLAYER = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');
const SECRET = 's'.repeat(16);

let api, rendered, PORT;

/** Instantiate the engine with fakes for the DOM and the rotation engine. */
function boot(port, over = {}) {
  const start = PLAYER.indexOf('    let triggerActive = null;');
  const end = PLAYER.indexOf('    // ==================== PiP overlay');
  assert.ok(start > 0 && end > start, 'the trigger engine is still in index.html');
  const src = PLAYER.slice(start, end);

  const out = [];
  const env = {
    window: { TriggerResolve: TR, __debugLog_push() {} },
    // A #pipContainer fake that models children, classNames and remove() — the previous inline
    // fake had no querySelectorAll, so scoped teardown threw, the throw escaped into the HTTP
    // handler, and the test hung instead of failing. See helpers/fake-overlay-dom.js.
    document: makeDocument(),
    console: { log() {}, warn() {} },
    setTimeout, clearTimeout, Date, JSON, Number, Array, String, Math, require,
    socket: null,
    config: { deviceId: 'd1' },
    triggers: [{
      id: 't1', name: 'Evac', match_token: 'EVAC', clear_token: 'EVAC_CLR',
      source_http: true, source_udp: false, mode: 'until_cleared',
      items: [{ content_id: 'c1', duration_sec: 5 }, { content_id: 'c2', duration_sec: 5 }],
    }, {
      id: 't2', name: 'Promo', match_token: 'PROMO', clear_token: null,
      source_http: true, source_udp: false, mode: 'once', max_duration_sec: 3,
      items: [{ content_id: 'c3', duration_sec: 30 }],
    }, {
      id: 't3', name: 'Empty', match_token: 'EMPTY', source_http: true, mode: 'once', items: [],
    }],
    triggerConfig: { accept_http: true, secret: SECRET, http_port: port, clear_all_token: 'ALLSTOP' },
    showZoneItem: (zone, div, items, i) => out.push({ zone: zone.id, count: items.length, i }),
    // Spy for the base-audio suppression call. Production guards this with typeof, because the
    // real helper lives outside this slice; providing it here is what makes the calls assertable.
    setBaseAudioSuppressed: (on) => { env.__audio.push(!!on); },
    __audio: [],
    ...over,
  };
  const names = Object.keys(env);
  // eslint-disable-next-line no-new-func
  const fn = new Function(...names, `${src}\n; return { handleTrigger, startTriggerHttp, wireClean, stats: triggerStats,
      active: () => triggerActive,
      stop: () => { try { if (triggerHttpServer) triggerHttpServer.close(); } catch (e) {} } };`);
  return { api: fn(...names.map((n) => env[n])), out, audio: env.__audio, env };
}

const post = async (body, ct) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/`, {
    method: 'POST', headers: ct ? { 'Content-Type': ct } : {}, body });
  return { status: r.status, body: await r.json() };
};

before(async () => {
  PORT = await freePort();
  const b = boot(PORT);
  api = b.api; rendered = b.out;
  // The slice contains the boot call, so the listener is already coming up; give it a tick.
  await new Promise((r) => setTimeout(r, 300));
});
// ⚠️ A bound listener holds the process open, so node --test would never exit without this.
after(() => { try { api && api.stop(); } catch (e) { /* already gone */ } });

test('the listener binds and reports the port it bound', () => {
  assert.equal(api.stats.listeners.http, PORT,
    'a bound listener must report its port — this is what declares the capability');
});

test('a raw one-line fire renders the trigger playlist', async () => {
  const r = await post(`ST1 ${SECRET} EVAC`);
  assert.deepEqual(r.body, { ok: true, action: 'fire' });
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].zone, '__trigger__', 'rendered by the shared rotation engine');
  assert.equal(rendered[0].count, 2, 'the whole trigger playlist, not one item');
  assert.equal(api.active().trigger.name, 'Evac');
});

test('⚠️ a re-fire of the already-active trigger does NOT restart it', async () => {
  // PLC and Crestron gear re-assert on a timer. A restart per repeat would freeze a multi-item
  // emergency loop on item 1 for as long as the sender keeps talking, and it would look like the
  // playlist was broken rather than like the sender was chatty.
  const before = rendered.length;
  const r = await post(`ST1 ${SECRET} EVAC`);
  assert.equal(r.body.ok, true);
  assert.equal(rendered.length, before, 'the rotation was restarted');
});

test('the wrong secret is refused with 400 and a named reason', async () => {
  const r = await post(`ST1 ${'x'.repeat(16)} EVAC`);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'bad_secret');
});

test('a JSON envelope works too, because some gear can only POST JSON', async () => {
  const r = await post(JSON.stringify({ secret: SECRET, token: 'EVAC_CLR' }), 'application/json');
  assert.deepEqual(r.body, { ok: true, action: 'clear' });
  assert.equal(api.active(), null, 'the overlay was torn down');
});

test('an unknown token is refused', async () => {
  const r = await post(`ST1 ${SECRET} NOT_A_TOKEN`);
  assert.equal(r.body.error, 'unknown_token');
});

test('broadcast noise is refused on the magic', async () => {
  const r = await post('M-SEARCH * HTTP/1.1');
  assert.equal(r.body.error, 'bad_magic');
});

test('a device-level clear-all tears down whatever is showing', async () => {
  await post(`ST1 ${SECRET} EVAC`);
  assert.ok(api.active());
  const r = await post(`ST1 ${SECRET} ALLSTOP`);
  assert.deepEqual(r.body, { ok: true, action: 'clear_all' });
  assert.equal(api.active(), null);
});

test('⚠️ a trigger whose playlist did not reach this device fires nothing, loudly', async () => {
  // This is the failure the pinning work exists to prevent, so it must not look like success.
  const r = await post(`ST1 ${SECRET} EMPTY`);
  assert.equal(r.body.ok, true, 'the token resolved — the payload was valid');
  assert.equal(api.active(), null, 'but nothing is showing, because there was nothing to show');
});

test('the counters break down by reason, and count rejected traffic', () => {
  const s = api.stats;
  assert.ok(s.received > s.accepted, 'rejections were counted');
  assert.equal(s.rejected.bad_secret, 1);
  assert.equal(s.rejected.unknown_token, 1);
  assert.equal(s.rejected.bad_magic, 1);
  /*
   * ⚠️ The distinction the whole diagnostic rests on: last_datagram_at is stamped for REJECTED
   * traffic too. Recent timestamp with zero accepts means packets are arriving and the secret is
   * wrong; null means nothing is arriving and it is the network. Two different site visits.
   */
  assert.ok(s.last_datagram_at, 'a rejected packet still proves something arrived');
});

test('⚠️ starting twice does not mark a working listener as down', async () => {
  // The bug this file caught: boot starts it, a config change starts it again, the duplicate takes
  // EADDRINUSE and its error handler cleared the flag for the listener that was actually serving.
  api.startTriggerHttp();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(api.stats.listeners.http, PORT,
    'a duplicate start reported the listener down while it was up');
  const r = await post(`ST1 ${SECRET} EVAC`);
  assert.equal(r.body.ok, true, 'and it is still serving');
});

test('the listener stays shut when the device was never told to open it', async () => {
  const b = boot(await freePort(), { triggerConfig: { accept_http: false, secret: SECRET } });
  await new Promise((r) => setTimeout(r, 200));
  try {
    assert.ok(!b.api.stats.listeners.http, 'a port that changes a screen must not default to open');
  } finally { b.api.stop(); }
});

/*
 * ⚠️ A SECOND INSTANCE ON ITS OWN PORT, deliberately.
 *
 * The rate limiter is keyed on source IP with burst 10 refilling at 5/s, and every test in this
 * file fires from 127.0.0.1 — so they all share one bucket and the tests above have already
 * drained it. Running the door tests against the same instance made them fail with 'rate_limited',
 * which is the limiter working correctly and the test being wrong. A fresh instance gives a fresh
 * bucket; the alternative (sleeping between requests) would encode the refill rate into the test
 * and break the day anyone tunes it.
 */
let door, doorPort, doorOut, doorAudio;
before(async () => {
  doorPort = await freePort();
  const b = boot(doorPort);
  door = b.api; doorOut = b.out; doorAudio = b.audio;
  await new Promise((r) => setTimeout(r, 300));
});
after(() => { try { door && door.stop(); } catch (e) { /* already gone */ } });

const get = async (qs) => {
  const r = await fetch(`http://127.0.0.1:${doorPort}/trigger${qs}`);
  return { status: r.status, body: await r.json() };
};
const dpost = async (body, ct) => {
  const r = await fetch(`http://127.0.0.1:${doorPort}/`, {
    method: 'POST', headers: ct ? { 'Content-Type': ct } : {}, body });
  return { status: r.status, body: await r.json() };
};

/*
 * GET is the ONLY http an AMX or Extron installer can emit. AMX NetLinx has no HTTP client at all
 * (hand-built strings, manual Content-Length) and no TLS anywhere in the language; Extron's Global
 * Scripter forbids the http, socket and ssl modules outright, so urllib is gone too. A POST-only
 * door is unreachable from both. These are not convenience tests — they cover the only reachable
 * surface for two of the five control platforms this feature exists to be driven by.
 */
test('GET with query parameters fires — the only HTTP AMX and Extron can emit', async () => {
  const before = doorOut.length;
  const r = await get(`?secret=${SECRET}&token=PROMO`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, action: 'fire' });
  assert.equal(doorOut.length, before + 1, 'a GET must render, not merely be accepted');
});

test('GET carrying a whole raw wire line in ?m= fires', async () => {
  const r = await get(`?m=${encodeURIComponent(`ST1 ${SECRET} EVAC`)}`);
  assert.deepEqual(r.body, { ok: true, action: 'fire' });
});

test('GET with the wrong secret is refused, exactly as POST is', async () => {
  const r = await get(`?secret=${'x'.repeat(16)}&token=ALLSTOP`);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'bad_secret', 'the GET door must not be a weaker door');
});

test('GET with no token names the reason instead of 405-ing', async () => {
  const r = await get('?secret=' + SECRET);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'malformed',
    'a mistyped parameter must be counted and named, not short-circuited outside the counters');
});

test('a form-encoded POST fires — the third shape control gear produces', async () => {
  const r = await dpost(`secret=${SECRET}&token=EVAC`, 'application/x-www-form-urlencoded');
  assert.deepEqual(r.body, { ok: true, action: 'fire' });
});

test('⚠️ framing is liberal — every terminator/padding COMBINATION, not one at a time', () => {
  /*
   * Driven through wireClean directly rather than over HTTP, because the exhaustive sweep is ~40
   * cases and the rate limiter is keyed on source IP with a burst of 10 — an end-to-end loop this
   * size measures the limiter, not the framing. A representative sample still goes over the wire
   * in the test below.
   *
   * ⚠️ The single-suffix loop this replaces PASSED while the code was broken for every combination:
   * the old wireClean stripped a trailing run of terminators and THEN trimmed, so any whitespace
   * after a NUL/CR/LF defeated the cleanup entirely and "TOKEN\r\n\0  " survived intact to be
   * rejected as malformed. That pairing is exactly the documented target — Q-SYS's Null EOL mode
   * plus AMX's hand-appended padding — and both platforms shipped it.
   */
  const b = boot(0, { triggerConfig: { accept_http: false, secret: SECRET } });
  const clean = b.api.wireClean;
  const tails = ['', '\r', '\n', '\r\n', '\0', '\0\r\n', '\n\0'];
  const pads = ['', ' ', '  ', '\t'];
  for (const t of tails) {
    for (const p of pads) {
      assert.equal(clean(`ST1 ${SECRET} EVAC${t}${p}`), `ST1 ${SECRET} EVAC`,
        `trailing ${JSON.stringify(t + p)} survived`);
      assert.equal(clean(`ST1 ${SECRET} EVAC${p}${t}`), `ST1 ${SECRET} EVAC`,
        `trailing ${JSON.stringify(p + t)} survived`);
      // A UTF-8 BOM is whitespace to neither JS trim() nor Kotlin's; .NET senders emit one.
      assert.equal(clean(`﻿${p}ST1 ${SECRET} EVAC`), `ST1 ${SECRET} EVAC`,
        `leading BOM + ${JSON.stringify(p)} survived`);
    }
  }
  // Interior whitespace is the field separator and must be untouched.
  assert.equal(clean(`ST1 ${SECRET} EVAC`), `ST1 ${SECRET} EVAC`);
});

test('framing survives the wire too — a representative sample end to end', async () => {
  for (const suffix of ['\r\n', '\0  ', '  ']) {
    const r = await dpost(`ST1 ${SECRET} EVAC${suffix}`);
    assert.equal(r.body.ok, true, `framing ${JSON.stringify(suffix)} was refused over HTTP`);
  }
});

test('the reply is newline-terminated so SendAndWait(deliTag) can match it', async () => {
  const r = await fetch(`http://127.0.0.1:${doorPort}/`, { method: 'POST', body: `ST1 ${SECRET} EVAC` });
  const text = await r.text();
  assert.ok(text.endsWith('\n'),
    'Extron integrators read until a known suffix; an unterminated body blocks them until timeout');
});

test('⚠️ the base playlist is silenced while a trigger covers the screen, and un-silenced after', () => {
  /*
   * The defect: showZoneItem sets `video.muted = (zone.sort_order > 0)`, and a trigger renders
   * through a synthetic zone with no sort_order — so `undefined > 0` is false and the OVERLAY
   * played unmuted, while triggerFire/triggerStop touched nothing outside #pipContainer so the
   * BASE video kept playing its soundtrack underneath. Two audio streams during an alarm.
   *
   * Its own instance, driven through handleTrigger directly: the rate limiter is keyed on source
   * IP with burst 10, and the HTTP tests above have already spent the shared bucket.
   */
  const b = boot(0, { triggerConfig: { accept_http: false, secret: SECRET, clear_all_token: 'ALLSTOP' } });
  const fire = (tok) => b.api.handleTrigger({ text: `ST1 ${SECRET} ${tok}`, source: 'http', sourceIp: '10.0.0.9' });

  fire('EVAC');
  assert.deepEqual(b.audio, [true], 'firing must suppress base audio');

  // A re-assert is a no-op that renews — control gear repeats on a timer (Extron ships
  // StartKeepAlive for exactly this), so any churn here recurs for the whole alarm.
  b.audio.length = 0;
  fire('EVAC'); fire('EVAC');
  assert.deepEqual(b.audio, [], 'a re-assert flapped the base audio');

  // ⚠️ A SUPERSEDE must not blip either. triggerFire opens with triggerStop('superseded'), so a
  // naive sync in triggerStop drives the base true -> false -> true and lets it sound through the
  // gap every time one trigger replaces another.
  b.audio.length = 0;
  fire('PROMO');
  assert.ok(!b.audio.includes(false), `base audio was released mid-supersede: ${JSON.stringify(b.audio)}`);

  b.audio.length = 0;
  fire('ALLSTOP');
  assert.deepEqual(b.audio, [false], 'clearing must release the base');
});

/*
 * ⚠️ THE LAYER-ISOLATION FIX HAD ZERO COVERAGE until these. #pipContainer has two owners — the
 * trigger engine and the manual PiP path — and both used to clear it with `innerHTML = ''`, so each
 * silently destroyed the other's DOM while the other's state machine carried on believing it was on
 * screen. A QA pass proved the fix was untested by inverting the selector in triggerStop (tear down
 * .pip-box instead of .trigger-box) and watching all 39 trigger tests still pass.
 */
test('⚠️ clearing a trigger removes ONLY the trigger box, leaving a live PiP alone', () => {
  const b = boot(0, { triggerConfig: { accept_http: false, secret: SECRET, clear_all_token: 'ALLSTOP' } });
  const c = b.env.document.getElementById('pipContainer');
  b.api.handleTrigger({ text: `ST1 ${SECRET} EVAC`, source: 'http', sourceIp: '10.0.0.11' });
  assert.ok(c.has('trigger-box'), 'the fire did not render a box into the shared layer');

  // A manual PiP arrives while the alarm is up, as device:pip-show would build it.
  c.appendChild(makeBox('pip-box'));

  b.api.handleTrigger({ text: `ST1 ${SECRET} EVAC_CLR`, source: 'http', sourceIp: '10.0.0.11' });
  assert.ok(!c.has('trigger-box'), 'the trigger box survived its own clear');
  assert.ok(c.has('pip-box'), "clearing a trigger destroyed the manual PiP's box");
});

test('⚠️ neither owner may clear the shared layer with innerHTML', () => {
  // The cheapest possible guard against a revert: innerHTML = '' on #pipContainer is always one
  // owner nuking the other's DOM, whatever the intent.
  const b = boot(0, { triggerConfig: { accept_http: false, secret: SECRET, clear_all_token: 'ALLSTOP' } });
  const c = b.env.document.getElementById('pipContainer');
  b.api.handleTrigger({ text: `ST1 ${SECRET} EVAC`, source: 'http', sourceIp: '10.0.0.12' });
  b.api.handleTrigger({ text: `ST1 ${SECRET} ALLSTOP`, source: 'http', sourceIp: '10.0.0.12' });
  assert.equal(c._innerHTMLWrites, 0,
    'the shared overlay layer was cleared wholesale instead of per-owner');
});

test('⚠️ a trigger playlist drops YouTube items but still renders the rest', () => {
  /*
   * The player-side drop exists for the case the API refusal cannot reach: definitions already
   * cached on devices in the field. It was entirely untested — disabling the filter left all 20
   * tests green — while the bug it prevents is severe: createYoutubeEmbed is a singleton shared
   * with the base playlist, so a YouTube item in a trigger destroys the base player with no
   * rebuild path, and its error branch advances the BASE playlist underneath the alarm.
   */
  const b = boot(0, {
    triggerConfig: { accept_http: false, secret: SECRET, clear_all_token: 'ALLSTOP' },
    triggers: [{
      id: 'ty', name: 'Mixed', match_token: 'MIXED', source_http: true, mode: 'once',
      items: [
        { content_id: 'yt1', mime_type: 'video/youtube' },
        { content_id: 'ok1', filepath: 'uploads/a.mp4' },
      ],
    }],
  });
  b.api.handleTrigger({ text: `ST1 ${SECRET} MIXED`, source: 'http', sourceIp: '10.0.0.13' });
  assert.equal(b.out.length, 1, 'the trigger did not render');
  assert.equal(b.out[0].count, 1, 'the YouTube item reached the shared renderer');
});

test('⚠️ an all-YouTube trigger does not destroy the overlay already showing', () => {
  // The drop can empty a playlist. That early return must leave the live overlay intact AND must
  // not leave the previous trigger both active and on the held list — otherwise clearing it fires
  // it straight back and an operator watches the alarm they cleared reappear on its own.
  const b = boot(0, {
    triggerConfig: { accept_http: false, secret: SECRET, clear_all_token: 'ALLSTOP' },
    triggers: [
      { id: 'a', name: 'Alarm', match_token: 'A', clear_token: 'A_CLR', source_http: true,
        mode: 'until_cleared', priority: 10, items: [{ content_id: 'c1', filepath: 'u/a.mp4' }] },
      { id: 'b', name: 'AllYT', match_token: 'B', source_http: true, mode: 'until_cleared',
        priority: 50, items: [{ content_id: 'y', mime_type: 'video/youtube' }] },
    ],
  });
  const fire = (t) => b.api.handleTrigger({ text: `ST1 ${SECRET} ${t}`, source: 'http', sourceIp: '10.0.0.14' });
  fire('A');
  assert.equal(b.api.active().trigger.id, 'a');
  fire('B');
  assert.equal(b.api.active().trigger.id, 'a', 'an unrenderable trigger displaced the live alarm');
  fire('A_CLR');
  assert.equal(b.api.active(), null, 'the cleared alarm came back from the held list');
});
