'use strict';

/*
 * Triggers — externally-fired interrupt content. See docs/triggers-design.md.
 *
 * This router is the DEFINITION surface only: create, edit, assign. ⚠️ Nothing here is on the fire
 * path. A trigger fires on the device, against its own synced copy, with the WAN down — that is the
 * entire feature, and any lookup that reached back here would defeat it.
 *
 * Scoping is by req.workspaceId on every query, which is what makes a token bound to workspace A
 * unable to see or address a trigger in workspace B. Same guarantee, same mechanism, as pip.js.
 */
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const { requireScope } = require('../middleware/apiToken');
const { accessContext } = require('../lib/tenancy');

/*
 * A trigger changes what appears on a screen, so it is a fleet-affecting write and carries the same
 * pairing pip.js uses: requireScope('full') gates API TOKENS (and is a deliberate pass-through for
 * JWT sessions), and this adds the role check that scope alone does not give a dashboard session.
 */
function requireFleetWrite(req, res, next) {
  if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context' });
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.workspaceId);
  const ctx = ws && accessContext(req.user.id, req.user.role, ws);
  if (!ctx) return res.status(403).json({ error: 'Access denied' });
  if (!ctx.actingAs && ctx.workspaceRole === 'workspace_viewer') {
    return res.status(403).json({ error: 'Read-only access' });
  }
  next();
}

const MODES = ['once', 'until_cleared'];
// POSITIONS is gone: geometry is reserved (see validate). The `position` column is still written
// as 'center' so existing rows keep a consistent value, but nothing reads it.
const TARGET_KINDS = ['playlist'];   // 'url' is designed for and deliberately not built yet

/*
 * ⚠️ THE TOKEN CHARSET IS A WIRE-FORMAT CONSTRAINT, NOT A STYLE PREFERENCE.
 *
 * The UDP payload is `ST1 <secret> <token>` — space-separated, one line, because that is what a
 * Crestron SendString or a PLC socket block can actually emit. A token containing a space would be
 * unparseable on arrival, and one containing a newline would let a single datagram look like two
 * messages. Rejecting them here is the only place that can be enforced before the field is saved;
 * on the wire it is already too late to give anyone a useful error.
 */
const TOKEN_RE = /^[\x21-\x7E]{1,64}$/;      // printable ASCII, no space, 1-64
const TOKEN_HINT = 'tokens must be 1-64 printable ASCII characters with no spaces — they travel in a ' +
                   'space-separated single-line datagram';

function intInRange(v, def, lo, hi) {
  if (v === undefined || v === null || v === '') return { ok: true, val: def };
  const n = Number(v);
  if (!Number.isFinite(n)) return { ok: false };
  const r = Math.round(n);
  if (r < lo || r > hi) return { ok: false };
  return { ok: true, val: r };
}

/** Shape a row for the API. Assignments come along because a trigger without them does nothing. */
function withAssignments(row) {
  if (!row) return row;
  const assignments = db.prepare(
    'SELECT target_type, target_id FROM trigger_assignments WHERE trigger_id = ?').all(row.id);
  return { ...row, assignments };
}

