'use strict';

/*
 * 3.0 Private AI — /api/ai/private (docs/private-ai.md).
 *
 *   status, test, settings     the local / private provider for this workspace (lib/private-ai.js)
 *   allow-host                 ONE private host an operator allows for an organization's AI
 *   policy                     the organization's "only allow private AI"
 *   starter                    "Set up my screens with AI" (lib/ai-starter.js)
 *   translate, translations    auto-translate a deck, reviewed before it reaches a screen
 *   screens                    what language each screen shows (lib/sign-translate.js)
 *
 * Mounted JWT-only with resolveTenancy, before /api/ai, like the hosted router. Every write refuses
 * a view-only member; every read and write is scoped to the caller's workspace or organization.
 *
 * ⚠️ NO PROMPT, DESCRIPTION OR SIGN TEXT IS LOGGED OR AUDITED HERE. Audit rows carry counts, ids,
 * a host name and a model name. That is the promise private AI makes, and the activity log is the
 * place a careless line would break it.
 */

const express = require('express');
const router = express.Router();
// Abuse backstop (lib/backstop-limiter.js): already counted app-wide; here so this router is never unguarded.
router.use(require('../lib/backstop-limiter'));
const { db } = require('../db/database');
const { encrypt } = require('../lib/secretbox');
const { denyReadOnly } = require('../lib/tenancy');
const { canRead, canWrite, canAdmin, isOrgAdmin } = require('../lib/permissions');
const { auditFromReq } = require('../lib/audit');
const { trimTrailing } = require('../lib/trim-trailing');
const privateAi = require('../lib/private-ai');
const starter = require('../lib/ai-starter');
const tr = require('../lib/sign-translate');
const brandKit = require('../lib/brand-kit');
const releasePolicy = require('../lib/release-policy');
const approvals = require('../lib/approvals');

function needWorkspace(req, res) {
  if (!req.workspaceId) { res.status(403).json({ error: 'No workspace context' }); return true; }
  return false;
}
/** Content editors (and admins): what Make a sign and the slide editor require. */
function needEditor(req, res) {
  if (needWorkspace(req, res)) return true;
  if (denyReadOnly(req, res)) return true;
  if (!canWrite(req)) { res.status(403).json({ error: 'Editor access required' }); return true; }
  return false;
}

function cleanUrl(raw) {
  const s = trimTrailing(String(raw || '').trim(), '/');
  if (!s || s.length > 500) return null;
  try {
    const u = new URL(s);
    if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.search || u.hash) return null;
  } catch { return null; }
  return s;
}

/** Tell the screens whose language is set that what they play may have changed. */
function pushScreens(req, deviceIds) {
  try {
    const io = req.app.get('io');
    if (!io || !deviceIds.length) return;
    const { buildPlaylistPayload } = require('../ws/deviceSocket');
    const commandQueue = require('../lib/command-queue');
    for (const id of deviceIds) commandQueue.queueOrEmitPlaylistUpdate(io.of('/device'), id, buildPlaylistPayload);
  } catch (e) { /* the next reconnect or publish delivers it */ }
}
function screensWithLanguage(workspaceId) {
  return db.prepare('SELECT device_id FROM device_languages WHERE workspace_id = ?').all(workspaceId).map((r) => r.device_id);
}

/* ============================================================ provider */

router.get('/status', (req, res) => {
  if (needWorkspace(req, res)) return;
  if (!canRead(req)) return res.status(403).json({ error: 'Workspace access required' });
  const st = privateAi.status(req.workspaceId);
  const out = {
    ...st,
    can_configure: canAdmin(req),
    can_set_policy: isOrgAdmin(req),
    can_allow_hosts: !!req.isPlatformAdmin,
    can_use: canWrite(req) && !(req.workspaceRole === 'workspace_viewer' && !req.actingAs),
  };
  // Host names on the customer's network are for the people who manage AI, not every member.
  if (canAdmin(req)) {
    const row = privateAi.settingsRow(req.workspaceId);
    out.base_url = row && row.provider_kind === 'local' ? row.base_url : '';
    out.image_model = row && row.provider_kind === 'local' ? row.image_model || '' : '';
    out.has_key = !!(row && row.provider_kind === 'local' && row.api_key_enc);
    out.allowed_hosts = privateAi.allowedHosts(req.organizationId);
  }
  res.json(out);
});

