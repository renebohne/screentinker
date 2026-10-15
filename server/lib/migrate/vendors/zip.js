'use strict';

/*
 * Reading an uploaded archive for lib/migrate (the generic "folder of media + CSV" zip, and vendor
 * export files that are zips). Nothing is ever extracted to a path the archive names: entries are
 * listed from the central directory, small text entries are inflated into memory with a real-byte
 * cap (lib/zip-inflate), and media entries are streamed straight to the <uuid>.part file the ingest
 * path chose — so a `../../etc/passwd` entry name is just a string in a list.
 *
 * Symlink entries, directories, macOS resource forks (__MACOSX/, ._x) and dot files are skipped.
 */

const path = require('path');
const unzipper = require('unzipper');
const { inflateCapped, inflateToFileCapped } = require('../../zip-inflate');

const MAX_ENTRIES = 20000;
const TEXT_CAP = 8 * 1024 * 1024;

function userError(msg) { const e = new Error(msg); e.userMessage = msg; return e; }

async function openZip(absPath) {
  let directory;
  try { directory = await unzipper.Open.file(absPath); }
  catch { throw userError('The file is not a readable zip archive.'); }
  const all = directory.files || [];
  if (all.length > MAX_ENTRIES) throw userError(`The archive has more than ${MAX_ENTRIES} entries.`);
  const entries = [];
  for (const e of all) {
    if (e.type !== 'File') continue;
    const mode = (e.externalFileAttributes >>> 16) & 0o170000;
    if (mode === 0o120000) continue;                    // symlink
    const name = String(e.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!name || name.split('/').some((seg) => seg === '..' || seg.startsWith('.')) || name.startsWith('__MACOSX/')) continue;
    entries.push({ name, size: Number(e.uncompressedSize) || 0, entry: e });
  }
  const byName = new Map(entries.map((x) => [x.name, x]));
  const byLower = new Map(entries.map((x) => [x.name.toLowerCase(), x]));
  return {
    entries,
    find(name) {
      const n = String(name || '').replace(/\\/g, '/').replace(/^\.?\/+/, '');
      return byName.get(n) || byLower.get(n.toLowerCase()) || null;
    },
    async text(name, cap = TEXT_CAP) {
      const x = this.find(name);
      if (!x) return null;
      const buf = await inflateCapped(x.entry, Math.min(cap, Math.max(1, x.size || cap)),
        (kind) => userError(kind === 'too-large' ? `${path.basename(name)} is too large.` : `${path.basename(name)} is damaged.`));
      return buf.toString('utf8');
    },
    async toFile(name, dest, maxBytes) {
      const x = this.find(name);
      if (!x) throw userError('The file is missing from the archive.');
      if (x.size > maxBytes) throw Object.assign(new Error('too large'), { code: 'too_large' });
      const cap = Math.min(maxBytes, x.size || maxBytes);
      const size = await inflateToFileCapped(x.entry, dest, cap, null,
        (kind) => (kind === 'too-large' ? Object.assign(new Error('too large'), { code: 'too_large' }) : userError('The file is damaged in the archive.')));
      return { size };
    },
  };
}

/** The absolute path of an upload a job names, contained to the upload directory. */
function uploadPath(uploadDir, name) {
  const { resolveWithin } = require('../../safe-path');
  return resolveWithin(uploadDir, path.basename(String(name || '')));
}

module.exports = { openZip, uploadPath, userError, MAX_ENTRIES };