function validate(req, b, { id = null } = {}) {
  if (!b.name || !String(b.name).trim()) return 'name required';

  if (!TOKEN_RE.test(String(b.match_token || ''))) return `invalid match_token — ${TOKEN_HINT}`;
  if (b.clear_token != null && b.clear_token !== '' && !TOKEN_RE.test(String(b.clear_token))) {
    return `invalid clear_token — ${TOKEN_HINT}`;
  }
  if (b.clear_token && String(b.clear_token) === String(b.match_token)) {
    return 'clear_token and match_token must differ, or a fire and a clear are the same message';
  }

  if (!MODES.includes(b.mode)) return `invalid mode, use one of: ${MODES.join(', ')}`;

  const kind = b.target_kind == null || b.target_kind === '' ? 'playlist' : String(b.target_kind);
  if (!TARGET_KINDS.includes(kind)) {
    return `invalid target_kind — v1 supports ${TARGET_KINDS.join(', ')} ('url' is designed but not built)`;
  }
  /*
   * ⚠️ The playlist must exist IN THIS WORKSPACE. Accepting a bare id would let a caller point a
   * trigger at another tenant's playlist and have the device pin and display it — the assignment
   * check on the device would never catch it, because by then it is just a playlist id.
   */
  const pl = db.prepare('SELECT id, published_snapshot FROM playlists WHERE id = ? AND workspace_id = ?')
    .get(String(b.target_ref || ''), req.workspaceId);
  if (!pl) return 'target_ref must be a playlist in this workspace';

  /*
   * ⚠️ THE TARGET MUST BE PLAYABLE OFFLINE, which is a stronger claim than "the target is a
   * playlist" and is the one that actually matters.
   *
   * The reason this feature targets a playlist rather than a URL (§1) is that playlist items are
   * library content and therefore PINNABLE. That reasoning has a hole: requestOfflineCache pins
   * `it.filepath && !it.remote_url`, so a playlist item carrying a remote_url is never pinned, and
   * a YouTube item cannot be pinned at all. Such a trigger passes every structural check and still
   * fires against nothing on exactly the day the WAN is down — the failure the playlist rule was
   * written to prevent, arriving through the front door.
   *
   * Caught at SAVE time, because the alternative is catching it during an alarm. YouTube is doubly
   * disqualified: createYoutubeEmbed is a singleton shared with the base playlist, so a YouTube
   * item in a trigger destroys the base player outright (the player drops them defensively for
   * definitions already cached in the field).
   */
  /*
   * ⚠️ FAIL CLOSED. This used to be `if (pl.published_snapshot) { … }`, so a playlist that had
   * never been published skipped the whole check and saved with a 200 — and deviceSocket.js uses
   * the same guard, so such a trigger syncs with `items: []` and renders nothing, forever,
   * silently. A green save on a trigger that can never fire is the worst outcome available here.
   */
  if (!pl.published_snapshot) {
    return 'that playlist has never been published — publish it first, or the trigger has nothing to render';
  }
  {
    let items;
    try { items = JSON.parse(pl.published_snapshot); } catch (e) { items = null; }
    // A non-array parses fine and then throws on for..of — which, with no error middleware, is a
    // 500 rather than a 400. Checked rather than caught.
    if (!Array.isArray(items)) return "that playlist's published snapshot is unreadable — republish it";
    if (!items.length) return 'that playlist is empty — the trigger would fire against nothing';
    const unpinnable = [];
    for (const it of items) {
      if (!it) continue;
      const label = it.filename || it.title || it.content_id || 'an item';
      /*
       * ⚠️ THE RULE IS "EXACTLY WHAT requestOfflineCache PINS", not a denylist of known-bad types.
       * That function keeps `it.filepath && !it.remote_url` (server/player/index.html), so the
       * inverse is the honest test — and it catches the two shapes a hand-written denylist missed:
       *
       *   • WIDGETS. A widget snapshot item has widget_id set and filepath/remote_url/mime_type
       *     all NULL, so it matched neither branch. It is fetched LIVE from serverUrl at render
       *     time, and sw.js documents that it cannot be service-worker cached at all — the
       *     sandboxed iframe is an opaque origin, so the worker never sees its request. When that
       *     fetch fails the worker serves a BLACK PAGE. An "Evacuation — proceed to Exit B" HTML
       *     widget is the most natural thing an operator would build, and it would have produced a
       *     fullscreen black box during a fire alarm with the WAN down.
       *   • DANGLING CONTENT. A content row deleted after publish leaves the item in the snapshot
       *     with every joined column NULL — no filepath, not pinnable, previously accepted.
       */
      if (it.mime_type === 'video/youtube' || it.youtube_id) unpinnable.push(`${label} (YouTube)`);
      else if (it.remote_url) unpinnable.push(`${label} (remote URL)`);
      else if (it.widget_id) unpinnable.push(`${label} (widget — re-rendered from the server on every play)`);
      else if (!it.filepath) unpinnable.push(`${label} (no local file — deleted from the library?)`);
    }
    if (unpinnable.length) {
      return `that playlist cannot be held on the device for offline playback: `
        + `${unpinnable.slice(0, 3).join(', ')}${unpinnable.length > 3 ? `, +${unpinnable.length - 3} more` : ''}. `
        + 'A trigger must fire with the network down, so its playlist may only contain uploaded '
        + 'media. See docs/triggers-design.md §1.';
    }
  }

  /*
   * ⚠️ GEOMETRY IS RESERVED, and saying so is the point.
   *
   * These five were copied from the PiP contract and never wired to anything: the renderer
   * discards them (a trigger is always fullscreen and opaque), the shared cross-platform contract
   * omits them, and they are no longer projected to devices. Accepting them with a 200 tells an
   * API client the overlay was positioned when it was not — a lie that only surfaces during an
   * emergency. A 400 naming the reason is worth more than a 200 that is wrong.
   *
   * The columns remain (SQLite drops need a table rebuild, and this schema treats unused columns
   * as the no-migration hook). If a non-fullscreen mode is wanted, add ONE semantic field
   * (takeover | banner) rather than resurrecting five raw CSS primitives.
   */
  const geo = ['width', 'height', 'opacity', 'border_radius']
    .filter((k) => b[k] != null && b[k] !== '');
  if (b.position != null && b.position !== '' && b.position !== 'center') geo.unshift('position');
  if (geo.length) {
    return `${geo.join(', ')} ${geo.length > 1 ? 'are' : 'is'} reserved — a trigger renders `
      + 'fullscreen; see docs/triggers-design.md §4';
  }

  if (!intInRange(b.max_duration_sec, 0, 0, 86400).ok) return 'max_duration_sec must be 0-86400 (0 = no cap)';
  if (!intInRange(b.priority, 0, -1000, 1000).ok) return 'priority must be -1000..1000';

  // lease_sec is until_cleared-only: on a `once` trigger there is nothing to renew, and accepting it
  // would silently store a field that never applies.
  if (b.lease_sec != null && b.lease_sec !== '') {
    if (b.mode !== 'until_cleared') return 'lease_sec applies to until_cleared triggers only';
    if (!intInRange(b.lease_sec, 0, 5, 86400).ok) return 'lease_sec must be 5-86400 seconds';
  }

  /*
   * ⚠️ FIRE AND CLEAR TOKENS SHARE ONE NAMESPACE, so uniqueness has to span both columns.
   *
   * evaluate() walks the device's triggers in query order and, per trigger, tests match_token and
   * then clear_token. So if trigger A's clear_token equals trigger B's match_token, the token
   * resolves to whichever row the SELECT happened to return first — and the losing case is the bad
   * one: an emergency trigger becomes silently UNFIRABLE because an unrelated trigger's clear
   * shadows it. Nothing logs, because from the resolver's point of view the token matched.
   *
   * The unique index only covers (workspace_id, match_token), and an index error would surface as
   * a 500 rather than something an operator can act on, so this is checked here and named.
   */
  const tokens = [String(b.match_token)];
  if (b.clear_token) tokens.push(String(b.clear_token));
  const rows = id
    ? db.prepare('SELECT match_token, clear_token FROM triggers WHERE workspace_id = ? AND id != ?')
      .all(req.workspaceId, id)
    : db.prepare('SELECT match_token, clear_token FROM triggers WHERE workspace_id = ?')
      .all(req.workspaceId);
  const taken = new Set();
  for (const r of rows) {
    if (r.match_token) taken.add(r.match_token);
    if (r.clear_token) taken.add(r.clear_token);
  }
  for (const tok of tokens) {
    if (taken.has(tok)) {
      return `"${tok}" is already used as a fire or clear token by another trigger in this `
        + 'workspace — fire and clear tokens share one namespace, and a duplicate would resolve '
        + 'to whichever trigger the database returned first';
    }
  }

  return null;
}

