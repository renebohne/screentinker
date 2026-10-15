/*
 * 3.0: adding a passkey to this account — shared by Settings → Security and the Simple view guide,
 * so both run the same three steps: re-authenticate and get options from the server, let the
 * browser create the credential, hand it back to be verified and stored.
 */
import { api } from '../api.js';
import { t } from '../i18n.js';
import { createPasskey, isUserCancel } from '../lib/passkeys.js';

/**
 * Resolves to the stored passkey ({ id, name, ... }). Rejects with an Error whose message is ready to
 * show; `err.cancelled` is set when the person simply closed the browser's sheet.
 */
export async function addPasskey({ password, code, name }) {
  const opts = await api.passkeyRegisterOptions(password, code || undefined);
  let response;
  try {
    response = await createPasskey(opts.options);
  } catch (err) {
    if (isUserCancel(err)) throw Object.assign(new Error(t('passkey.err_cancelled')), { cancelled: true });
    // InvalidStateError: this authenticator already holds a passkey for this account (excludeCredentials).
    if (err && err.name === 'InvalidStateError') throw new Error(t('passkey.err_exists'));
    throw new Error(t('passkey.err_create'));
  }
  const r = await api.passkeyRegisterVerify(opts.challenge_id, response, name);
  return r.passkey;
}

/** What to tell someone when passkeys are switched off here. Admins get the fix, everyone else the fact. */
export function unavailableMessage(reason, isAdmin) {
  if (!isAdmin) return t('passkey.unavailable');
  if (reason === 'insecure_origin') return t('passkey.admin_insecure');
  if (reason === 'ip_address') return t('passkey.admin_ip');
  if (reason === 'bad_app_url') return t('passkey.admin_bad_app_url');
  return t('passkey.admin_no_app_url');
}
