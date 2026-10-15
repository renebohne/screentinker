# Site cache

A **site cache** is a small, always-on computer at a site (a Raspberry Pi, a NUC, a spare Linux
box, or a container on a NAS) that downloads your media **once** from your ScreenTinker server and
serves it to the screens on the same local network. A school with forty screens downloads a new
video once instead of forty times; a shop on a metered 4G link pays for one copy.

It is an optimisation and nothing more. Every screen still knows the server's address, checks every
file it gets from the cache against a fingerprint (sha256) it got from the server, and goes back to
the server on any failure: the cache is down, slow, out of date, or hands over wrong bytes. A broken
cache costs bandwidth. It never blanks a screen.

Where it lives: **Displays → Site caches** (Advanced view).

---

## For admins: setting one up

1. **Displays → Site caches → Add site cache.** Give it a name ("Main campus") and the address the
   *screens* will use to reach it, for example `http://10.0.0.5:8088`. Use a fixed IP (a DHCP
   reservation) or a local DNS name, because screens are told this address.
2. Copy the **token** from the window that opens. It is shown once. (Lost it? **New token** makes
   another one and switches the old one off.)
3. Start the cache on the site computer (below). It shows as **Online** within a minute.
4. **Assign screens**: pick device groups, single screens, or both. A screen picked on its own uses
   this cache even if its group uses another one.

That's all. Screens pick it up on their next playlist update; the dashboard shows disk use, files
ready, hit rate, bytes served and **internet saved** (bytes served to screens minus the bytes the
cache itself downloaded).

### Raspberry Pi / NUC / any Linux machine

The cache needs **Node.js 22.14 or newer** and the `server/` folder of a ScreenTinker download. It
uses only Node's built-in modules, so **no `npm install`** is needed.

```bash
# Node 22 (Raspberry Pi OS / Debian / Ubuntu)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt-get install -y nodejs

# ScreenTinker (the same version as your server is best)
sudo git clone --depth 1 https://github.com/screentinker/screentinker /opt/screentinker
sudo useradd --system --home /var/lib/st-site-cache --create-home st-cache
```

`/etc/systemd/system/st-site-cache.service`:

```ini
[Unit]
Description=ScreenTinker site cache
After=network-online.target
Wants=network-online.target

[Service]
User=st-cache
WorkingDirectory=/opt/screentinker/server
Environment=SITE_CACHE_FOR=https://signage.example.com
Environment=SITE_CACHE_TOKEN=stcn_paste_the_token_here
Environment=SITE_CACHE_PORT=8088
Environment=SITE_CACHE_DIR=/var/lib/st-site-cache
ExecStart=/usr/bin/node server.js
Restart=always
# Exit 78 = bad configuration (missing token, bad URL): stop instead of restarting forever.
RestartPreventExitStatus=78

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now st-site-cache
journalctl -u st-site-cache -f
curl http://localhost:8088/healthz
```

`node server.js` with `SITE_CACHE_FOR` set starts the cache instead of the server (before any
dependency is loaded). `node lib/site-cache/node.js` does the same thing directly.

Disk: give it at least the size of everything the assigned screens play, plus room for one
replaced playlist. It keeps 1 GB free by default and never fills the disk to download.

### Docker

The normal ScreenTinker image becomes a cache when `SITE_CACHE_FOR` is set:

```bash
docker run -d --name st-site-cache --restart unless-stopped \
  -p 8088:8088 -v st-site-cache:/data \
  -e SITE_CACHE_FOR=https://signage.example.com \
  -e SITE_CACHE_TOKEN=stcn_paste_the_token_here \
  -e SITE_CACHE_PORT=8088 \
  ghcr.io/screentinker/screentinker
```