function columnsFrom(b) {
  return {
    name: String(b.name).trim().slice(0, 200),
    match_token: String(b.match_token),
    clear_token: b.clear_token ? String(b.clear_token) : null,
    source_http: b.source_http === false || b.source_http === 0 ? 0 : 1,
    source_udp: b.source_udp === true || b.source_udp === 1 ? 1 : 0,
    target_kind: b.target_kind || 'playlist',
    target_ref: String(b.target_ref),
    position: b.position || 'center',
    width: intInRange(b.width, null, 40, 3840).val,
    height: intInRange(b.height, null, 40, 3840).val,
    opacity: b.opacity == null || b.opacity === '' ? null : Math.max(0, Math.min(1, Number(b.opacity))),
    border_radius: intInRange(b.border_radius, null, 0, 512).val,
    mode: b.mode,
    max_duration_sec: intInRange(b.max_duration_sec, 0, 0, 86400).val,
    lease_sec: b.mode === 'until_cleared' && b.lease_sec != null && b.lease_sec !== ''
      ? intInRange(b.lease_sec, null, 5, 86400).val : null,
    priority: intInRange(b.priority, 0, -1000, 1000).val,
    enabled: b.enabled === false || b.enabled === 0 ? 0 : 1,
  };
}

/** Replace a trigger's assignments, validating every target is in this workspace. */
function setAssignments(req, triggerId, assignments) {
  if (!Array.isArray(assignments)) return null;
  const rows = [];
  for (const a of assignments) {
    const type = a && a.target_type;
    const tid = a && String(a.target_id || '');
    if (type !== 'device' && type !== 'group') return `invalid target_type: ${type}`;
    const found = type === 'device'
      ? db.prepare('SELECT id FROM devices WHERE id = ? AND workspace_id = ?').get(tid, req.workspaceId)
      : db.prepare('SELECT id FROM device_groups WHERE id = ? AND workspace_id = ?').get(tid, req.workspaceId);
    if (!found) return `${type} ${tid} not found in this workspace`;
    rows.push({ type, tid });
  }
  db.prepare('DELETE FROM trigger_assignments WHERE trigger_id = ?').run(triggerId);
  const ins = db.prepare(
    'INSERT OR IGNORE INTO trigger_assignments (trigger_id, target_type, target_id) VALUES (?, ?, ?)');
  for (const r of rows) ins.run(triggerId, r.type, r.tid);
  return null;
}

