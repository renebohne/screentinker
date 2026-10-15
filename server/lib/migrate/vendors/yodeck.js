'use strict';

/*
 * Yodeck, REST API v2 (Premium and Enterprise plans). Written against:
 *   https://app.yodeck.com/api-docs/                (reference; raw OpenAPI at /api-docs/bundle.yaml)
 *   https://www.yodeck.com/academy/api-token/        (creating a token)
 *
 * Fixed host: https://app.yodeck.com/api/v2. Header `Authorization: Token <label>:<token>`.
 * Paging: limit/offset, envelope { count, next, previous, results }. Rate limit: 21 requests per
 * 10 s per token on list endpoints, answered with 429 + Retry-After — lib/migrate/transport honours it.
 *
 * ⚠️ YODECK'S API DOES NOT HAND OUT UPLOADED ORIGINALS. The only file addresses in the spec are
 * arguments.download_from_url (media that was imported from a URL), arguments.play_from_url (the
 * transcoded video Yodeck plays) and thumbnail_url (a small render). So:
 *   - media with download_from_url  -> imported from that address
 *   - video without it              -> imported from play_from_url (Yodeck's transcode; said in the docs)
 *   - an uploaded image / audio / document without it -> NOT imported, listed with the reason; a
 *     thumbnail is never passed off as the original. The zip import covers those files.
 * Web pages and apps are not media and are listed as not imported.
 *
 * Screens are grouped by their tags (GET /screens?subset=basic adds basic.tags and time_zone); a
 * screen's content (playlist / layout) becomes its placeholder's playlist, and a screen showing a
 * schedule becomes the target of that schedule's events.
 */

const { client } = require('../transport');
const { offsetPages, truncatedNote, userError, str } = require('./common');
const map = require('../map');

const BASE = 'https://app.yodeck.com/api/v2';

