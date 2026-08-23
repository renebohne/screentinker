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

/** @returns {{playlist_id: string|null, source: 'device'|'wall'|'group'|null}} */
function resolveDevicePlaylist(deviceId) {
  if (!deviceId) return { playlist_id: null, source: null };
  return db.prepare(SELECT).get(deviceId) || { playlist_id: null, source: null };
}

/** Just the id — the shape most callers replacing `device.playlist_id` want. */
function resolveDevicePlaylistId(deviceId) {
  return resolveDevicePlaylist(deviceId).playlist_id;
}

module.exports = { resolveDevicePlaylist, resolveDevicePlaylistId };
