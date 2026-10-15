'use strict';

/*
 * Screenly (cloud), API v4.1. Written against:
 *   https://developer.screenly.io/api_v4_1/                                   (reference + examples)
 *   https://www.screenly.io/docs/developers/overview/api-tokens/              (tokens)
 *   https://www.screenly.io/docs/scheduling/advanced/predicates/              (playlist predicates)
 *
 * Fixed host: https://api.screenlyapp.com/api/v4.1. Header `Authorization: Token <token>`.
 * Paging: limit/offset (PostgREST). Rate limits are not documented; 429 + Retry-After is honoured.
 *
 * Mapping:
 *   assets (image / video / audio with asset_url) -> media; web pages and apps -> not imported
 *   playlists + playlist-items (position order)     -> playlists
 *   labels                                          -> groups (a screen's own same-named label targets that screen)
 *   screens                                         -> placeholders, with their labels as groups
 *   playlist predicate x the playlist's labels      -> schedules: $WEEKDAY IN {...}, $TIME BETWEEN {a,b},
 *                                                      $DATE >= / <= / BETWEEN joined with AND; anything with OR
 *                                                      or another form is listed as not imported
 * Screenly has no layouts or zones.
 */

const { client } = require('../transport');
const { offsetPages, truncatedNote, userError, str } = require('./common');
const map = require('../map');

const BASE = 'https://api.screenlyapp.com/api/v4.1';

/*
 * A predicate of AND-joined clauses -> { byDay, from 'HH:MM', to 'HH:MM', startDate, endDate } or null.
 * $WEEKDAY is 0 = Monday ... 6 = Sunday; $TIME is ms since local midnight; $DATE is epoch ms of the day.
 */