Files go to `/data/site-cache` (the image's `DATA_DIR`).

### Settings

| Variable | Default | |
|---|---|---|
| `SITE_CACHE_FOR` | (required) | Your ScreenTinker server, e.g. `https://signage.example.com` |
| `SITE_CACHE_TOKEN` | (required) | The token from the dashboard (`stcn_…`) |
| `SITE_CACHE_PORT` | `8088` | Port the screens connect to |
| `SITE_CACHE_HOST` | `0.0.0.0` | Address to listen on |
| `SITE_CACHE_DIR` | `$DATA_DIR/site-cache`, else `./site-cache-data` | Files and state |
| `SITE_CACHE_MAX_BYTES` | `0` (no cap) | Most bytes to hold. Files that do not fit come from the server |
| `SITE_CACHE_MIN_FREE_BYTES` | `1073741824` (1 GB) | Disk to always leave free |
| `SITE_CACHE_TLS_CERT` / `SITE_CACHE_TLS_KEY` | (none) | Serve HTTPS (see below) |
| `SITE_CACHE_POLL_SECONDS` | from the server (60) | How often to check for new media |

---

## Network requirements

- **Cache → server:** outbound HTTPS to your ScreenTinker server, the same as a screen needs. No
  inbound port from the internet. The server **never connects to the cache**; the address you type
  is only handed to screens.
- **Screens → cache:** TCP to the cache's port on the LAN (8088 by default). Open it in the cache
  computer's firewall for the screen VLAN only.
- **Fixed address:** a DHCP reservation or a local DNS name.
- **Same network, or routed:** the screens only need to reach the address. Multi-site campuses can
  run one cache per building.

### HTTPS on the cache (web players on an https server)

A browser will not let a page served over `https://` fetch from `http://` (mixed content). So:

- **Android players** (the native app) can use `http://` caches. Nothing else to do.
- **Web players** (browsers, BrightSign, webOS, Tizen, Vega, Raspberry Pi kiosk) loaded from an
  `https://` server need the cache on **https** with a certificate the player trusts. Typical ways:
  - a DNS name for the cache (`cache.campus.example.com` → `10.0.0.5` in internal or public DNS)
    with a Let's Encrypt certificate obtained by the DNS-01 challenge (no inbound port needed), then
    `SITE_CACHE_TLS_CERT=/path/fullchain.pem SITE_CACHE_TLS_KEY=/path/privkey.pem` and
    `https://cache.campus.example.com:8088` as the address in the dashboard;
  - or your organisation's internal CA, if its root is installed on the players.
- A web player on a **self-hosted `http://` server** can use an `http://` cache directly.

Until that is in place nothing breaks: those web players simply keep downloading from the server.
The dashboard warns when it sees an `http://` cache on an `https://` server.

Chrome's Private Network Access checks (a public page fetching a private address) are answered by
the cache (`Access-Control-Allow-Private-Network`).

---

## How it works

```
             manifest (60 s) + verified downloads, once
  ScreenTinker server  ◄──────────────────────────────  site cache (Pi / NUC / Docker)
        │      ▲                                              ▲
 payload│      │ fallback on any failure                      │ GET /cache/<sha256>
 + token│      │                                              │ Authorization: Bearer <screen token>
        ▼      │                                              │
      screen ──┴──────────────────────────────────────────────┘
```

1. **Manifest.** Every poll the cache asks the server which screens it serves and, for each, the
   sha256 of every file that screen's payload references (playlist items, the standby image,
   trigger media). The server builds this by running *the same payload builder that feeds the
   screens*, so the cache cannot disagree with what a screen actually plays.
2. **Pre-warm.** It downloads what it does not hold, one file at a time, resumably (a dropped link
   continues where it stopped), and keeps a file only if its bytes hash to its name. A slow scrub
   re-hashes one held file per poll, so a failing SD card is found by the cache, not by a screen.
   Files no screen needs any more are kept for a day (campaigns come back), then deleted.
3. **Payload.** A screen that declares the `net.site_cache` capability and is assigned to a cache
   gets a top-level `site_cache` in its payload: the cache address, a token for this screen, and the
   sha256 and size of each file. It is outside the item list, so it never restarts playback.
4. **Fetch.** The player asks the cache for `/cache/<sha256>` with its token, checks the bytes hash
   to the digest **the server** gave it, stores them in its own offline cache, and plays. Any
   failure — no answer within 4 s, a refusal, a wrong byte — and it fetches from the server as it
   always did. A cache still downloading a file says so (503 *warming*), and the player waits for it
   a few minutes rather than making its own WAN download, which is the point.
