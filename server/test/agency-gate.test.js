'use strict';

// #73 mount seam: agencyGate does SCOPE/off-ladder confinement ONLY (only an agency token
// reaches the agency router). The per-target check moved to router.param('playlistId') in
// routes/agency.js, because Express doesn't populate req.params at mount-level middleware -
// so the target restriction is proven on the REAL runtime path by test/agency.test.js
// (the integration bite-suite), not here.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

// agencyGate needs no db now, but requiring the module loads db/database - inject a stub.
require.cache[require.resolve('../db/database')] = {
  id: require.resolve('../db/database'), loaded: true, exports: { db: new Database(':memory:') },
};
const { agencyGate } = require('../middleware/apiToken');

function gate(over = {}) {
  const req = { viaToken: true, tokenScope: 'agency', ...over };
  let status = 200, nexted = false;
  const res = { status(s) { status = s; return this; }, json() { return this; } };
  agencyGate(req, res, () => { nexted = true; });
  return { status, nexted };
}

test('#73 agencyGate (mount seam): only agency tokens pass; non-agency + JWT rejected', () => {
  assert.equal(gate().nexted, true, 'agency token passes the scope seam');
  assert.equal(gate({ tokenScope: 'write' }).status, 403, 'read/write/full token -> 403');
  assert.equal(gate({ tokenScope: 'full' }).status, 403, 'full token -> 403');
  assert.equal(gate({ viaToken: false }).status, 403, 'JWT (not a token) -> 403');
});

test('agencyGate re-checks the owner\'s CURRENT role: a demoted (viewer) owner\'s agency token is refused', () => {
  assert.equal(gate({ workspaceRole: 'workspace_viewer' }).status, 403, 'owner demoted to viewer -> 403');
  assert.equal(gate({ workspaceRole: 'workspace_viewer' }).nexted, false);
  assert.equal(gate({ workspaceRole: 'workspace_editor' }).nexted, true, 'editor still passes');
  assert.equal(gate({ workspaceRole: null, actingAs: true }).nexted, true, 'org owner/admin (acting-as) still passes');
});
