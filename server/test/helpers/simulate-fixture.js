'use strict';

/*
 * A fleet that exercises every branch of "which playlist does this screen play": device override,
 * group (two groups, priority and tie), wall, 'none', the unclassified raw id, a head office mandate
 * and a dark one, device / group / wall schedules (recurring, one-off, overlapping, overnight),
 * per-item dayparts and play windows, content expiry, a power schedule, and devices in three zones
 * (one with none reported). Used by the preview-at-time equivalence and behaviour tests.
 *
 * Runs against the REAL database module (the caller sets DATA_DIR first), because the point is to
 * drive the real scheduler, the real resolver view and the real payload builder.
 */

const crypto = require('node:crypto');

const uid = (p) => `${p}-${crypto.randomUUID()}`;

function build(db) {
  const f = { devices: {}, playlists: {}, groups: {}, schedules: {}, content: {} };
  const userId = uid('u');
  db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)').run(userId, `${userId}@example.com`, 'Sim', 'x');
  const orgId = uid('org');
  db.prepare('INSERT INTO organizations (id, name, owner_user_id, corporate_enabled) VALUES (?, ?, ?, 1)').run(orgId, 'Sim org', userId);
  const wsId = uid('ws');
  db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(wsId, orgId, 'Sim ws');
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')").run(wsId, userId);
  f.userId = userId; f.orgId = orgId; f.wsId = wsId;

  const content = (name, mime, extra = {}) => {
    const id = uid('c');
    db.prepare(`INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, userId, wsId, name, `/uploads/${id}.bin`, mime, extra.expires_at ?? null);
    f.content[name] = id;
    return id;
  };
  const item = (cid, name, mime, extra = {}) => ({ content_id: cid, filename: name, mime_type: mime, filepath: `/uploads/${cid}.bin`, duration_sec: 10, sort_order: 0, zone_id: null, ...extra });
  const playlist = (name, items, { corporate = 0 } = {}) => {
    const id = uid('pl');
    db.prepare(`INSERT INTO playlists (id, user_id, workspace_id, name, status, published_snapshot, corporate)
                VALUES (?, ?, ?, ?, 'published', ?, ?)`).run(id, userId, wsId, name, JSON.stringify(items), corporate);
    f.playlists[name] = id;
    return id;
  };

  const cA = content('a.jpg', 'image/jpeg');
  const cB = content('b.mp4', 'video/mp4');
  // Expires 2026-03-10 12:00 UTC: the expiry boundary test straddles it.
  const cExp = content('expiring.jpg', 'image/jpeg', { expires_at: Math.floor(Date.UTC(2026, 2, 10, 12, 0) / 1000) });
  const cHls = content('stream.m3u8', 'video/hls');
  const cRain = content('umbrella.jpg', 'image/jpeg');

  playlist('Own', [item(cA, 'a.jpg', 'image/jpeg'), item(cExp, 'expiring.jpg', 'image/jpeg')]);
  playlist('Breakfast', [
    item(cA, 'a.jpg', 'image/jpeg', { schedules: [{ days: [1, 2, 3, 4, 5], start: '07:00', end: '10:30' }] }),
    item(cB, 'b.mp4', 'video/mp4'),
  ]);
  playlist('GroupLow', [item(cB, 'b.mp4', 'video/mp4')]);
  playlist('GroupHigh', [
    item(cA, 'a.jpg', 'image/jpeg', { play_from: '2026-03-05T09:00', play_until: '2026-03-12T18:00' }),
    item(cHls, 'stream.m3u8', 'video/hls'),
    item(cRain, 'umbrella.jpg', 'image/jpeg', { play_when: { type: 'weather', field: 'condition', op: 'eq', value: 'rain' } }),
  ]);
  playlist('Wall', [item(cB, 'b.mp4', 'video/mp4')]);
  playlist('Night', [item(cA, 'a.jpg', 'image/jpeg', { schedules: [{ days: [5], start: '22:00', end: '02:00' }] })]);
  playlist('Promo', [item(cB, 'b.mp4', 'video/mp4')]);
  playlist('HQ', [item(cA, 'a.jpg', 'image/jpeg')], { corporate: 1 });

  const group = (name, playlistName, priority, createdAt) => {
    const id = uid('g');
    db.prepare('INSERT INTO device_groups (id, user_id, workspace_id, name, playlist_id, priority, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, userId, wsId, name, playlistName ? f.playlists[playlistName] : null, priority, createdAt);
    f.groups[name] = id;
    return id;
  };
  group('Low', 'GroupLow', 1, 1000);
  group('High', 'GroupHigh', 5, 2000);
  group('TieOld', 'Promo', 3, 100);
  group('TieNew', 'Breakfast', 3, 200);
  group('Corp', null, 0, 300);

  const device = (name, cols = {}) => {
    const id = uid('d');
    db.prepare(`INSERT INTO devices (id, user_id, workspace_id, name, pairing_code, status, playlist_id, playlist_source,
                  timezone, reported_timezone, wall_id, layout_id, orientation, client_type, platform, capabilities)
                VALUES (?, ?, ?, ?, ?, 'online', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, userId, wsId, name, crypto.randomBytes(3).toString('hex'),
        cols.playlist ? f.playlists[cols.playlist] : null, cols.source ?? null,
        cols.timezone ?? 'UTC', cols.reported ?? null, null, null, cols.orientation || 'landscape',
        cols.client_type || 'web', cols.platform || 'web', cols.capabilities ?? null);
    f.devices[name] = id;
    for (const g of cols.groups || []) db.prepare('INSERT INTO device_group_members (device_id, group_id) VALUES (?, ?)').run(id, f.groups[g]);
    return id;
  };
  // Declares a backlight schedule (in no baseline) and HLS, so its power windows are obeyed.
  device('own', { playlist: 'Own', source: 'device', reported: 'America/New_York',
    capabilities: JSON.stringify(['playback.video', 'playback.image', 'playback.widget', 'display.power_schedule', 'playback.hls']) });
  device('grouped', { groups: ['Low', 'High'], reported: 'Europe/Berlin' });
  device('tie', { groups: ['TieOld', 'TieNew'], timezone: 'Australia/Sydney' });
  device('none', { source: 'none', groups: ['Low'], reported: 'America/New_York' });
  device('none_sched', { source: 'none', reported: 'America/New_York' });
  device('raw', { playlist: 'Own', source: null });              // an unclassified writer's id
  device('stale_copy', { playlist: 'Own', source: null, groups: ['Low'] });
  device('no_tz', { playlist: 'Own', source: 'device', timezone: 'UTC', reported: null });
  device('mandated', { playlist: 'Own', source: 'device', groups: ['Corp'], reported: 'Europe/London' });
  device('dark', { playlist: 'Own', source: 'device', reported: 'Europe/London' });
  device('offline', { playlist: 'Own', source: 'device', reported: 'America/New_York' });
  db.prepare("UPDATE devices SET status = 'offline' WHERE id = ?").run(f.devices.offline);

  // A video wall with two panels, the leader reporting Chicago.
  const wallId = uid('w');
  db.prepare('INSERT INTO video_walls (id, user_id, workspace_id, name, playlist_id) VALUES (?, ?, ?, ?, ?)').run(wallId, userId, wsId, 'Lobby wall', f.playlists.Wall);
  f.wallId = wallId;
  for (const [n, col] of [['wall_a', 0], ['wall_b', 1]]) {
    const id = device(n, { reported: n === 'wall_a' ? 'America/Chicago' : 'Asia/Tokyo' });
    db.prepare('UPDATE devices SET wall_id = ? WHERE id = ?').run(wallId, id);
    db.prepare('INSERT INTO video_wall_devices (wall_id, device_id, grid_col, grid_row) VALUES (?, ?, ?, 0)').run(wallId, id, col);
  }
  db.prepare('UPDATE video_walls SET leader_device_id = ? WHERE id = ?').run(f.devices.wall_a, wallId);

  // Head office: a mandate on the Corp group, and a dark one on one device.
  db.prepare("INSERT INTO corporate_mandates (id, organization_id, playlist_id, dark, target_kind, target_id) VALUES (?, ?, ?, 0, 'group', ?)")
    .run(uid('m'), orgId, f.playlists.HQ, f.groups.Corp);
  db.prepare("INSERT INTO corporate_mandates (id, organization_id, playlist_id, dark, target_kind, target_id) VALUES (?, ?, NULL, 1, 'device', ?)")
    .run(uid('m'), orgId, f.devices.dark);

  const schedule = (key, cols) => {
    const id = uid('s');
    db.prepare(`INSERT INTO schedules (id, user_id, device_id, group_id, wall_id, playlist_id, layout_id, title, start_time, end_time,
                  timezone, recurrence, recurrence_end, priority, enabled, created_at)
                VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'UTC', ?, ?, ?, ?, ?)`)
      .run(id, userId, cols.device ? f.devices[cols.device] : null, cols.group ? f.groups[cols.group] : null,
        cols.wall ? wallId : null, cols.playlist ? f.playlists[cols.playlist] : null, key,
        cols.start, cols.end, cols.recurrence ?? null, cols.recurrence_end ?? null, cols.priority ?? 0,
        cols.enabled ?? 1, cols.created_at ?? 0);
    f.schedules[key] = id;
    return id;
  };
  // Weekday breakfast on the own-playlist screen (device level).
  schedule('breakfast', { device: 'own', playlist: 'Breakfast', start: '2026-01-01T07:00', end: '2026-01-01T10:30', recurrence: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' });
  // Overlapping group schedules: priority decides; a device schedule outranks both.
  schedule('group_lo', { group: 'Low', playlist: 'Promo', start: '2026-01-01T12:00', end: '2026-01-01T14:00', recurrence: 'FREQ=DAILY', priority: 1 });
  schedule('group_hi', { group: 'High', playlist: 'Night', start: '2026-01-01T13:00', end: '2026-01-01T15:00', recurrence: 'FREQ=DAILY', priority: 9 });
  schedule('grouped_dev', { device: 'grouped', playlist: 'Breakfast', start: '2026-01-01T13:30', end: '2026-01-01T13:45', recurrence: 'FREQ=DAILY', priority: 0 });
  // A one-off campaign that ends during the test range, and a disabled one that must be ignored.
  schedule('campaign', { device: 'tie', playlist: 'Promo', start: '2026-03-07T09:00', end: '2026-03-09T17:00' });
  schedule('disabled', { device: 'tie', playlist: 'Night', start: '2026-01-01T00:00', end: '2026-12-31T23:59', enabled: 0 });
  // 'none' plus a schedule: the schedule lights the deliberately dark screen.
  schedule('lights_dark', { device: 'none_sched', playlist: 'Promo', start: '2026-01-01T18:00', end: '2026-01-01T20:00', recurrence: 'FREQ=DAILY' });
  // A wall schedule on the wall's clock (Chicago).
  schedule('wall_eve', { wall: true, playlist: 'Promo', start: '2026-01-01T17:00', end: '2026-01-01T19:00', recurrence: 'FREQ=WEEKLY;BYDAY=SA,SU' });
  // Monthly, ending mid-range.
  schedule('monthly', { device: 'raw', playlist: 'Night', start: '2026-01-08T08:00', end: '2026-01-08T09:00', recurrence: 'FREQ=MONTHLY', recurrence_end: '2026-04-30' });
  // A schedule on the mandated screen: the mandate must still win.
  schedule('under_mandate', { device: 'mandated', playlist: 'Promo', start: '2026-01-01T00:00', end: '2026-01-01T23:59', recurrence: 'FREQ=DAILY' });

  // Power: the own screen sleeps weeknights 22:00–06:00 in New York.
  db.prepare(`INSERT INTO display_power_schedules (id, workspace_id, name, device_id, timezone, enabled, windows)
              VALUES (?, ?, 'Nights', ?, 'America/New_York', 1, ?)`)
    .run(uid('ps'), wsId, f.devices.own, JSON.stringify([{ days: [1, 2, 3, 4, 5], start: '22:00', end: '06:00' }]));

  return f;
}

module.exports = { build };
