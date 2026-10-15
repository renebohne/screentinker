'use strict';
/*
 * 3.0: screen share — the signed-in side (docs/screen-share.md). JWT only (config/api-surface.js):
 * sharing a screen is a person at a browser, never an API token.
 *
 *   GET    /devices/:id         what the dashboard shows: can this screen be shared to, who is sharing
 *   POST   /devices/:id         start a share (editor+) -> a single-use ticket for the signalling socket,
 *                               plus one leg per mirror of the display (its link open elsewhere)
 *   DELETE /devices/:id         stop whoever is sharing (editor+) — the owner's "kick", mirrors included
 *   PUT    /devices/:id/guest   the meeting-room code on this screen, on/off (workspace admin)
 *   GET    /workspace/:wsId     the workspace switch, for the settings card
 *   PUT    /workspace/:wsId     turn the feature on/off for the workspace (workspace admin)
 *   POST   /shares              multi share: one share on several screens / a group (editor+)
 *   DELETE /shares/:shareId     stop a multi share on every screen (editor+ on all of them)
 *   GET    /groups/:groupId     which of a group's screens can take a share, and why not
 *   PUT    /devices/:id/multi   let several people present at once on this display (workspace admin)
 *   PUT    /devices/:id/spotlight            {share_id|null}: one presenter fills the screen (editor+)
 *   DELETE /devices/:id/presenters/:shareId  take one presenter off the display (editor+)
 *
 * The media never comes here: the browser and the screen connect peer to peer, and this server only
 * relays their signalling (lib/screen-share.js). Every route resolves the device's OWN workspace
 * and checks the caller's access to it, exactly like routes/devices.js, so a device id from another
 * tenant is a 403 whatever workspace the caller has switched into.
 */
const express = require('express');
const router = express.Router();
router.use(require('../lib/backstop-limiter'));
const { db } = require('../db/database');
const { resourceAccess } = require('../lib/tenancy');
const { canAdminWorkspace } = require('../lib/permissions');
const { auditFromReq, audit } = require('../lib/audit');
const share = require('../lib/screen-share');

// Device + its workspace + the caller's access, or null after answering.
function loadDevice(req, res) {
  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(String(req.params.id || ''));
  if (!device) { res.status(404).json({ error: 'Device not found' }); return null; }
  if (!device.workspace_id) { res.status(403).json({ error: 'Device not assigned to a workspace' }); return null; }
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(device.workspace_id);
  const ctx = ws && resourceAccess(req, ws);
  if (!ctx) { res.status(403).json({ error: 'Access denied' }); return null; }
  const readOnly = !ctx.actingAs && ctx.workspaceRole === 'workspace_viewer';
  return { device, ws, ctx, readOnly };
}

function denyIfReadOnly(r, res) {
  if (r.readOnly) { res.status(403).json({ error: 'Read-only access' }); return true; }
  return false;
}

// A mirror has no switches of its own: it reports its display's.
function displayOf(device) {
  if (!device.mirror_of) return device;
  return db.prepare('SELECT * FROM devices WHERE id = ? AND workspace_id IS ?').get(device.mirror_of, device.workspace_id) || null;
}

function guestSwitch(device) {
  if (!device.mirror_of) return device.screen_share_guest;
  const src = db.prepare('SELECT screen_share_guest FROM devices WHERE id = ? AND workspace_id IS ?').get(device.mirror_of, device.workspace_id);
  return src ? src.screen_share_guest : 0;
}

