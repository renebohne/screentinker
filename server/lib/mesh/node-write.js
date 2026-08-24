'use strict';

const writeProxy = require('./write-proxy');

/*
 * Applying a write a parent asked for — on the child, by the child, or not at all.
 *
 * ⚠️ THE ORDER OF CHECKS IS THE DESIGN. Allowlist, then resolve the target locally, then grant, then
 * idempotency, then apply. Every one of those happens on the node that owns the screens, using that
 * node's own rows. Nothing the parent sent is trusted for anything except *what it is asking for*.
 *
 * ⚠️ THE TARGET'S WORKSPACE IS RESOLVED HERE, NEVER SENT. This is the difference between a scoped
 * grant and a decorative one: if the parent named the workspace it was writing to, a compromised or
 * merely buggy parent would name a different one and the check would pass. So the child looks up
 * what the object actually belongs to and compares that against what its operator granted.
 */

const MAX_SKEW_MS = 10 * 60 * 1000;

function parseList(v) {
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string');
  if (typeof v !== 'string' || !v) return [];
  try { const p = JSON.parse(v); return Array.isArray(p) ? p.filter((x) => typeof x === 'string') : []; }
  catch (e) { return []; }
}

/**
 * Which workspace does the object this path targets belong to?
 *
 * ⚠️ Returns null when the target does not exist, and the caller must refuse — not fall back to a
 * default, not treat it as "no workspace, therefore unscoped". An unknown target with an unscoped
 * write is how a grant for one customer becomes a write against another.
 */
function resolveTargetWorkspace(db, path) {
  const seg = String(path || '').split('?')[0].split('/');
  // /api/playlists -> a creation, so the target workspace comes from the request body instead and
  // the caller supplies it; every other rule addresses an existing object.
  if (seg.length === 3) return { kind: 'collection', workspaceId: null };

  const playlistId = seg[3];
  if (!playlistId) return null;
  const row = db.prepare('SELECT workspace_id FROM playlists WHERE id = ?').get(playlistId);
  if (!row) return null;
  return { kind: 'playlist', workspaceId: row.workspace_id, id: playlistId };
}

/**
 * @returns {{ok:true, outcome:object, replayed?:boolean} | {ok:false, reason:string}}
 */
/*
 * ⚠️ ASYNC, AND IT MUST STAY ASYNC. The executor re-enters this server's own HTTP API
 * (lib/mesh/local-apply.js), so `apply()` returns a promise. A synchronous version of this function
 * recorded that promise as a successful outcome BEFORE the request had been sent, acked ok:true to
 * the hub, and — because the outcome was written to mesh_write_ops — replayed that invented success
 * on every retry, so the write could never recover.
 *
 * It was green, because the test stubbed `apply` synchronously. The lesson is the one this codebase
 * keeps relearning: a stub that is simpler than the real collaborator tests the stub.
 */
