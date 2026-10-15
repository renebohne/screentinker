const express = require('express');
const router = express.Router();
// Abuse backstop (lib/backstop-limiter.js): already counted app-wide; here so this router is never unguarded.
router.use(require('../lib/backstop-limiter'));
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const { denyReadOnly } = require('../lib/tenancy');
const { auditFromReq } = require('../lib/audit');
const signs = require('../lib/sign-templates');
const brandKit = require('../lib/brand-kit');
const deckLib = require('../lib/slide-deck');

/*
 * Make a sign: built-in templates → a slide deck and its widget, ready for a screen.
 *
 * ⚠️ WHAT "CREATE" DOES, AND WHAT IT DELIBERATELY DOES NOT. Creating a sign writes two things in the
 * caller's workspace: a slide DECK (the editable source — it opens in Advanced → Slides like any
 * other) and the deck's slide WIDGET, made now rather than at a deck publish so the sign can be put
 * on a screen in the same minute. It does NOT put anything on a screen and does NOT publish
 * anything: the client adds the widget to the chosen screens' playlists and publishes those through
 * the normal endpoints (components/release.js publishOrSubmit). So the release gate, review, plan
 * limits and corporate locks all apply exactly as they do to any other change — a workspace that
 * reviews changes gets "sent for review", and a fresh widget no published playlist references
 * reaches no screen on its own.
 *
 * ⚠️ AND NOT A DECK PUBLISH EITHER. Publishing a deck would also make the deck's own playlist; a sign
 * does not need one, and a second "Sign name" playlist next to each screen's own would be clutter
 * nobody asked for. The widget is recorded on the deck (slide.widget_id + published_widget_ids)
 * exactly as a publish records it, so the day somebody edits the sign in Slides and publishes, that
 * publish updates THIS widget in place — and every screen showing the sign follows.
 */

const nowSec = () => Math.floor(Date.now() / 1000);
const MAX_PREVIEWS = signs.TEMPLATES.length * 2;

function resolverFor(workspaceId) {
  return require('./widgets').imageResolverFor({ workspace_id: workspaceId });
}

/** The templates and their fields, plus this workspace's brand kit to pre-fill them with. */
router.get('/templates', (req, res) => {
  if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context' });
  res.json({
    templates: signs.catalogue(),
    aspects: Object.keys(signs.ASPECTS),
    brand: brandKit.getKit(db, req.workspaceId),
  });
});

/*
 * Previews: the sign rendered by the SAME renderer a player uses, returned as a document string the
 * dashboard puts in a sandboxed srcdoc frame. Either one sign ({template, values, aspect}) or the
 * whole gallery at once ({items: [...]}), so the template grid is one round trip rather than fourteen.
 *
 * ⚠️ Read-only, so a view-only member may preview; it writes nothing and renders only from what was
 * posted plus this workspace's own brand kit and images.
 */
router.post('/preview', (req, res) => {
  if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context' });
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const brand = brandKit.getKit(db, req.workspaceId);
  const resolveImage = resolverFor(req.workspaceId);
  const one = (it) => {
    const tpl = it && signs.getTemplate(it.template);
    if (!tpl) return null;
    const samples = it.values == null;
    return signs.renderSign(tpl.id, it.values || {}, { aspect: it.aspect || body.aspect, brand, samples, resolveImage });
  };
  if (Array.isArray(body.items)) {
    const previews = {};
    for (const it of body.items.slice(0, MAX_PREVIEWS)) {
      const html = one(it);
      if (html) previews[`${it.template}:${it.aspect || body.aspect || '16:9'}`] = html;
    }
    return res.json({ previews });
  }
  const html = one(body);
  if (!html) return res.status(400).json({ error: 'Unknown template' });
  const tpl = signs.getTemplate(body.template);
  const { errors } = signs.validateValues(tpl, body.values || {}, { brand });
  res.json({ html, errors });
});

/** Create the sign: a deck + its slide widget. Nothing is shown anywhere until the client publishes. */
router.post('/', (req, res) => {
  if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context. Switch to a workspace first.' });
  if (denyReadOnly(req, res)) return;
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const tpl = signs.getTemplate(body.template);
  if (!tpl) return res.status(400).json({ error: 'Unknown template' });

  const brand = brandKit.getKit(db, req.workspaceId);
  const built = signs.buildSign(tpl.id, body.values, { aspect: body.aspect, brand });
  if (built.errors.length) {
    return res.status(400).json({ error: 'Some of the sign\'s fields need attention.', errors: built.errors });
  }

  const name = String(body.name || built.name || tpl.name).trim().slice(0, 120) || tpl.name;
  const deckId = uuidv4();
  const widgetId = uuidv4();
  const ts = nowSec();
  const doc = deckLib.normalizeDeck({ aspect: built.aspect, slides: [{ ...built.slide, name }] });
  const slide = doc.slides[0];
  slide.widget_id = widgetId;

  db.transaction(() => {
    db.prepare(`INSERT INTO widgets (id, user_id, workspace_id, widget_type, name, config, created_at, updated_at)
                VALUES (?,?,?,'slide',?,?,?,?)`)
      .run(widgetId, req.user.id, req.workspaceId, name.slice(0, 200), deckLib.slideWidgetConfig(doc, slide), ts, ts);
    db.prepare(`INSERT INTO slide_decks (id, workspace_id, user_id, name, doc, published_widget_ids, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run(deckId, req.workspaceId, req.user.id, name, JSON.stringify(doc), JSON.stringify([widgetId]), ts, ts);
  })();

  auditFromReq(req, 'sign:create', { workspace_id: req.workspaceId, template: tpl.id, deck_id: deckId, widget_id: widgetId, aspect: built.aspect });
  res.status(201).json({
    deck_id: deckId, widget_id: widgetId, name, aspect: built.aspect, dwell_sec: slide.dwell_sec, template: tpl.id,
  });
});

module.exports = router;