router.get('/devices/:id', (req, res) => {
  const r = loadDevice(req, res);
  if (!r) return;
  const avail = share.availability(r.device, r.ws);
  const session = share.sessionForDevice(r.device.id);
  const caps = require('../lib/player-capabilities');
  const display = displayOf(r.device);
  const roomKey = display ? display.id : r.device.id;
  res.json({
    feature: share.featureOn(),
    workspace_enabled: share.workspaceOn(r.ws),
    supported: require('../lib/player-capabilities').supports(r.device, share.CAP),
    available: avail.ok,
    reason: avail.ok ? null : avail.reason,
    can_share: !r.readOnly,
    can_admin: canAdminWorkspace(db, req.user, r.ws),
    // A mirror shows its display's meeting-room code, so it reports the display's switch.
    guest_enabled: !!guestSwitch(r.device),
    mirror_of: r.device.mirror_of || null,
    // A display's mirrors always get its shares (no choosing): the card names them.
    mirrors: r.device.mirror_of ? [] : require('../lib/mirrors').mirrorsOf(r.device.id)
      .filter((m) => { const row = db.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(m.id); return row && row.workspace_id === r.device.workspace_id; })
      .map((m) => ({ id: m.id, name: m.name || '', online: share.isOnline(m.id) })),
    max_seconds: share.maxSeconds(),
    session: share.publicSession(session),
    // Multi share: how many screens one share may reach, and what kind of player this is (the card
    // names it when it cannot show a share: "This screen can't show a screen share (Roku)").
    max_targets: share.maxTargets(),
    platform: require('../lib/player-capabilities').platformFamily(r.device),
    /*
     * Several presenters at once (the display's switch; a mirror reports its display's). `supported`:
     * the display's player can tile; `slots`: how many may present right now (1 when off);
     * `max_presenters`: the platform's limit. `presenters`: who is presenting on the display (and its
     * mirrors), first-come first, with the spotlight — what the owner's controls act on.
     */
    multi: {
      enabled: !!(display && display.screen_share_multi),
      supported: !!(display && caps.supports(display, share.TILES_CAP)),
      this_screen_tiles: caps.supports(r.device, share.TILES_CAP),
      slots: share.slotsFor(roomKey),
      max_presenters: share.maxPresenters(),
    },
    presenters: share.publicPresenters(roomKey),
  });
});

// ------------------------------------------------------------------ multi share
/*
 * The caller's access to one screen, without answering: { device, ws, readOnly } or { status, error }.
 * Same resolution as loadDevice — the screen's OWN workspace, resourceAccess on it.
 */
function accessFor(req, deviceId) {
  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(String(deviceId || ''));
  if (!device) return { status: 404, error: 'Device not found' };
  if (!device.workspace_id) return { status: 403, error: 'Device not assigned to a workspace' };
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(device.workspace_id);
  const ctx = ws && resourceAccess(req, ws);
  if (!ctx) return { status: 403, error: 'Access denied' };
  return { device, ws, readOnly: !ctx.actingAs && ctx.workspaceRole === 'workspace_viewer' };
}

// A device group the caller can see, and its members in the group's own workspace.
function loadGroupMembers(req, res, groupId) {
  const group = db.prepare('SELECT * FROM device_groups WHERE id = ?').get(String(groupId || ''));
  if (!group) { res.status(404).json({ error: 'Group not found' }); return null; }
  if (!group.workspace_id) { res.status(403).json({ error: 'Group not assigned to a workspace' }); return null; }
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(group.workspace_id);
  const ctx = ws && resourceAccess(req, ws);
  if (!ctx) { res.status(403).json({ error: 'Access denied' }); return null; }
  const members = db.prepare(`SELECT d.id FROM devices d JOIN device_group_members m ON m.device_id = d.id
                              WHERE m.group_id = ? AND d.workspace_id = ? ORDER BY d.name COLLATE NOCASE`).all(group.id, group.workspace_id);
  return { group, ws, readOnly: !ctx.actingAs && ctx.workspaceRole === 'workspace_viewer', ids: members.map((m) => m.id) };
}

// What a list of screens would do with a share: [{ id, name, ok, reason, platform }]. A mirror added
// for a display (roomKey) is judged as a leg of that display's room.
function describeTargets(list) {
  const caps = require('../lib/player-capabilities');
  return list.map(({ device, ws, roomKey }) => {
    const a = share.availability(device, ws, roomKey);
    return { id: device.id, name: device.name || '', ok: a.ok, reason: a.ok ? null : a.reason, platform: caps.platformFamily(device) };
  });
}

