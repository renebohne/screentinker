'use strict';

/*
 * The thing that actually reports upward: opens an Uplink per `up` edge and feeds it projections.
 *
 * ⚠️ EVERY PAYLOAD GOES THROUGH lib/mesh/mirror.js FIRST. Nothing reads a device row and sends it.
 * The grant is enforced by CONSTRUCTING what is allowed rather than by removing what is not — the
 * moment a new telemetry column lands, a delete-based filter silently starts shipping it upward and
 * nobody finds out until a client asks why their hub knows something it was never granted.
 *
 * ⚠️ THIS SERVICE MUST NEVER BE ABLE TO HARM ITS OWN NODE (I1). It is a reporter to an observer.
 * Every path is wrapped, the timer is unref'd, and a parent that is down, wrong, slow or hostile
 * changes nothing about scheduling, playback or the local dashboard.
 */

const { Uplink } = require('../lib/mesh/uplink');
const nodeData = require('../lib/mesh/node-data');
const {
  deviceProjections, workspaceProjections, nodeHealth, openAlerts, answerRead, deviceDetail,
} = nodeData;
const { createReadRunner } = require('../lib/mesh/read-runner');
const nodeWrite = require('../lib/mesh/node-write');
const { createLocalApply } = require('../lib/mesh/local-apply');
const envelope = require('../lib/mesh/envelope');
const mirror = require('../lib/mesh/mirror');
const store = require('../lib/mesh/store');

/*
 * How often a child reports. ⚠️ Not per heartbeat. A 400-screen node whose panels beat every 30s
 * would push 800 envelopes a minute at a hub that wants a picture, not a firehose — and the hub's
 * own backpressure would then throttle it, so the extra traffic buys nothing but load on both ends.
 */
const REPORT_INTERVAL_MS = 60_000;

const nowSec = () => Math.floor(Date.now() / 1000);

function activeUpEdges(db) {
  try {
    return db.prepare(
      "SELECT * FROM mesh_edges WHERE direction = 'up' AND revoked_at IS NULL AND up_token IS NOT NULL")
      .all();
  } catch (e) {
    return [];
  }
}

/*
 * ⚠️ THE WORKSPACE SCOPE IS ENFORCED IN THE QUERY, not filtered afterwards.
 *
 * A shared list that is applied after the rows are fetched leaks the moment somebody adds a count,
 * a total or a "devices online" to a payload — the classic shape of this bug, and the same one the
 * hub's client scoping avoids by resolving visibility before it selects. Here the SQL simply cannot
 * return a workspace this edge was not granted.
 *
 * `null` means every workspace INCLUDING ones created later, which only the instance owner can
 * choose. A named list is fixed: a workspace added tomorrow is not silently swept in.
 */

