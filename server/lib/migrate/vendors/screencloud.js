'use strict';

/*
 * ScreenCloud Studio, GraphQL API. Written against:
 *   https://screencloud.github.io/signage-next-graphql-docs/              (reference, get-an-api-token)
 *   .../graphql-reference/content-json-reference/playlist-content          (playlist `content` JSON)
 *   .../graphql-reference/content-json-reference/channel-content           (channel zones + rules)
 *   .../graphql-reference/content-json-reference/custom-layout-config      (layout config, zone CSS)
 *
 * Endpoint: the region's fixed host, https://graphql.eu.screencloud.com/graphql or
 * https://graphql.us.screencloud.com/graphql (the person picks the region shown on Studio's
 * Developer tab). Header `Authorization: Bearer <token>`. Paging: PostGraphile connections
 * (first / after / pageInfo). Errors arrive as HTTP 200 with errors[].
 *
 * Mapping:
 *   files (image / video / audio) -> media, downloaded from File.source (no credential is sent: it is
 *                                    another host), falling back to the first processed output URL
 *   playlists (published)         -> playlists; durations are milliseconds in `content`, 0 = default
 *   channels + their layout       -> layouts: zone geometry is parsed from the layout's CSS (vw / vh /
 *                                    % / px); each zone's file and playlist items fill it
 *   screen groups + screen tags   -> groups;  screens -> placeholders (their channel as the layout)
 *   item rules (time / weekday / date) -> NOT schedules: ScreenCloud has no schedule object, only
 *                                    per-item rules inside a channel; they are listed as not imported
 */

const { client } = require('../transport');
const { cursorPages, truncatedNote, userError, str } = require('./common');
const map = require('../map');

const HOSTS = { eu: 'https://graphql.eu.screencloud.com/graphql', us: 'https://graphql.us.screencloud.com/graphql' };

const Q = {
  files: 'query($first:Int!,$after:Cursor){ allFiles(first:$first, after:$after){ pageInfo{ hasNextPage endCursor } nodes{ id name mimetype size source fileOutputsByFileId{ nodes{ url mimetype } } } } }',
  playlists: 'query($first:Int!,$after:Cursor){ allPlaylists(first:$first, after:$after){ pageInfo{ hasNextPage endCursor } nodes{ id name content draftOf isPublished } } }',
  layouts: 'query($first:Int!,$after:Cursor){ allLayouts(first:$first, after:$after){ pageInfo{ hasNextPage endCursor } nodes{ id name width height config } } }',
  channels: 'query($first:Int!,$after:Cursor){ allChannels(first:$first, after:$after){ pageInfo{ hasNextPage endCursor } nodes{ id name width height layoutId content draftOf } } }',
  screens: 'query($first:Int!,$after:Cursor){ allScreens(first:$first, after:$after){ pageInfo{ hasNextPage endCursor } nodes{ id name screenGroupId tags timezone content } } }',
  groups: 'query($first:Int!,$after:Cursor){ allScreenGroups(first:$first, after:$after){ pageInfo{ hasNextPage endCursor } nodes{ id name } } }',
  org: 'query{ currentOrgId }',
};

const json = (v) => { if (v && typeof v === 'object') return v; try { return JSON.parse(v || 'null'); } catch { return null; } };

/* "#zone1 { position:absolute; width:70vw; height:100vh; top:0; left:0; z-index:10 }" -> pixel rect */
function zonesFromCss(css, W, H) {
  const out = new Map();
  const unit = (v, axis) => {
    const m = /^(-?[\d.]+)\s*(vw|vh|%|px)?$/.exec(String(v || '').trim());
    if (!m) return null;
    const n = Number(m[1]);
    if (m[2] === 'px' || !m[2]) return n;
    const size = m[2] === 'vw' ? W : m[2] === 'vh' ? H : axis === 'x' ? W : H;
    return (n / 100) * size;
  };
  const re = /#([A-Za-z0-9_-]+)\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(String(css || '')))) {
    const props = {};
    for (const decl of m[2].split(';')) { const [k, v] = decl.split(':'); if (k && v) props[k.trim().toLowerCase()] = v.trim(); }
    out.set(m[1], {
      left: unit(props.left, 'x') || 0, top: unit(props.top, 'y') || 0,
      width: unit(props.width, 'x') || W, height: unit(props.height, 'y') || H, z: Number(props['z-index']) || 0,
    });
  }
  return out;
}

