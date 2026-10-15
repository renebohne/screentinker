'use strict';

/*
 * A software WebAuthn authenticator for tests: real P-256 keys and real ES256 signatures from
 * node:crypto, real CBOR, real authenticator data — so the server's library verifies genuine
 * bytes, and a test that tampers with one field fails for the reason it claims to.
 *
 * It is deliberately NOT a verifier and shares no code with the server: if both sides used the
 * same encoder, an encoding bug would cancel out and every test would pass.
 */

const crypto = require('node:crypto');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (data) => crypto.createHash('sha256').update(data).digest();

// ---- minimal CBOR encoder (the subset WebAuthn uses: ints, bytes, text, maps) ----
function head(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
  const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
}
function cbor(v) {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (typeof v === 'string') { const s = Buffer.from(v, 'utf8'); return Buffer.concat([head(3, s.length), s]); }
  if (v instanceof Map) {
    const parts = [head(5, v.size)];
    for (const [k, val] of v) parts.push(cbor(k), cbor(val));
    return Buffer.concat(parts);
  }
  if (v && typeof v === 'object') return cbor(new Map(Object.entries(v)));
  throw new Error('cbor: unsupported value');
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

class SoftAuthenticator {
  constructor({ origin, rpId }) {
    this.origin = origin;
    this.rpId = rpId;
    this.credentials = []; // { id: Buffer, privateKey, publicJwk, userHandle, rpId, counter }
  }

  /** navigator.credentials.create(), returning the RegistrationResponseJSON a browser would. */
  create(options, { origin = this.origin, rpId = options.rp.id, uv = true, counter = 0 } = {}) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    const credId = crypto.randomBytes(32);
    const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1],
      [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
    const countBuf = Buffer.alloc(4); countBuf.writeUInt32BE(counter, 0);
    const lenBuf = Buffer.alloc(2); lenBuf.writeUInt16BE(credId.length, 0);
    const authData = Buffer.concat([
      sha256(rpId), Buffer.from([FLAG_UP | FLAG_AT | (uv ? FLAG_UV : 0)]), countBuf,
      Buffer.alloc(16), lenBuf, credId, cose,
    ]);
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin, crossOrigin: false }));
    const attObj = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    const cred = { id: credId, privateKey, userHandle: options.user.id, rpId, counter };
    this.credentials.push(cred);
    return {
      cred,
      response: {
        id: b64u(credId), rawId: b64u(credId), type: 'public-key',
        response: { clientDataJSON: b64u(clientData), attestationObject: b64u(attObj), transports: ['internal'] },
        clientExtensionResults: {}, authenticatorAttachment: 'platform',
      },
    };
  }

  /** navigator.credentials.get(), returning the AuthenticationResponseJSON a browser would. */
  get(options, cred = this.credentials[0], {
    origin = this.origin, rpId = cred.rpId, uv = true, counter = null, userHandle = cred.userHandle, type = 'webauthn.get',
  } = {}) {
    cred.counter = counter == null ? cred.counter + 1 : counter;
    const countBuf = Buffer.alloc(4); countBuf.writeUInt32BE(cred.counter, 0);
    const authData = Buffer.concat([sha256(rpId), Buffer.from([FLAG_UP | (uv ? FLAG_UV : 0)]), countBuf]);
    const clientData = Buffer.from(JSON.stringify({ type, challenge: options.challenge, origin, crossOrigin: false }));
    const signature = crypto.sign('sha256', Buffer.concat([authData, sha256(clientData)]), cred.privateKey); // DER
    return {
      id: b64u(cred.id), rawId: b64u(cred.id), type: 'public-key',
      response: {
        clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(signature),
        ...(userHandle ? { userHandle } : {}),
      },
      clientExtensionResults: {}, authenticatorAttachment: 'platform',
    };
  }
}

module.exports = { SoftAuthenticator, cbor };
