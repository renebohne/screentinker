'use strict';

/*
 * Experiments: turning a test into ordinary playlist rows, and back (see core.js for the why).
 *
 * start    the slot row becomes variant A (control) and N-1 copies become B, C, D, each limited to
 *          its turns (time mode) or its locations (location mode); then the playlist is published.
 * restore  the copies are deleted and the slot row is put back exactly as it was — or, when rolling
 *          out, put back with the winner's content in it.
 *
 * Everything here is synchronous SQLite inside one transaction, and the publish comes after: a
 * failed publish leaves the database consistent (the rows are right; screens get them on the next
 * publish of that playlist).
 */

const { db } = require('../../db/database');
const assign = require('./assign');
const core = require('./core');

const COPY_COLS = ['zone_id', 'sort_order', 'duration_sec', 'muted', 'play_from', 'play_until', 'enabled', 'log_play',
  'fit_mode', 'play_when', 'weight', 'repeat_every_sec', 'play_to_end'];

function schedulesOf(itemId) {
  return db.prepare('SELECT active_days, start_time, end_time, start_date, end_date FROM playlist_item_schedules WHERE playlist_item_id = ? ORDER BY sort_order ASC, created_at ASC')
    .all(itemId).map((r) => ({
      days: String(r.active_days || '').split(',').filter((s) => s !== '').map(Number),
      start: r.start_time, end: r.end_time, start_date: r.start_date || null, end_date: r.end_date || null,
    }));
}

function writeSchedules(itemId, blocks) {
  const { randomUUID } = require('crypto');
  db.prepare('DELETE FROM playlist_item_schedules WHERE playlist_item_id = ?').run(itemId);
  const ins = db.prepare('INSERT INTO playlist_item_schedules (id, playlist_item_id, active_days, start_time, end_time, start_date, end_date, sort_order) VALUES (?,?,?,?,?,?,?,?)');
  blocks.forEach((b, i) => ins.run(randomUUID(), itemId, b.days.join(','), b.start, b.end, b.start_date || null, b.end_date || null, i));
}

const refCols = (ref) => [ref.content_id || null, ref.widget_id || null, ref.child_playlist_id || null];

/** Is the playlist free of unpublished edits (so publishing it ships only our change)? */
function playlistClean(playlistId) {
  const p = db.prepare('SELECT status FROM playlists WHERE id = ?').get(playlistId);
  return !!p && p.status === 'published';
}

function approvalsOn(workspaceId) {
  try { return require('../release-policy').approvalRequired(db, workspaceId); } catch { return false; }
}

/**
 * Publish through the release gate (start, roll-out) or directly (restore). `reqOrIo` is the
 * request for a person's action, the socket server for the sweep.
 */
function publish(playlistId, reqOrIo, { gated }) {
  if (gated) {
    const releases = require('../releases');
    return releases.releasePlaylist(db, playlistId, reqOrIo, { actor: reqOrIo && reqOrIo.app ? releases.actorOf(reqOrIo) : null, source: 'experiment' });
  }
  return require('../../routes/playlists').publishPlaylist(playlistId, reqOrIo);
}

/* ─── start ─────────────────────────────────────────────────────────────────────────────────── */