// GET /groups/:groupId — which of a group's screens can take a share right now, and why not.
router.get('/groups/:groupId', (req, res) => {
  const g = loadGroupMembers(req, res, req.params.groupId);
  if (!g) return;
  const list = g.ids.map((id) => accessFor(req, id)).filter((a) => a.device);
  res.json({
    feature: share.featureOn(), workspace_enabled: share.workspaceOn(g.ws), can_share: !g.readOnly,
    max_targets: share.maxTargets(), screens: describeTargets(list),
  });
});

/*
 * POST /shares {device_ids?: [...], group_id?: id, audio?} — one share on several screens.
 *
 * Every screen the caller NAMED (directly or through the group) must be in their reach with edit
 * rights, or the whole request is refused: a share must never half-start because one id was
 * someone else's, and the error does not say which (no probing other tenants' ids). Screens that
 * are reachable but cannot take a share right now (no receiver, offline, busy) are SKIPPED and
 * listed, so the sharer is told "3 of 5 — these two can't" instead of nothing happening.
 */
router.post('/shares', (req, res) => {
  const body = req.body || {};
  let requested = Array.isArray(body.device_ids) ? body.device_ids.filter((x) => typeof x === 'string').slice(0, 500) : [];
  if (body.group_id) {
    const g = loadGroupMembers(req, res, body.group_id);
    if (!g) return;
    if (g.readOnly) return res.status(403).json({ error: 'Read-only access' });
    requested = requested.concat(g.ids);
  }
  if (!requested.length) return res.status(400).json({ error: 'Choose at least one screen', reason: 'none_available' });
  if (!share.featureOn()) return res.status(409).json({ error: 'Screen sharing is not available on this server', reason: 'disabled' });

  const targets = [];
  for (const t of share.expandShareTargets(requested)) {
    const a = accessFor(req, t.id);
    if (a.error || a.readOnly) {
      if (t.via) continue;   // an added mirror the caller cannot reach is simply not included
      return res.status(a.readOnly ? 403 : a.status).json({ error: a.readOnly ? 'Read-only access' : a.error });
    }
    targets.push({ device: a.device, ws: a.ws, roomKey: t.via ? t.of : t.id });
  }
  const described = describeTargets(targets);
  const skipped = described.filter((d) => !d.ok);
  // A mirror only rides along with its display: a display that cannot take the share (its room is
  // full, say) must not be joined through the back door of one of its mirrors.
  const okIds = new Set(targets.filter((t, i) => described[i].ok).map((t) => t.device.id));
  const ok = targets.filter((t, i) => described[i].ok && (t.roomKey === t.device.id || okIds.has(t.roomKey)));
  if (!ok.length) {
    return res.status(409).json({ error: 'None of these screens can take a share right now', reason: skipped.length === 1 ? skipped[0].reason : 'none_available', skipped });
  }
  if (ok.length > share.maxTargets()) {
    return res.status(409).json({
      error: `One share can reach at most ${share.maxTargets()} screens: each one is a separate upload from your computer`,
      reason: 'too_many_targets', max_targets: share.maxTargets(), screens: ok.length, skipped,
    });
  }
  const name = (req.user && (req.user.name || req.user.email)) || 'Someone';
  const out = share.createShare({
    targets: ok.map((t) => ({ device: t.device, workspace: t.ws, roomKey: t.roomKey })),
    sharedBy: name, userId: req.user.id, guest: false, ip: req.ip, audio: !!body.audio,
  });
  if (out.error) return res.status(409).json({ error: 'A screen became busy, please try again', reason: out.error === 'too_many_targets' ? 'too_many_targets' : 'busy' });
  res.status(201).json({
    share_id: out.shareId,
    ws_path: '/api/screen-share/ws',
    max_seconds: share.maxSeconds(),
    legs: out.legs.map((l) => ({
      device_id: l.device.id, screen_name: l.device.name || '', session_id: l.session.id,
      ticket: l.ticket, ice_servers: share.iceServersFor(l.device.id),
    })),
    skipped,
  });
});

