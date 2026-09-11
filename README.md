# OmniVault 🔐

**A full self-hosted vault for passwords, notes and images — zero-knowledge by design.**

OmniVault encrypts everything in your browser (AES-256-GCM) before anything
touches the server. The server stores only ciphertext, usernames, and
timestamps. It works as a regular website, installs as an app on **Android**
(PWA), and ships with a native **Android APK wrapper**, Docker images, CI/CD,
and an encrypted backup format.

[![CI](https://github.com/OmniNodeCo/OmniVault/actions/workflows/ci.yml/badge.svg)](https://github.com/OmniNodeCo/OmniVault/actions/workflows/ci.yml)
[![Build APK](https://github.com/OmniNodeCo/OmniVault/actions/workflows/build.yml/badge.svg)](https://github.com/OmniNodeCo/OmniVault/actions/workflows/build.yml)
[![Release](https://github.com/OmniNodeCo/OmniVault/actions/workflows/release.yml/badge.svg)](https://github.com/OmniNodeCo/OmniVault/actions/workflows/release.yml)
[![Docker](https://github.com/OmniNodeCo/OmniVault/actions/workflows/docker.yml/badge.svg)](https://github.com/OmniNodeCo/OmniVault/actions/workflows/docker.yml)
[![CodeQL](https://github.com/OmniNodeCo/OmniVault/actions/workflows/codeql.yml/badge.svg)](https://github.com/OmniNodeCo/OmniVault/actions/workflows/codeql.yml)

## Features

- 🔑 **Passwords** — website logins with username, URL, notes, and live
  **TOTP two-factor codes** right on the card
- 📝 **Notes** — arbitrary encrypted text (recovery codes, WiFi details…)
- 🖼️ **Images** — photos, screenshots and scans, encrypted *before* upload,
  decrypted only in your browser
- 📵 **100% local mode** — no server at all: the whole vault (users, items,
  images) lives in your browser's IndexedDB, works offline, no network calls
- ❤️ **Vault health** — one tap audits every password for weak, reused,
  stale and missing entries, entirely on-device
- 🔄 **Auto-update checks** — the app quietly compares its version with the
  latest GitHub release (once a day); the one-tap **Go to release** button
  opens the release page in your browser
- 🔄 **Instant password change** — items are encrypted with a random vault key
  that is simply re-wrapped, never re-encrypted
- 🔐 **Password reset** — a one-time **recovery code** lets you back in (and
  resets your master password) if you ever forget it — no data lost
- 🎲 **Password generator** — one tap from the toolbar (⚡), remembers your
  options, and saves the result straight into the vault; unbiased
  (rejection-sampled) crypto randomness
- 🧩 **Autofill (Android)** — the APK registers a system autofill service
  (Android 8+): Chrome and other apps can fill saved logins; the credential
  cache is Keystore-encrypted and wiped whenever the vault locks — toggle
  it in Settings
- 💾 **Encrypted backups** — portable JSON export/import with their own password
- ⏱️ **Auto-lock** — configurable inactivity lock + clipboard auto-clear
- 📱 **Android** — installable PWA (offline app shell) *and* a standalone
  local-vault APK that bundles the whole app (no server, no URL) with
  `build.yml` / `release.yml` CI pipelines
- 🐳 **Docker** — one-command self-hosting, plus GHCR image publishing
- 🧪 **Tested** — RFC-vector crypto tests, API tests, end-to-end and
  local-mode simulations of the real client
- 📦 **Zero npm dependencies** — the entire stack is Node built-ins +
  vanilla JS (small supply-chain surface)

## Quick start

### Node (≥ 18.17)

```bash
git clone https://github.com/OmniNodeCo/OmniVault.git
cd OmniVault
npm start          # → http://localhost:3000
```

### Share with every device on your WiFi

```bash
npm run lan        # random port, HTTPS + QR code in the terminal
```

`--lan` (WiFi share mode) checks that the machine is actually connected to a
network, picks a **free random port** each run, prints the LAN address and a
**scannable QR code** so any phone/tablet on the same WiFi can open the
vault, and serves **HTTPS** with a locally generated self-signed certificate
(browsers need a secure context for WebCrypto — accept the one-time
certificate warning). No network? It says so instead of sharing nothing.

### Docker

```bash
docker compose up -d   # → http://localhost:3000
```

Or use the published image:

```bash
docker run -d -p 3000:3000 -v omnivault-data:/data ghcr.io/omninodeco/omnivault:latest
```

Open the site, choose **Create vault**, pick a username and a long master
password — you're running your own encrypted vault. You'll get a one-time
**recovery code**: save it, it's the only way back in if you forget the
master password.

> **HTTPS note:** client-side encryption (WebCrypto) and PWA install require a
> secure context. `http://localhost` works for development. For LAN/remote
> access use `npm run lan` (self-signed HTTPS out of the box), put
> Caddy/Traefik/nginx in front with TLS, or pass
> `OMNIVAULT_TLS_CERT` / `OMNIVAULT_TLS_KEY` to serve HTTPS directly.

## 100% local mode (no server)

The app doesn't need a backend at all. When no server is reachable — for
example when you host the `public/` folder on any static host (GitHub Pages,
Netlify, `python3 -m http.server`) or open it from disk — OmniVault switches
to **local mode** automatically:

- users, wrapped vault keys and all items (including images) are stored in
  **IndexedDB** in this browser profile; zero network requests are made
- login, unlock, password change, **recovery-code reset**, backups and the
  whole UI behave exactly like server mode (same code paths, tested)
- the app asks for `navigator.storage.persist()` so Android/Chrome won't
  evict the vault of an installed PWA
- a chip at the bottom ("On this device" vs "Server · host") always shows
  where your data lives; you can switch modes on the login screen

Use Settings → Export/Import backup to move a vault between local mode and a
server (or between devices). Note: clearing site data wipes a local vault —
keep backups.

## Android

**Option 1 — PWA (recommended):** open your vault in Chrome on Android →
menu → **Install app**. It gets its own icon, fullscreen window, offline app
shell, and home-screen shortcuts (Passwords / Notes / Images).

**Option 2 — native APK (standalone local vault):** the repo contains a
zero-dependency WebView wrapper (`android/`) that **bundles the whole web
app into the APK** — a fully offline, on-device vault with **no server and
no URL configuration**:

```bash
gradle -p android assembleDebug
# → android/app/build/outputs/apk/debug/app-debug.apk
```

Or let CI do it (nothing to configure):
- **Build APK workflow** (`build.yml`) — runs automatically on changes to
  `android/**` / `public/**`, or manually; downloads the APK artifact.
- **Release workflow** (`release.yml`) — push a `v*` tag and a GitHub Release
  is published with the (optionally signed, via repo secrets) local-vault
  APK + SHA-256 checksums:

```bash
git tag v1.0.0 && git push origin v1.0.0
```

Want the APK connected to your server instead? Build with
`gradle assembleDebug -PvaultUrl=https://vault.example.com`.
See [`android/README.md`](android/README.md).

## How the encryption works

```
master password ──PBKDF2-SHA256 (600k iters, per-account salt)──► master key
recovery code   ──PBKDF2-SHA256 (600k iters, per-account salt)──► recovery key
                                                                     │
                        ┌────────────────────────────────────────────┤
                        ▼                                            ▼
        vault key ──wrapped by──► {vault} envelope        {recovery} envelope
           │
           └──► AES-256-GCM encrypts every item (fresh IV per envelope)
```

- A random 256-bit **vault key** is generated when you create the vault; it
  encrypts all items. It is *wrapped* (AES-GCM) by your master password and,
  independently, by your **recovery code**.
- The **vault key never leaves your browser unwrapped**; it lives in memory
  (mirrored to `sessionStorage` so a reload keeps the vault open — closing
  the app locks it).
- **Changing the master password** only re-wraps the vault key — instant,
  even for huge vaults; item ciphertext is untouched (asserted by tests).
- **Forgot the password?** Enter the recovery code on the "Forgot master
  password?" link: it unwraps the vault key, you set a new password, and no
  data is lost. Regenerate the code any time from Settings.
- The **auth key** sent to the server for login is derived one-way from the
  master key; the server (and the local backend) store only a
  scrypt/PBKDF2 *hash* of it. Unknown usernames get deterministic decoy
  salts so real and missing accounts are indistinguishable.

Full details and limitations: [SECURITY.md](SECURITY.md).

## Daily use

| Task | How |
| --- | --- |
| Save a login | Passwords tab → **Add** → fill fields (use the 🎲 generator) |
| 2FA codes | Paste a base32 secret or `otpauth://` URI — live code shows on the card |
| Save images | Images tab → **Add** → pick or drop a file (≤ 15 MB, encrypted locally) |
| Copy secrets | Card buttons; copied passwords clear from the clipboard after 25 s |
| Backups | Settings → Export (choose a backup password) / Import |
| Change password | Settings → Change master password (instant — items aren't re-uploaded) |
| Forgot password | "Forgot master password?" on the login/lock screen → recovery code |
| New recovery code | Settings → Recovery → Regenerate (shown once) |
| Lock | Padlock button, or walk away — auto-lock defaults to 5 minutes |

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `OMNIVAULT_DATA_DIR` | `./data` | Database location (JSON file) |
| `SESSION_TTL_HOURS` | `168` | Login session lifetime |
| `MAX_BODY_MB` | `32` | Max encrypted request body |
| `OMNIVAULT_TLS_CERT` / `OMNIVAULT_TLS_KEY` | – | Serve HTTPS directly |

## API

All item payloads are client-encrypted envelopes. Session auth via
`Authorization: Bearer <token>`.

| Method | Path | Body / notes |
| --- | --- | --- |
| GET | `/api/health` | liveness + version |
| GET | `/api/auth/salt?username=u` | `{salt, recoverySalt}` (decoy-safe) |
| POST | `/api/auth/register` | `{username, salt, authKey, vault, recovery}` → `{token, user}` |
| POST | `/api/auth/login` | `{username, authKey}` → `{token, user}` (user.vault = wrapped key) |
| POST | `/api/auth/verify` | `{authKey}` — used by unlock |
| POST | `/api/auth/recovery-login` | `{username, recoveryAuthKey}` → `{token, user, recovery}` |
| POST | `/api/auth/update-auth` | `{salt?, authKey?, vault?, recovery?}` — swaps credentials/envelopes |
| POST | `/api/auth/logout` | invalidate session |
| GET | `/api/me` | current user (incl. wrapped vault key) |
| GET | `/api/items` | all items (ciphertext) |
| POST | `/api/items` | `{type, title, data}` envelopes |
| GET/PUT/DELETE | `/api/items/:id` | single item |
| PUT | `/api/items` | `{items: [...]}` — replace all |
| DELETE | `/api/items` | `{authKey}` — wipe vault |

In local mode, `public/js/localstore.js` implements this exact surface over
IndexedDB.

## Project layout

```
├── server/            # zero-dependency Node HTTP server (lib/: config, store, db, api, static)
├── public/            # the vault web app + PWA (vanilla JS, no build step)
│   ├── js/crypto.js   # client-side crypto core (also used by the test-suite)
│   ├── js/views.js    # screens, cards, modals
│   ├── js/app.js      # application controller
│   ├── sw.js          # service worker (app shell cache, never caches /api)
│   └── manifest.webmanifest
├── android/           # native WebView wrapper → APK (gradle, no dependencies)
├── tests/             # node:test — crypto vectors, API, end-to-end
├── scripts/make-icons.py  # regenerates the PWA icon set with PIL
├── Dockerfile
├── docker-compose.yml
└── .github/workflows/ # ci.yml, docker.yml, android.yml, codeql.yml (+ dependabot.yml)
```

## Development

```bash
npm test    # crypto vectors (RFC 7914/6238), server API, e2e client simulation
npm run check  # syntax-check every JS file
npm run dev    # server with auto-reload
python3 scripts/make-icons.py   # regenerate icons after editing the SVGs
```

The test-suite imports `public/js/crypto.js` directly (Node's WebCrypto is
identical to the browser's), so the exact key-derivation and envelope code
users run is what gets tested against RFC vectors.

## Security & limitations

Honest scope notes — see [SECURITY.md](SECURITY.md) for the full threat model:

- No password recovery exists, by design. Back up your vault and master
  password somewhere safe.
- The server sees usernames, item counts, sizes and timestamps (not content).
- No built-in rate limiting or 2FA on login — front it with a proxy or VPN if
  exposed to the internet.
- Storage is a single JSON file — designed for personal/family scale
  (thousands of items, ~64 MB). Use the export/import format to move vaults.

## License

Add a `LICENSE` file to match your organization's policy before distributing.
