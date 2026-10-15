'use strict';

/*
 * The fallback for any CMS without an API we support: a zip of media, optionally with CSVs.
 *
 *   - every image / video / audio file in the zip is imported (the bytes are sniffed at ingest, so a
 *     misnamed file is caught there, not trusted here); anything else is listed as not imported;
 *   - playlists.csv (optional) — columns: playlist, file, duration (seconds, optional), order
 *     (optional). `file` is the path inside the zip. Rows keep their order unless `order` says;
 *   - without playlists.csv, every folder that directly holds media becomes a playlist of those
 *     files, in name order (images 10 s, videos their own length);
 *   - screens.csv (optional) — columns: name, group (optional; several separated by ";"), playlist
 *     (optional). Each row becomes an unpaired placeholder; groups are created.
 *
 * Column names are matched case-insensitively and a few common synonyms are accepted (see COLS).
 */

const path = require('path');
const { openZip, uploadPath, userError } = require('./zip');
const map = require('../map');

const COLS = {
  playlist: ['playlist', 'playlist name', 'loop', 'channel', 'show'],
  file: ['file', 'filename', 'file name', 'path', 'media', 'asset'],
  duration: ['duration', 'seconds', 'duration_sec', 'duration (s)', 'time'],
  order: ['order', 'position', 'sort', 'index', '#'],
  name: ['name', 'screen', 'display', 'screen name', 'display name', 'player'],
  group: ['group', 'groups', 'tag', 'tags', 'location'],
};

function table(text) {
  const { parseCsv } = require('../../data-sources/tabular');
  const { rows } = parseCsv(text);
  const clean = rows.filter((r) => r.some((c) => String(c || '').trim()));
  if (!clean.length) return [];
  const header = clean[0].map((h) => String(h || '').trim().toLowerCase());
  const idx = {};
  for (const [k, names] of Object.entries(COLS)) {
    const i = header.findIndex((h) => names.includes(h));
    if (i >= 0) idx[k] = i;
  }
  return clean.slice(1).map((r) => {
    const o = {};
    for (const [k, i] of Object.entries(idx)) o[k] = String(r[i] == null ? '' : r[i]).trim();
    return o;
  });
}

module.exports = {
  id: 'generic-zip',
  name: 'Folder of media (zip)',
  mode: 'file',
  docs: [],
  fields: [],

  checkCredentials(cred) {
    if (!cred || !cred.upload_path) throw userError('Upload a .zip file.');
    return { cred: { upload_path: cred.upload_path }, upload_path: cred.upload_path, label: cred.label || '' };
  },

  async open(cred, { uploadDir }) {
    const abs = uploadPath(uploadDir, cred && cred.upload_path);
    if (!abs) throw userError('The uploaded file has expired. Upload it again.');
    const zip = await openZip(abs);
    return {
      async scan() {
        const unmapped = [];
        const media = [];
        const byPath = new Map();
        for (const e of zip.entries) {
          const base = path.posix.basename(e.name);
          if (/\.csv$/i.test(base)) continue;
          const kind = map.kindOf(base);
          if (!kind) { unmapped.push({ kind: 'file', name: e.name, reason: 'Not an image, video or audio file.' }); continue; }
          const m = { id: e.name, name: base, kind, size: e.size, ref: e.name };
          media.push(m);
          byPath.set(e.name.toLowerCase(), m);
        }

        const playlists = [];
        const csvName = zip.entries.find((e) => /(^|\/)playlists?\.csv$/i.test(e.name));
        if (csvName) {
          const rows = table(await zip.text(csvName.name));
          const lists = new Map();
          rows.forEach((r, i) => {
            if (!r.playlist || !r.file) return;
            const m = byPath.get(r.file.replace(/\\/g, '/').replace(/^\.?\/+/, '').toLowerCase())
              || media.find((x) => x.name.toLowerCase() === path.posix.basename(r.file).toLowerCase());
            if (!m) { unmapped.push({ kind: 'playlist item', name: `${r.playlist}: ${r.file}`, reason: 'That file is not in the zip.' }); return; }
            if (!lists.has(r.playlist)) lists.set(r.playlist, []);
            lists.get(r.playlist).push({ media_id: m.id, duration: map.seconds(r.duration), order: r.order !== '' && Number.isFinite(Number(r.order)) ? Number(r.order) : i });
          });
          for (const [name, items] of lists) {
            items.sort((a, b) => a.order - b.order);
            playlists.push({ id: `csv:${name}`, name, items: items.map(({ media_id, duration }) => ({ media_id, duration })) });
          }
        } else {
          const folders = new Map();
          for (const m of media) {
            const dir = path.posix.dirname(m.ref);
            if (dir === '.') continue;
            if (!folders.has(dir)) folders.set(dir, []);
            folders.get(dir).push(m);
          }
          for (const [dir, list] of [...folders].sort((a, b) => a[0].localeCompare(b[0]))) {
            list.sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }));
            playlists.push({ id: `dir:${dir}`, name: dir.split('/').join(' / '), items: list.map((m) => ({ media_id: m.id, duration: null })) });
          }
        }

        const screens = [], groups = [];
        const screensCsv = zip.entries.find((e) => /(^|\/)screens?\.csv$|(^|\/)displays?\.csv$/i.test(e.name));
        if (screensCsv) {
          const gids = new Map();
          table(await zip.text(screensCsv.name)).forEach((r, i) => {
            if (!r.name) return;
            const g = (r.group || '').split(/[;|]/).map((x) => x.trim()).filter(Boolean);
            for (const n of g) if (!gids.has(n.toLowerCase())) { gids.set(n.toLowerCase(), `g:${n.toLowerCase()}`); groups.push({ id: `g:${n.toLowerCase()}`, name: n }); }
            const pl = r.playlist ? playlists.find((p) => p.name.toLowerCase() === r.playlist.toLowerCase()) : null;
            screens.push({ id: `s:${i}:${r.name}`, name: r.name, group_ids: g.map((n) => gids.get(n.toLowerCase())), playlist_id: pl ? pl.id : null });
          });
        }
        // The same zip uploaded twice is the same source (a re-run reuses what it made); a different
        // zip that happens to reuse a file name is not. Keyed on the archive's own listing + CRCs.
        const account = 'zip:' + require('crypto').createHash('sha256')
          .update(zip.entries.map((e) => `${e.name}\u0000${e.size}\u0000${e.entry.crc32 >>> 0}`).sort().join('\n')).digest('hex').slice(0, 32);
        return { account, label: '', media, playlists, layouts: [], schedules: [], screens, groups, unmapped };
      },
      fetchMedia(m, dest, maxBytes) { return zip.toFile(m.ref, dest, maxBytes); },
      close() {},
    };
  },
};