function parsePredicate(pred) {
  const p = String(pred || '').trim();
  if (!p || /\bOR\b/i.test(p) || /\bNOT\b/i.test(p)) return p && !/^TRUE$/i.test(p) ? null : {};
  const out = {};
  const hm = (ms) => { const m = Math.max(0, Math.min(1439, Math.round(Number(ms) / 60000))); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
  const day = (ms) => new Date(Number(ms)).toISOString().slice(0, 10);
  for (let clause of p.split(/\bAND\b/i)) {
    clause = clause.trim().replace(/^\(+|\)+$/g, '').trim();
    let m;
    if (!clause || /^TRUE$/i.test(clause)) continue;
    if ((m = /^\$WEEKDAY\s+IN\s*\{([\d,\s]+)\}$/i.exec(clause))) { out.byDay = m[1].split(',').map((x) => (Number(x) + 1) % 7); continue; }
    if ((m = /^\$TIME\s+BETWEEN\s*\{\s*(\d+)\s*,\s*(\d+)\s*\}$/i.exec(clause))) { out.from = hm(m[1]); out.to = hm(m[2]); continue; }
    if ((m = /^\$DATE\s+BETWEEN\s*\{\s*(\d+)\s*,\s*(\d+)\s*\}$/i.exec(clause))) { out.startDate = day(m[1]); out.endDate = day(m[2]); continue; }
    if ((m = /^\$DATE\s*>=?\s*(\d+)$/i.exec(clause))) { out.startDate = day(m[1]); continue; }
    if ((m = /^\$DATE\s*<=?\s*(\d+)$/i.exec(clause))) { out.endDate = day(m[1]); continue; }
    return null;
  }
  return out;
}

module.exports = {
  id: 'screenly',
  name: 'Screenly',
  mode: 'api',
  docs: ['https://developer.screenly.io/api_v4_1/', 'https://www.screenly.io/docs/developers/overview/api-tokens/'],
  fields: [{ key: 'token', type: 'secret', required: true }],
  parsePredicate,

  checkCredentials(cred) {
    const token = str(cred.token, 500).trim().replace(/^Token\s+/i, '');
    if (!/^\S{8,500}$/.test(token)) throw userError('Paste the API token from Screenly (Settings, Security, Tokens).');
    return { cred: { token }, label: 'Screenly' };
  },

  async open(cred) {
    if (!cred) throw userError('Enter the Screenly token again.');
    const c = client(BASE, { Authorization: `Token ${cred.token}` });
    const list = (path) => offsetPages(async (offset, limit) => {
      const { body } = await c.api(path, { query: { limit, offset } });
      return { rows: Array.isArray(body) ? body : [] };
    });

    return {
      async scan() {
        const unmapped = [];
        const assetsR = await list('/assets');
        const plR = await list('/playlists');
        const itemsR = await list('/playlist-items');
        const labelsR = await list('/labels');
        const lsR = await list('/labels/screens');
        const lpR = await list('/labels/playlists');
        const scrR = await list('/screens');
        for (const [k, r] of [['media', assetsR], ['playlists', plR], ['screens', scrR]]) truncatedNote(unmapped, k, r.truncated);

        const media = [];
        const mediaIds = new Set();
        for (const a of assetsR.rows) {
          const kind = map.kindOf(a.mimetype || `${a.type}/`);
          if (!kind || !a.asset_url) { unmapped.push({ kind: 'media', name: str(a.title), reason: `Screenly "${str(a.type, 30)}" assets are not media files; recreate them as a ScreenTinker widget.` }); continue; }
          if (a.status && a.status !== 'finished') { unmapped.push({ kind: 'media', name: str(a.title), reason: 'Screenly has not finished processing it.' }); continue; }
          media.push({ id: String(a.id), name: str(a.title), kind, size: Number(a.source_size) || 0, ext: String(a.mimetype || '').split('/')[1] || '', ref: { url: String(a.asset_url) } });
          mediaIds.add(String(a.id));
        }

        const byPlaylist = new Map();
        for (const it of itemsR.rows) {
          if (!byPlaylist.has(String(it.playlist_id))) byPlaylist.set(String(it.playlist_id), []);
          byPlaylist.get(String(it.playlist_id)).push(it);
        }
        const playlists = plR.rows.map((p) => {
          const items = (byPlaylist.get(String(p.id)) || []).sort((a, b) => (a.position || 0) - (b.position || 0));
          const kept = items.filter((it) => mediaIds.has(String(it.asset_id))).map((it) => ({ media_id: String(it.asset_id), duration: map.seconds(it.duration) }));
          const notes = kept.length < items.length ? [`${items.length - kept.length} item(s) that are not imported media were left out.`] : [];
          if (p.is_enabled === false) notes.push('It was disabled in Screenly.');
          return { id: String(p.id), name: str(p.title), items: kept, notes };
        });

        /* labels: a label named exactly like a screen is that screen's own */
        const screenIds = new Set(scrR.rows.map((s) => String(s.id)));
        const labelScreens = new Map();
        for (const ls of lsR.rows) {
          if (!labelScreens.has(String(ls.label_id))) labelScreens.set(String(ls.label_id), []);
          labelScreens.get(String(ls.label_id)).push(String(ls.screen_id));
        }
        const screenName = new Map(scrR.rows.map((s) => [String(s.id), str(s.name)]));
        const ownLabel = new Map();   // label id -> screen id
        const groups = [];
        for (const l of labelsR.rows) {
          const members = labelScreens.get(String(l.id)) || [];
          if (members.length === 1 && screenName.get(members[0]) === str(l.name)) { ownLabel.set(String(l.id), members[0]); continue; }
          groups.push({ id: String(l.id), name: str(l.human_name || l.name) });
        }
        const groupIds = new Set(groups.map((g) => g.id));
        const screens = scrR.rows.map((s) => ({
          id: String(s.id), name: str(s.name),
          group_ids: lsR.rows.filter((x) => String(x.screen_id) === String(s.id) && groupIds.has(String(x.label_id))).map((x) => String(x.label_id)),
        }));
        const tzOf = new Map(scrR.rows.filter((s) => map.isZone(s.timezone)).map((s) => [String(s.id), s.timezone]));

        const schedules = [];
        for (const p of plR.rows) {
          const labels = lpR.rows.filter((x) => String(x.playlist_id) === String(p.id)).map((x) => String(x.label_id));
          if (!labels.length) continue;
          const parsed = parsePredicate(p.predicate);
          if (!parsed) { unmapped.push({ kind: 'schedule', name: str(p.title), reason: 'Its schedule rule uses OR or a form ScreenTinker cannot express. Schedule it by hand.' }); continue; }
          for (const lid of labels) {
            const screen = ownLabel.get(lid);
            const target = screen && screenIds.has(screen) ? { type: 'screen', id: screen } : groupIds.has(lid) ? { type: 'group', id: lid } : null;
            if (!target) continue;
            const members = screen ? [screen] : labelScreens.get(lid) || [];
            const tz = members.map((m) => tzOf.get(m)).find(Boolean) || 'UTC';
            const startDate = parsed.startDate || '2000-01-01';
            const recurring = parsed.byDay || parsed.from;
            schedules.push({
              id: `${p.id}:${lid}`, name: str(p.title), target, playlist_id: String(p.id), timezone: tz, priority: p.priority ? 10 : 0,
              start: `${startDate}T${parsed.from || '00:00'}`,
              end: recurring ? `${startDate}T${parsed.to || '23:59'}` : `${parsed.endDate || '2099-12-31'}T23:59`,
              recurrence: recurring ? { freq: parsed.byDay ? 'WEEKLY' : 'DAILY', byDay: parsed.byDay || null, until: parsed.endDate || null } : null,
              notes: [],
            });
          }
        }
        return { account: 'screenly:' + str((assetsR.rows[0] || plR.rows[0] || scrR.rows[0] || {}).team_id, 100), label: 'Screenly', media, playlists, layouts: [], schedules, screens, groups, unmapped };
      },
      fetchMedia(m, dest, maxBytes) { return c.download(m.ref.url, dest, maxBytes); },
      close() { c.setAuth({}); },
    };
  },
};
