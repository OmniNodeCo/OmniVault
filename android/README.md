# OmniVault — Android app

A **standalone local vault** APK. The entire web app (the repo's `public/`
folder) is bundled into the APK at build time and served from app-private
storage on a secure `https://appassets.androidplatform.net` origin — so the
vault runs 100% on-device:

- **no server, no URL, no configuration** — build it and it works
- encryption (WebCrypto) and storage (IndexedDB) need a secure context, which
  the intercepted https origin provides
- zero network requests are ever made — the vault never leaves the phone
- all encryption/decryption, recovery codes and backups behave exactly like
  the web app (same code)

Want it connected to your own server instead? Build with
`-PvaultUrl=https://vault.example.com` and the same APK opens your server
(sync mode). You can also just install the PWA from Chrome — no APK needed.

## Build

Requirements: JDK 17, Android SDK (platform 34), Gradle 8.7+.

```bash
# Standalone local vault (default — no URL needed):
gradle -p android assembleDebug
# → android/app/build/outputs/apk/debug/app-debug.apk

# Optional: server-connected build instead:
gradle -p android assembleDebug -PvaultUrl=https://vault.example.com

# For emulator testing against a local server:
gradle -p android assembleDebug -PvaultUrl=http://10.0.2.2:3000
```

## How the local APK works

1. The `copyWebApp` Gradle task copies the repo's `public/` into
   `app/src/main/assets/` before every build (generated — gitignored, always
   in sync with the web app).
2. `MainActivity` intercepts **every** WebView request and serves it from
   those bundled assets. The page origin is
   `https://appassets.androidplatform.net` — an offline placeholder that is
   never resolved on the network.
3. The web app probes `/api/health`, gets no server, and automatically runs
   in **local mode**: users, wrapped vault keys and encrypted items live in
   the app's private IndexedDB.

Uninstalling the app permanently deletes the vault — use the in-app
encrypted backup (Settings → Export) to move data between devices.

## GitHub Actions (no configuration needed)

- **Build APK** (`build.yml`) — runs automatically on changes to
  `android/**` or `public/**`, or manually (Actions → *Build APK* → Run
  workflow → optionally pick a release build). Download the
  `OmniVault-debug-apk` / `OmniVault-release-unsigned-apk` artifact.
- **Release** (`release.yml`) — push a `v*` tag and a GitHub Release is
  published with the local-vault APK and SHA-256 checksums. With keystore
  secrets configured the APK is signed; otherwise it is built unsigned.
  Manual run: Actions → *Release* → Run workflow with a tag name — if the
  tag does not exist yet it is created from the commit you run it on.

```bash
git tag v1.0.0 && git push origin v1.0.0
```

## In-app updates (auto-update)

The app checks for updates itself — no Play Store needed:

- On launch (at most once every 24 h) it fetches the repo's GitHub
  **Releases → latest** JSON and compares the version with the installed one.
- If a newer release with an `.apk` asset exists, a dialog offers to
  **download the update** via the system Download Manager; tapping the
  completed notification installs it over the existing app (vault data is
  kept, provided the APK is signed with the same key).
- **Menu → Check for updates** triggers the check manually.
- The update source defaults to this repository's releases and can be
  changed or disabled at build time:

```bash
gradle -p android assembleDebug -PupdateUrl=https://api.github.com/repos/YOU/YOURFORK/releases/latest
gradle -p android assembleDebug -PupdateUrl=   # disable update checks entirely
```

- The check contacts only `api.github.com` (or your override) — the vault
  itself stays fully offline and on-device.

## Release signing

Every built APK is signed — Android refuses to install unsigned APKs with
an "App not installed" error.

- **Debug builds** are auto-signed with the standard debug keystore.
- **Release builds** are signed with your release keystore when these
  **repository secrets** are set, otherwise with a keystore generated on
  the fly (CI test key):

| Secret | Value |
| --- | --- |
| `OMNIVAULT_KEYSTORE_B64` | base64 of your `.keystore` file (`base64 -w0 release.keystore`) |
| `OMNIVAULT_KEYSTORE_PASSWORD` | keystore password |
| `OMNIVAULT_KEY_ALIAS` | key alias |
| `OMNIVAULT_KEY_PASSWORD` | key password |

Generate a keystore with:

```bash
keytool -genkey -v -keystore release.keystore -alias omnivault \
  -keyalg RSA -keysize 2048 -validity 10000
```

**Set the secrets** if you keep the app installed: a CI test key is unique
to each run, so a newer CI-signed build **cannot install over** an older one
— Android requires an uninstall first, which deletes the local vault
(export it first!). With a stable release keystore, updates install in
place and in-app auto-updates work. `signature.txt` in each release states
which key was used.

Never commit keystores or passwords (`.gitignore` already excludes `*.keystore`).

## What the wrapper does

- Bundles and serves the web app offline (local vault by default), or loads
  `BuildConfig.VAULT_URL` when built with `-PvaultUrl=…`.
- Keeps vault URLs in the app; external links open in the browser.
- Enables DOM storage — the vault key lives in `sessionStorage`, so closing
  the app locks the vault; auto-lock also applies.
- Blocks mixed content and file/content URL access; HTTPS only (except
  `10.0.2.2`/`localhost` cleartext for emulator debugging).
- Handles the WebView file chooser (image uploads), back navigation, state
  restore on rotation, and an offline screen with retry (server mode only).
- Checks GitHub Releases for newer APKs (daily + on demand) and downloads
  them with the system Download Manager — zero dependencies.

## Requirements

| Item    | Value                          |
| ------- | ------------------------------ |
| minSdk  | 26 (Android 8.0)               |
| target  | 34 (Android 14)                |
| deps    | none (no AndroidX)             |
