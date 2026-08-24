'use strict';

const crypto = require('node:crypto');

/*
 * Executing a mesh write THE SAME WAY A LOCAL OPERATOR WOULD.
 *
 * ⚠️ THIS IS THE WHOLE DESIGN BRIEF, AND IT IS WHY THIS IS A LOOPBACK REQUEST RATHER THAN A
 * FUNCTION CALL. A mesh write goes back through this server's own HTTP API, over the loopback
 * interface, authenticated as an ordinary workspace-bound API token. It therefore passes every
 * guard a local request passes — tenancy resolution, the scope gate, the draft/publish flow, the
 * fan-out helper, zone validation, upload sniffing — with no second implementation to keep in step.
 *
 * A parallel write engine would have been quicker and would have drifted within a release. Every
 * rule that has been discovered the hard way in this codebase — a fan-out that forgets a case, a
 * column a writer never heard about, a publish that restarts every screen — lives in those routes.
 * Re-entering them is how a mesh write inherits all of it for free.
 *
 * ⚠️ THE TOKEN IS EPHEMERAL, WORKSPACE-BOUND AND REVOKED IMMEDIATELY. It exists for the duration of
 * one request. api_tokens is used because it already has exactly the properties needed and they are
 * already tested: it forces the effective platform role to 'user', so every platform/elevated check
 * downstream evaluates false; it drops a caller-supplied X-Workspace-Id in favour of the bound one;
 * and mount-by-exclusion means it cannot reach admin, auth, billing, provisioning or workspaces at
 * all. A mesh write is strictly weaker than a workspace member, by construction rather than by
 * remembering to check.
 */

const TOKEN_PREFIX = 'st_mesh_';

/**
 * Create the executor a child uses to apply an authorised mesh write.
 *
 * @param {object} db
 * @param {object} config       needs `port`
 * @param {object} [deps]       `fetch` override for tests
 */
function createLocalApply(db, config, deps = {}) {
  const doFetch = deps.fetch || global.fetch;

  /**
   * ⚠️ The principal is a synthetic user owned by this node, never a human.
   *
   * playlists.user_id is NOT NULL REFERENCES users(id) and foreign keys are on, so a pushed
   * playlist genuinely cannot exist without one — this is not bookkeeping. It also means the audit
   * trail attributes the change to "the mesh", not to whichever operator happened to enrol the
   * link, which is the answer their customer actually needs.
   */
  function meshPrincipal() {
    const existing = db.prepare("SELECT id FROM users WHERE email = 'mesh@localhost.invalid'").get();
    if (existing) return existing.id;
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO users (id, email, name, password_hash, role)
                VALUES (?, 'mesh@localhost.invalid', 'Another server (mesh)', NULL, 'user')`).run(id);
    return id;
  }

  return async function applyLocally({ path, method, body, workspaceId, edge }) {
    if (!doFetch) throw new Error('no fetch available to apply the write');
    if (!workspaceId) throw new Error('a write must resolve to a workspace before it is applied');

    const secret = TOKEN_PREFIX + crypto.randomBytes(24).toString('hex');
    const hash = crypto.createHash('sha256').update(secret).digest('hex');
    const tokenId = crypto.randomUUID();

    db.prepare(`INSERT INTO api_tokens (id, token_hash, prefix, name, user_id, workspace_id, scope, created_at)
                VALUES (?,?,?,?,?,?, 'write', strftime('%s','now'))`)
      .run(tokenId, hash, secret.slice(0, 12),
           `mesh write (${(edge && edge.peer_node_id) || 'peer'})`, meshPrincipal(), workspaceId);

    try {
      const res = await doFetch(`http://127.0.0.1:${config.port}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
        ...(body === undefined || method === 'DELETE' ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch (e) { parsed = null; }

      if (!res.ok) {
        /*
         * ⚠️ The local API's own refusal is passed through, not replaced. If a route rejects a
         * cross-tenant zone id or an unpublished trigger target, the hub should see that sentence —
         * it is more useful than "that change could not be applied", and it is the same answer a
         * local operator would have got.
         */
        const e = new Error((parsed && parsed.error) || `local API returned ${res.status}`);
        e.status = res.status;
        throw e;
      }
      return { status: res.status, result: parsed };
    } finally {
      // Revoked whatever happened. A token that outlives its request is standing access.
      db.prepare('UPDATE api_tokens SET revoked_at = strftime(\'%s\',\'now\') WHERE id = ?').run(tokenId);
    }
  };
}

module.exports = { createLocalApply, TOKEN_PREFIX };
