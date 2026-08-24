'use strict';

/*
 * MESH HOUSEKEEPING — the sweeps that were designed, indexed for, and never scheduled.
 *
 * Three tables grow without bound on a long-lived node, and each already had everything needed to
 * prune it except a caller:
 *
 *   mesh_mirror_alerts / mesh_mirror_play_logs — mirror-store.pruneEdge() honours each edge's own
 *     retention_days and had NO callers outside its tests. So a hub kept every closed alert and
 *     every proof-of-play line from every child for ever, while the UI offered a retention setting
 *     that did nothing. Configurable retention that is never applied is worse than none: it is a
 *     promise the product does not keep, on the one axis a customer asks about by name.
 *
 *   mesh_write_ops — one row per mesh write, for ever, on the CUSTOMER's box.
 *     idx_mesh_write_ops_age exists on applied_at and was created for a pruner nobody wrote.
 *
 *   mesh_pull_tickets — same shape: an expires_at index and no sweeper.
 *
 * ⚠️ THIS SERVICE MUST NEVER BE ABLE TO HARM ITS OWN NODE (I1), which is the same rule the uplink
 * service carries. Every sweep is wrapped, a failure is logged and dropped, and nothing here is on
 * a request path. A housekeeping task that can take a signage server down is worse than the
 * disk it was meant to save.
 *
 * ⚠️ IDEMPOTENCY OUTLIVES THE RETRY WINDOW, DELIBERATELY. A write op is kept far longer than any
 * plausible retry, because the cost of keeping one is a row and the cost of dropping one too early
 * is applying somebody's change twice. The horizon is generous for that reason, not by accident.
 */

const mirrorStore = require('../lib/mesh/mirror-store');

/** How long a settled write op is remembered. Far beyond any retry; see the note above. */
const WRITE_OP_RETENTION_DAYS = 30;

/** How often the sweep runs. Housekeeping, not a deadline — hourly is plenty and cheap. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

function sweepOnce(db, logger = console) {
  const nowSec = Math.floor(Date.now() / 1000);
  const out = { alerts: 0, playLogs: 0, tombstoned: 0, writeOps: 0, tickets: 0 };

  /*
   * Mirrored data, per edge, against that edge's OWN retention. Per edge rather than one global
   * sweep because retention is negotiated per relationship — one customer may keep 90 days and
   * another 7, and a single cutoff would quietly impose one on the other.
   */
  try {
    const edges = db.prepare("SELECT * FROM mesh_edges WHERE direction = 'down'").all();
    for (const edge of edges) {
      try {
        const r = mirrorStore.pruneEdge(db, edge, nowSec);
        out.alerts += r.alerts; out.playLogs += r.playLogs; out.tombstoned += r.tombstoned;
      } catch (e) {
        logger.warn(`[mesh] could not prune mirrored data for ${edge.peer_node_id}: ${e && e.message}`);
      }
    }
  } catch (e) {
    logger.warn(`[mesh] retention sweep skipped: ${e && e.message}`);
  }

  /*
   * ⚠️ Settled ops only. A row still marked in-flight (ok = -1) is a write whose outcome nobody
   * knows; deleting it would free its op id for reuse and turn the mandated retry into a second
   * application of the same change.
   */
  try {
    out.writeOps = db.prepare(
      'DELETE FROM mesh_write_ops WHERE ok >= 0 AND applied_at < ?',
    ).run(nowSec - WRITE_OP_RETENTION_DAYS * 86400).changes;
  } catch (e) {
    logger.warn(`[mesh] could not prune write ops: ${e && e.message}`);
  }

  try {
    out.tickets = db.prepare('DELETE FROM mesh_pull_tickets WHERE expires_at < ?').run(nowSec).changes;
  } catch (e) {
    logger.warn(`[mesh] could not prune pull tickets: ${e && e.message}`);
  }

  return out;
}

/**
 * Start the hourly sweep. Returns a stop function.
 *
 * ⚠️ Not run at boot. Startup is the busiest moment a signage server has — panels reconnecting,
 * playlists resolving, media being served — and a delete across several tables is exactly what
 * should not be competing with it. The first sweep is one interval away, and nothing depends on it
 * having happened.
 */
function startMeshMaintenance(db, { logger = console } = {}) {
  const timer = setInterval(() => {
    try {
      const r = sweepOnce(db, logger);
      const total = r.alerts + r.playLogs + r.tombstoned + r.writeOps + r.tickets;
      if (total > 0) {
        logger.log(`[mesh] housekeeping removed ${total} row(s): ` +
                   `${r.alerts} alerts, ${r.playLogs} play logs, ${r.tombstoned} tombstoned devices, ` +
                   `${r.writeOps} write ops, ${r.tickets} expired tickets`);
      }
    } catch (e) {
      logger.warn(`[mesh] housekeeping failed: ${e && e.message}`);
    }
  }, SWEEP_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();   // never hold the process open
  return () => clearInterval(timer);
}

module.exports = { startMeshMaintenance, sweepOnce, WRITE_OP_RETENTION_DAYS, SWEEP_INTERVAL_MS };
