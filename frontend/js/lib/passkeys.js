/*
 * 3.0: passkeys in the browser — plain navigator.credentials and a little base64url, no library.
 *
 * The server sends WebAuthn options as JSON (base64url strings where the API wants bytes) and
 * expects the credential back the same way. Browsers that have PublicKeyCredential.parse*FromJSON
 * and credential.toJSON() do this themselves; the hand conversion below is for the ones that don't
 * yet. Nothing here VERIFIES anything: that is the server's job (@simplewebauthn/server).
 */

export function b64uToBuf(s) {
  const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export function bufToB64u(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The browser can do WebAuthn at all (and the page is a secure context). */
export function passkeysSupported() {
  return typeof window !== 'undefined' && !!window.PublicKeyCredential && !!navigator.credentials
    && window.isSecureContext !== false;
}

/*
 * Passkeys can work on THIS page: the server has a trusted public address, this page is on it, and
 * the browser supports them. On any other address (the LAN IP of a server whose APP_URL is its
 * public name, say) the browser would refuse the ceremony, so the button is not drawn there.
 *
 * Inside the Manager app (Android WebView) they are hidden: a WebView only gets WebAuthn when the
 * app opts in through androidx.webkit and the server's domain is linked to the app — see
 * docs/passkeys.md.
 */
export function passkeysUsableHere(cfg, { inApp = false } = {}) {
  return !!(cfg && cfg.enabled && cfg.origin === window.location.origin && passkeysSupported() && !inApp);
}

export async function conditionalMediationAvailable() {
  try {
    return !!(window.PublicKeyCredential && PublicKeyCredential.isConditionalMediationAvailable
      && await PublicKeyCredential.isConditionalMediationAvailable());
  } catch { return false; }
}

function creationOptions(json) {
  if (typeof PublicKeyCredential.parseCreationOptionsFromJSON === 'function') {
    return PublicKeyCredential.parseCreationOptionsFromJSON(json);
  }
  return {
    ...json,
    challenge: b64uToBuf(json.challenge),
    user: { ...json.user, id: b64uToBuf(json.user.id) },
    excludeCredentials: (json.excludeCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) })),
  };
}

function requestOptions(json) {
  if (typeof PublicKeyCredential.parseRequestOptionsFromJSON === 'function') {
    return PublicKeyCredential.parseRequestOptionsFromJSON(json);
  }
  return {
    ...json,
    challenge: b64uToBuf(json.challenge),
    allowCredentials: (json.allowCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) })),
  };
}

function credentialJSON(cred) {
  if (typeof cred.toJSON === 'function') {
    try { return cred.toJSON(); } catch { /* fall through to the manual shape */ }
  }
  const r = cred.response;
  const response = { clientDataJSON: bufToB64u(r.clientDataJSON) };
  if (r.attestationObject) {
    response.attestationObject = bufToB64u(r.attestationObject);
    if (typeof r.getTransports === 'function') response.transports = r.getTransports();
  } else {
    response.authenticatorData = bufToB64u(r.authenticatorData);
    response.signature = bufToB64u(r.signature);
    if (r.userHandle) response.userHandle = bufToB64u(r.userHandle);
  }
  return {
    id: cred.id,
    rawId: bufToB64u(cred.rawId),
    type: cred.type,
    response,
    clientExtensionResults: typeof cred.getClientExtensionResults === 'function' ? cred.getClientExtensionResults() : {},
    authenticatorAttachment: cred.authenticatorAttachment || undefined,
  };
}

/** Create a passkey from server options; resolves to the JSON the server verifies. */
export async function createPasskey(optionsJSON) {
  const cred = await navigator.credentials.create({ publicKey: creationOptions(optionsJSON) });
  return credentialJSON(cred);
}

/** Sign in with a passkey. `mediation: 'conditional'` is the autofill flavour; pass a signal to abort it. */
export async function getPasskey(optionsJSON, { mediation, signal } = {}) {
  const req = { publicKey: requestOptions(optionsJSON) };
  if (mediation) req.mediation = mediation;
  if (signal) req.signal = signal;
  const cred = await navigator.credentials.get(req);
  return cred ? credentialJSON(cred) : null;
}

/** A user who closed the browser's sheet is not an error worth shouting about. */
export function isUserCancel(err) {
  return !!err && (err.name === 'NotAllowedError' || err.name === 'AbortError');
}

/** A default name for a new passkey, from the browser's own description of the device. */
export function suggestedPasskeyName() {
  const ua = navigator.userAgent || '';
  const os = /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac'
    : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'Chromebook' : /Linux/.test(ua) ? 'Linux' : '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari' : '';
  // Product names only, no words, so it needs no translation; the person can rename it.
  return [browser, os].filter(Boolean).join(' · ') || 'Passkey';
}
