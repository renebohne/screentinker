'use strict';

// Security: never return a device's WebSocket auth secret to API/dashboard
// clients. `device_token` is the credential the device proves with (validated
// via crypto.timingSafeEqual on the /device socket); leaking it to any
// workspace user enables device impersonation. Strip it from every device row
// before it leaves the server.
function stripDeviceSecrets(d) {
  if (!d || typeof d !== 'object') return d;
  delete d.device_token;
  return d;
}

// List responses additionally drop `settings_pin`.
//
// The PIN unlocks the player's on-device settings menu (2x Back), i.e. physical control of
// the panel. The dashboard genuinely needs it — but only on ONE screen, the device detail
// page, which fetches a single device via GET /api/devices/:id. The collection endpoint was
// handing out the PIN for EVERY device in the workspace on every load, to every member,
// with no consumer for it. Same data, far wider blast radius, for nothing.
//
// So: detail keeps it (the feature is unchanged), the list does not. If a future list view
// needs the PIN, fetch the device rather than widening this.
function stripDeviceSecretsForList(d) {
  const row = stripDeviceSecrets(d);
  if (row && typeof row === 'object') {
    delete row.settings_pin;
    // Same reasoning as the PIN: the trigger secret has exactly one consumer, the device detail
    // page, and handing it out for every device in the workspace on every list load is the same
    // data with a far wider blast radius for nothing.
    delete row.trigger_secret;
  }
  return row;
}

/*
 * ⚠️ THE TRIGGER SECRET IS NEVER GIVEN TO AN API TOKEN, even a full-scope one, and this is a
 * stronger rule than the one applied to settings_pin.
 *
 * The PIN unlocks a menu for someone already standing at the panel. The trigger secret is the
 * credential that makes an unauthenticated LAN datagram change what a screen displays — so handing
 * it to a READ-scoped integration token would turn "may list your screens" into "may put content on
 * any of them", which is an escalation no scope on that token ever granted.
 *
 * A dashboard session keeps it, because a human configuring a Crestron panel has to type it in
 * somewhere and that screen is the only place it exists.
 */
function stripTriggerSecretForTokens(d, viaToken) {
  if (viaToken && d && typeof d === 'object') delete d.trigger_secret;
  return d;
}

module.exports = { stripDeviceSecrets, stripDeviceSecretsForList, stripTriggerSecretForTokens };
