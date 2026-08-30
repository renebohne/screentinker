'use strict';

/*
 * #299 — the rules for accepting a play a PLAYER recorded while it was offline.
 *
 * ⚠️ THESE TIMESTAMPS COME FROM THE PANEL, AND THE PANEL'S CLOCK IS NOT TRUSTWORTHY. A live play
 * is stamped by the server (`strftime('%s','now')`), which is why nothing here was needed before.
 * A backfilled play cannot be: the whole point is that it happened hours ago, so the player has to
 * say when — and a signage panel with a dead RTC or no NTP will cheerfully report 1970, or next
 * year, or a duration of eleven days.
 *
 * A wrong timestamp is worse than a missing row. A gap is visibly a gap; a play stamped 1970 is
 * indistinguishable from real data in a report an advertiser is billed from. So anything outside a
 * defensible window is DROPPED rather than clamped into looking plausible.
 *
 * Pure and clock-injected, so the rules can be tested without a socket, a database or a real clock
 * — the same shape as lib/incident-classify next door, and for the same reason: the handler calls
 * exactly this, so the tests and the live path cannot disagree.
 */

/** At most this many plays are accepted from one flush; a player drains a backlog across batches. */
const MAX_BACKFILL_BATCH = 500;
/** Older than this is a broken clock, not an outage anyone is reporting. */
const BACKFILL_MAX_AGE_SEC = 30 * 24 * 60 * 60;
/** Mild skew is tolerated; a future date is not. */
const BACKFILL_FUTURE_SKEW_SEC = 5 * 60;
/** A single item playing for longer than a day is nonsense, however sincerely reported. */
const BACKFILL_MAX_DURATION_SEC = 24 * 60 * 60;

/**
 * Validate and normalise one offline play.
 *
 * @param {object} p       the player's record
 * @param {number} nowSec  current epoch seconds (injected)
 * @returns {object|null}  a row-shaped object, or null if it must not be stored
 */
function normalizeBackfillPlay(p, nowSec) {
  if (!p || typeof p !== 'object') return null;

  const startedAt = Number(p.started_at);
  if (!Number.isFinite(startedAt)) return null;
  if (startedAt > nowSec + BACKFILL_FUTURE_SKEW_SEC) return null;
  if (startedAt < nowSec - BACKFILL_MAX_AGE_SEC) return null;

  /*
   * An end that is missing, before its start, or in the future leaves the row OPEN (ended_at
   * null) rather than being repaired into something plausible. An open row is honest about not
   * knowing when the play finished; a fabricated end is not.
   */
  let endedAt = Number(p.ended_at);
  if (!Number.isFinite(endedAt) || endedAt < startedAt || endedAt > nowSec + BACKFILL_FUTURE_SKEW_SEC) {
    endedAt = null;
  }
  const durationSec = endedAt === null
    ? null
    : Math.min(endedAt - startedAt, BACKFILL_MAX_DURATION_SEC);

  return {
    started_at: Math.floor(startedAt),
    ended_at: endedAt === null ? null : Math.floor(endedAt),
    duration_sec: durationSec === null ? null : Math.floor(durationSec),
    completed: p.completed ? 1 : 0,
    content_id: p.content_id || null,
    widget_id: p.widget_id || null,
    zone_id: p.zone_id || null,
    content_name: p.content_name || 'Unknown',
    client_event_id: p.client_event_id || null,
  };
}

/** Cap a flush. Returns the slice that may be processed. */
function boundBatch(plays) {
  return Array.isArray(plays) ? plays.slice(0, MAX_BACKFILL_BATCH) : [];
}

/**
 * Close plays that were left open, using the start of the play that followed.
 *
 * ⚠️ WHY THIS IS SOUND, NOT A GUESS. A play row is opened by play_start and closed by play_end. If
 * the link drops between them the close is lost and the row stays open forever with no duration —
 * one per outage, plus every reboot mid-item. But the device advancing to another item is itself
 * proof the previous one ran until that moment: the successor's started_at IS the predecessor's
 * end. Nothing is invented; the evidence was already in the table.
 *
 * ⚠️ ONLY WHERE A SUCCESSOR EXISTS. The item genuinely playing right now is the newest row and has
 * none, so it is left open — which is correct, it has not ended.
 *
 * ⚠️ AND ONLY WITHIN A SANE SPAN. If a panel played one item, went dark for a week, and came back,
 * the "next" play is a week later; attributing a week of runtime to that item would be a far bigger
 * lie than leaving it open. Beyond the cap it stays open and honest.
 *
 * `completed` is deliberately NOT set. We have evidence it played for that long, not evidence it
 * ran to its end — an error-advance looks identical from here. Duration is the number reports are
 * built on; claiming completion would be asserting more than the data supports.
 *
 * @returns {number} rows closed
 */
function closeStrandedPlays(db, deviceId, maxInferredSec = BACKFILL_MAX_DURATION_SEC) {
  const info = db.prepare(`
    UPDATE play_logs
       SET ended_at = nxt.next_start,
           duration_sec = nxt.next_start - play_logs.started_at
      FROM (SELECT p.id AS id, MIN(n.started_at) AS next_start
              FROM play_logs p
              JOIN play_logs n
                ON n.device_id = p.device_id
               AND n.started_at > p.started_at
               -- ⚠️ SAME ZONE ONLY. A multi-zone device plays several items AT ONCE, so the next
               -- row for the device can belong to a different zone that started while this one was
               -- still on screen. Closing against it would cut the play short and under-report it.
               -- IS rather than = so the fullscreen case (zone_id NULL) matches itself.
               -- (No backticks in here: this is inside a JS template literal and they would end it.)
               AND n.zone_id IS p.zone_id
             WHERE p.device_id = ? AND p.ended_at IS NULL
             GROUP BY p.id) AS nxt
     WHERE play_logs.id = nxt.id
       AND nxt.next_start - play_logs.started_at <= ?
  `).run(deviceId, maxInferredSec);
  return info.changes;
}

module.exports = {
  normalizeBackfillPlay,
  boundBatch,
  closeStrandedPlays,
  MAX_BACKFILL_BATCH,
  BACKFILL_MAX_AGE_SEC,
  BACKFILL_FUTURE_SKEW_SEC,
  BACKFILL_MAX_DURATION_SEC,
};
