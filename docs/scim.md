# User provisioning (SCIM 2.0)

ScreenTinker can be provisioned by your identity provider over SCIM 2.0 (RFC 7643 / RFC 7644).
Once it is connected, your identity provider handles the joiner/mover/leaver work here:

- **Joiners.** When you assign someone to the ScreenTinker app in Okta or Entra ID, they get a
  ScreenTinker account in your organization. They sign in with your single sign-on. The account
  never has a password.
- **Movers.** When someone joins or leaves a group in your identity provider, the workspace access
  you mapped to that group is added or removed.
- **Leavers.** When someone is deactivated or unassigned, their sessions end straight away and
  they lose access to your organization. Reactivating them gives that access back.

This page has two parts. The first is for the administrator who sets it up, with step-by-step
instructions for [Okta](#okta) and [Microsoft Entra ID](#microsoft-entra-id). The second is a
[reference](#reference) that describes exactly what each SCIM request does.

---

## Before you start

1. **Single sign-on must be set up and working**, with at least one sign-in domain **verified**.
   Use *Settings > Single sign-on (your organization)*. Provisioned people sign in through it, and
   ScreenTinker only provisions addresses at your organization's verified domains. Another tenant
   can't provision people at your domain, and you can't provision people at theirs.
2. You must be an **owner or admin of the organization**, and your own email address must be
   verified.

## Turn it on in ScreenTinker

1. Go to **Settings > User provisioning (SCIM)**.
2. Tick **Turn on user provisioning**.
3. Copy the **SCIM base URL**. It looks like `https://signage.example.com/scim/v2`.
4. Under **Provisioning tokens**, enter a name (for example `Okta`) and click **Create token**.
   Copy the token right away. **It is shown only once.** ScreenTinker stores only a hash of it.
5. Optional: under **Access for everyone provisioned**, pick a workspace and role that every
   provisioned person should get. You can also give access only through groups (see below).

You can have up to five active tokens. To rotate a token, create a new one, paste it into your
identity provider, then revoke the old one. Provisioning keeps working the whole time. The token
list shows when each token was last used.

---

## Okta

These steps use the Okta app integration you already created for single sign-on (SAML or OIDC).
Adding provisioning to that app keeps assignments in one place.

1. In the Okta Admin Console, open **Applications > Applications** and select your ScreenTinker app.
2. On the **General** tab, click **Edit** under *App Settings*. Set **Provisioning** to **SCIM**
   and save. A **Provisioning** tab appears.
3. Open **Provisioning > Integration** and click **Edit**:
   - **SCIM connector base URL:** the SCIM base URL from ScreenTinker.
   - **Unique identifier field for users:** `userName`
   - **Supported provisioning actions:** tick *Push New Users*, *Push Profile Updates* and
     *Push Groups*.
   - **Authentication Mode:** *HTTP Header*
   - **Authorization / Bearer:** paste the provisioning token, without the word `Bearer`.
4. Click **Test Connector Configuration**. Okta should report that it found the user and group
   features. Then click **Save**.
5. Open **Provisioning > To App**, click **Edit**, and enable **Create Users**,
   **Update User Attributes** and **Deactivate Users**. Leave *Sync Password* off. ScreenTinker
   ignores any password it is sent, because provisioned people sign in with single sign-on.
6. On the **Sign On** tab, make sure **Application username format** is the person's **email**
   (for example *Email* or *Okta username* when that is an email). ScreenTinker keys accounts on
   the email address, and it must be at one of your verified domains.
7. On **Assignments**, assign the people or groups who should have ScreenTinker.
8. On **Push Groups**, push the groups you want to use for workspace access. Okta then creates
   them in ScreenTinker and keeps their membership in sync.
9. Back in ScreenTinker, give each pushed group its access. See
   [Groups and workspace access](#groups-and-workspace-access).

**How Okta's actions map:** Okta updates people with `PUT /Users/{id}`. Unassigning or deactivating
someone sends `active: false`, which deactivates them here. Okta does not delete users.
Reassigning them reactivates them.

## Microsoft Entra ID

These steps use the Enterprise application you created for single sign-on.

1. In the Microsoft Entra admin center, go to **Identity > Applications > Enterprise applications**
   and open your ScreenTinker application.
2. Open **Provisioning** and click **Get started** (or *New configuration*).
3. Set **Provisioning Mode** to **Automatic**. Under **Admin Credentials**:
   - **Tenant URL:** the SCIM base URL from ScreenTinker.
   - **Secret Token:** the provisioning token.
4. Click **Test Connection**, wait for the success message, then click **Save**.
5. Open **Mappings > Provision Microsoft Entra ID Users** and check these attribute mappings:
   - `userName` ← `userPrincipalName`. Use `mail` instead if your UPNs are not the addresses
     people sign in with.
   - `emails[type eq "work"].value` ← `mail`
   - `active` ← `Switch([IsSoftDeleted], , "False", "True", "True", "False")` (the default)
   - `displayName`, `name.givenName`, `name.familyName` and `externalId` as Entra proposes.

   ScreenTinker uses the **work email**, or `userName` when no email is sent. That address must
   match the one your single sign-on sends at sign-in. Other attributes Entra maps, such as phone
   numbers, addresses and the enterprise extension, are accepted and ignored.
6. Make sure **Provision Microsoft Entra ID Groups** is **enabled** if you want to manage
   access by group.
7. Under **Settings**, set **Scope** to **Sync only assigned users and groups**.
8. Under **Users and groups**, assign the people and groups who should have ScreenTinker.
9. Set **Provisioning Status** to **On** and click **Save**. Entra runs an initial cycle, then
   syncs about every 40 minutes. To try one person straight away, use **Provision on demand**.
10. Back in ScreenTinker, give each group its access. See
    [Groups and workspace access](#groups-and-workspace-access).

**How Entra's actions map:** Entra updates people with `PATCH`. Disabling or unassigning someone
sends `active` as the string `"False"`, which deactivates them here. When Entra later hard-deletes
the user (after its soft-delete period, or straight away for some scopes), it sends `DELETE`. See
[Removing people](#removing-people-delete).

Microsoft documents an optional `?aadOptscim062020` flag for the Tenant URL. ScreenTinker handles
Entra's requests correctly with or without it.

## Other identity providers

Any SCIM 2.0 client that uses a bearer token works, including OneLogin, JumpCloud, Ping and
Authentik. Use the base URL and a token from the settings page. If the client has the option,
choose *email* as the user identifier.

---

## Groups and workspace access

Groups appear in **Settings > User provisioning (SCIM) > Groups and workspace access** as your
identity provider pushes them. For each group, pick a **workspace** and a **role** (*Admin*,
*Editor* or *Viewer*) and click **Give access**. A group can give access to several workspaces.

- Joining a group in the identity provider gives the person that role in that workspace.
  Leaving the group takes it away.
- When several groups, or the organization-wide default, give the same workspace, the person gets
  the **highest** role among them.
- Removing a mapping, or deleting the group in the identity provider, removes the access it gave.
- **Access you granted by hand is never removed.** If someone was already a *Viewer* in a workspace
  and a group makes them *Admin*, they go back to *Viewer* when they leave the group, not to
  nothing. Provisioning only ever removes what it added.
- Groups can only give **workspace** roles. Organization roles, including organization admin, stay
  with your organization's admins. Changing a group in the identity provider can never make
  someone an organization admin here.

## Removing people (DELETE)

| The account… | What DELETE does |
|---|---|
| …was created by provisioning, or signs in through your SSO, and has no access to any other organization | The account is **deleted**. A personal organization they made only for themselves goes with it. |
| …signs in through your SSO but also has access to another organization | Their access to your organization is removed, and the account is **disabled** and signed out everywhere. Your identity provider owns how it signs in, so it can't keep signing in elsewhere. |
| …was an existing member you linked, with their own password or their own sign-in | Only their access **to your organization** is removed, and their sessions are ended. The account itself is theirs. |

If you provision the same person again later, provisioning picks up the same account, or creates
it again if it was deleted. A disabled account is switched back on.

---

## Reference

### Endpoints

Base URL: `https://<your server>/scim/v2`. Every request needs `Authorization: Bearer <token>`.
Requests and responses use `application/scim+json`; `application/json` is accepted too.

| Method | Path | Notes |
|---|---|---|
| GET | `/ServiceProviderConfig`, `/ResourceTypes`, `/Schemas` | Discovery. PATCH and filter are supported. Bulk, sort, ETags and password change are not. |
| GET | `/Users` | `filter`, `startIndex` (1-based), `count` (default 100, max 200, `0` returns only the total), `attributes`, `excludedAttributes` |
| POST | `/Users` | `201` with a `Location` header. `409 uniqueness` if the `userName` is already provisioned. |
| GET / PUT / PATCH / DELETE | `/Users/{id}` | DELETE returns `204`. |
| GET | `/Groups` | Same parameters as `/Users`. `excludedAttributes=members` skips the member list. |
| POST | `/Groups` | `409 uniqueness` on a duplicate `displayName` (case-insensitive). |
| GET / PUT / PATCH / DELETE | `/Groups/{id}` | PATCH returns `204`, or `200` with the group when `attributes`/`excludedAttributes` is given. A PUT without `members` keeps the current members. |

**Filters.** The grammar is deliberately strict: one to four comparisons joined by `and`, each
`<attribute> eq <value>`. The value must be a quoted JSON string, or `true`/`false` for `active`.

- Users can be filtered on `userName` (case-insensitive), `externalId` (case-sensitive), `id`,
  `emails` / `emails.value`, `displayName` and `active`.
- Groups can be filtered on `displayName`, `externalId`, `id` and `members` / `members.value`.

Any other operator or attribute returns `400` with `scimType: invalidFilter`. Values are always
bound as parameters, never built into SQL.

**PATCH.** Operation names are case-insensitive. Booleans are accepted as `true`/`false` or as the
strings `"True"`/`"False"`. Both the *with path* and *no path* forms work, including dotted keys
such as `{"name.givenName": "Ada"}`. These paths are supported: `emails[type eq "work"].value`,
`members` (add, replace, or remove with a value array), and `members[value eq "<id>"]` (remove).
Attributes ScreenTinker doesn't store are accepted and ignored.

**Errors** use the SCIM error envelope:

```json
{ "schemas": ["urn:ietf:params:scim:api:messages:2.0:Error"], "status": "409", "scimType": "uniqueness", "detail": "…" }
```

### Who can be provisioned

These rules mirror the account-linking rules for single sign-on, so provisioning can't do anything
your organization's SSO couldn't already do:

- The address must be at a **verified sign-in domain** of your organization's enabled SSO.
- A **new** address creates an ordinary account. It has no password, its email is marked as
  verified, and it signs in through your SSO. Your identity provider can never create a platform
  administrator. Any `roles` it sends are ignored.
- An **existing** account is linked when one of these is true:
  - it already signs in through your SSO;
  - it is an invited account that never set a password;
  - your organization requires single sign-on for that verified domain. In this case the unusable
    password is cleared, exactly as an SSO sign-in would do.
- An existing account that is **already a member** of your organization can also be linked. In
  that case provisioning manages only its access inside your organization. Its email, name and
  sign-in stay its own.
- Anything else is refused with `409`. That covers a password account outside your organization,
  an account another organization's SSO signs in, and any platform staff account. The owner of a
  password account can join by linking it to your SSO from their own account settings.

### Deactivation

Setting `active` to false, through PUT or PATCH, does the following:

- removes the person's access to your organization: group access, default access, and any access
  granted by hand. The hand-granted access is remembered;
- ends all their sessions straight away (`token_version` is bumped) and disconnects open
  dashboards;
- if your SSO owns the account, **disables it**. Sign-in, existing sessions and API tokens are all
  refused until reactivation.

Setting `active` back to true restores the remembered access, re-applies group access and, if the
account was disabled, enables it again.

**The organization owner can't be deactivated or deleted by provisioning.** The request fails with
`400 mutability`. Transfer ownership first if that person is leaving.

### Rate limits

- Each organization has its own budget: **600 requests per minute** by default. You can change it
  with the `SCIM_RATE_LIMIT` environment variable. Okta and Entra send requests from shared
  addresses for many customers, so the budget is not per IP address. Above the limit the answer is
  `429` with `Retry-After`, which both identity providers respect.
- Failed authentication is limited per IP address: 30 bad tokens in 10 minutes blocks that address
  for the rest of the window.
- A coarse per-IP ceiling of 3000 requests per minute also applies to the whole `/scim` path.

### Turning it off

Unticking **Turn on user provisioning** makes every request from your identity provider fail with
`403`. **Nobody's access changes.** Turning it off stops the sync; it doesn't remove anyone. To
remove people, deprovision them in your identity provider while provisioning is on.

### Recent provisioning activity

The settings page lists the latest 500 provisioning events for your organization, including
failures with the reason that was sent back to your identity provider. This is the first place to
look when something doesn't arrive. Token creation, revocation, the on/off switch and mapping
changes also go to the audit log.

### Troubleshooting

| Symptom | Cause |
|---|---|
| `401` in the identity provider | The token is wrong, or it was revoked. Create a new one. Paste only the token, without `Bearer`. |
| `403 User provisioning is turned off` | The switch in Settings is off. |
| `400 … is not a verified sign-in domain` | The person's email is not at a verified domain of your SSO. Check the `userName`/`emails` mapping, or verify the domain. |
| `409 … already exists outside this organization` | That address already has a ScreenTinker account with its own password. Its owner can link it to your SSO from their account settings, or you can invite them. Provisioning then picks the account up. |
| A person was provisioned but can't sign in | The address the identity provider provisioned must be the same address your SSO sends at sign-in. |
| A person has no workspaces | No group mapping or default access covers them yet. See [Groups and workspace access](#groups-and-workspace-access). |