async function applyWrite(db, edge, req, deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now() : Date.now();
  const method = req && req.method;
  /*
   * ⚠️ NORMALISED ONCE, HERE, AND NOTHING BELOW EVER SEES THE RAW STRING AGAIN.
   *
   * The allowlist, the target lookup and the outgoing request must all be talking about the same
   * path. When they were not, a backslash in an item id matched an allowlisted playlist rule and
   * arrived at the server as DELETE /api/devices/<id> — see write-proxy.normalizeTarget.
   */
  const norm = writeProxy.normalizeTarget(req && req.path);
  const path = norm ? norm.full : null;
  if (!path) return { ok: false, reason: writeProxy.REFUSED };

  /*
   * ⚠️ A DEADLINE, CHECKED BEFORE ANYTHING ELSE. Revocation is "stop future writes", and without a
   * deadline a write that left the parent before a revocation can arrive long after it and still
   * apply. The parent sets it on its own clock; both clocks travel in the envelope already, so a
   * peer whose skew is absurd is refused rather than trusted to have meant well.
   */
  if (req && typeof req.notAfter === 'number') {
    if (Math.abs((req.sentAt || now) - now) > MAX_SKEW_MS) {
      return { ok: false, reason: "This server and yours disagree about the time by more than ten " +
                                  'minutes, so a deadline on the request cannot be trusted. Fix the ' +
                                  'clock skew and try again.' };
    }
    if (req.notAfter < now) {
      return { ok: false, reason: 'That request expired before it arrived, so it was not applied.' };
    }
  }

  const writeGrant = parseList(edge && edge.write_grant);
  const writeScope = parseList(edge && edge.write_scope);

  // Cheap refusal first: an edge with no write grant at all should never reach a target lookup,
  // because even the EXISTENCE of an object is something this connection may not learn this way.
  if (!writeGrant.length) {
    return { ok: false, reason: 'This connection may not change anything on this server. Write ' +
                                "access is granted by this server's operator." };
  }
  if (!writeProxy.isWritable(path, method)) {
    return { ok: false, reason: writeProxy.REFUSED };
  }

  const target = resolveTargetWorkspace(db, path);
  if (!target) {
    // ⚠️ The IDENTICAL string a denial uses — see write-proxy.REFUSED. A parent must not be able
    // to tell "no such playlist" from "not yours", or the write door becomes an oracle for what
    // exists on someone else's server.
    return { ok: false, reason: writeProxy.REFUSED };
  }

  const workspaceId = target.kind === 'collection'
    ? (req.body && req.body.workspace_id) || null
    : target.workspaceId;

  const auth = writeProxy.authorizeWrite(edge, path, method, writeGrant, writeScope, workspaceId);
  if (!auth.ok) return auth;

  /*
   * ⚠️ IDEMPOTENCY, and it returns the RECORDED OUTCOME rather than re-applying. The uplink
   * re-queues on ack timeout, so a link that drops mid-write will send the same intent again as a
   * matter of course. Without this, "the network hiccuped" and "the operator asked twice" are
   * indistinguishable, and the second one adds a duplicate item to somebody's playlist.
   */
  const opId = req && req.opId;
  if (!opId) {
    return { ok: false, reason: 'A write must carry an operation id, so that retrying it is safe.' };
  }
  const seen = db.prepare('SELECT ok, outcome FROM mesh_write_ops WHERE edge_id = ? AND op_id = ?')
    .get(edge.id, opId);
  if (seen) {
    let outcome = null;
    try { outcome = seen.outcome ? JSON.parse(seen.outcome) : null; } catch (e) { outcome = null; }
    return seen.ok
      ? { ok: true, outcome, replayed: true }
      : { ok: false, reason: 'That write was already refused.', replayed: true };
  }

  /*
   * ⚠️ ORDERING. A stale intent for the same target must not win by arriving last. Dropped rather
   * than applied, and reported as such — silently ignoring it would look identical to success.
   */
  const targetKey = `${target.kind}:${target.id || (workspaceId || '')}`;
  if (typeof req.intentSeq === 'number') {
    const last = db.prepare(
      `SELECT MAX(intent_seq) AS m FROM mesh_write_ops
        WHERE edge_id = ? AND target = ? AND ok = 1`).get(edge.id, targetKey);
    if (last && typeof last.m === 'number' && req.intentSeq <= last.m) {
      return { ok: false, reason: 'A newer change to that item has already been applied, so this ' +
                                  'older one was not.' };
    }
  }

  const apply = typeof deps.apply === 'function' ? deps.apply : null;
  if (!apply) {
    return { ok: false, reason: 'This server cannot apply writes right now.' };
  }

  let result;
  try {
    // ⚠️ auth.path, not `path`: the executor sends precisely the string that was authorised.
    result = await apply({ path: auth.path, method, body: req.body, workspaceId, rule: auth.rule, edge });
  } catch (e) {
    // Record the refusal too: a retry of a write that genuinely failed must not silently succeed
    // on the second attempt against different state.
    db.prepare(`INSERT OR REPLACE INTO mesh_write_ops
                (edge_id, op_id, target, intent_seq, ok, outcome, applied_at)
                VALUES (?,?,?,?,0,?,?)`)
      .run(edge.id, opId, targetKey,
           typeof req.intentSeq === 'number' ? req.intentSeq : null,
           JSON.stringify({ error: String((e && e.message) || e) }), Math.floor(now / 1000));
    return { ok: false, reason: 'That change could not be applied.' };
  }

  db.prepare(`INSERT OR REPLACE INTO mesh_write_ops
              (edge_id, op_id, target, intent_seq, ok, outcome, applied_at)
              VALUES (?,?,?,?,1,?,?)`)
    .run(edge.id, opId, targetKey,
         typeof req.intentSeq === 'number' ? req.intentSeq : null,
         JSON.stringify(result || null), Math.floor(now / 1000));

  return { ok: true, outcome: result || null };
}

module.exports = { applyWrite, resolveTargetWorkspace };
