'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { digestFile, digestFilename } = require('../content-digest');
const grants = require('./grants');

/*
 * Receiving content a hub wants to put on this node's screens.
 *
 * ⚠️ THE ORDER IS THE DESIGN, AND IT IS NOT NEGOTIABLE:
 *
 *   stage -> verify -> rename -> commit metadata -> (only then) the playlist write
 *
 * Every other order has a known failure, and two of them are documented incidents in this codebase:
 *
 *   COMMIT BEFORE RENAME — the content row names a file that does not exist yet, and
 *   refreshContentRevs re-stamps that filepath onto every panel's payload AT SEND TIME. Panels
 *   fetch it and 404. That is the "replacing an asset 404'd every web and BrightSign panel"
 *   incident, reproduced deliberately.
 *
 *   RENAME BEFORE VERIFY — a corrupt or truncated asset goes live under Cache-Control immutable
 *   for 30 days, and Android's cache validates the BYTE COUNT rather than the content, so a short
 *   file with a matching Content-Length is promoted as valid.
 *
 *   PUBLISH BEFORE EVERYTHING IS PRESENT — the player declares its URL list to the service worker
 *   as the COMPLETE set with prune:true, so a half-transferred playlist does not merely fail to
 *   play the new item, it EVICTS the cached bytes of everything that was working. On exactly the
 *   site whose link was bad enough to make the transfer slow.
 *
 * ⚠️ ALL OR NOTHING. If any asset fails, nothing is committed and the node's state is identical to
 * before. There is no "apply 4 of 6": a short playlist that publishes successfully is the silent
 * failure — the operator is told it worked and the wall is missing two items.
 */

const MAX_MANIFEST_ENTRIES = 500;   // matches the envelope's item cap

function parseList(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string' || !v) return [];
  try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch (e) { return []; }
}

/**
 * Given a hub's manifest, what does this node actually need?
 *
 * ⚠️ "Have a row" is NOT the same as "have the bytes". In a typical library a large fraction of
 * content rows have no file on disk — restores, migrations, and manual cleanups all produce them.
 * A check that stops at the row would report a playlist ready and then play nothing.
 *
 * @returns {{ok:true, need:Array, have:Array, cannot:Array, bytesNeeded:number}
 *          |{ok:false, reason:string}}
 */
function evaluateManifest(db, edge, manifest, deps = {}) {
  const contentDir = deps.contentDir;
  if (!contentDir) return { ok: false, reason: 'This server is not configured to receive content.' };

  const entries = (manifest && Array.isArray(manifest.content)) ? manifest.content : null;
  if (!entries) return { ok: false, reason: 'That manifest is not readable.' };
  if (entries.length > MAX_MANIFEST_ENTRIES) {
    return {
      ok: false,
      reason: `That manifest lists ${entries.length} items; this server takes ` +
              `${MAX_MANIFEST_ENTRIES} at a time. Send it in pages.`,
    };
  }

  const originNodeId = edge && edge.peer_node_id;
  const need = []; const have = []; const cannot = [];

  for (const e of entries) {
    if (!e || typeof e.oid !== 'string') { cannot.push({ oid: null, why: 'An entry had no id.' }); continue; }

    /*
     * Remote and YouTube items have no local bytes and never will. They still need a ROW — the
     * child's own playlist route refuses an item whose content_id does not resolve — so they
     * participate fully in the metadata closure and not at all in the byte closure. Listing them
     * explicitly is also what lets a hub say "3 of 9 items will not work offline on this site"
     * rather than succeeding quietly.
     */
    if (e.kind === 'remote' || e.kind === 'youtube') {
      have.push({ oid: e.oid, matched: 'no-bytes', kind: e.kind });
      continue;
    }

    const prov = db.prepare(`SELECT local_content_id FROM mesh_content_provenance
                              WHERE origin_node_id = ? AND origin_content_id = ?`)
      .get(originNodeId, e.oid);

    if (prov) {
      const row = db.prepare('SELECT id, filepath, byte_digest FROM content WHERE id = ?')
        .get(prov.local_content_id);
      // ⚠️ The row can exist while the bytes do not. Check the disk, not the database.
      const onDisk = row && row.filepath &&
        fs.existsSync(path.join(contentDir, path.basename(row.filepath)));
      if (row && onDisk && (!e.dg || !row.byte_digest || row.byte_digest === e.dg)) {
        have.push({ oid: e.oid, localId: row.id, matched: 'provenance' });
        continue;
      }
      need.push({ oid: e.oid, why: onDisk ? 'digest-mismatch' : 'bytes-missing', sz: Number(e.sz) || 0 });
      continue;
    }

    /*
     * No provenance, but we may already hold these exact bytes from somewhere else — a sibling
     * site, an earlier manual upload, the same stock clip. Costs one indexed lookup and saves the
     * entire transfer.
     */
    if (e.dg) {
      const byDigest = db.prepare('SELECT id, filepath FROM content WHERE byte_digest = ? LIMIT 1').get(e.dg);
      if (byDigest && byDigest.filepath &&
          fs.existsSync(path.join(contentDir, path.basename(byDigest.filepath)))) {
        have.push({ oid: e.oid, localId: byDigest.id, matched: 'digest' });
        continue;
      }
    }
    need.push({ oid: e.oid, why: 'absent', sz: Number(e.sz) || 0 });
  }

  const bytesNeeded = need.reduce((n, x) => n + (x.sz || 0), 0);
  return { ok: true, need, have, cannot, bytesNeeded };
}