// DELETE /shares/:shareId — stop a share on every screen it is on. Needs edit rights on all of them.
router.delete('/shares/:shareId', (req, res) => {
  const legs = share.sessionsForShare(String(req.params.shareId || ''));
  if (!legs.length) return res.status(404).json({ error: 'Share not found' });
  for (const s of legs) {
    const a = accessFor(req, s.deviceId);
    // Another tenant's share is "not found", never "forbidden": no confirming that an id exists.
    if (a.error) return res.status(404).json({ error: 'Share not found' });
    if (a.readOnly) return res.status(403).json({ error: 'Read-only access' });
  }
  const stopped = share.stopShare(legs[0].shareId, 'stopped_by_owner', { userId: req.user.id, ip: req.ip });
  res.json({ stopped });
});

router.post('/devices/:id', (req, res) => {
  const r = loadDevice(req, res);
  if (!r) return;
  if (denyIfReadOnly(r, res)) return;
  const avail = share.availability(r.device, r.ws);
  if (!avail.ok) return res.status(409).json({ error: 'Screen sharing is not available on this screen', reason: avail.reason });
  const name = (req.user && (req.user.name || req.user.email)) || 'Someone';
  // The display's mirrors (its link open somewhere else) show what it shows, a share included:
  // best-effort, so a mirror that is offline or cannot show a share never refuses the share.
  const plan = share.withMirrors(r.device, r.ws, {
    reachable: (m) => { const a = accessFor(req, m.id); return !a.error && !a.readOnly; },
  });
  const { out, skipped } = share.createDisplayShare(plan, {
    sharedBy: name, userId: req.user.id, guest: false, ip: req.ip, audio: !!(req.body && req.body.audio),
  });
  if (out.error) return res.status(409).json({ error: 'Someone is already sharing to this screen', reason: 'busy' });
  res.status(201).json(share.displayShareBody(out, skipped));
});

router.delete('/devices/:id', (req, res) => {
  const r = loadDevice(req, res);
  if (!r) return;
  if (denyIfReadOnly(r, res)) return;
  // A display's mirrors showing the same share stop with it (lib/screen-share.js stopForDisplay).
  const stopped = share.stopForDisplay(r.device.id, 'stopped_by_owner', { userId: req.user.id, ip: req.ip });
  res.json({ stopped });
});

/*
 * PUT /devices/:id/multi {enabled} — let several people present on this display at once (up to the
 * platform's limit). Workspace admin, like the meeting-room code next to it. Turning it OFF mid-share
 * keeps everyone presenting and lets nobody new in (the room is then "full" at one slot) until it
 * empties; turning it ON shows a code again at once when a slot is free.
 */
router.put('/devices/:id/multi', (req, res) => {
  const r = loadDevice(req, res);
  if (!r) return;
  if (denyIfReadOnly(r, res)) return;
  if (!canAdminWorkspace(db, req.user, r.ws)) return res.status(403).json({ error: 'Only workspace admins can change screen sharing settings' });
  if (r.device.mirror_of) return res.status(409).json({ error: 'This screen is a mirror: change the setting on the display it mirrors.', reason: 'mirror' });
  const enabled = !!(req.body && req.body.enabled);
  db.prepare('UPDATE devices SET screen_share_multi = ? WHERE id = ?').run(enabled ? 1 : 0, r.device.id);
  audit('screen_share.multi_toggle', {
    userId: req.user.id, workspaceId: r.ws.id, deviceId: r.device.id, ip: req.ip, details: { enabled },
  });
  share.pushCode(r.device.id);   // a free slot shows a code now; a full room hides it
  res.json({ multi_enabled: enabled, slots: share.slotsFor(r.device.id) });
});

// The room an owner's control acts on: a mirror's is its display's.
function roomKeyFor(r) { const d = displayOf(r.device); return d ? d.id : r.device.id; }