function startMeshUplinks(db, { config, connect, logger = console } = {}) {
  if (!config || !config.meshAllowUplink) return { stop() {}, links: new Map(), refresh() {} };

  const io = connect || require('socket.io-client').io;
  const links = new Map();
  let timer = null;

  const me = store.ensureNodeIdentity(db);
  if (!me) {
    logger.warn('[mesh] MESH_ALLOW_UPLINK is set but this node has no identity — not reporting upward.');
    return { stop() {}, links, refresh() {} };
  }

  /*
   * ⚠️ Reads go to a worker where one exists, and inline where one does not — the same answer
   * either way. better-sqlite3 is synchronous, so an inline read is served on the event loop that
   * answers every player's heartbeat: a parent's convenience paid for out of the child's own
   * responsiveness, which is what I1 forbids.
   */
  // One executor for the whole service: it mints a short-lived, workspace-bound token per
  // write and re-enters this server's own HTTP API, so a mesh write passes exactly the
  // guards a local one does.
  const applyLocally = createLocalApply(db, config);

  const reads = createReadRunner({
    dbPath: (config && config.dbPath) || require('../config').dbPath,
    db,
    nodeData,
    logger,
    preferWorker: process.env.ST_MESH_READ_WORKER !== '0',
  });

  function send(edge, link) {
    const grant = store.safeParseArray(edge.grant_categories);
    const mk = (type, body) => envelope.createEnvelope({
      originNodeId: me, type, bodyVersion: 1,
      ancestry: [me], originTs: Date.now(), body,
    });

    /*
     * ⚠️ ALERTS ARE NOT BATCHED, and that is a product decision rather than an oversight. An alert is
     * the one payload where latency IS the point; batching it behind four hundred device summaries
     * adds up to a full cycle of delay to the message an operator is waiting for. "Fewer bytes" and
     * "better product" are not the same goal, and where they disagree this one wins.
     */
    for (const a of openAlerts(db, grant, edge)) link.send(mk('alert-event', a));

    /*
     * Everything else travels together. Node health leads and workspaces precede devices, because a
     * device arriving before its workspace flickers into "unfiled" and back out again on the very
     * first sync — order is preserved inside a batch, so this ordering still means something.
     */
    /*
     * ⚠️ WHAT WE HAVE DECIDED THIS PARENT MAY DO, SENT UPWARD SO IT CAN RENDER THE RIGHT CONTROLS.
     *
     * The grant lives here and is enforced here, on this node's own row, re-read live per request.
     * The parent has no copy and must never infer one — so without this it cannot tell an operator
     * whether they may push to this client, and can only let them try and be refused. The refusal
     * is deliberately identical for "no such thing" and "not permitted", so it teaches nothing.
     *
     * Sent every tick alongside the rest rather than only on change: a report that only fires on
     * change is a report that is wrong for ever after one dropped connection, and this is cheap —
     * four short fields.
     *
     * ⚠️ The BUDGET is included and the USED figure with it, so the hub can warn before a push
     * fails rather than after. Neither is authority: the child re-checks both when the bytes
     * actually arrive.
     */
    const writeGrant = store.safeParseArray(edge.write_grant);
    const writeScope = store.safeParseArray(edge.write_scope);
    const bulk = [
      mk('node-health', nodeHealth(db, me)),
      mk('write-offer', {
        categories: writeGrant,
        workspaces: writeScope,
        bytesBudget: typeof edge.write_bytes_budget === 'number' ? edge.write_bytes_budget : null,
        bytesUsed: Number(edge.write_bytes_used) || 0,
      }),
    ];
    for (const w of workspaceProjections(db, grant, edge)) bulk.push(mk('workspace-summary', w));
    for (const d of deviceProjections(db, grant, edge)) bulk.push(mk('device-summary', d));
    link.sendMany(bulk, { nodeId: me, ancestry: [me] });
  }

  function tick() {
    for (const [edgeId, link] of links) {
      const edge = db.prepare('SELECT * FROM mesh_edges WHERE id = ?').get(edgeId);
      /*
       * ⚠️ Re-read every tick, so a revoke or a narrowed grant takes effect on the NEXT report
       * rather than at the next restart. The same reasoning as the parent re-reading its edge per
       * envelope: a permission change that waits for a process lifecycle is not a permission change.
       */
      if (!edge || edge.revoked_at) {
        try { link.stop(); } catch (e) { /* best effort */ }
        links.delete(edgeId);
        continue;
      }
      try { send(edge, link); } catch (e) {
        logger.warn(`[mesh] could not build a report for ${edge.peer_node_id}: ${e && e.message}`);
      }
    }
  }

  function refresh() {
    for (const edge of activeUpEdges(db)) {
      if (links.has(edge.id)) continue;
      try {
        const link = new Uplink({
          parentUrl: edge.peer_url,
          edgeToken: edge.up_token,
          nodeId: me,
          connect: io,
          tlsVerify: edge.tls_verify !== 0,
          logger,
          // ⚠️ Re-read per request, so narrowing a grant or a workspace scope takes effect on the
          // NEXT read rather than at the next restart.
          onRead: (req) => {
            /*
             * ⚠️ The EDGE is re-read on this thread, then handed to the runner. Authorisation is
             * decided here from live state; the worker only computes an answer for an edge it was
             * given. A worker that fetched its own edge row could serve a revoked one from a
             * connection opened before the revoke.
             */
            const fresh = db.prepare('SELECT * FROM mesh_edges WHERE id = ?').get(edge.id);
            if (!fresh || fresh.revoked_at) {
              return { ok: false, reason: 'This connection is no longer authorised.' };
            }
            return reads.run(fresh, req);
          },

          /*
           * ⚠️ Same live re-read as onRead, and it matters MORE here. For a read, a stale edge means
           * a hub sees something it should no longer see. For a write it means a hub CHANGES
           * something after its operator revoked the right to — so the grant is read inside the
           * request, from the row, every time. Nothing is cached at handshake, because revocation
           * that only takes effect at the next restart is not revocation.
           */
          onWrite: (req) => {
            const fresh = db.prepare('SELECT * FROM mesh_edges WHERE id = ?').get(edge.id);
            if (!fresh || fresh.revoked_at) {
              return { ok: false, reason: 'This connection is no longer authorised.' };
            }
            /*
             * ⚠️ Runs on THIS thread with the writable handle, unlike reads.
             *
             * The read path deliberately opens its own read-only connection on a worker, so "the
             * read path cannot write" is a property of the file descriptor rather than of the code
             * above it. A write cannot have that, so it gives up that guarantee — which is exactly
             * why the allowlist in write-proxy.js is narrow and why nothing that touches bytes is
             * on it. It also means a parent's convenience is paid out of this node's event loop,
             * the one answering every player's heartbeat: keep the surface small.
             */
            return nodeWrite.applyWrite(db, fresh, req, { apply: applyLocally });
          },
        }).start();
        /*
         * ⚠️ REPORT AS SOON AS THE SOCKET COMES UP, not at the next tick. Otherwise a node that was
         * just enrolled shows nothing on the hub for up to a minute — the operator's very first
         * look at the thing they just connected is an empty page, which reads as "it did not work"
         * and gets retried. Also covers every reconnect, so a link that drops catches up at once
         * instead of waiting out the interval.
         */
        /*
         * ⚠️ A failing uplink SAYS SO in the log. The Uplink keeps lastError for the connection view,
         * but nothing printed it — so a link that could not connect looked identical to one that was
         * connected and idle, and the only symptom was a hub showing a node with no data. Rate is
         * not a concern: the backoff is jittered and caps at a minute.
         */
        link.on('retry-scheduled', ({ attempt, delayMs, reason }) => {
          logger.warn(`[mesh] uplink to ${edge.peer_node_id} failed (attempt ${attempt}): ` +
                      `${reason || 'unknown'} — retrying in ${Math.round(delayMs / 1000)}s`);
        });
        link.on('connected', () => {
          try {
            const fresh = db.prepare('SELECT * FROM mesh_edges WHERE id = ?').get(edge.id);
            if (fresh && !fresh.revoked_at) send(fresh, link);
          } catch (e) {
            logger.warn(`[mesh] first report to ${edge.peer_node_id} failed: ${e && e.message}`);
          }
        });
        links.set(edge.id, link);
        logger.log(`[mesh] reporting upward to ${edge.peer_node_id} at ${edge.peer_url}`);
      } catch (e) {
        /*
         * A bad row must not stop the others, and must not stop the node (I6).
         *
         * ⚠️ But it must not be QUIET either. A ReferenceError in the constructor is a programming
         * fault, not a malformed edge, and this handler once turned exactly that into one warn line
         * per edge while the entire mesh sat inert — no telemetry, no reads, no writes, and a suite
         * of 2,300 tests still green. Isolation is right; hiding the difference between "this row is
         * bad" and "this build is broken" is not. The stack goes in the log, and the message says
         * what is actually not happening.
         */
        logger.warn(`[mesh] NOT reporting to ${edge.peer_node_id} — its uplink could not start: ` +
                    `${(e && e.stack) || e}`);
      }
    }
    // Anything revoked while we were not looking.
    for (const [edgeId, link] of links) {
      const still = db.prepare(
        "SELECT 1 FROM mesh_edges WHERE id = ? AND revoked_at IS NULL AND direction = 'up'").get(edgeId);
      if (!still) { try { link.stop(); } catch (e) { /* best effort */ } links.delete(edgeId); }
    }
  }

  refresh();
  tick();
  timer = setInterval(tick, REPORT_INTERVAL_MS);
  // ⚠️ Never hold the process open for an observer relationship.
  if (timer.unref) timer.unref();

  return {
    links,
    refresh,
    status: () => [...links.entries()].map(([id, l]) => ({ edgeId: id, ...l.status() })),
    readMode: () => reads.mode,
    stop() {
      if (timer) clearInterval(timer);
      reads.stop();
      for (const l of links.values()) { try { l.stop(); } catch (e) { /* best effort */ } }
      links.clear();
    },
  };
}

module.exports = {
  startMeshUplinks, REPORT_INTERVAL_MS,
  deviceProjections, workspaceProjections, nodeHealth, openAlerts, answerRead, deviceDetail,
};
