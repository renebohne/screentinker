'use strict';

/*
 * 3.0 Private AI (docs/private-ai.md), through the real routers, against a FAKE OpenAI-compatible
 * server on 127.0.0.1. No real network: DNS for the made-up names is answered by the test.
 *
 * The instance runs in HOSTED mode (no SELF_HOSTED), which is where the outbound rules bite: the
 * fake server is on loopback, a private address, so it has to be allowed — one host, for one
 * organization, by a platform administrator — before anything may connect to it.
 */
const path = require('path');
const os = require('os');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-privai-' + process.pid + '-' + Date.now());
process.env.JWT_SECRET = 'test-secret-private-ai';
process.env.NODE_ENV = 'test';
delete process.env.SELF_HOSTED;
delete process.env.OUTBOUND_ALLOW_HOSTS;
delete process.env.OUTBOUND_ALLOW_PRIVATE;
process.env.XAI_API_KEY = 'test-xai-key';   // so hosted AI is "on" and the policy has something to switch off

const { test, after, before } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const express = require('express');
const { db } = require('../db/database');
const { requireAuth, generateToken } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');
const privateAi = require('../lib/private-ai');
const aiFetchLib = require('../lib/ai-fetch');
const signs = require('../lib/sign-templates');
const starter = require('../lib/ai-starter');
const tr = require('../lib/sign-translate');

/* ------------------------------------------------------------------ tenants */

const O = 'org-pai', O2 = 'org-pai-2', WS = 'ws-pai', WS2 = 'ws-pai-2';
const users = {
  root: 'u-pai-root', admin: 'u-pai-admin', editor: 'u-pai-editor', viewer: 'u-pai-viewer', other: 'u-pai-other',
};
for (const [k, id] of Object.entries(users)) {
  db.prepare("INSERT OR IGNORE INTO users (id,email,password_hash,role,name) VALUES (?,?,'x',?,?)")
    .run(id, `${k}@pai.local`, k === 'root' ? 'platform_admin' : 'user', k);
}
db.prepare('INSERT OR IGNORE INTO organizations (id,name,owner_user_id) VALUES (?,?,?)').run(O, 'School', users.admin);
db.prepare('INSERT OR IGNORE INTO organizations (id,name,owner_user_id) VALUES (?,?,?)').run(O2, 'Other', users.other);
db.prepare('INSERT OR IGNORE INTO workspaces (id,organization_id,name) VALUES (?,?,?)').run(WS, O, 'Main');
db.prepare('INSERT OR IGNORE INTO workspaces (id,organization_id,name) VALUES (?,?,?)').run(WS2, O2, 'Theirs');
const mem = db.prepare('INSERT OR IGNORE INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)');
mem.run(WS, users.root, 'workspace_admin');
mem.run(WS, users.admin, 'workspace_admin'); mem.run(WS, users.editor, 'workspace_editor'); mem.run(WS, users.viewer, 'workspace_viewer');
mem.run(WS2, users.other, 'workspace_admin');
try { db.prepare("INSERT OR IGNORE INTO organization_members (organization_id,user_id,role) VALUES (?,?,'org_owner')").run(O, users.admin); } catch { /* older schema name */ }
try { db.prepare("INSERT OR IGNORE INTO organization_members (organization_id,user_id,role) VALUES (?,?,'org_owner')").run(O2, users.other); } catch { /* */ }
db.prepare("INSERT OR IGNORE INTO devices (id, name, workspace_id) VALUES ('dev-pai-a', 'Lobby', ?)").run(WS);
db.prepare("INSERT OR IGNORE INTO devices (id, name, workspace_id) VALUES ('dev-pai-b', 'Theirs', ?)").run(WS2);

/* ------------------------------------------------------------------ the fake AI server */