function start(exp, reqOrIo, { now = core.nowSec(), baseline = null } = {}) {
  if (exp.status !== 'draft') core.fail('This test has already been started.', 409, 'EXPERIMENT_STATE');
  if (approvalsOn(exp.workspace_id)) {
    core.fail('This workspace reviews changes before they reach screens, so a test cannot switch content on its own. Turn approvals off to run experiments.', 409, 'EXPERIMENT_APPROVALS');
  }
  // Re-validate against the database as it is NOW: the slot or a variant may have gone since the draft.
  const d = core.define(exp.workspace_id, {
    name: exp.name, mode: exp.mode, playlist_id: exp.playlist_id, slot_item_id: exp.slot_item_id,
    variants: exp.variants.map((v) => ({ kind: v.kind, id: v.id, label: v.label, qr_link_id: v.qr_link_id })),
    config: exp.config, planned_end_at: exp.planned_end_at && exp.planned_end_at > now ? exp.planned_end_at : null,
  });
  if (!playlistClean(d.playlist.id)) {
    core.fail('This playlist has changes that are not published yet. Publish or discard them first, so starting the test does not publish them too.', 409, 'EXPERIMENT_PLAYLIST_DRAFT');
  }
  const units = core.syncUnits(exp);
  if (!units.length) core.fail('No screen is playing this playlist, so there is nobody to show the test to.', 409, 'EXPERIMENT_NO_SCREENS');
  const n = d.variants.length;
  let assignment = null;
  if (exp.mode === 'location') {
    if (units.length < n) core.fail(`Testing by location needs at least ${n} locations (one per version). Test by time of day instead, or give your screens locations.`, 409, 'EXPERIMENT_FEW_LOCATIONS');
    assignment = assign.assignLocations(units.map((u) => ({ key: u.unit_key })), n, exp.id, baseline);
  }

  const item = d.item;
  const original = { item: {}, schedules: schedulesOf(item.id) };
  for (const k of ['id', 'content_id', 'widget_id', 'child_playlist_id', ...COPY_COLS]) original.item[k] = item[k] === undefined ? null : item[k];

  const rowIds = [];
  db.transaction(() => {
    if (assignment) {
      const upd = db.prepare('UPDATE experiment_units SET variant = ? WHERE experiment_id = ? AND unit_key = ?');
      for (const u of units) upd.run(assignment[u.unit_key], exp.id, u.unit_key);
    }
    const devicesOf = (k) => units.filter((u) => assignment && assignment[u.unit_key] === k).flatMap((u) => u.device_ids);
    const others = (k0) => units.filter((u) => assignment && assignment[u.unit_key] !== k0).flatMap((u) => u.device_ids);
    for (let k = 0; k < n; k++) {
      const v = d.variants[k];
      let playWhen = item.play_when || null;
      if (exp.mode === 'location') {
        playWhen = JSON.stringify(k === 0
          ? { type: 'screens', op: 'not_in', ids: others(0), experiment_id: exp.id }
          : { type: 'screens', op: 'in', ids: devicesOf(k), experiment_id: exp.id });
      }
      const duration = v.duration || item.duration_sec;
      let rowId;
      if (k === 0) {
        db.prepare('UPDATE playlist_items SET content_id = ?, widget_id = ?, child_playlist_id = ?, duration_sec = ?, play_when = ?, experiment_id = ?, updated_at = strftime(\'%s\',\'now\') WHERE id = ?')
          .run(...refCols(v.ref), duration, playWhen, exp.id, item.id);
        rowId = item.id;
      } else {
        const cols = COPY_COLS.filter((c) => c !== 'play_when' && c !== 'duration_sec');
        const r = db.prepare(`INSERT INTO playlist_items (playlist_id, content_id, widget_id, child_playlist_id, duration_sec, play_when, experiment_id, ${cols.join(', ')})
          VALUES (?, ?, ?, ?, ?, ?, ?, ${cols.map(() => '?').join(', ')})`)
          .run(d.playlist.id, ...refCols(v.ref), duration, playWhen, exp.id, ...cols.map((c) => item[c] === undefined ? null : item[c]));
        rowId = Number(r.lastInsertRowid);
      }
      if (exp.mode === 'time') {
        writeSchedules(rowId, assign.intersectBlocks(original.schedules, assign.timeBlocks(k, n, exp.config.block_hours || 1)));
      } else if (k > 0) {
        writeSchedules(rowId, original.schedules);
      }
      rowIds.push(rowId);
    }
    db.prepare(`UPDATE experiments SET status = 'running', start_at = ?, original = ?, variants = ?, planned_end_at = ?, notice = NULL, updated_at = strftime('%s','now') WHERE id = ?`)
      .run(now, JSON.stringify({ ...original, row_ids: rowIds }), JSON.stringify(d.variants), d.planned_end_at, exp.id);
  })();

  try {
    publish(d.playlist.id, reqOrIo, { gated: true });
  } catch (e) {
    // The gate said no after all (approvals switched on between the check and here): undo.
    restoreRows(core.load(exp.id, exp.workspace_id), null);
    db.prepare(`UPDATE experiments SET status = 'draft', start_at = NULL, original = NULL, updated_at = strftime('%s','now') WHERE id = ?`).run(exp.id);
    db.prepare('UPDATE experiment_units SET variant = NULL WHERE experiment_id = ?').run(exp.id);
    if (e && e.name === 'ReleaseError') core.fail(e.message, e.status || 409, 'EXPERIMENT_APPROVALS');
    throw e;
  }
  return core.load(exp.id, exp.workspace_id);
}

/* ─── restore / end / roll out ─────────────────────────────────────────────────────────────── */

/**
 * Put the slot back. winnerRef: the content to leave in it ({ content_id | widget_id |
 * child_playlist_id } and duration), or null for the original content.
 */
