'use strict';

/*
 * Which triggers apply to a device, and what the device needs to fire them offline.
 * docs/triggers-design.md.
 *
 * ⚠️ This runs on the SERVER, at sync time, and never at fire time. The device answers a datagram
 * from its own cached copy of this result with the WAN down — that is the whole feature. Everything
 * the device needs to decide must therefore be IN the payload; a field left out here is a field the
 * device cannot go and fetch when it matters.
 */

/**
 * Triggers assigned to a device, directly or through any group it belongs to.
 *
 * ⚠️ Assignment is by device OR group and a device can be in several groups, so the same trigger can
 * match more than once. DISTINCT is not decoration: two rows would sync as two triggers with the
 * same match_token, and the device's resolver would then have to pick one — turning a normal
 * configuration (assign to a group AND to a screen in it) into ambiguous behaviour.
 */
function triggersForDevice(db, deviceId) {
  return db.prepare(`
    SELECT DISTINCT t.*
      FROM triggers t
      JOIN trigger_assignments ta ON ta.trigger_id = t.id
      JOIN devices d ON d.id = ?
     WHERE t.enabled = 1
       AND t.workspace_id = d.workspace_id
       AND (
         (ta.target_type = 'device' AND ta.target_id = d.id)
         OR (ta.target_type = 'group' AND ta.target_id IN (
               SELECT group_id FROM device_group_members WHERE device_id = d.id))
       )
     ORDER BY t.priority DESC, t.name
  `).all(deviceId);
}

/**
 * Shape one trigger for the wire.
 *
 * `items` is the resolved playlist, carried inline rather than referenced: the device cannot resolve
 * a playlist id offline, and the moment it has to, the trigger stops working on exactly the day it
 * is needed.
 */
function projectTrigger(t, items) {
  return {
    id: t.id,
    name: t.name,
    match_token: t.match_token,
    clear_token: t.clear_token || null,
    source_http: !!t.source_http,
    source_udp: !!t.source_udp,
    target_kind: t.target_kind,
    // ⚠️ target_ref travels too, but only so the player can LOG which playlist it rendered. It is
    // never resolved on the device; `items` is the content.
    target_ref: t.target_ref || null,
    /*
     * ⚠️ position / width / height / opacity / border_radius are DELIBERATELY NOT PROJECTED.
     *
     * They were copied wholesale from the PiP contract and are dead in every direction: no client
     * writes them (frontend/js/views/triggers.js sets none), four of the five never entered the
     * player's change signature so an edit could not reach a device anyway, the renderer discards
     * all five (triggerFire hardcodes inset:0 opaque black), the Android/shared contract
     * (TriggerResolve.kt, shared/trigger-vectors.json) has never had them, and no test asserts one.
     *
     * Sending a field the device provably ignores is how the next person concludes it works. The
     * COLUMNS stay — this schema treats unused columns as the no-migration hook, and SQLite would
     * need a table rebuild to drop them. If a non-fullscreen mode is wanted later, the right shape
     * is ONE semantic field (takeover | banner), which is also what the mass-notification vendors
     * expose, rather than five raw CSS primitives.
     */
    mode: t.mode,
    max_duration_sec: t.max_duration_sec == null ? 0 : t.max_duration_sec,
    lease_sec: t.lease_sec == null ? null : t.lease_sec,
    priority: t.priority || 0,
    items: Array.isArray(items) ? items : [],
  };
}

/**
 * Every content URL a device must hold to fire its triggers offline.
 *
 * ⚠️ THIS IS WHAT MAKES PINNING WORK, and it is not optional. The service worker's
 * pruneToPlaylist() deletes any content-cache entry that is not in the set the player sends it — so
 * a trigger target is not merely un-prefetched, it is ACTIVELY EVICTED unless it appears here. The
 * player appends these to the same st-cache-playlist message it already sends for the base playlist.
 */
function triggerMediaUrls(triggers, mediaUrl) {
  const out = [];
  for (const t of triggers || []) {
    for (const item of t.items || []) {
      const u = mediaUrl(item);
      if (u) out.push(u);
    }
  }
  return out;
}

module.exports = { triggersForDevice, projectTrigger, triggerMediaUrls };