// PUT /devices/:id/spotlight {share_id | null} — one presenter fills the screen; null = tiles again.
router.put('/devices/:id/spotlight', (req, res) => {
  const r = loadDevice(req, res);
  if (!r) return;
  if (denyIfReadOnly(r, res)) return;
  const shareId = req.body && typeof req.body.share_id === 'string' ? req.body.share_id : null;
  const ok = share.setSpotlight(roomKeyFor(r), shareId, { userId: req.user.id, ip: req.ip, name: req.user.name || req.user.email });
  if (!ok) return res.status(404).json({ error: 'That presenter is not on this screen', reason: 'not_found' });
  res.json({ spotlight: shareId });
});

// DELETE /devices/:id/presenters/:shareId — take one presenter off this display and its mirrors.
router.delete('/devices/:id/presenters/:shareId', (req, res) => {
  const r = loadDevice(req, res);
  if (!r) return;
  if (denyIfReadOnly(r, res)) return;
  const n = share.removePresenter(roomKeyFor(r), String(req.params.shareId || ''), { userId: req.user.id, ip: req.ip, name: req.user.name || req.user.email });
  if (!n) return res.status(404).json({ error: 'That presenter is not on this screen', reason: 'not_found' });
  res.json({ removed: n });
});

router.put('/devices/:id/guest', (req, res) => {
  const r = loadDevice(req, res);
  if (!r) return;
  if (denyIfReadOnly(r, res)) return;
  if (!canAdminWorkspace(db, req.user, r.ws)) return res.status(403).json({ error: 'Only workspace admins can change meeting-room sharing' });
  // A mirror shows its display's code; the switch lives on the display.
  if (r.device.mirror_of) return res.status(409).json({ error: 'This screen is a mirror: it shows the meeting-room code of the display it mirrors. Change the setting on that display.', reason: 'mirror' });
  const enabled = !!(req.body && req.body.enabled);
  db.prepare('UPDATE devices SET screen_share_guest = ? WHERE id = ?').run(enabled ? 1 : 0, r.device.id);
  audit('screen_share.guest_toggle', {
    userId: req.user.id, workspaceId: r.ws.id, deviceId: r.device.id, ip: req.ip, details: { enabled },
  });
  if (!enabled) share.dropCode(r.device.id);
  else share.rotateCode(r.device.id);   // turning it on is a fresh code, never one from before
  share.pushCode(r.device.id);
  res.json({ guest_enabled: enabled });
});

// The workspace switch, for a workspace named in the URL (the members page can show any workspace
// the caller administers, not only the one they are switched into).
function loadWorkspace(req, res) {
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(String(req.params.wsId || ''));
  const ctx = ws && resourceAccess(req, ws);
  if (!ctx) { res.status(ws ? 403 : 404).json({ error: ws ? 'Access denied' : 'Workspace not found' }); return null; }
  return ws;
}

router.get('/workspace/:wsId', (req, res) => {
  const ws = loadWorkspace(req, res);
  if (!ws) return;
  res.json({ feature: share.featureOn(), enabled: share.workspaceOn(ws), can_admin: canAdminWorkspace(db, req.user, ws), max_seconds: share.maxSeconds() });
});

router.put('/workspace/:wsId', (req, res) => {
  const ws = loadWorkspace(req, res);
  if (!ws) return;
  if (!canAdminWorkspace(db, req.user, ws)) return res.status(403).json({ error: 'Only workspace admins can change screen sharing' });
  const enabled = !!(req.body && req.body.enabled);
  db.prepare('UPDATE workspaces SET screen_share_enabled = ? WHERE id = ?').run(enabled ? 1 : 0, ws.id);
  auditFromReq(req, 'screen_share.workspace_toggle', { workspace_id: ws.id, enabled });
  if (!enabled) share.stopWorkspace(ws.id, 'disabled_by_admin', { userId: req.user.id, ip: req.ip });
  else {
    // Back on: screens that had the meeting-room code on show a fresh one again.
    for (const d of db.prepare('SELECT id FROM devices WHERE workspace_id = ? AND screen_share_guest = 1').all(ws.id)) share.pushCode(d.id);
  }
  res.json({ enabled });
});

module.exports = router;
