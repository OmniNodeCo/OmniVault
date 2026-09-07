# OmniVault — Android wrapper

A zero-dependency native shell (plain `android.app.Activity` + `WebView`) that
packages the OmniVault PWA as a real APK. All encryption still happens inside
the web app via WebCrypto — this wrapper just provides the app-like frame:
its own icon, no browser UI, back-button navigation, and the system file
chooser for encrypted image uploads.

For most people the **PWA route is enough**: open the vault in Chrome on
Android → menu → **Install app**. Same experience, no APK, auto-updates.
Use this project when you want a sideloadable/distributable APK instead.

## Build

Requirements: JDK 17, Android SDK (platform 34), Gradle 8.7+.

```bash
# Point the app at your vault server (default: https://vault.example.com)
gradle -p android assembleDebug -PvaultUrl=https://vault.example.com

# Output:
# android/app/build/outputs/apk/debug/app-debug.apk
```

For local development against a server on your machine, the emulator can use
cleartext to `10.0.2.2` (allowed by `network_security_config.xml`):

```bash
gradle -p android assembleDebug -PvaultUrl=http://10.0.2.2:3000
```

### GitHub Actions (recommended)

No local toolchain needed — the repo ships two workflows:

- **Build APK** (`build.yml`) — runs automatically on changes to `android/**`,
  or manually: Actions → *Build APK* → Run workflow → set `vault_url` (and
  optionally choose a release build) → download the `OmniVault-debug-apk` /
  `OmniVault-release-apk` artifact.
- **Release** (`release.yml`) — push a `v*` tag and a GitHub Release is
  published with the release APK and SHA-256 checksums. If keystore secrets
  are configured the APK is signed; otherwise it is built unsigned.

## Release signing

Debug APKs are for testing. `android/app/build.gradle` already supports
env-based signing — the Release workflow picks it up automatically from these
**repository secrets**:

| Secret | Value |
| --- | --- |
| `OMNIVAULT_KEYSTORE_B64` | base64 of your `.keystore` file (`base64 -w0 release.keystore`) |
| `OMNIVAULT_KEYSTORE_PASSWORD` | keystore password |
| `OMNIVAULT_KEY_ALIAS` | key alias |
| `OMNIVAULT_KEY_PASSWORD` | key password |
| `VAULT_URL` | server URL baked into the APK |

Generate a keystore with:

```bash
keytool -genkey -v -keystore release.keystore -alias omnivault \
  -keyalg RSA -keysize 2048 -validity 10000
```

Never commit keystores or passwords (`.gitignore` already excludes `*.keystore`).

## What the wrapper does

- Loads `BuildConfig.VAULT_URL` (set via the `vaultUrl` Gradle property).
- Keeps vault URLs in the app; external links open in the browser.
- Enables DOM storage — the web app keeps the derived key in `sessionStorage`,
  so closing the app locks the vault.
- Blocks mixed content and file/content URL access; HTTPS only (except
  `10.0.2.2`/`localhost` for emulator debugging).
- Handles the WebView file chooser (image uploads), back navigation, state
  restore on rotation, and an offline screen with retry.

## Requirements

| Item    | Value                          |
| ------- | ------------------------------ |
| minSdk  | 26 (Android 8.0)               |
| target  | 34 (Android 14)                |
| deps    | none (no AndroidX)             |
