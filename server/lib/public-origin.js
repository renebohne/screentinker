'use strict';

/*
 * The public origin to put in a link that LEAVES the request — an emailed password reset, email
 * verification, workspace invite, account notice.
 *
 * ⚠️ NEVER TRUST THE Host HEADER FOR AN EMAILED LINK. These sites used
 * `process.env.APP_URL || \`${req.protocol}://${req.get('host')}\``, so on an install with no
 * APP_URL anyone could POST /forgot-password for a victim with `Host: evil.example` and the real,
 * single-use reset token was mailed to the victim inside a link to evil.example — one click hands
 * the attacker the account (host-header poisoning). The fallback is now:
 *
 *   1. APP_URL, when set — the canonical answer, and what production uses.
 *   2. The request host, ONLY when it is in PUBLIC_HOSTS (comma-separated host[:port]) or loopback.
 *   3. SELF_HOSTED with no APP_URL: still the request host. A LAN install reached by IP has no other
 *      way to know its own address, and refusing would break reset/invite mail on every such box
 *      after an in-place upgrade. RESIDUAL RISK: whoever can reach that server with a forged Host
 *      can still poison a link there — set APP_URL (or PUBLIC_HOSTS) to close it; boot says so.
 *   4. Otherwise the first PUBLIC_HOSTS entry, else this server on localhost — a link that may not
 *      work, which is the safe failure, never one that points somewhere an attacker chose.
 */

const config = require('../config');

const HOST_RE = /^[A-Za-z0-9.\-]+(?::\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](?::\d{1,5})?$/;

function appUrl() {
  return String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
}

function allowedHosts() {
  return new Set(String(process.env.PUBLIC_HOSTS || '').split(',')
    .map((h) => h.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
    .filter(Boolean));
}

function isLoopbackHost(host) {
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return name === 'localhost' || name === '::1' || /^127\./.test(name);
}

function proto(req) {
  return req && req.protocol === 'https' ? 'https' : 'http';
}

let warned = false;
function warnOnce() {
  if (warned || appUrl()) return;
  warned = true;
  console.warn('[config] ⚠️ APP_URL is not set. Emailed links (password reset, verification, invites) '
    + (config.selfHosted
      ? 'use the address the request arrived on, which a forged Host header can steer. Set APP_URL to this server\'s public address.'
      : 'are only built from hosts listed in PUBLIC_HOSTS. Set APP_URL to this server\'s public address.'));
}

function publicOrigin(req) {
  const configured = appUrl();
  if (configured) return configured;
  warnOnce();
  const host = String((req && typeof req.get === 'function' && req.get('host')) || '').trim();
  const validHost = HOST_RE.test(host) ? host : '';
  if (validHost && (allowedHosts().has(validHost.toLowerCase()) || isLoopbackHost(validHost))) {
    return `${proto(req)}://${validHost}`;
  }
  if (validHost && config.selfHosted) return `${proto(req)}://${validHost}`;
  const first = [...allowedHosts()][0];
  if (first) return `${proto(req)}://${first}`;
  return `http://localhost:${config.port}`;
}

// Said once at boot rather than on the first email, so an operator reading the startup log sees it.
warnOnce();

module.exports = { publicOrigin, _resetWarning: () => { warned = false; } };