5. **Offline.** The cache keeps its manifest and key on disk, and players keep the cache address,
   so if the internet goes down a screen that reboots can still fill from the cache.

### Players

| Player | Status |
|---|---|
| Web player (browser, Raspberry Pi kiosk, BrightSign, webOS, Tizen, Vega, iOS shell) | Yes, in its service worker. Declared only when a service worker is in control and WebCrypto exists, so from the second load of a new screen (the same rule as offline caching). Files up to 768 MB (they are hashed in memory). |
| Android (native app) | Yes, in its downloader (`ContentCache.fetchFromSiteCache`), from this release. |
| Older players, Roku, e-ink, Pi native, Windows native | Unchanged: they never declare `net.site_cache`, so their payload is byte-for-byte what it was. |

---

## Security model

- **The cache is authenticated to the server** by its own token (`stcn_…`, 256 bits). The server
  stores only its sha256. Rotating it (**New token**) also rotates the key below, and the old cache
  stops serving at its next poll.
- **Screens are authenticated to the cache** by a per-screen token: an HMAC-SHA256 over
  (cache, screen, expiry) with a key shared by the server and that one cache. The cache checks it
  itself, so it keeps working while the internet is down. Tokens last about a week and are
  re-issued with every payload.
- **Entitlement is per screen, not per cache.** A token lets a screen fetch only the digests *its
  own payload* references. A cache belongs to one workspace and only that workspace's screens can be
  assigned (checked when assigning and again on every read). So a cache for workspace A never holds
  or serves workspace B's media, and a guessed sha256 gets the same `404` as a file that does not
  exist — from the cache and from the server's download endpoint alike.
- **Integrity is end to end.** The cache verifies what it downloads; the player verifies again
  against the digest from the server, never one from the cache. A compromised cache can withhold
  files (players then use the server) but cannot make a screen show something else.
- **What a stolen cache box gives away:** the media its screens play (it is on the disk), and the
  key that checks screen tokens for that cache (in `state.json`, mode 0600). It cannot reach any
  other workspace, any dashboard API, or other caches. Delete it or rotate its token.
- **No SSRF door:** the server never connects to the cache address.
- **Logs:** neither side logs tokens. The cache's `/healthz` names no files.
- **Who can manage caches:** workspace admins (and org admins acting as one). Viewers and editors
  can see status but not change anything. Every create, change, assignment, token rotation and
  delete is in the activity log.

---

## Decisions and limits

- **A mode of the server, not a separate product.** `node server.js` with `SITE_CACHE_FOR` set (or
  the Docker image with that variable) runs `lib/site-cache/node.js`, which uses Node built-ins
  only. One download, one image, nothing extra to install on a Pi. It does not run the database,
  the dashboard or the mesh: the [Node Mesh](scale-out.md) replica is the tool when a site needs its
  own server; this is the tool when it only needs the bytes.
- **Pull, not push.** The cache dials out; sites behind NAT need no port forwarding, and the server
  never needs a route to a customer's LAN.
- **Content addressed.** Files are stored and fetched by sha256, which is what lets players verify
  them, and what makes a file shared between playlists a single download. Content uploaded before
  digests existed is hashed lazily the first time a cache needs it; until then that one file comes
  from the server.
- **Manual assignment first.** Auto-discovery (mDNS/DNS-SD `_screentinker-cache._tcp`, or a DHCP
  option) is not implemented. It would need players to trust a box they found on the network; with
  the per-screen token and digest checks that is safe for integrity, but an admin still has to say
  which cache a screen should use. A natural follow-up is "use the cache this screen's network
  advertises" as an assignment option.
- **No peer-to-peer between screens.** Many screens (BrightSign, TVs) cannot serve; a dedicated box
  is simpler to reason about and to monitor.
- **Large files on web players.** WebCrypto has no streaming hash, so the web player verifies in
  memory and skips the cache for files over 768 MB (they come from the server). The playback path
  waits for the cache only for files up to 64 MB; larger ones stream from the server once while
  the background prefetch fills from the cache.
- **First load.** A brand-new web player declares the capability from its second load (its service
  worker has to be in control first), exactly like offline caching. Media it pinned on its first
  load came from the server.