const fake = { hits: [], auth: [], chat: null, modelsShape: 'openai' };
const fakeSrv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    fake.hits.push(`${req.method} ${req.url}`);
    fake.auth.push(req.headers.authorization || '');
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(typeof obj === 'string' ? obj : JSON.stringify(obj)); };
    if (req.method === 'GET' && req.url === '/v1/models') {
      if (fake.modelsShape === 'ollama-only') return send(404, { error: 'not found' });
      return send(200, { object: 'list', data: [{ id: 'llama3.1:8b' }, { id: 'qwen2.5:3b' }, { id: 'nomic-embed-text' }, { id: 'stable-diffusion-xl' }] });
    }
    if (req.method === 'GET' && req.url === '/api/tags') {
      return send(200, { models: [{ name: 'llama3.2:3b', model: 'llama3.2:3b' }, { name: 'gemma2:2b' }] });
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let j = {};
      try { j = JSON.parse(body); } catch { /* */ }
      const content = fake.chat ? fake.chat(j) : '{}';
      return send(200, { choices: [{ message: { role: 'assistant', content } }] });
    }
    send(404, { error: 'nope' });
  });
});

/* ------------------------------------------------------------------ the app */

const app = express();
app.use(express.json({ limit: '2mb' }));
const nsp = { adapter: { rooms: new Map() }, to: () => ({ emit() {} }), emit() {} };
app.set('io', { of: () => nsp });
app.use('/api/ai/hosted', requireAuth, resolveTenancy, require('../routes/ai-hosted'));
app.use('/api/ai/private', requireAuth, resolveTenancy, require('../routes/ai-private'));
app.use('/api/ai', requireAuth, resolveTenancy, require('../routes/ai'));
app.use('/api/signs', requireAuth, resolveTenancy, require('../routes/signs'));
const server = app.listen(0);

let BASE;      // http://127.0.0.1:<port>/v1
let FAKE_PORT;
const captured = [];
const origLog = { log: console.log, warn: console.warn, error: console.error };

before(async () => {
  await new Promise((r) => fakeSrv.listen(0, '127.0.0.1', r));
  FAKE_PORT = fakeSrv.address().port;
  BASE = `http://127.0.0.1:${FAKE_PORT}/v1`;
  // DNS for made-up names, answered here: no real network in this suite.
  privateAi._setLookup(async (host) => {
    if (host === 'cloud.example.com') return [{ address: '93.184.216.34', family: 4 }];
    if (host === 'ollama.lan') return [{ address: '192.168.1.20', family: 4 }];
    throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
  });
  for (const k of Object.keys(origLog)) {
    console[k] = (...a) => { captured.push(a.map(String).join(' ')); };
  }
});
after(() => {
  Object.assign(console, origLog);
  privateAi._setLookup(null);
  aiFetchLib._setTransport(null);
  server.close(); fakeSrv.close();
  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* */ }
});

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

/* ================================================================== provider setup */

test('nothing configured: status says so, and the AI features explain rather than fail', async () => {
  const st = await call('GET', '/api/ai/private/status', 'editor');
  assert.equal(st.status, 200);
  assert.equal(st.json.configured, false);
  assert.equal(st.json.private, false);
  const s = await call('POST', '/api/ai/private/starter', 'editor', { description: 'A bakery' });
  assert.equal(s.status, 400);
  assert.equal(s.json.code, 'not_configured');
});

test('⚠️ a private host is refused until it is allowed — and nothing connects before that', async () => {
  fake.hits.length = 0;
  const r = await call('POST', '/api/ai/private/test', 'admin', { base_url: BASE });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.private, true);
  assert.equal(r.json.allowed, false);
  assert.equal(r.json.reachable, false);
  assert.equal(r.json.how_to_allow.env, 'OUTBOUND_ALLOW_HOSTS=127.0.0.1', 'tells the admin exactly what to allow');
  assert.equal(r.json.can_allow, false, 'a workspace admin cannot open a private address');
  assert.deepEqual(fake.hits, [], 'the private server must not see a request before it is allowed');

  // Saving it is refused too.
  const s = await call('PUT', '/api/ai/private/settings', 'admin', { base_url: BASE, model: 'llama3.1:8b' });
  assert.equal(s.status, 400);
  assert.equal(s.json.code, 'not_allowed');

  // A workspace or org admin may not allow it; only a platform administrator.
  assert.equal((await call('POST', '/api/ai/private/allow-host', 'admin', { host: '127.0.0.1' })).status, 403);
  assert.equal((await call('POST', '/api/ai/private/allow-host', 'viewer', { host: '127.0.0.1' })).status, 403);
});

