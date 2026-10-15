# Passkeys (WebAuthn)

ScreenTinker 3.0 lets people sign in with a **passkey**: a fingerprint, face, device PIN, phone or
security key instead of a password. A passkey can also stand in for the **two-factor code** on
accounts that use an authenticator app.

Passkeys are for **password accounts** (local accounts). People who sign in through single sign-on
use whatever their identity provider offers.

## For users

### Add a passkey

- **Advanced view:** Settings → *Passkeys* → **Add a passkey**. Enter your current password (and a
  code from your authenticator app if two-factor is on), give it a name, then follow your browser.
- **Simple view:** account menu (top right) → **Sign in with a passkey**. One screen: your password,
  then your browser's prompt, then done.

You are asked for your password again on purpose: a passkey is a way into your account that lasts
until you remove it, so the person adding one must prove it is them, not just be holding a signed-in
browser.

### Sign in with a passkey

- On the sign-in page, press **Sign in with a passkey**. You do not type your email: the browser
  asks which passkey to use, and the passkey says which account it belongs to.
- In browsers that support it, your passkeys are also offered in the **autofill list** under the
  email box.
- If your account uses two-factor codes and you sign in with your password, the code screen offers
  **Use a passkey instead**.

A passkey sign-in does not then ask for a two-factor code. Passkeys here always require your
fingerprint, face or device PIN, so the sign-in already checks two things (the device, and that it
is you), and it cannot be phished: the browser will not use the passkey on any other site.

### Manage passkeys

Settings → *Passkeys* lists each passkey with when it was added and last used. **Rename** it, or
**Remove** it. Removing a passkey **signs out every other device** signed in to your account (this
browser stays signed in). The usual reason to remove a passkey is a lost or sold device, and that
device is probably still signed in.

Adding a passkey does not sign anyone out: your password still works exactly as before, so nothing
has become harder to get past.

An account can hold up to 20 passkeys.

## For administrators

### Passkeys need a stable public address

A passkey is permanently tied to the **domain** it was created on (the WebAuthn "relying party").
ScreenTinker takes that domain **only** from configuration the operator wrote, never from the
address a request claims to be for (the `Host` header, which anyone can forge):

1. **`APP_URL`**, when set — e.g. `APP_URL=https://signage.example.com`. This is the normal setup,
   and the same setting emailed links use.
2. Otherwise, a host listed in **`PUBLIC_HOSTS`** (comma-separated `host[:port]`), when the request
   arrived on that host.
3. Otherwise passkeys are **off**. Settings → *Passkeys* says so, and tells platform admins what to
   set. Nothing is silently bound to whatever address a request arrived on.

Unlike emailed links, there is no "self-hosted, trust the request's address" fallback and no
loopback exception: a bad reset link fails once, but a passkey created against a bad address is
bound to it for good.

Browsers add two rules of their own, so these are reported in Settings rather than offered and
then failing:

- **HTTPS is required**, except for `http://localhost`.
- **An IP address cannot be used** (`https://192.168.1.20` will not work). Give the server a host
  name, even a local one, and use that in `APP_URL`.

Passkeys only work on the page served from that address. If `APP_URL` is
`https://signage.example.com` and someone opens the dashboard by its LAN IP, the passkey button is
not shown there (the browser would refuse it).

**Changing `APP_URL` to a different domain** makes existing passkeys unusable (they stay bound to
the old one). People sign in with their password and add a new passkey.

### Single sign-on enforced organizations

When an organization **requires single sign-on**, passkeys are refused for its members exactly as
passwords are, and with the same rules:

- by membership as well as by email domain;
- the **platform admin** keeps the break-glass (so the operator can never be locked out by a broken
  identity provider);
- if the policy cannot be read, the answer is "single sign-on required" (fail closed).

Members of such an organization cannot add a passkey, and a passkey they added earlier stops
signing them in (it answers "your organization requires single sign-on").

### Security notes

- **Verification** is done by `@simplewebauthn/server` (pinned to an exact version). Nothing about
  attestation or signatures is hand-rolled.
- **Challenges** are stored server-side, are single-use (deleted before they are checked, whatever
  the outcome), expire after 5 minutes, and are bound to their purpose (add / sign in / second
  factor) and, where there is one, to the account. Unauthenticated callers can create challenges
  (the sign-in page does), so the table is swept on every insert and capped at 5,000 live rows.
- **Signature counters**: a counter that goes backwards suggests a cloned security key. The sign-in
  is refused and an `auth:passkey_counter_regression` audit entry is written. (Synced passkeys
  always report 0, which is not treated as a regression.) If a real key trips this, remove it and
  add it again.
