const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const { accessContext } = require('../lib/tenancy');
const deckLib = require('../lib/slide-deck');

/*
 * Slide decks — the authoring surface for PowerPoint-style slides.
 *
 * ⚠️ EVERYTHING HERE IS AN EDITOR CONCERN. A deck publishes to a playlist of slide widgets, and
 * from that moment the deck row has no part in playback: players, scheduling, groups and the
 * resolver see only the widgets and the playlist. That is deliberate — it is what keeps a new
 * authoring model from becoming a new duty at every reader in the codebase.
 *
 * ⚠️ WHICH MEANS DELETING A DECK MUST NOT BLANK A SCREEN. See DELETE below: the published playlist
 * and its widgets are what somebody's wall is showing, and they outlive the document that made them
 * unless the caller explicitly asks otherwise.
 */

const nowSec = () => Math.floor(Date.now() / 1000);

/** Scope every read and write to the caller's workspace, the way content and devices do. */
function checkDeckAccess(req, res) {
  const deck = db.prepare('SELECT * FROM slide_decks WHERE id = ?').get(req.params.id);
  if (!deck) { res.status(404).json({ error: 'Deck not found' }); return null; }
  const ws = deck.workspace_id ? db.prepare('SELECT * FROM workspaces WHERE id = ?').get(deck.workspace_id) : null;
  const ctx = ws && accessContext(req.user.id, req.user.role, ws);
  if (!ctx) { res.status(403).json({ error: 'Access denied' }); return null; }
  return deck;
}

function parseDoc(deck) {
  try { return JSON.parse(deck.doc || '{"slides":[]}'); } catch (e) { return { slides: [] }; }
}

/** A deck as the editor wants it: the document, plus what publishing it would warn about. */
function present(deck) {
  const doc = deckLib.normalizeDeck(parseDoc(deck));
  return {
    id: deck.id,
    name: deck.name,
    playlist_id: deck.playlist_id,
    created_at: deck.created_at,
    updated_at: deck.updated_at,
    doc,
    warnings: deckLib.deckWarnings(doc),
  };
}

router.get('/', (req, res) => {
  if (!req.workspaceId) return res.json([]);
  const rows = db.prepare(
    'SELECT * FROM slide_decks WHERE workspace_id = ? ORDER BY updated_at DESC').all(req.workspaceId);
  // The list view wants a count and a name, not every element of every slide.
  res.json(rows.map((d) => {
    const doc = deckLib.normalizeDeck(parseDoc(d));
    return {
      id: d.id, name: d.name, playlist_id: d.playlist_id, updated_at: d.updated_at,
      slide_count: doc.slides.length,
      total_sec: doc.slides.reduce((a, s) => a + s.dwell_sec, 0),
    };
  }));
});

router.post('/', (req, res) => {
  if (!req.workspaceId) {
    return res.status(403).json({ error: 'No workspace context. Switch to a workspace before creating a deck.' });
  }
  const name = String((req.body && req.body.name) || '').trim().slice(0, 120);
  if (!name) return res.status(400).json({ error: 'A deck needs a name.' });

  const id = uuidv4();
  const doc = deckLib.normalizeDeck(req.body && req.body.doc);
  const ts = nowSec();
  db.prepare(`INSERT INTO slide_decks (id, workspace_id, user_id, name, doc, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?)`)
    .run(id, req.workspaceId, req.user.id, name, JSON.stringify(doc), ts, ts);
  res.status(201).json(present(db.prepare('SELECT * FROM slide_decks WHERE id = ?').get(id)));
});

router.get('/:id', (req, res) => {
  const deck = checkDeckAccess(req, res);
  if (!deck) return;
  res.json(present(deck));
});

/*
 * Save the document. ⚠️ SAVING IS NOT PUBLISHING, and the split is the point: an operator part-way
 * through a deck has every right to a slide that does not add up yet, and nothing should reach a
 * screen until they say so. Warnings come back on every save so the editor can show the problem
 * while they work rather than refusing the keystroke.
 */
router.put('/:id', (req, res) => {
  const deck = checkDeckAccess(req, res);
  if (!deck) return;

  const name = req.body && req.body.name !== undefined
    ? String(req.body.name).trim().slice(0, 120) : deck.name;
  if (!name) return res.status(400).json({ error: 'A deck needs a name.' });

  const doc = req.body && req.body.doc !== undefined
    ? deckLib.normalizeDeck(req.body.doc) : deckLib.normalizeDeck(parseDoc(deck));

  db.prepare('UPDATE slide_decks SET name = ?, doc = ?, updated_at = ? WHERE id = ?')
    .run(name, JSON.stringify(doc), nowSec(), deck.id);
  res.json(present(db.prepare('SELECT * FROM slide_decks WHERE id = ?').get(deck.id)));
});