test('⚠️ allow-host takes ONE exact host: never a range, a pattern or cloud metadata', async () => {
  for (const host of ['10.0.0.0/8', '*.lan', '169.254.169.254', 'metadata.google.internal', 'http://x/', '', 'a b']) {
    const r = await call('POST', '/api/ai/private/allow-host', 'root', { host });
    assert.equal(r.status, 400, `"${host}" must be refused`);
  }
  assert.equal(process.env.OUTBOUND_ALLOW_PRIVATE, undefined, 'the private ranges are never opened');
});

test('model listing: OpenAI /v1/models once the host is allowed, with image models told apart', async () => {
  const a = await call('POST', '/api/ai/private/allow-host', 'root', { host: '127.0.0.1' });
  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.deepEqual(a.json.hosts, ['127.0.0.1']);

  fake.modelsShape = 'openai';
  const r = await call('POST', '/api/ai/private/test', 'admin', { base_url: BASE });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.reachable, true);
  assert.equal(r.json.via, 'org_allowlist');
  assert.equal(r.json.dialect, 'openai');
  assert.ok(r.json.text_models.includes('llama3.1:8b'));
  assert.ok(!r.json.text_models.includes('nomic-embed-text'), 'an embedding model is not a text model');
  assert.deepEqual(r.json.image_models, ['stable-diffusion-xl']);
});

test('model listing: Ollama /api/tags when /v1/models is not there', async () => {
  fake.modelsShape = 'ollama-only';
  try {
    const r = await call('POST', '/api/ai/private/test', 'admin', { base_url: BASE });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.dialect, 'ollama');
    assert.deepEqual(r.json.models, ['llama3.2:3b', 'gemma2:2b']);
  } finally { fake.modelsShape = 'openai'; }
});

test('⚠️ tenancy: an allowed host is allowed for THAT organization only', async () => {
  fake.hits.length = 0;
  const r = await call('POST', '/api/ai/private/test', 'other', { base_url: BASE }, WS2);
  assert.equal(r.status, 200);
  assert.equal(r.json.allowed, false, 'another organization must not inherit the allowance');
  assert.deepEqual(fake.hits, []);
  const st = await call('GET', '/api/ai/private/status', 'other', null, WS2);
  assert.deepEqual(st.json.allowed_hosts, []);
});

test('⚠️ a cloud key does not follow the endpoint to a local server', async () => {
  // A bring-your-own cloud setup with a key...
  db.prepare(`INSERT INTO ai_settings (workspace_id, base_url, api_key_enc, model) VALUES (?, ?, ?, ?)
    ON CONFLICT(workspace_id) DO UPDATE SET base_url=excluded.base_url, api_key_enc=excluded.api_key_enc, model=excluded.model`)
    .run(WS, 'https://api.openai.com/v1', require('../lib/secretbox').encrypt('sk-cloud-secret'), 'gpt-4o-mini');
  // ...switched to local without typing a key.
  const s = await call('PUT', '/api/ai/private/settings', 'admin', { base_url: BASE, model: 'llama3.1:8b', image_model: 'stable-diffusion-xl' });
  assert.equal(s.status, 200, JSON.stringify(s.json));
  assert.equal(s.json.kind, 'local');
  assert.equal(s.json.private, true, 'a loopback server is private: the badge may say so');
  const saved = db.prepare('SELECT api_key_enc, image_base_url, image_provider, provider_kind FROM ai_settings WHERE workspace_id = ?').get(WS);
  assert.equal(saved.api_key_enc, null, 'the OpenAI key must not be sent to the LAN box');
  assert.equal(saved.image_base_url, BASE);
  assert.equal(saved.image_provider, 'openai');
});