router.get('/', (req, res) => {
  if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context' });
  const rows = db.prepare('SELECT * FROM triggers WHERE workspace_id = ? ORDER BY priority DESC, name')
    .all(req.workspaceId);
  res.json({ triggers: rows.map(withAssignments) });
});

router.get('/:id', (req, res) => {
  if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context' });
  const row = db.prepare('SELECT * FROM triggers WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'trigger not found' });
  res.json(withAssignments(row));
});

/**
 * Push the new definitions AND their media to every device this trigger touches, now.
 *
 * ⚠️ THIS IS THE HALF THAT MAKES THE OFFLINE GUARANTEE TRUE. A trigger's whole point is that it
 * fires with the WAN down, which requires the device to be holding both the definition and the
 * target playlist's content BEFORE anything goes wrong. Without a push, none of that happens until
 * the panel next reconnects — for a screen that has been up for weeks, effectively never. The
 * definition sits in the database looking configured, the media is not pinned, and the first time
 * anyone learns otherwise is when an alarm fires against nothing.
 *
 * The payload the device receives carries `triggers` with their playlists resolved inline, and the
 * player's own handler re-pins on a trigger-set change — so one playlist-update does both jobs.
 *
 * `before` lets a delete/reassign reach the devices that are LOSING the trigger as well as the
 * ones gaining it; a device dropped from the assignment list still needs to be told, or it keeps
 * a definition nobody can see in the dashboard.
 */
function pushTrigger(req, triggerId, before) {
  try {
    const io = req.app && req.app.get('io');
    if (!io) return;
    const { buildPlaylistPayload } = require('../ws/deviceSocket');
    const commandQueue = require('../lib/command-queue');
    const { devicesForTrigger } = require('../lib/device-triggers');
    const ns = io.of('/device');
    const ids = new Set(before || []);
    for (const id of devicesForTrigger(db, triggerId)) ids.add(id);
    for (const id of ids) commandQueue.queueOrEmitPlaylistUpdate(ns, id, buildPlaylistPayload);
    if (ids.size) console.log(`[trigger] pushed ${triggerId} to ${ids.size} device(s)`);
  } catch (e) { console.warn(`[trigger] push failed: ${e && e.message}`); }
}

router.post('/', requireScope('full'), requireFleetWrite, (req, res) => {
  const b = req.body || {};
  const bad = validate(req, b);
  if (bad) return res.status(400).json({ error: bad });

  const id = uuidv4();
  const c = columnsFrom(b);
  db.prepare(`INSERT INTO triggers
      (id, workspace_id, name, match_token, clear_token, source_http, source_udp,
       target_kind, target_ref, position, width, height, opacity, border_radius,
       mode, max_duration_sec, lease_sec, priority, enabled)
      VALUES (@id, @workspace_id, @name, @match_token, @clear_token, @source_http, @source_udp,
              @target_kind, @target_ref, @position, @width, @height, @opacity, @border_radius,
              @mode, @max_duration_sec, @lease_sec, @priority, @enabled)`)
    .run({ id, workspace_id: req.workspaceId, ...c });

  const aErr = setAssignments(req, id, b.assignments);
  if (aErr) { db.prepare('DELETE FROM triggers WHERE id = ?').run(id); return res.status(400).json({ error: aErr }); }

  console.log(`[trigger] created ${id} "${c.name}" token=${c.match_token} mode=${c.mode}`);
  pushTrigger(req, id);
  res.json(withAssignments(db.prepare('SELECT * FROM triggers WHERE id = ?').get(id)));
});

router.put('/:id', requireScope('full'), requireFleetWrite, (req, res) => {
  const existing = db.prepare('SELECT * FROM triggers WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.workspaceId);
  if (!existing) return res.status(404).json({ error: 'trigger not found' });

  const b = req.body || {};
  const bad = validate(req, b, { id: existing.id });
  if (bad) return res.status(400).json({ error: bad });

  // Captured before the assignment rewrite, so a device REMOVED from the list is still told —
  // otherwise it holds a definition that no longer appears anywhere in the dashboard.
  const { devicesForTrigger } = require('../lib/device-triggers');
  const before = devicesForTrigger(db, existing.id);

  const c = columnsFrom(b);
  db.prepare(`UPDATE triggers SET
      name=@name, match_token=@match_token, clear_token=@clear_token,
      source_http=@source_http, source_udp=@source_udp,
      target_kind=@target_kind, target_ref=@target_ref, position=@position,
      width=@width, height=@height, opacity=@opacity, border_radius=@border_radius,
      mode=@mode, max_duration_sec=@max_duration_sec, lease_sec=@lease_sec,
      priority=@priority, enabled=@enabled, updated_at=strftime('%s','now')
      WHERE id=@id`).run({ id: existing.id, ...c });

  if (b.assignments !== undefined) {
    const aErr = setAssignments(req, existing.id, b.assignments);
    if (aErr) return res.status(400).json({ error: aErr });
  }

  console.log(`[trigger] updated ${existing.id} "${c.name}"`);
  pushTrigger(req, existing.id, before);
  res.json(withAssignments(db.prepare('SELECT * FROM triggers WHERE id = ?').get(existing.id)));
});

router.delete('/:id', requireScope('full'), requireFleetWrite, (req, res) => {
  const existing = db.prepare('SELECT id FROM triggers WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.workspaceId);
  if (!existing) return res.status(404).json({ error: 'trigger not found' });
  // ⚠️ Read the affected devices BEFORE the row goes: trigger_assignments cascades on this delete
  // (FK declared inline, foreign_keys is ON), so afterwards there is nothing left to ask.
  const { devicesForTrigger } = require('../lib/device-triggers');
  const before = devicesForTrigger(db, existing.id);
  db.prepare('DELETE FROM triggers WHERE id = ?').run(existing.id);
  console.log(`[trigger] deleted ${existing.id}`);
  // The push also frees the pinned media: the player's keep-set no longer lists it, so the
  // service worker's prune reclaims the space on the next update rather than holding it forever.
  pushTrigger(req, existing.id, before);
  res.json({ success: true });
});

module.exports = router;