/**
 * May this edge send us these bytes at all?
 *
 * ⚠️ CHECKED BEFORE ANY BYTES MOVE. A transfer that discovers the limit halfway has already spent
 * the disk it was meant to protect, and leaves a half-populated playlist to explain. The same
 * applies to free space: refuse at negotiation, never mid-transfer.
 */
function admitTransfer(edge, bytesNeeded, deps = {}) {
  const grant = parseList(edge && edge.write_grant);
  if (!grant.includes('content-push')) {
    return { ok: false, reason: 'This connection may not send content to this server.' };
  }

  const budget = typeof edge.write_bytes_budget === 'number' ? edge.write_bytes_budget : null;
  const used = Number(edge.write_bytes_used) || 0;
  if (!grants.budgetAllows(budget, used, bytesNeeded)) {
    return {
      ok: false,
      reason: budget === null
        ? 'This connection has no storage allowance on this server.'
        : `That needs ${grants.describeBytes(bytesNeeded)}, and only ` +
          `${grants.describeBytes(Math.max(0, budget - used))} of the ` +
          `${grants.describeBytes(budget)} allowance is left.`,
    };
  }

  /*
   * ⚠️ And the disk itself, which the allowance knows nothing about. A budget is what the operator
   * agreed to give; free space is what the machine actually has, and the second can be smaller. A
   * full disk on a signage server takes the screens down with it.
   */
  const freeFloor = typeof deps.freeFloorBytes === 'number' ? deps.freeFloorBytes : 1024 * 1024 * 1024;
  const free = typeof deps.freeBytes === 'function' ? deps.freeBytes() : null;
  if (free !== null && free - bytesNeeded < freeFloor) {
    return {
      ok: false,
      reason: `This server does not have room for ${grants.describeBytes(bytesNeeded)} right now.`,
    };
  }
  return { ok: true };
}

/**
 * Commit one staged asset: verify, rename, insert, record provenance — in a single transaction.
 *
 * @param {string} stagedPath  the `.part` file already written to contentDir
 * @param {object} entry       the manifest entry it was staged for
 */
async function commitStagedAsset(db, edge, entry, stagedPath, deps) {
  const { contentDir, sniffExt, workspaceId, userId, now = () => Date.now() } = deps;

  let stat;
  try { stat = fs.statSync(stagedPath); } catch (e) {
    return { ok: false, reason: 'The transferred file is not there.' };
  }

  // ⚠️ Size from the DISK, never from the wire. The manifest is a claim; statSync is a fact.
  if (typeof entry.sz === 'number' && stat.size !== entry.sz) {
    return { ok: false, reason: `That file arrived ${stat.size} bytes, not the ${entry.sz} promised.` };
  }

  const digest = await digestFile(stagedPath);
  if (!digest) return { ok: false, reason: 'The transferred file could not be read back.' };
  if (entry.dg && entry.dg !== digest) {
    return { ok: false, reason: 'The transferred file does not match its checksum.' };
  }

  /*
   * ⚠️ SNIFFED HERE TOO. A hub is an authenticated remote writer running a version we do not
   * control — exactly the caller the upload sniffer exists for. Trusting the peer's declared type
   * because "the hub checked" is letting the sender choose the extension the browser interprets.
   */
  const ext = sniffExt(stagedPath);
  if (!ext) return { ok: false, reason: 'That file is not a type this server accepts.' };

  const finalName = digestFilename(digest, ext);
  const finalPath = path.join(contentDir, finalName);

  try {
    // Same filesystem, so the rename is atomic. If the bytes are already here under this exact
    // name, they are byte-identical by construction — drop the duplicate rather than rewrite it.
    if (fs.existsSync(finalPath)) fs.unlinkSync(stagedPath);
    else fs.renameSync(stagedPath, finalPath);
  } catch (e) {
    return { ok: false, reason: 'That file could not be stored.' };
  }

  const ts = Math.floor(now() / 1000);
  const localId = crypto.randomUUID();
  const commit = db.transaction(() => {
    db.prepare(`INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type,
                                     file_size, byte_digest, duration_sec, width, height,
                                     created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(localId, userId, workspaceId, entry.fn || finalName, finalName,
           entry.mt || 'application/octet-stream', stat.size, digest,
           entry.dur ?? null, entry.w ?? null, entry.h ?? null, ts, ts);

    db.prepare(`INSERT INTO mesh_content_provenance
                  (origin_node_id, origin_content_id, local_content_id, edge_id, bytes,
                   first_seen_at, last_seen_at)
                VALUES (?,?,?,?,?,?,?)
                ON CONFLICT(origin_node_id, origin_content_id) DO UPDATE SET
                  local_content_id = excluded.local_content_id,
                  last_seen_at     = excluded.last_seen_at`)
      .run(edge.peer_node_id, entry.oid, localId, edge.id, stat.size, ts, ts);

    // The allowance is spent here, in the same transaction as the row that spent it. Accounting
    // that happens separately is accounting that drifts.
    db.prepare('UPDATE mesh_edges SET write_bytes_used = COALESCE(write_bytes_used,0) + ? WHERE id = ?')
      .run(stat.size, edge.id);
  });
  commit();

  return { ok: true, localId, filepath: finalName, digest, bytes: stat.size };
}

module.exports = { evaluateManifest, admitTransfer, commitStagedAsset, MAX_MANIFEST_ENTRIES };