module.exports = {
  id: 'screencloud',
  name: 'ScreenCloud',
  mode: 'api',
  docs: ['https://screencloud.github.io/signage-next-graphql-docs/', 'https://developer.screencloud.com/'],
  fields: [
    { key: 'token', type: 'secret', required: true },
    { key: 'region', type: 'region', required: true, options: ['eu', 'us'] },
  ],
  zonesFromCss,

  checkCredentials(cred) {
    const token = str(cred.token, 2000).trim().replace(/^Bearer\s+/i, '');
    if (!/^\S{8,2000}$/.test(token)) throw userError('Paste the API token from Studio (Account Settings, Developer).');
    const region = String(cred.region || 'eu').toLowerCase();
    if (!HOSTS[region]) throw userError('Choose the region shown on the Developer tab (EU or US).');
    return { cred: { token, region }, label: `ScreenCloud (${region.toUpperCase()})` };
  },

  async open(cred) {
    if (!cred) throw userError('Enter the ScreenCloud token again.');
    const c = client(HOSTS[cred.region], { Authorization: `Bearer ${cred.token}` });
    const all = (q, key) => cursorPages(c, q, (d) => d[key]);

    return {
      async scan() {
        const unmapped = [];
        const { gql } = require('./common');
        const org = await gql(c, Q.org);
        const filesR = await all(Q.files, 'allFiles');
        const plR = await all(Q.playlists, 'allPlaylists');
        const layR = await all(Q.layouts, 'allLayouts');
        const chR = await all(Q.channels, 'allChannels');
        const scrR = await all(Q.screens, 'allScreens');
        const grR = await all(Q.groups, 'allScreenGroups');
        for (const [k, r] of [['media', filesR], ['playlists', plR], ['screens', scrR]]) truncatedNote(unmapped, k, r.truncated);

        const media = [];
        const mediaIds = new Set();
        for (const f of filesR.rows) {
          const kind = map.kindOf(f.mimetype);
          const out = ((f.fileOutputsByFileId && f.fileOutputsByFileId.nodes) || []).find((o) => o && o.url && map.kindOf(o.mimetype) === kind);
          const url = (typeof f.source === 'string' && /^https:\/\//i.test(f.source)) ? f.source : out && out.url;
          if (!kind) { unmapped.push({ kind: 'media', name: str(f.name), reason: `"${str(f.mimetype, 60)}" files are not media ScreenTinker plays.` }); continue; }
          if (!url) { unmapped.push({ kind: 'media', name: str(f.name), reason: 'ScreenCloud gave no address for the file.' }); continue; }
          media.push({ id: String(f.id), name: str(f.name), kind, size: Number(f.size) || 0, ext: String(f.mimetype || '').split('/')[1] || '', ref: { url: String(url) } });
          mediaIds.add(String(f.id));
        }

        const playlistItems = new Map();
        const listItems = (list, defaults, notes, depth = 0) => (list || []).flatMap((entry) => {
          const ref = entry && entry.content && entry.content._ref;
          if (entry && Array.isArray(entry.rules) && entry.rules.length) notes.add('time rules on items');
          if (ref && ref.type === 'file' && mediaIds.has(String(ref.id))) {
            const ms = Number(entry.content.props && entry.content.props.duration) || 0;
            return [{ media_id: String(ref.id), duration: ms > 0 ? map.seconds(ms / 1000) : (defaults && defaults.image ? map.seconds(defaults.image / 1000) : null) }];
          }
          if (ref && ref.type === 'playlist' && depth < 3) {
            if (playlistItems.has(String(ref.id))) return playlistItems.get(String(ref.id));
          }
          notes.add(ref ? `${str(ref.type, 20)} items` : 'unknown items');
          return [];
        });

        const playlists = [];
        for (const p of plR.rows) {
          if (p.draftOf) continue;
          const content = json(p.content) || {};
          const notes = new Set();
          const items = listItems(content.list, content.props && content.props.default_durations, notes);
          playlistItems.set(String(p.id), items);
          playlists.push({ id: String(p.id), name: str(p.name), items, notes: notes.size ? [`Left out: ${[...notes].join(', ')}.`] : [] });
        }

        const layoutById = new Map(layR.rows.map((l) => [String(l.id), l]));
        const layouts = [];
        for (const ch of chR.rows) {
          if (ch.draftOf) continue;
          const lay = layoutById.get(String(ch.layoutId)) || {};
          const cfg = json(lay.config) || {};
          const W = Number(ch.width || lay.width || cfg.width) || 1920, H = Number(ch.height || lay.height || cfg.height) || 1080;
          const rects = zonesFromCss(cfg.css, W, H);
          const content = json(ch.content) || {};
          const notes = new Set();
          const zoneDefs = Array.isArray(cfg.zones) && cfg.zones.length ? cfg.zones : Object.keys(content.zones || {}).map((id) => ({ id, name: id }));
          const zones = zoneDefs.map((z) => {
            const r = rects.get(String(z.id)) || { left: 0, top: 0, width: W, height: H, z: 0 };
            return { id: String(z.id), name: str(z.name || z.id), ...r, items: listItems(((content.zones || {})[z.id] || {}).list, null, notes) };
          });
          if (rects.size === 0 && zones.length > 1) notes.add('zone positions (the layout CSS could not be read; zones were stacked full-screen)');
          if (notes.has('time rules on items')) unmapped.push({ kind: 'schedule', name: str(ch.name), reason: 'ScreenCloud time rules on channel items are not imported. Use a ScreenTinker schedule or item dayparting.' });
          notes.delete('time rules on items');
          layouts.push({ id: String(ch.id), name: str(ch.name), width: W, height: H, zones, notes: notes.size ? [`Left out: ${[...notes].join(', ')}.`] : [] });
        }

        const groups = grR.rows.map((g) => ({ id: `g:${g.id}`, name: str(g.name) }));
        const tagIds = new Map();
        const screens = scrR.rows.map((s) => {
          const gids = s.screenGroupId ? [`g:${s.screenGroupId}`] : [];
          for (const tag of Array.isArray(s.tags) ? s.tags : []) {
            const k = str(tag, 100).toLowerCase();
            if (!k) continue;
            if (!tagIds.has(k)) { tagIds.set(k, `tag:${k}`); groups.push({ id: `tag:${k}`, name: str(tag, 100) }); }
            gids.push(tagIds.get(k));
          }
          const sc = json(s.content) || {};
          const ref = sc._ref || sc;
          return {
            id: String(s.id), name: str(s.name), group_ids: gids,
            layout_id: ref && ref.type === 'channel' ? String(ref.id) : null,
            playlist_id: ref && ref.type === 'playlist' ? String(ref.id) : null,
          };
        });
        return { account: `screencloud:${str(org.currentOrgId, 80)}`, label: `ScreenCloud (${cred.region.toUpperCase()})`, media, playlists, layouts, schedules: [], screens, groups, unmapped };
      },
      fetchMedia(m, dest, maxBytes) { return c.download(m.ref.url, dest, maxBytes); },
      close() { c.setAuth({}); },
    };
  },
};