module.exports = {
  id: 'yodeck',
  name: 'Yodeck',
  mode: 'api',
  docs: ['https://app.yodeck.com/api-docs/', 'https://www.yodeck.com/academy/api-token/'],
  fields: [
    { key: 'api_key', type: 'secret', required: true },
    { key: 'timezone', type: 'timezone', required: false },
  ],

  checkCredentials(cred) {
    const key = str(cred.api_key, 600).trim().replace(/^Token\s+/i, '');
    if (!/^[^\s:]{1,100}:[^\s]{8,500}$/.test(key)) throw userError('Paste the token as label:token (the label is the name you gave it in Yodeck).');
    const tz = str(cred.timezone, 64).trim();
    return { cred: { api_key: key, timezone: map.isZone(tz) ? tz : '' }, label: 'app.yodeck.com' };
  },

  async open(cred) {
    if (!cred) throw userError('Enter the Yodeck token again.');
    const c = client(BASE, { Authorization: `Token ${cred.api_key}` });
    const list = (path, extra = {}) => offsetPages(async (offset, limit) => {
      const { body } = await c.api(path, { query: { limit, offset, ...extra } });
      return { rows: (body && body.results) || [], total: body && Number(body.count) };
    });

    return {
      async scan() {
        const unmapped = [];
        const mediaR = await list('/media/');
        const plR = await list('/playlists/');
        const layR = await list('/layouts/');
        const schR = await list('/schedules/');
        const scrR = await list('/screens/', { subset: 'basic' });
        for (const [k, r] of [['media', mediaR], ['playlists', plR], ['layouts', layR], ['schedules', schR], ['screens', scrR]]) truncatedNote(unmapped, k, r.truncated);

        const media = [];
        const mediaIds = new Set();
        for (const m of mediaR.rows) {
          const type = m.media_origin && m.media_origin.type;
          const kind = map.kindOf(`${type}/`);
          const a = m.arguments || {};
          const name = str(m.name) + (m.file_extension && !/\.[a-z0-9]{2,5}$/i.test(str(m.name)) ? `.${str(m.file_extension, 8)}` : '');
          if (!kind) { unmapped.push({ kind: 'media', name: str(m.name), reason: `Yodeck "${str(type, 30)}" items are not media files; recreate them as a ScreenTinker widget.` }); continue; }
          if (m.status && m.status !== 'finished') { unmapped.push({ kind: 'media', name: str(m.name), reason: 'Yodeck has not finished processing it.' }); continue; }
          const url = a.download_from_url || (kind === 'video' ? a.play_from_url : null);
          if (!url) { unmapped.push({ kind: 'media', name: str(m.name), reason: 'Yodeck\'s API does not provide the original file. Download it from Yodeck and add it with the zip import.' }); continue; }
          media.push({ id: String(m.id), name, kind, size: 0, duration: map.seconds(a.duration || m.default_duration), ref: { url: String(url) } });
          mediaIds.add(String(m.id));
        }

        const itemsOf = (items, notes) => [...(items || [])].sort((x, y) => (x.priority || 0) - (y.priority || 0)).flatMap((it) => {
          if (it.type === 'media' && mediaIds.has(String(it.id))) return [{ media_id: String(it.id), duration: map.seconds(it.duration) }];
          notes.add(it.type === 'media' ? 'media that was not imported' : str(it.type, 30));
          return [];
        });

        const playlists = [];
        const plItems = new Map();
        for (const p of plR.rows) {
          const dropped = new Set();
          const items = itemsOf(p.items, dropped);
          plItems.set(String(p.id), items);
          const notes = dropped.size ? [`Items that are not imported media (${[...dropped].slice(0, 4).join(', ')}) were left out.`] : [];
          if (p.playback_options && p.playback_options.random_playback) notes.push('It played in random order; it now plays in order.');
          playlists.push({ id: String(p.id), name: str(p.name), items, notes });
        }

        const layouts = layR.rows.map((l) => ({
          id: String(l.id), name: str(l.name), width: l.resolution_width, height: l.resolution_height,
          zones: [...(l.regions || [])].sort((a, b) => (a.order || 0) - (b.order || 0)).map((r, i) => ({
            id: String(r.id), name: `Zone ${i + 1}`, left: r.left, top: r.top, width: r.width, height: r.height, z: r.zindex,
            items: r.item && r.item.type === 'playlist' ? (plItems.get(String(r.item.id)) || [])
              : r.item && r.item.type === 'media' && mediaIds.has(String(r.item.id)) ? [{ media_id: String(r.item.id), duration: null }] : [],
          })),
          notes: (l.regions || []).some((r) => r.item && !['playlist', 'media'].includes(r.item.type)) ? ['Widget zones were left empty.'] : [],
        }));

        /* screens: tags become groups */
        const groups = [];
        const tagId = new Map();
        const screens = [];
        const screensBySchedule = new Map();
        const tzOf = new Map();
        for (const s of scrR.rows) {
          const basic = s.basic || {};
          const gids = [];
          for (const tag of basic.tags || []) {
            const k = str(tag, 100).toLowerCase();
            if (!k) continue;
            if (!tagId.has(k)) { tagId.set(k, `tag:${k}`); groups.push({ id: `tag:${k}`, name: str(tag, 100) }); }
            gids.push(tagId.get(k));
          }
          const sc = s.screen_content || {};
          if (map.isZone(basic.time_zone)) tzOf.set(String(s.id), basic.time_zone);
          if (sc.source_type === 'schedule') {
            if (!screensBySchedule.has(String(sc.source_id))) screensBySchedule.set(String(sc.source_id), []);
            screensBySchedule.get(String(sc.source_id)).push(String(s.id));
          }
          screens.push({
            id: String(s.id), name: str(s.name), group_ids: gids,
            playlist_id: sc.source_type === 'playlist' ? String(sc.source_id) : null,
            layout_id: sc.source_type === 'layout' ? String(sc.source_id) : null,
          });
        }

        /* schedules: each event, aimed at every screen showing that schedule */
        const schedules = [];
        const FREQ = { d: 'DAILY', w: 'WEEKLY', m: 'MONTHLY', y: 'YEARLY' };
        for (const sch of schR.rows) {
          const targets = screensBySchedule.get(String(sch.id)) || [];
          if (!targets.length) { unmapped.push({ kind: 'schedule', name: str(sch.name), reason: 'No screen shows it, so there is nothing to aim it at.' }); continue; }
          if (sch.filler_content && sch.filler_content.source_id) unmapped.push({ kind: 'schedule', name: str(sch.name), reason: 'Its filler content is not imported; set the screens\' default playlist after pairing.' });
          for (const ev of sch.events || []) {
            const src = ev.source || {};
            const what = src.source_type === 'playlist' ? { playlist_id: String(src.source_id) } : src.source_type === 'layout' ? { layout_id: String(src.source_id) } : null;
            if (!what) { unmapped.push({ kind: 'schedule', name: `${str(sch.name)}: ${str(src.source_name)}`, reason: src.source_type === 'turned_off' ? 'Screen-off events are a power schedule in ScreenTinker; set one after pairing.' : 'Only playlist and layout events are imported.' }); continue; }
            const start = map.stamp(ev.start);
            if (!start) continue;
            const mins = Math.max(1, Number(ev.duration) || 0);
            const endInstant = Date.parse(`${start}:00Z`) + mins * 60000;
            const firstEnd = new Date(endInstant).toISOString().slice(0, 16);
            const rec = ev.recurrence && ev.recurrence !== 'o' ? {
              freq: FREQ[ev.recurrence] || String(ev.recurrence).toUpperCase(),
              interval: Number(ev.every) || 1,
              // days_of_week is a Monday-first bit string ("1111100" = Mon-Fri).
              byDay: /^[01]{7}$/.test(String(ev.days_of_week || '')) ? [...String(ev.days_of_week)].map((b, i) => (b === '1' ? (i + 1) % 7 : -1)).filter((d) => d >= 0) : null,
              until: ev.end ? String(ev.end).slice(0, 10) : null,
            } : null;
            const notes = [];
            if (ev.occurrences) notes.push(`It was limited to ${Number(ev.occurrences)} occurrences; it now runs until its end date.`);
            for (const sid of targets) {
              const tz = tzOf.get(sid) || cred.timezone || 'UTC';
              schedules.push({
                id: `${sch.id}:${ev.id}:${sid}`, name: `${str(sch.name)}: ${str(src.source_name)}`, target: { type: 'screen', id: sid }, ...what,
                start, end: firstEnd, timezone: tz, recurrence: rec, priority: Number(ev.priority) || 0,
                notes: tz === 'UTC' && !cred.timezone ? notes.concat('No time zone was known; the times were read as UTC. Check them.') : notes,
              });
            }
          }
        }
        // The Yodeck workspaces this token sees identify the account (two accounts imported into one
        // ScreenTinker workspace must not share an id map), without keeping anything from the token.
        const wsIds = [...new Set([...mediaR.rows, ...scrR.rows, ...plR.rows].map((x) => x.workspace && x.workspace.id).filter((x) => x != null).map(String))].sort();
        return { account: `yodeck:${wsIds.join(',').slice(0, 200)}`, label: 'Yodeck', media, playlists, layouts, schedules, screens, groups, unmapped };
      },
      fetchMedia(m, dest, maxBytes) { return c.download(m.ref.url, dest, maxBytes); },
      close() { c.setAuth({}); },
    };
  },
};