/*
 * Test & list models. Says exactly where the host lives and, when it is a private address the
 * outbound rules do not allow, what would allow it — without connecting to it first.
 */
router.post('/test', async (req, res) => {
  if (needWorkspace(req, res)) return;
  if (!canAdmin(req)) return res.status(403).json({ error: 'Workspace admin required' });
  const base = cleanUrl(req.body && req.body.base_url);
  if (!base) return res.status(400).json({ error: 'Enter the server address, starting with http:// or https://', code: 'bad_url' });
  const reach = await privateAi.reachability(req.workspaceId, base);
  if (!reach.host && reach.reason) return res.status(400).json({ error: 'That address is not usable.', code: reach.reason });
  if (reach.reason === 'never') return res.status(400).json({ error: 'That address is never allowed.', code: 'never' });
  if (reach.reason === 'dns') return res.status(400).json({ error: `The name ${reach.host} could not be found from this server.`, code: 'dns', host: reach.host });
  const policyOk = !(privateAi.onlyPrivateForWorkspace(req.workspaceId) && !reach.private);
  const base_info = { host: reach.host, private: !!reach.private, allowed: !!reach.allowed, via: reach.via || null, policy_ok: policyOk };
  if (!reach.allowed) {
    return res.json({ ...base_info, reachable: false, how_to_allow: reach.how_to_allow, can_allow: !!req.isPlatformAdmin });
  }
  const key = (req.body && typeof req.body.api_key === 'string' && req.body.api_key) ? req.body.api_key.slice(0, 500) : null;
  let savedKey = null;
  if (!key) {
    const row = privateAi.settingsRow(req.workspaceId);
    if (row && row.provider_kind === 'local' && row.base_url === base) savedKey = require('../lib/secretbox').decrypt(row.api_key_enc);
  }
  try {
    const list = await privateAi.listModels({ baseUrl: base, apiKey: key || savedKey, privateHosts: privateAi.privateHostsFor(req.workspaceId) });
    res.json({ ...base_info, reachable: true, ...list });
  } catch (e) {
    res.status(400).json({ ...base_info, reachable: false, error: e.message });
  }
});

router.put('/settings', async (req, res) => {
  if (needWorkspace(req, res)) return;
  if (denyReadOnly(req, res)) return;
  if (!canAdmin(req)) return res.status(403).json({ error: 'Workspace admin required' });
  const b = req.body || {};
  const base = cleanUrl(b.base_url);
  const model = String(b.model || '').trim().slice(0, 200);
  if (!base) return res.status(400).json({ error: 'Enter the server address.', code: 'bad_url' });
  if (!model) return res.status(400).json({ error: 'Choose a text model.', code: 'no_model' });
  const reach = await privateAi.reachability(req.workspaceId, base);
  if (!reach.allowed) {
    return res.status(400).json({ error: 'This server may not reach that address yet.', code: 'not_allowed', host: reach.host || null, how_to_allow: reach.how_to_allow || null });
  }
  const pol = await privateAi.policyCheck(req.workspaceId, [base]);
  if (pol) return res.status(pol.status).json({ error: pol.error, code: pol.code });

  const existing = privateAi.settingsRow(req.workspaceId);
  /*
   * ⚠️ A KEY DOES NOT FOLLOW THE ENDPOINT TO A DIFFERENT SERVER. Switching from a cloud provider to
   * a local one without typing a key used to mean the OpenAI key would be sent, as a Bearer token,
   * to whatever box answers on the LAN. Kept only when this is the same local server as before.
   */
  let keyEnc = existing && existing.provider_kind === 'local' && existing.base_url === base ? existing.api_key_enc : null;
  if (typeof b.api_key === 'string' && b.api_key.length) keyEnc = encrypt(b.api_key.slice(0, 500));
  if (b.clear_key) keyEnc = null;

  const imageModel = typeof b.image_model === 'string' ? b.image_model.trim().slice(0, 200) : null;
  // An image model on the same server: the OpenAI-compatible images endpoint, using the same key.
  let image = { base: existing ? existing.image_base_url : null, model: existing ? existing.image_model : null, provider: existing ? existing.image_provider : null, keyEnc: existing ? existing.image_api_key_enc : null };
  if (imageModel) image = { base, model: imageModel, provider: 'openai', keyEnc };
  else if (b.clear_image || imageModel === '') image = { base: null, model: null, provider: null, keyEnc: null };
  if (image.base && image.base !== base) {
    const pol2 = await privateAi.policyCheck(req.workspaceId, [image.base]);
    if (pol2) image = { base: null, model: null, provider: null, keyEnc: null };   // a cloud image endpoint cannot stay under the policy
  }

  db.prepare(`
    INSERT INTO ai_settings (workspace_id, base_url, api_key_enc, model, image_base_url, image_model, image_provider, image_api_key_enc, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'))
    ON CONFLICT(workspace_id) DO UPDATE SET base_url=excluded.base_url, api_key_enc=excluded.api_key_enc,
      model=excluded.model, image_base_url=excluded.image_base_url, image_model=excluded.image_model,
      image_provider=excluded.image_provider, image_api_key_enc=excluded.image_api_key_enc, updated_at=excluded.updated_at
  `).run(req.workspaceId, base, keyEnc, model, image.base, image.model, image.provider, image.keyEnc);
  db.prepare("UPDATE ai_settings SET provider_kind = 'local', endpoint_private = ? WHERE workspace_id = ?")
    .run(reach.private ? 1 : 0, req.workspaceId);
  auditFromReq(req, 'ai:private_settings', { workspace_id: req.workspaceId, host: reach.host, model, image_model: image.model || null, private: !!reach.private });
  res.json({ ok: true, ...privateAi.status(req.workspaceId) });
});