/*
 * Publish: one slide widget per page, plus a playlist that orders them.
 *
 * ⚠️ THE RETURNED DOCUMENT IS PERSISTED HERE, not left to the client. Publishing assigns a widget id
 * to every slide that did not have one, and those ids are how the NEXT publish recognises a slide it
 * has already built. Dropping them on the floor would make every republish create a fresh set of
 * widgets and leave the old ones orphaned in the library.
 */
router.post('/:id/publish', (req, res) => {
  const deck = checkDeckAccess(req, res);
  if (!deck) return;

  let out;
  try {
    let priorIds = [];
    try { priorIds = JSON.parse(deck.published_widget_ids || '[]'); } catch (e) { priorIds = []; }
    out = deckLib.publishDeck(db, {
      deck, doc: parseDoc(deck), userId: req.user.id, playlistId: deck.playlist_id,
      publishedWidgetIds: priorIds,
    });
  } catch (e) {
    console.error('[slide-deck] publish failed:', e && e.message);
    return res.status(500).json({ error: 'Could not publish this deck.' });
  }

  /*
   * ⚠️ published_widget_ids IS PERSISTED HERE OR NOT AT ALL. It is the server's own record of what
   * publish created, and the next publish diffs against it to work out what to remove. Losing it
   * means a removed slide's widget is never cleaned up — and, worse, it is the reason the drop set
   * is not read out of the caller's document, where naming a foreign widget id would have deleted
   * somebody else's widget.
   */
  db.prepare('UPDATE slide_decks SET doc = ?, playlist_id = ?, published_widget_ids = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(out.doc), out.playlistId, JSON.stringify(out.publishedWidgetIds), nowSec(), deck.id);

  // ⚠️ Published through the playlist's OWN publish path, not by writing published_snapshot here.
  // That function carries the change-triggered guard which keeps an unchanged resolved list from
  // restarting every screen showing this playlist — the #234 shape, estate-wide.
  try {
    require('./playlists').publishPlaylist(out.playlistId, req);
  } catch (e) {
    console.error('[slide-deck] playlist publish failed:', e && e.message);
    return res.status(500).json({ error: 'The slides were saved but the playlist could not be published.' });
  }

  res.json({
    ...present(db.prepare('SELECT * FROM slide_decks WHERE id = ?').get(deck.id)),
    published: { playlist_id: out.playlistId, slides: out.slideCount, removed: out.removed },
  });
});

/*
 * ⚠️ DELETING THE DOCUMENT DOES NOT TAKE THE SCREENS DOWN WITH IT.
 *
 * By the time a deck has been published, what is on the wall is a playlist of widgets — possibly
 * assigned to devices, possibly on a schedule, possibly inside another playlist. A delete that
 * cascaded into those would turn "remove this draft from my list" into an outage, and the operator
 * would have had no way to know that was the offer.
 *
 * `?with_published=1` is the explicit second act, and it still refuses to remove a widget that
 * something else plays.
 */
router.delete('/:id', (req, res) => {
  const deck = checkDeckAccess(req, res);
  if (!deck) return;

  const alsoPublished = req.query.with_published === '1' || req.query.with_published === 'true';
  let removedWidgets = 0;

  if (alsoPublished && deck.playlist_id) {
    const doc = deckLib.normalizeDeck(parseDoc(deck));
    const tx = db.transaction(() => {
      for (const s of doc.slides) {
        if (!s.widget_id) continue;
        db.prepare('DELETE FROM playlist_items WHERE playlist_id = ? AND widget_id = ?')
          .run(deck.playlist_id, s.widget_id);
        const stillUsed = db.prepare('SELECT COUNT(*) AS n FROM playlist_items WHERE widget_id = ?')
          .get(s.widget_id).n;
        if (!stillUsed) {
          db.prepare("DELETE FROM widgets WHERE id = ? AND widget_type = 'slide'").run(s.widget_id);
          removedWidgets++;
        }
      }
    });
    tx();
  }

  db.prepare('DELETE FROM slide_decks WHERE id = ?').run(deck.id);
  res.json({
    success: true,
    removed_widgets: removedWidgets,
    // Said plainly rather than implied: the playlist is still there and may still be on a screen.
    playlist_kept: !!deck.playlist_id,
  });
});

module.exports = router;
