'use strict';

/*
 * Anthias (open-source Screenly OSE), the device's own API v2. Written against the project source,
 * which is where its API is documented (each device also serves the reference at /api/docs/):
 *   https://github.com/Screenly/Anthias  (src/anthias_server/api/urls/v2.py, api/serializers/v2.py)
 *
 * The address is the DEVICE's, typed by the person, so it goes through lib/ssrf-guard: an Anthias
 * box on a LAN is a private address and is refused unless the operator opened it with
 * OUTBOUND_ALLOW_HOSTS / OUTBOUND_ALLOW_PRIVATE (docs/outbound-requests.md). Metadata addresses
 * are refused regardless. Authentication is off by default on Anthias; when Basic is on, the
 * username and password are sent as Basic auth to that address only.
 *
 * Mapping:
 *   GET /api/v2/assets (image / video / audio stored on the device) -> media, from
 *       GET /api/v2/assets/{id}/content; web pages and URL streams are not imported
 *   the device's one loop (enabled assets by play_order)            -> one playlist
 *   GET /api/v2/device_settings player_name                          -> one placeholder screen
 *   per-asset date / weekday / time windows                          -> not imported (said per asset)
 *
 * The backup archive (POST /api/v2/backup, a tar.gz holding a SQLite database) is NOT read: parsing
 * an uploaded SQLite file is a larger attack surface than this import is worth, and the API covers
 * the same data. Documented in docs/migrate.md.
 */

const { client, normalizeBaseUrl } = require('../transport');
const { userError, str } = require('./common');
const map = require('../map');

module.exports = {
  id: 'anthias',
  name: 'Anthias (Screenly OSE)',
  mode: 'api',
  selfHosted: true,
  docs: ['https://github.com/Screenly/Anthias'],
  fields: [
    { key: 'url', type: 'url', required: true },
    { key: 'username', type: 'text', required: false },
    { key: 'password', type: 'secret', required: false },
  ],

  checkCredentials(cred) {
    const base = normalizeBaseUrl(cred.url).replace(/\/api(\/v2)?$/i, '');
    const user = str(cred.username, 200), pass = str(cred.password, 500);
    if ((user && !pass) || (!user && pass)) throw userError('Enter both the username and the password, or neither.');
    return { cred: { base, username: user, password: pass }, label: new URL(base).host };
  },

  async open(cred) {
    if (!cred) throw userError('Enter the Anthias address again.');
    const auth = cred.username ? { Authorization: `Basic ${Buffer.from(`${cred.username}:${cred.password}`).toString('base64')}` } : {};
    const c = client(cred.base, auth);
    return {
      async scan() {
        const unmapped = [];
        const { body: assets } = await c.api('/api/v2/assets');
        let settings = {};
        try { settings = (await c.api('/api/v2/device_settings')).body || {}; } catch { settings = {}; }
        const media = [];
        const items = [];
        const rows = (Array.isArray(assets) ? assets : []).slice(0, 5000).sort((a, b) => (a.play_order || 0) - (b.play_order || 0));
        for (const a of rows) {
          const kind = map.kindOf(`${a.mimetype}/`) || map.kindOf(a.mimetype);
          const local = typeof a.uri === 'string' && a.uri.startsWith('/');
          if (!kind || !local) { unmapped.push({ kind: 'media', name: str(a.name), reason: kind ? 'It plays from a web address, not a file on the device; add it as a Media URL.' : 'Web pages are not media; add a ScreenTinker web page widget.' }); continue; }
          media.push({ id: String(a.asset_id), name: str(a.name), kind, size: 0, ext: (/\.([a-z0-9]{2,5})$/i.exec(a.uri) || [])[1] || '', ref: { id: String(a.asset_id) } });
          if (a.is_enabled) {
            items.push({ media_id: String(a.asset_id), duration: map.seconds(a.duration) });
            const windowed = (Array.isArray(a.play_days) && a.play_days.length && a.play_days.length < 7) || a.play_time_from || a.play_time_to || a.end_date;
            if (windowed) unmapped.push({ kind: 'schedule', name: str(a.name), reason: 'Its date, weekday or time window was not imported; set it on the playlist item (dayparting).' });
          }
        }
        const name = str(settings.player_name) || new URL(cred.base).host;
        const playlists = [{ id: 'loop', name: `${name} playlist`, items, notes: settings.shuffle_playlist ? ['It was shuffled on the device; it now plays in order.'] : [] }];
        const screens = [{ id: 'device', name, group_ids: [], playlist_id: 'loop' }];
        return { account: cred.base.toLowerCase(), label: new URL(cred.base).host, media, playlists, layouts: [], schedules: [], screens, groups: [], unmapped };
      },
      fetchMedia(m, dest, maxBytes) { return c.download(`${cred.base}/api/v2/assets/${encodeURIComponent(m.ref.id)}/content`, dest, maxBytes); },
      close() { c.setAuth({}); },
    };
  },
};