- **User verification** is required when adding a passkey and when signing in with one; as a second
  factor after a password it is preferred, not required (possession is what is being proven there).
- As a **second factor**, only the account's own passkeys are accepted, and failures share the
  existing TOTP lockout (5 failures → 15 minutes).
- **Rate limits** (per IP, per minute): sign-in options 60, sign-in 20, second-factor options 20,
  second factor 10, add-passkey options 10, add-passkey verify 10.
- **Audit log** (`activity_log`): `auth:passkey_added`, `auth:passkey_renamed`,
  `auth:passkey_removed`, `auth:passkey_login`, `auth:passkey_counter_regression`, plus the usual
  `auth:login_success` / `auth:login_failed`.
- The WebAuthn **user handle** stored on the authenticator is 32 random bytes, never the email or the
  internal user id.

### Storage

Two additive tables (created at boot by the migration list in `server/db/database.js`):

- `webauthn_credentials` — one row per passkey: credential id, public key (not secret), signature
  counter, transports, user handle, the domain it is bound to, name, created / last used.
- `webauthn_challenges` — outstanding challenges (minutes-long, single-use).

Deleting a user deletes their passkeys.

## API

All under `/api/auth/passkeys`.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/` | session | This account's passkeys, and whether passkeys work here (`available`, `reason`, `origin`) |
| POST | `/register/options` | session + `password` (+ `code` if TOTP is on) | Creation options |
| POST | `/register/verify` | session | `{ challenge_id, response, name }` → stores the passkey |
| PATCH | `/:id` | session | `{ name }` |
| DELETE | `/:id` | session | Removes it; ends other sessions; returns a fresh `token` |
| POST | `/login/options` | none | Discoverable-credential request options |
| POST | `/login/verify` | none | `{ challenge_id, response }` → same answer as `POST /api/auth/login` |
| POST | `/mfa/options` | `mfa_token` | Request options for this account's passkeys |
| POST | `/mfa/verify` | `mfa_token` | `{ mfa_token, challenge_id, response }` → session |

`GET /api/auth/config` carries `passkeys: { enabled, origin }`, and the `mfa_required` answer from
`POST /api/auth/login` carries `passkey: true|false`.

API tokens are unaffected: passkeys are an interactive sign-in method.

## The Manager app (Android)

Passkeys are **hidden in the Manager app** for now; people sign in there with their password or
single sign-on as before. Passkeys added in a browser keep working in that browser (including the
phone's own browser, where Account settings opens).

What it would take, from a read of `android-admin/`:

1. **WebView support.** Android's WebView only exposes WebAuthn when the app opts in, through
   androidx.webkit. The app does not use androidx.webkit today. It needs
   `implementation("androidx.webkit:webkit:1.17.1")` (current stable; `minCompileSdk` 33, the app
   compiles against 36) and, in `MainActivity.setUpWebView()`:

   ```kotlin
   if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_AUTHENTICATION)) {
       WebSettingsCompat.setWebAuthenticationSupport(
           web.settings, WebSettingsCompat.WEB_AUTHENTICATION_SUPPORT_FOR_APP)
   }
   ```

   Whether the feature is present depends on the installed Android System WebView version, so the
   check is required. `WEB_AUTHENTICATION_SUPPORT_FOR_BROWSER` is for apps that are browsers and
   does not apply.

2. **The server's domain must be linked to the app.** In "for app" mode the WebView asks Android's
   Credential Manager on the app's behalf, and Credential Manager only allows it for a domain that
   lists the app in **Digital Asset Links**: `https://<RP domain>/.well-known/assetlinks.json` naming
   `com.screentinker.manager` and the SHA-256 fingerprint(s) of its signing certificate (the Play
   app-signing key, plus the upload/debug keys for testing), with the
   `delegate_permission/common.get_login_creds` relation. Because the Manager app talks to any
   self-hosted server, the ScreenTinker server would need to serve that file itself, with the
   official app's fingerprints built in and a setting for forks signed with other keys.

3. **Origin.** A request made "as the app" may reach the server with the app's origin
   (`android:apk-key-hash:<hash of the signing certificate>`) in the client data rather than the
   web origin. If so, the server must accept that origin for those requests in addition to
   `APP_URL`'s. This needs confirming on a real device before it is built.

4. Then remove the `inApp` exclusion in `frontend/js/lib/passkeys.js` (`passkeysUsableHere`).

Step 1 alone is a safe, small change, but on its own it would only turn a hidden button into one
that fails, so it was left for the release that does steps 2–4 together and can be tested on a
device.
