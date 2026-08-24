'use strict';

const grantsLib = require('./grants');

/*
 * Exactly what a parent may CHANGE on this node, and nothing else.
 *
 * ⚠️ THIS IS A SEPARATE FILE FROM read-proxy.js ON PURPOSE. There is a test that greps read-proxy
 * for HTTP verbs and asserts none appear — `!== 'GET'` is present, `'POST':` is not. That guard is
 * worth keeping exactly as it is: the read surface should stay provably read-only, and mixing
 * writes into it would delete a property in order to add a feature.
 *
 * The shape mirrors READABLE deliberately — an exact path, the grant it needs, and matching that is
 * segment-exact — because the failure modes are the same ones and the read proxy already learned
 * them. What differs is that a write rule also pins its METHOD, and that authorization has a second
 * axis: the workspace. A read grant degrades gracefully when it is too narrow (you see less); a
 * write applied to the wrong target is the wrong content on somebody's screen.
 *
 * ⚠️ NOTHING THAT TOUCHES BYTES IS HERE. Media files do not fit this transport (the envelope caps a
 * batch at 512 KB against a 500 MB upload limit) and they are not going to arrive by accident
 * through a JSON path. Content distribution is its own channel and its own decision.
 *
 * ⚠️ NOTHING PRIVILEGED IS HERE, and it is an allowlist rather than a blocklist so that a route
 * added to this server later is refused until somebody deliberately adds it. Never reachable, by
 * construction: users, roles, workspace membership, API tokens, SSO, billing, org settings, the
 * node's own mesh state (a hub that could widen its own grant has defeated the entire design), and
 * anything at the server level — restart, update, config, log retention.
 */
const WRITABLE = Object.freeze([
  // Playlist composition. The hub manages what plays; it does not upload what plays.
  { pattern: '/api/playlists',                     method: 'POST',   grant: 'content-push' },
  { pattern: '/api/playlists/:id',                 method: 'PUT',    grant: 'content-push' },
  { pattern: '/api/playlists/:id/items',           method: 'POST',   grant: 'content-push' },
  { pattern: '/api/playlists/:id/items/:itemId',   method: 'PUT',    grant: 'content-push' },
  { pattern: '/api/playlists/:id/items/:itemId',   method: 'DELETE', grant: 'content-push' },
  { pattern: '/api/playlists/:id/publish',         method: 'POST',   grant: 'content-push' },
  { pattern: '/api/playlists/:id/assign',          method: 'POST',   grant: 'content-push' },
]);

/*
 * ⚠️ Segment-exact, and copied from read-proxy rather than shared — because the day someone
 * loosens one matcher, the other must not loosen with it. `.` and `..` are refused explicitly:
 * they are legal path segments that satisfy "some non-empty value", which is how a matcher gets
 * walked out of its own rule.
 */
function matchPath(path, method) {
  const got = String(path || '').split('?')[0].split('/');
  const verb = String(method || '').toUpperCase();
  for (const rule of WRITABLE) {
    if (rule.method !== verb) continue;
    const want = rule.pattern.split('/');
    if (want.length !== got.length) continue;
    let ok = true;
    for (let i = 0; i < want.length; i++) {
      if (want[i].startsWith(':')) {
        const v = got[i];
        if (!v || v === '.' || v === '..' || v.includes('%2f') || v.includes('%2F')) { ok = false; break; }
      } else if (want[i] !== got[i]) { ok = false; break; }
    }
    if (ok) return rule;
  }
  return null;
}

function isWritable(path, method) {
  return !!matchPath(path, method);
}

/**
 * May this edge perform this write, on this workspace?
 *
 * ⚠️ `workspaceId` is resolved BY THE CALLER FROM THIS NODE'S OWN ROWS — it is the workspace the
 * target object actually belongs to, never a value the parent sent. A parent naming its own scope
 * is a parent choosing its own permission, which is the defect this whole design exists to close.
 *
 * @param {object}   edge         the edge the request arrived on (child side)
 * @param {string}   path
 * @param {string}   method
 * @param {string[]} writeGrant   the edge's stored write categories
 * @param {string[]} writeScope   the edge's stored workspace scope
 * @param {string}   workspaceId  the workspace the TARGET belongs to, resolved locally
 */
/*
 * ⚠️ ONE refusal string for every "no", and it is exported so the executor uses the identical one.
 *
 * A target that does not exist and a target that is not yours must be indistinguishable, or the
 * write door becomes an oracle: a parent could enumerate which playlists exist on someone else's
 * server purely by telling two refusals apart. Deliberately does not say WHICH half of the grant
 * failed either — "you have the category but not this workspace" tells a caller how to probe for
 * the scope. The operator on this node can see the whole grant on their own page, which is the
 * only place that answer belongs.
 */
const REFUSED = 'That is not something this connection may change. Write access is granted by this ' +
                "server's operator, per workspace — ask them if you believe it should be allowed.";

function authorizeWrite(edge, path, method, writeGrant, writeScope, workspaceId) {
  const rule = matchPath(path, method);
  if (!rule) {
    // Same refusal for "no such route" and "not permitted": a parent has no business mapping this
    // server's API surface, and only needs to know the answer is no.
    return { ok: false, reason: REFUSED };
  }
  if (!grantsLib.writeAllows(writeGrant, writeScope, rule.grant, workspaceId)) {
    /*
     * Deliberately does not say WHICH half failed. "You have the category but not this workspace"
     * tells a caller how to probe for the scope; the operator on this node can see the whole grant
     * on their own page, which is the only place that answer belongs.
     */
    return { ok: false, reason: REFUSED };
  }
  return { ok: true, rule };
}

module.exports = { WRITABLE, REFUSED, matchPath, isWritable, authorizeWrite };