test('viewer: reads the status (no addresses), changes nothing', async () => {
  const st = await call('GET', '/api/ai/private/status', 'viewer');
  assert.equal(st.status, 200);
  assert.equal(st.json.configured, true);
  assert.equal(st.json.private, true);
  assert.equal(st.json.base_url, undefined, 'a network address is for the people who manage AI');
  assert.equal(st.json.can_use, false);
  for (const [m, p, b] of [
    ['PUT', '/api/ai/private/settings', { base_url: BASE, model: 'x' }],
    ['POST', '/api/ai/private/test', { base_url: BASE }],
    ['PUT', '/api/ai/private/policy', { only_private: true }],
    ['POST', '/api/ai/private/starter', { description: 'x' }],
    ['POST', '/api/ai/private/translate', { deck_id: 'x', langs: ['fr'] }],
    ['PUT', '/api/ai/private/screens/dev-pai-a', { mode: 'fixed', langs: ['fr'] }],
  ]) {
    const r = await call(m, p, 'viewer', b);
    assert.equal(r.status, 403, `${m} ${p} must be refused for a viewer`);
  }
});

/* ================================================================== only private AI */

test('⚠️ "only allow private AI": cloud endpoints and hosted credits are blocked, the local server is not', async () => {
  assert.equal((await call('PUT', '/api/ai/private/policy', 'editor', { only_private: true })).status, 403, 'an editor cannot set org policy');
  // Before: hosted AI is on for this org.
  let h = await call('GET', '/api/ai/hosted/status', 'editor');
  assert.equal(h.json.enabled, true);

  const p = await call('PUT', '/api/ai/private/policy', 'admin', { only_private: true });
  assert.equal(p.status, 200, JSON.stringify(p.json));

  h = await call('GET', '/api/ai/hosted/status', 'editor');
  assert.equal(h.json.enabled, false);
  assert.equal(h.json.reason, 'private_only');
  const g = await call('POST', '/api/ai/hosted/generate', 'editor', { prompt: 'x', idempotency_key: 'abcdefgh12', provider: 'xai', model: 'grok-imagine-image', resolution: '1k', quality: 'standard' });
  assert.equal(g.status, 403);
  assert.equal(g.json.code, 'private_only');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ai_credit_reservations').get().n, 0, 'nothing reserved, nothing spent');

  // The bring-your-own form cannot save a cloud endpoint...
  const s = await call('PUT', '/api/ai/settings', 'admin', { base_url: 'https://cloud.example.com/v1', model: 'gpt' });
  assert.equal(s.status, 403);
  assert.equal(s.json.code, 'private_only');
  // ...nor list its models...
  const m = await call('POST', '/api/ai/models', 'admin', { base_url: 'https://cloud.example.com/v1' });
  assert.equal(m.status, 403);
  // ...and a cloud endpoint already saved is refused at generation time, before any request.
  const sent = [];
  aiFetchLib._setTransport(async (u) => { sent.push(u); throw new Error('must not be called'); });
  try {
    db.prepare("UPDATE ai_settings SET base_url = 'https://cloud.example.com/v1', provider_kind = NULL WHERE workspace_id = ?").run(WS);
    const gen = await call('POST', '/api/ai/generate-slide', 'editor', { prompt: 'Autumn sale' });
    assert.notEqual(gen.status, 200);
    assert.match(gen.json.error, /private AI only/);
    const st = await call('POST', '/api/ai/private/starter', 'editor', { description: 'A bakery' });
    assert.equal(st.status, 403);
    assert.equal(st.json.code, 'private_only');
    assert.deepEqual(sent, [], 'no request may leave for a cloud endpoint under the policy');
  } finally {
    aiFetchLib._setTransport(null);
    db.prepare("UPDATE ai_settings SET base_url = ?, provider_kind = 'local' WHERE workspace_id = ?").run(BASE, WS);
  }

  // Another organization is untouched by this one's policy.
  h = await call('GET', '/api/ai/hosted/status', 'other', null, WS2);
  assert.equal(h.json.enabled, true);
});

/* ================================================================== starter set */

