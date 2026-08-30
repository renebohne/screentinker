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

module.exports = {
  normalizeBackfillPlay,
  boundBatch,
  MAX_BACKFILL_BATCH,
  BACKFILL_MAX_AGE_SEC,
  BACKFILL_FUTURE_SKEW_SEC,
  BACKFILL_MAX_DURATION_SEC,
};