function restoreRows(exp, winner) {
  const orig = exp.original && exp.original.item;
  if (!orig) return;
  db.transaction(() => {
    db.prepare('DELETE FROM playlist_items WHERE playlist_id = ? AND experiment_id = ? AND id != ?').run(exp.playlist_id, exp.id, orig.id);
    // A "discard changes" on the playlist rebuilds its rows from the published structure, which does
    // not carry experiment_id. Location-mode rows still name the test inside their condition.
    const rebuilt = db.prepare('DELETE FROM playlist_items WHERE playlist_id = ? AND id != ? AND play_when LIKE ?').run(exp.playlist_id, orig.id, `%"experiment_id":"${exp.id}"%`).changes;
    const ref = winner ? winner.ref : { content_id: orig.content_id, widget_id: orig.widget_id, child_playlist_id: orig.child_playlist_id };
    const duration = winner && winner.duration ? winner.duration : orig.duration_sec;
    const row = db.prepare('SELECT id FROM playlist_items WHERE id = ? AND playlist_id = ?').get(orig.id, exp.playlist_id);
    let rowId = row && row.id;
    if (rowId) {
      db.prepare('UPDATE playlist_items SET content_id = ?, widget_id = ?, child_playlist_id = ?, duration_sec = ?, play_when = ?, experiment_id = NULL, updated_at = strftime(\'%s\',\'now\') WHERE id = ?')
        .run(...refCols(ref), duration, orig.play_when || null, rowId);
    } else if (winner || rebuilt) {
      // The slot row is gone: deleted during the test (rolling out still means "put the winner
      // here"), or rebuilt under a new id by a discard (put the original back where it was).
      const cols = COPY_COLS.filter((c) => c !== 'play_when' && c !== 'duration_sec');
      const r = db.prepare(`INSERT INTO playlist_items (playlist_id, content_id, widget_id, child_playlist_id, duration_sec, play_when, ${cols.join(', ')})
        VALUES (?, ?, ?, ?, ?, ?, ${cols.map(() => '?').join(', ')})`)
        .run(exp.playlist_id, ...refCols(ref), duration, orig.play_when || null, ...cols.map((c) => orig[c] === undefined ? null : orig[c]));
      rowId = Number(r.lastInsertRowid);
    }
    if (rowId) writeSchedules(rowId, exp.original.schedules || []);
  })();
}

/**
 * End a running test. reason: 'stopped' (a person, early), 'ended' (the end date, or End now).
 * A person's action requires a clean playlist; the sweep restores anyway and leaves the publish to
 * whoever is editing, with a notice.
 */
function finish(exp, reqOrIo, { reason = 'ended', now = core.nowSec(), system = false } = {}) {
  if (exp.status !== 'running') core.fail('This test is not running.', 409, 'EXPERIMENT_STATE');
  const clean = playlistClean(exp.playlist_id);
  if (!clean && !system) {
    core.fail('This playlist has changes that are not published yet. Publish or discard them first, so ending the test does not publish them too.', 409, 'EXPERIMENT_PLAYLIST_DRAFT');
  }
  // Final exposure snapshot while the raw plays are certainly still there.
  try { require('./data').refreshExposure(exp, now); } catch (e) { console.warn(`[experiments] exposure refresh failed: ${e && e.message}`); }
  restoreRows(exp, null);
  db.prepare(`UPDATE experiments SET status = ?, end_at = ?, notice = ?, updated_at = strftime('%s','now') WHERE id = ?`)
    .run(reason, now, clean ? null : 'restored_unpublished', exp.id);
  if (clean) {
    try { publish(exp.playlist_id, reqOrIo, { gated: false }); } catch (e) { console.warn(`[experiments] publish after end failed: ${e && e.message}`); }
  } else {
    db.prepare("UPDATE playlists SET status = 'draft', updated_at = strftime('%s','now') WHERE id = ?").run(exp.playlist_id);
  }
  return core.load(exp.id, exp.workspace_id);
}

/** Make the winner permanent: running → restore with the winner; ended/stopped → swap it in. */
function rollOut(exp, variantIndex, reqOrIo, { now = core.nowSec() } = {}) {
  const k = Number(variantIndex);
  if (!Number.isInteger(k) || k < 0 || k >= exp.variants.length) core.fail('Choose which version to keep.');
  if (!['running', 'ended', 'stopped'].includes(exp.status)) core.fail('Only a started test can be rolled out.', 409, 'EXPERIMENT_STATE');
  if (approvalsOn(exp.workspace_id)) {
    core.fail('This workspace reviews changes before they reach screens. Put the winning version in the playlist by hand and send it for review.', 409, 'EXPERIMENT_APPROVALS');
  }
  if (!playlistClean(exp.playlist_id)) {
    core.fail('This playlist has changes that are not published yet. Publish or discard them first, so rolling out does not publish them too.', 409, 'EXPERIMENT_PLAYLIST_DRAFT');
  }
  // The winner must still exist and still be this workspace's; re-resolved, so a sign republished
  // since the start is rolled out as it is now.
  const v = exp.variants[k];
  const winner = core.checkVariant(exp.workspace_id, { kind: v.kind, id: v.id, label: v.label }, k);
  if (exp.status === 'running') {
    try { require('./data').refreshExposure(exp, now); } catch (_) { /* results only */ }
  }
  restoreRows(exp, winner);
  db.prepare(`UPDATE experiments SET status = 'rolled_out', winner = ?, end_at = COALESCE(end_at, ?), notice = NULL, updated_at = strftime('%s','now') WHERE id = ?`).run(k, now, exp.id);
  publish(exp.playlist_id, reqOrIo, { gated: true });
  return core.load(exp.id, exp.workspace_id);
}

module.exports = { start, finish, rollOut, restoreRows, schedulesOf, playlistClean };
