'use strict';

const { db } = require('../db/database');

/*
 * Which playlist a screen plays, resolved LIVE.
 *
 * devices.playlist_id used to be written by twelve call sites and read by one. Precedence needs a
 * resolver; twelve writers and no resolver is not precedence, it is whoever wrote last. Three
 * things fell out of that, none of them documented: a device in two groups had no defined winner,
 * a hand-set per-device playlist was destroyed by the next unrelated group edit, and "this screen
 * overrides its group" could not be expressed at all, because the copy erased the difference
 * between inherited and chosen.
 *
 * The rule is the one schedules.js already applies (device beats group, then priority, then
 * oldest), extended with walls above groups. It lives in SQL — see the device_resolved_playlist
 * view in db/database.js — so that the point lookup here and the JOINs in ws/deviceSocket.js share
 * a single definition and cannot drift.
 *
 * ⚠️ Nothing is copied on assign. That is the industry norm (unanimous across 17 surveyed vendors)
 * and it is what makes a group playlist change reach its members because nothing was copied, rather
 * than because a fan-out loop remembered to visit them.
 */
const SELECT = 'SELECT playlist_id, source FROM device_resolved_playlist WHERE device_id = ?';

/**
 * ⚠️ Always returns a PLAIN object with both keys present.
 *
 * This project runs on two SQLite drivers (better-sqlite3 and node:sqlite, see the mesh work), and
 * they do not agree on the prototype of a result row — node:sqlite hands back null-prototype
 * objects. Callers comparing or spreading the row should not have to know which driver is loaded,
 * and a missing device should look like a device that resolves to nothing rather than `undefined`.
 *
 * @returns {{playlist_id: string|null, source: 'corporate'|'schedule'|'device'|'wall'|'group'|null}}
 */
function resolveDevicePlaylist(deviceId) {
  if (!deviceId) return { playlist_id: null, source: null };
  const row = db.prepare(SELECT).get(deviceId);
  return { playlist_id: row?.playlist_id ?? null, source: row?.source ?? null };
}

/** Just the id — the shape most callers replacing `device.playlist_id` want. */
function resolveDevicePlaylistId(deviceId) {
  return resolveDevicePlaylist(deviceId).playlist_id;
}

/*
 * ⚠️ Drop a device's leftover COPY of an inherited playlist — but never its own choice.
 *
 * The view falls back to the raw devices.playlist_id as a last resort, so that writers not yet
 * converted keep working. That fallback has a sharp edge: a device carrying a stale copy of its
 * group's or wall's playlist would, the moment it LEAVES, stop inheriting and start playing that
 * stale copy — so "remove this screen from the wall" would leave the wall's content on it instead
 * of going dark.
 *
 * Membership changes therefore clear the copy, and only the copy: a row with
 * playlist_source = 'device' is an operator's decision and is left exactly alone.
 */
function clearInheritedCopy(deviceId) {
  db.prepare("UPDATE devices SET playlist_id = NULL WHERE id = ? AND IFNULL(playlist_source, '') != 'device'")
    .run(deviceId);
}

/**
 * The layout the device is ACTUALLY using: an active schedule's, else its own. Same reasoning as
 * the playlist — the scheduler no longer overwrites devices.layout_id, so reading that column
 * directly would miss a schedule that is running right now.
 */
function resolvedLayoutId(deviceId) {
  if (!deviceId) return null;
  return db.prepare('SELECT layout_id FROM device_resolved_playlist WHERE device_id = ?')
    .get(deviceId)?.layout_id ?? null;
}

/** Single-query lookup for both playlist_id and layout_id */
function resolveDeviceContext(deviceId) {
  if (!deviceId) return { playlist_id: null, layout_id: null, source: null };
  const row = db.prepare('SELECT playlist_id, layout_id, source FROM device_resolved_playlist WHERE device_id = ?').get(deviceId);
  return {
    playlist_id: row?.playlist_id ?? null,
    layout_id: row?.layout_id ?? null,
    source: row?.source ?? null,
  };
}

/**
 * The layout the device draws and WHICH TIER chose it — mandate, schedule, the playlist's own (3.0)
 * or the device's — so the dashboard can say "this screen uses its playlist's layout" instead of
 * showing a device layout that is not on screen. The view decides; this only reads back why.
 * @returns {{id, name, source, playlist_id}|null}
 */
function resolvedLayoutInfo(deviceId) {
  if (!deviceId) return null;
  const r = db.prepare(`SELECT r.layout_id, r.source, r.playlist_id, d.scheduled_layout_id, d.wall_id
                          FROM device_resolved_playlist r JOIN devices d ON d.id = r.device_id
                         WHERE r.device_id = ?`).get(deviceId);
  if (!r || !r.layout_id) return null;
  let source = 'device';
  if (r.source === 'corporate') source = 'mandate';
  else if (r.scheduled_layout_id) source = 'schedule';
  else if (!r.wall_id && r.playlist_id) {
    let pl = null;
    try { pl = db.prepare('SELECT published_layout_id FROM playlists WHERE id = ?').get(r.playlist_id); } catch (_) { pl = null; }
    if (pl && pl.published_layout_id === r.layout_id) source = 'playlist';
  }
  const l = db.prepare('SELECT name FROM layouts WHERE id = ?').get(r.layout_id);
  return { id: r.layout_id, name: l ? l.name : null, source, playlist_id: source === 'playlist' ? r.playlist_id : null };
}

module.exports = { resolveDevicePlaylist, resolveDevicePlaylistId, resolvedLayoutId, resolveDeviceContext, resolvedLayoutInfo, clearInheritedCopy };