const VALID_SET = {
  signs: [
    { template: 'hours', values: { title: 'Opening hours', rows: [{ label: 'Every day', value: '7:00 – 17:00' }], note: 'Fresh bread from 7' } },
    { template: 'specials', values: { business: 'Model Bakery Name', title: 'Fresh today', items: [{ label: 'Sourdough loaf', value: '' }, { label: 'Pastries' }, 'junk', { label: { x: 1 } }] } },
    { template: 'welcome', values: { title: '<b>Welcome</b> in!', message: 'x'.repeat(400), bg: '#FF0000', url: 'https://evil.example' } },
    { template: 'wifi', values: { title: 'Free Wi-Fi', network: 'Guest', password: 'invented123' } },
    { template: 'not-a-template', values: { title: 'x' } },
    { template: 'hours', values: { title: 'duplicate' } },
    { template: 'sale', values: { title: 'Weekend offer' } },   // missing required "big"
    { template: 'event', values: { title: { text: 'x' }, eyebrow: ['no'], details: 'Every Saturday' } },   // required title is not text
  ],
};

test('⚠️ starter set: junk, then a messy answer → retried once, every value checked against the template schema', async () => {
  db.prepare("INSERT INTO brand_kits (workspace_id, business_name) VALUES (?, 'Rosa''s Bakery') ON CONFLICT(workspace_id) DO UPDATE SET business_name = excluded.business_name").run(WS);
  let n = 0;
  fake.chat = (body) => {
    n++;
    assert.match(body.messages[0].content, /Templates:/);
    return n === 1 ? 'Sure! Here are some great signs for your bakery :)' : 'Here you go:\n```json\n' + JSON.stringify(VALID_SET) + '\n```';
  };
  const r = await call('POST', '/api/ai/private/starter', 'editor', { description: 'A small bakery in Leeds, open 7-5, we sell sourdough and pastries' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(n, 2, 'one retry, no more');
  assert.equal(r.json.retried, true);
  assert.equal(r.json.private, true);
  const ids = r.json.proposals.map((p) => p.template);
  assert.deepEqual(ids, ['hours', 'specials', 'welcome'], 'unknown, not-offered, duplicate and incomplete templates are dropped');
  for (const p of r.json.proposals) {
    const tpl = signs.getTemplate(p.template);
    assert.deepEqual(signs.validateValues(tpl, p.values, {}).errors, [], `${p.template} must validate as a person's form would`);
    for (const v of Object.values(p.values)) assert.ok(!/[<>]/.test(JSON.stringify(v)), 'no markup');
  }
  const welcome = r.json.proposals.find((p) => p.template === 'welcome');
  assert.equal(welcome.values.title, 'Welcome in!');
  assert.ok(welcome.values.message.length <= 140, 'trimmed to the field max');
  assert.ok(!('bg' in welcome.values) && !('url' in welcome.values), 'fields the model may not fill never pass');
  assert.ok(welcome.dropped.includes('bg') && welcome.dropped.includes('url'));
  const specials = r.json.proposals.find((p) => p.template === 'specials');
  assert.equal(specials.values.business, "Rosa's Bakery", 'the brand kit wins over the model for the business name');
  assert.deepEqual(specials.values.items, [{ label: 'Sourdough loaf', value: '' }, { label: 'Pastries', value: '' }]);
});

test('starter set: a model that never answers usefully is explained, not a 500', async () => {
  fake.chat = () => '{"signs": "I cannot do that"}';
  const r = await call('POST', '/api/ai/private/starter', 'editor', { description: 'A library' });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'no_valid_signs');
  fake.chat = () => 'not json at all';
  const r2 = await call('POST', '/api/ai/private/starter', 'editor', { description: 'A library' });
  assert.equal(r2.status, 400);
});

test('starter set: validateProposal unit — every offered template exists, required facts are never offered', () => {
  for (const id of Object.keys(starter.OFFER)) {
    const tpl = signs.getTemplate(id);
    assert.ok(tpl, `${id} is not a sign template`);
    for (const k of Object.keys(starter.OFFER[id].fields)) assert.ok(tpl.fields.some((f) => f.key === k), `${id}.${k} does not exist`);
    for (const f of tpl.fields.filter((x) => x.required)) {
      assert.ok(starter.offeredFields(tpl).some((o) => o.key === f.key), `${id} requires ${f.key}, which the model is not offered`);
    }
  }
  for (const id of ['wifi', 'qr', 'countdown', 'celebration']) assert.ok(!starter.OFFER[id], `${id} needs a fact a model cannot know`);
  assert.equal(starter.validateProposal({ template: 'hours', values: { title: 'x'.repeat(60) } }).values.title.length <= 40, true);
});

/* ================================================================== translation */

let deckId;
let translationId;

test('⚠️ translation keeps placeholders and numbers; a lost marker is retried, then kept in the original', async () => {
  const sign = await call('POST', '/api/signs', 'editor', {
    template: 'specials', aspect: '16:9',
    values: { title: 'Fresh sourdough today', subtitle: 'Ask for {{ds:menu.special}} at the counter', items: [{ label: 'Croissant', value: '2.50' }, { label: 'Visit https://bakery.example/menu', value: '' }] },
  });
  assert.equal(sign.status, 201, JSON.stringify(sign.json));
  deckId = sign.json.deck_id;

  const seen = [];
  fake.chat = (body) => {
    const input = JSON.parse(body.messages[1].content.split('\n').pop());
    seen.push(input);
    const out = {};
    for (const [k, v] of Object.entries(input)) {
      // The subtitle's marker is lost on the FIRST attempt only; the link's marker always.
      if (/\[\[1\]\] at the counter/.test(v) && seen.length === 1) out[k] = 'Demandez au comptoir';
      else if (/^Visit \[\[1\]\]$/.test(v)) out[k] = 'Visitez notre site';
      else out[k] = `FR ${v}`;
    }
    return JSON.stringify(out);
  };
  const r = await call('POST', '/api/ai/private/translate', 'editor', { deck_id: deckId, langs: ['fr'] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const t = r.json.translations[0];
  translationId = t.id;
  assert.equal(t.lang, 'fr');
  assert.equal(t.status, 'draft', 'nothing reaches a screen before review');
  assert.equal(t.on_screens, false);
  const by = (src) => t.strings.find((s) => s.source === src);
  assert.equal(by('Ask for {{ds:menu.special}} at the counter').text, 'FR Ask for {{ds:menu.special}} at the counter', 'retried and the token came back intact');
  assert.equal(by('Visit https://bakery.example/menu').text, 'Visit https://bakery.example/menu', 'kept in the original rather than lose the link');
  assert.equal(by('Visit https://bakery.example/menu').note, 'kept_original');
  assert.equal(by('Fresh sourdough today').text, 'FR Fresh sourdough today');
  // The model never saw the placeholder itself.
  assert.ok(!JSON.stringify(seen).includes('{{ds:menu.special}}'), 'placeholders are masked before the model sees them');
  assert.ok(!JSON.stringify(seen).includes('2.50'), 'text with no words (a price) is not sent at all');
});

test('review: an edit that drops a placeholder is refused; a good edit goes back to draft', async () => {
  const bad = await call('PUT', `/api/ai/private/translations/${translationId}`, 'editor', {
    strings: [{ slide_id: (await call('GET', `/api/ai/private/translations?deck_id=${deckId}`, 'editor')).json.translations[0].strings[0].slide_id,
      slot: (await call('GET', `/api/ai/private/translations?deck_id=${deckId}`, 'editor')).json.translations[0].strings.find((s) => s.source.includes('{{ds:')).slot,
      text: 'Demandez la spécialité au comptoir' }],
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, 'placeholder_lost');
  const cur = (await call('GET', `/api/ai/private/translations?deck_id=${deckId}`, 'editor')).json.translations[0];
  const title = cur.strings.find((s) => s.source === 'Fresh sourdough today');
  const ok = await call('PUT', `/api/ai/private/translations/${translationId}`, 'editor', { strings: [{ slide_id: title.slide_id, slot: title.slot, text: 'Pain au levain frais' }] });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.strings.find((s) => s.source === 'Fresh sourdough today').text, 'Pain au levain frais');
  assert.equal(ok.json.status, 'draft');
});

test('⚠️ a workspace that reviews changes: an editor cannot approve; an admin can, and screens follow', async () => {
  db.prepare('UPDATE workspaces SET require_approval = 1 WHERE id = ?').run(WS);
  try {
    const e = await call('POST', `/api/ai/private/translations/${translationId}/approve`, 'editor');
    assert.equal(e.status, 403);
    assert.equal(e.json.code, 'review_required');
  } finally { db.prepare('UPDATE workspaces SET require_approval = 0 WHERE id = ?').run(WS); }

  const a = await call('POST', `/api/ai/private/translations/${translationId}/approve`, 'admin');
  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.equal(a.json.status, 'approved');
  assert.equal(a.json.on_screens, true);

  const map = JSON.parse(db.prepare('SELECT widget_map FROM sign_translations WHERE id = ?').get(translationId).widget_map);
  const [srcWidget, frWidget] = Object.entries(map)[0];
  const w = db.prepare('SELECT workspace_id, config FROM widgets WHERE id = ?').get(frWidget);
  assert.equal(w.workspace_id, WS);
  assert.match(w.config, /Pain au levain frais/);
  assert.match(w.config, /\{\{ds:menu\.special\}\}/, 'the data-source token survives into the widget');

  // A screen: original → fixed French → rotating.
  const items = [{ widget_id: srcWidget, widget_type: 'slide', widget_name: 'Specials', duration_sec: 15 }, { content_id: 'c1', filename: 'photo.jpg' }];
  assert.deepEqual(tr.applyScreenLanguage(db, 'dev-pai-a', WS, items), items, 'no language set: as published');
  let s = await call('PUT', '/api/ai/private/screens/dev-pai-a', 'editor', { mode: 'fixed', langs: ['fr'] });
  assert.equal(s.status, 200, JSON.stringify(s.json));
  let out = tr.applyScreenLanguage(db, 'dev-pai-a', WS, items);
  assert.equal(out.length, 2);
  assert.equal(out[0].widget_id, frWidget);
  assert.equal(out[0].duration_sec, 15);
  assert.equal(out[1], items[1], 'other items untouched');
  s = await call('PUT', '/api/ai/private/screens/dev-pai-a', 'editor', { mode: 'rotate', langs: ['fr'] });
  out = tr.applyScreenLanguage(db, 'dev-pai-a', WS, items);
  assert.deepEqual(out.map((x) => x.widget_id || x.content_id), [srcWidget, frWidget, 'c1'], 'languages alternate item by item');

  const list = await call('GET', '/api/ai/private/screens', 'viewer');
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.languages, ['fr']);
  assert.equal(list.json.screens.find((x) => x.id === 'dev-pai-a').mode, 'rotate');
});

test('⚠️ tenancy: another workspace cannot see, approve, delete or point a screen at these translations', async () => {
  const l = await call('GET', `/api/ai/private/translations?deck_id=${deckId}`, 'other', null, WS2);
  assert.deepEqual(l.json.translations, []);
  assert.equal((await call('POST', `/api/ai/private/translations/${translationId}/approve`, 'other', null, WS2)).status, 404);
  assert.equal((await call('DELETE', `/api/ai/private/translations/${translationId}`, 'other', null, WS2)).status, 404);
  assert.equal((await call('POST', '/api/ai/private/translate', 'other', { deck_id: deckId, langs: ['de'] }, WS2)).status, 404);
  assert.equal((await call('PUT', '/api/ai/private/screens/dev-pai-a', 'other', { mode: 'fixed', langs: ['fr'] }, WS2)).status, 404);
  // A screen in another workspace never receives this workspace's translation, even with a language set.
  tr.setScreenLanguage(db, { deviceId: 'dev-pai-b', workspaceId: WS2, mode: 'fixed', langs: ['fr'] });
  const map = JSON.parse(db.prepare('SELECT widget_map FROM sign_translations WHERE id = ?').get(translationId).widget_map);
  const srcWidget = Object.keys(map)[0];
  const items = [{ widget_id: srcWidget, widget_type: 'slide' }];
  assert.deepEqual(tr.applyScreenLanguage(db, 'dev-pai-b', WS2, items), items);
});

test('translation units: masking round-trips; a marker lost or doubled is refused', () => {
  const { masked, tokens } = tr.mask('Price {{ds:menu.price}} — see https://x.example/a or mail a@b.co, {name}');
  assert.equal(masked, 'Price [[1]] — see [[2]] or mail [[3]], [[4]]');
  assert.equal(tr.unmask('Prix [[1]] — voir [[2]] ou [[3]], [[4]]', masked, tokens), 'Prix {{ds:menu.price}} — voir https://x.example/a ou a@b.co, {name}');
  assert.equal(tr.unmask('Prix — voir [[2]] ou [[3]], [[4]]', masked, tokens), null);
  assert.equal(tr.unmask('Prix [[1]] [[1]] [[2]] [[3]] [[4]]', masked, tokens), null);
  assert.equal(tr.normLang('fr'), 'fr');
  assert.equal(tr.normLang('pt-br'), 'pt-BR');
  assert.equal(tr.normLang('../../x'), null);
});

/* ================================================================== the transport */

test('⚠️ ai-fetch: privateHosts opens exactly that host, never metadata', async () => {
  const { guardedFetch } = aiFetchLib;
  const r = await guardedFetch(`http://127.0.0.1:${FAKE_PORT}/api/tags`, { privateHosts: ['127.0.0.1'] });
  assert.equal(r.status, 200);
  await assert.rejects(guardedFetch(`http://127.0.0.1:${FAKE_PORT}/api/tags`, { privateHosts: ['10.0.0.5'] }), /not allowed/);
  await assert.rejects(guardedFetch('http://169.254.169.254/latest/meta-data/', { privateHosts: ['169.254.169.254'] }), /not allowed/);
});

test('⚠️ the real device payload carries the screen\'s language, on the screen\'s own playlist', () => {
  const { Server } = require('socket.io');
  const setupDeviceSocket = require('../ws/deviceSocket');
  setupDeviceSocket(new Server(http.createServer()));
  const build = setupDeviceSocket.buildPlaylistPayloadUnchecked;
  const map = JSON.parse(db.prepare('SELECT widget_map FROM sign_translations WHERE id = ?').get(translationId).widget_map);
  const [srcWidget, frWidget] = Object.entries(map)[0];
  const snap = [{ widget_id: srcWidget, widget_type: 'slide', widget_name: 'Specials', filename: 'Specials', duration_sec: 15, sort_order: 0 }];
  db.prepare("INSERT OR REPLACE INTO playlists (id, user_id, workspace_id, name, status, published_snapshot) VALUES ('pl-pai', ?, ?, 'Lobby', 'published', ?)")
    .run(users.admin, WS, JSON.stringify(snap));
  db.prepare("UPDATE devices SET playlist_id = 'pl-pai', playlist_source = 'device' WHERE id = 'dev-pai-a'").run();
  tr.setScreenLanguage(db, { deviceId: 'dev-pai-a', workspaceId: WS, mode: 'fixed', langs: ['fr'] });
  assert.deepEqual(build('dev-pai-a').assignments.map((a) => a.widget_id), [frWidget]);
  tr.setScreenLanguage(db, { deviceId: 'dev-pai-a', workspaceId: WS, mode: 'original', langs: [] });
  assert.deepEqual(build('dev-pai-a').assignments.map((a) => a.widget_id), [srcWidget], 'back to the original');
});

/* ================================================================== logging */

test('⚠️ no prompt, description or sign text is logged or audited', () => {
  const rows = db.prepare("SELECT action, details FROM activity_log WHERE action LIKE 'ai:%'").all();
  assert.ok(rows.length >= 5, 'the actions themselves are audited');
  const blob = JSON.stringify(rows) + '\n' + captured.join('\n');
  for (const secret of ['sourdough', 'Leeds', 'Pain au levain', 'Demandez', 'menu.special', 'sk-cloud-secret']) {
    assert.ok(!blob.toLowerCase().includes(secret.toLowerCase()), `"${secret}" reached a log`);
  }
});