/* ============================================================ allow one host */

router.get('/allow-hosts', (req, res) => {
  if (needWorkspace(req, res)) return;
  if (!canAdmin(req)) return res.status(403).json({ error: 'Admin required' });
  res.json({ hosts: privateAi.allowedHosts(req.organizationId), can_allow: !!req.isPlatformAdmin });
});

/*
 * ⚠️ PLATFORM ADMINISTRATORS ONLY. Letting this server connect to an address on a private network
 * is a decision about the SERVER's network, not the customer's: on a shared instance an org admin
 * who could allow 10.0.0.5 could read whatever answers there. The operator decides, one exact host
 * at a time, for one organization.
 */
router.post('/allow-host', (req, res) => {
  if (needWorkspace(req, res)) return;
  if (!req.isPlatformAdmin) return res.status(403).json({ error: 'Only a server administrator can allow a private address.', code: 'platform_admin_required' });
  if (!req.organizationId) return res.status(403).json({ error: 'No organization context' });
  try {
    const host = privateAi.addAllowedHost(req.organizationId, req.body && req.body.host, req.user.id);
    auditFromReq(req, 'ai:private_host_allow', { workspace_id: req.workspaceId, org_id: req.organizationId, host });
    res.json({ ok: true, host, hosts: privateAi.allowedHosts(req.organizationId) });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

router.delete('/allow-host/:host', (req, res) => {
  if (needWorkspace(req, res)) return;
  if (!req.isPlatformAdmin) return res.status(403).json({ error: 'Only a server administrator can change this.', code: 'platform_admin_required' });
  const removed = privateAi.removeAllowedHost(req.organizationId, req.params.host);
  if (removed) auditFromReq(req, 'ai:private_host_remove', { workspace_id: req.workspaceId, org_id: req.organizationId, host: privateAi.hostKey(req.params.host) });
  res.json({ ok: true, removed, hosts: privateAi.allowedHosts(req.organizationId) });
});

/* ============================================================ org policy */

router.put('/policy', (req, res) => {
  if (needWorkspace(req, res)) return;
  if (denyReadOnly(req, res)) return;
  if (!isOrgAdmin(req) || !req.organizationId) return res.status(403).json({ error: 'Organization admin required' });
  const on = !!(req.body && req.body.only_private === true);
  privateAi.setOnlyPrivate(req.organizationId, on, req.user.id);
  auditFromReq(req, 'ai:policy', { workspace_id: req.workspaceId, org_id: req.organizationId, only_private: on });
  res.json({ ok: true, only_private: on });
});

/* ============================================================ starter set */

router.post('/starter', async (req, res) => {
  if (needEditor(req, res)) return;
  const description = typeof (req.body && req.body.description) === 'string' ? req.body.description : '';
  const brand = brandKit.getKit(db, req.workspaceId);
  const out = await starter.suggest({
    description, brand,
    ask: (system, user) => privateAi.chatJson({ workspaceId: req.workspaceId, system, user, temperature: 0.4 }),
  });
  if (out.error) return res.status(out.status || 400).json({ error: out.error, code: out.code || null });
  auditFromReq(req, 'ai:starter_set', { workspace_id: req.workspaceId, count: out.proposals.length, retried: !!out.retried, templates: out.proposals.map((p) => p.template) });
  res.json({ proposals: out.proposals, retried: !!out.retried, private: privateAi.status(req.workspaceId).private });
});

/* ============================================================ translations */

function deckOf(req, id) {
  return db.prepare('SELECT * FROM slide_decks WHERE id = ? AND workspace_id = ?').get(String(id || ''), req.workspaceId) || null;
}
function translationOf(req, id) {
  return db.prepare('SELECT * FROM sign_translations WHERE id = ? AND workspace_id = ?').get(String(id || ''), req.workspaceId) || null;
}

router.get('/translations', (req, res) => {
  if (needWorkspace(req, res)) return;
  if (!canRead(req)) return res.status(403).json({ error: 'Workspace access required' });
  const deckId = req.query.deck_id ? String(req.query.deck_id) : null;
  const rows = deckId
    ? db.prepare('SELECT * FROM sign_translations WHERE workspace_id = ? AND source_deck_id = ? ORDER BY lang').all(req.workspaceId, deckId)
    : db.prepare('SELECT * FROM sign_translations WHERE workspace_id = ? ORDER BY source_deck_id, lang').all(req.workspaceId);
  const decks = new Map();
  const out = rows.map((r) => {
    if (!decks.has(r.source_deck_id)) decks.set(r.source_deck_id, deckOf(req, r.source_deck_id));
    const d = decks.get(r.source_deck_id);
    const p = tr.present(db, r, d);
    if (!deckId) delete p.strings;   // the list is a summary; a review loads one deck
    return { ...p, deck_name: d ? d.name : null };
  });
  res.json({ translations: out });
});

router.post('/translate', async (req, res) => {
  if (needEditor(req, res)) return;
  const deck = deckOf(req, req.body && req.body.deck_id);
  if (!deck) return res.status(404).json({ error: 'Deck not found' });
  const langs = [...new Set((Array.isArray(req.body && req.body.langs) ? req.body.langs : []).map(tr.normLang).filter(Boolean))];
  if (!langs.length) return res.status(400).json({ error: 'Choose at least one language.', code: 'no_langs' });
  if (langs.length > tr.MAX_LANGS) return res.status(400).json({ error: `At most ${tr.MAX_LANGS} languages at a time.`, code: 'too_many_langs' });
  const srcDoc = tr.parseDoc(deck.doc);
  const strings = tr.collectStrings(srcDoc);
  if (!strings.length) return res.status(400).json({ error: 'This deck has no text to translate.', code: 'no_text' });
  const sources = [...new Set(strings.map((s) => s.source))];
  const ask = (system, user) => privateAi.chatJson({ workspaceId: req.workspaceId, system, user, temperature: 0.1 });

  const results = [];
  for (const lang of langs) {
    const r = await tr.translateStrings({ sources, lang, ask });
    if (r.error) {
      if (!results.length) return res.status(r.status || 400).json({ error: r.error, code: r.code || null });
      results.push({ lang, error: r.error });
      continue;
    }
    const { doc, notes } = tr.variantDoc(srcDoc, strings, r.map);
    const id = tr.saveDraft(db, { workspaceId: req.workspaceId, deck, lang, doc, notes, userId: req.user.id });
    results.push(tr.present(db, translationOf(req, id), deck));
  }
  auditFromReq(req, 'ai:translate', { workspace_id: req.workspaceId, deck_id: deck.id, langs, strings: sources.length });
  res.json({ translations: results });
});

router.put('/translations/:id', (req, res) => {
  if (needEditor(req, res)) return;
  const row = translationOf(req, req.params.id);
  if (!row) return res.status(404).json({ error: 'Translation not found' });
  const deck = deckOf(req, row.source_deck_id);
  if (!deck) return res.status(404).json({ error: 'The original deck is gone.' });
  const { doc, notes, errors } = tr.applyEdits(tr.parseDoc(deck.doc), row, req.body && req.body.strings);
  if (errors.length) return res.status(400).json({ error: 'A translation lost a placeholder from the original. Put it back.', code: 'placeholder_lost', errors });
  // An edit is reviewed again before it reaches a screen; screens keep the last approved words until then.
  db.prepare("UPDATE sign_translations SET doc = ?, notes = ?, status = 'draft', updated_at = strftime('%s','now') WHERE id = ?")
    .run(JSON.stringify(doc), JSON.stringify(notes), row.id);
  auditFromReq(req, 'ai:translation_edit', { workspace_id: req.workspaceId, translation_id: row.id, lang: row.lang });
  res.json(tr.present(db, translationOf(req, row.id), deck));
});

router.post('/translations/:id/approve', (req, res) => {
  if (needEditor(req, res)) return;
  const row = translationOf(req, req.params.id);
  if (!row) return res.status(404).json({ error: 'Translation not found' });
  const deck = deckOf(req, row.source_deck_id);
  if (!deck) return res.status(404).json({ error: 'The original deck is gone.' });
  /*
   * ⚠️ A WORKSPACE THAT REVIEWS CHANGES REVIEWS THESE TOO. Approving a translation changes what a
   * screen set to that language shows, without a playlist publish — so where review is required,
   * only a reviewer or an admin may do it, exactly the people who could approve the publish.
   */
  if (releasePolicy.approvalRequired(db, req.workspaceId) && !canAdmin(req) && !approvals.isReviewer(db, req.workspaceId, req.user.id)) {
    return res.status(403).json({ error: 'This workspace reviews changes: a reviewer or admin approves translations.', code: 'review_required' });
  }
  const map = tr.approve(db, { row, srcDeck: deck, userId: req.user.id });
  auditFromReq(req, 'ai:translation_approve', { workspace_id: req.workspaceId, translation_id: row.id, deck_id: deck.id, lang: row.lang, widgets: Object.keys(map).length });
  pushScreens(req, screensWithLanguage(req.workspaceId));
  res.json(tr.present(db, translationOf(req, row.id), deck));
});

router.delete('/translations/:id', (req, res) => {
  if (needEditor(req, res)) return;
  const row = translationOf(req, req.params.id);
  if (!row) return res.status(404).json({ error: 'Translation not found' });
  tr.remove(db, row);
  auditFromReq(req, 'ai:translation_delete', { workspace_id: req.workspaceId, translation_id: row.id, lang: row.lang });
  pushScreens(req, screensWithLanguage(req.workspaceId));
  res.json({ ok: true });
});

/* ============================================================ screens */

router.get('/screens', (req, res) => {
  if (needWorkspace(req, res)) return;
  if (!canRead(req)) return res.status(403).json({ error: 'Workspace access required' });
  const devices = db.prepare('SELECT id, name FROM devices WHERE workspace_id = ? ORDER BY name').all(req.workspaceId);
  const langs = db.prepare("SELECT DISTINCT lang FROM sign_translations WHERE workspace_id = ? AND widget_map != '{}' ORDER BY lang").all(req.workspaceId).map((r) => r.lang);
  res.json({
    languages: langs,
    screens: devices.map((d) => {
      const pref = tr.screenLanguage(db, d.id, req.workspaceId);
      return { id: d.id, name: d.name, mode: pref ? pref.mode : 'original', langs: pref ? pref.langs : [] };
    }),
  });
});

router.put('/screens/:deviceId', (req, res) => {
  if (needEditor(req, res)) return;
  const dev = db.prepare('SELECT id FROM devices WHERE id = ? AND workspace_id = ?').get(String(req.params.deviceId), req.workspaceId);
  if (!dev) return res.status(404).json({ error: 'Screen not found' });
  const mode = String(req.body && req.body.mode || 'original');
  if (!['original', 'fixed', 'rotate'].includes(mode)) return res.status(400).json({ error: 'Unknown language mode', code: 'bad_mode' });
  const langs = [...new Set((Array.isArray(req.body && req.body.langs) ? req.body.langs : []).map(tr.normLang).filter(Boolean))].slice(0, tr.MAX_LANGS);
  if (mode !== 'original' && !langs.length) return res.status(400).json({ error: 'Choose a language.', code: 'no_langs' });
  const pref = tr.setScreenLanguage(db, { deviceId: dev.id, workspaceId: req.workspaceId, mode, langs: mode === 'fixed' ? langs.slice(0, 1) : langs });
  auditFromReq(req, 'ai:screen_language', { workspace_id: req.workspaceId, device_id: dev.id, mode, langs: pref ? pref.langs : [] });
  pushScreens(req, [dev.id]);
  res.json({ id: dev.id, mode: pref ? pref.mode : 'original', langs: pref ? pref.langs : [] });
});

module.exports = router;
