'use strict';

const fs = require('fs');
const path = require('path');
const { db } = require('../db/database');
const config = require('../config');

/*
 * ⚠️ NEVER UNLINK A FILE ANOTHER ROW IS STILL USING.
 *
 * For most of this product's life one row meant one file, because every upload minted its own uuid
 * filename and two rows could not collide. Content received over the mesh is stored under the
 * sha256 of its bytes instead, so the same file legitimately backs one row per workspace — that is
 * tenancy working correctly, and it means a delete can no longer assume it owns what it points at.
 *
 * Without this check, deleting one customer's copy of a shared asset unlinks the bytes out from
 * under every other workspace holding it, and every panel that has not already cached the file
 * 404s. The thumbnail is worse: its name is derived from the filepath, so it is shared even when
 * only one row records a thumbnail_path of its own.
 *
 * ⚠️ It lives in lib/ rather than beside its first caller because "who else points at these bytes"
 * is one question with one answer, and the moment it is answered in two places they disagree. That
 * is the fan-out-helper lesson (lib/devices-playing.js) applied to deletion.
 *
 * Counted, not assumed. The column name is interpolated, so it is checked against a fixed set
 * first — it is never caller data, and this keeps it never being caller data by accident.
 */
const REFCOUNTED_COLUMNS = Object.freeze(['filepath', 'thumbnail_path', 'subtitle_url']);

function unlinkIfUnreferenced(rel, keeperId, column) {
  if (!rel) return { unlinked: false, reason: 'nothing to remove' };
  if (!REFCOUNTED_COLUMNS.includes(column)) throw new Error(`refusing to refcount on ${column}`);

  const base = path.basename(rel);
  const others = db.prepare(
    `SELECT COUNT(*) AS n FROM content
      WHERE ${column} IS NOT NULL AND ${column} != '' AND id != ?
        AND (${column} = ? OR ${column} LIKE ?)`,
  ).get(keeperId, base, `%/${base}`);

  if (others && others.n > 0) return { unlinked: false, reason: 'still referenced', others: others.n };

  const p = path.join(config.contentDir, base);
  if (!fs.existsSync(p)) return { unlinked: false, reason: 'already gone' };
  try {
    fs.unlinkSync(p);
    return { unlinked: true };
  } catch (e) {
    return { unlinked: false, reason: 'best-effort' };
  }
}

module.exports = { unlinkIfUnreferenced, REFCOUNTED_COLUMNS };
