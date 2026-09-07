# Security policy

## Threat model

**OmniVault protects the confidentiality of your vault contents against a
compromised or curious server.** If an attacker gets a full copy of the
server's database, they obtain usernames, opaque ciphertext, item counts,
sizes and timestamps — not your passwords, notes or images. Opening the
ciphertext requires your master password (600,000-iteration PBKDF2-SHA256 →
AES-256-GCM, per-item random IVs, authenticated tags).

## What the server never sees

- Your master password or the derived master key
- Any item content: titles, URLs, usernames, passwords, TOTP secrets,
  note text, image bytes
- Decrypted anything — there is no server-side decryption code path

## What the server does see (metadata)

- Usernames and account creation times
- Number of items per user, their types, encrypted sizes, update timestamps
- Login times and session lifetimes

## Design details

| Concern | Mitigation |
| --- | --- |
| Key derivation | PBKDF2-SHA256, 600,000 iterations, 16-byte random per-account salt, 256-bit key (OWASP-aligned) |
| Vault key model | A random 256-bit vault key encrypts items; it is wrapped (AES-256-GCM) separately by the master password and the recovery code. Password changes re-wrap only — item ciphertext is never touched (asserted by tests) |
| Auth without exposing the key | A separate auth key is derived from the master key (one-way); the server stores only a scrypt hash of it (N=16384, per-user salt). The local backend stores a PBKDF2 (100k) hash instead |
| Recovery codes | 120-bit random, base32, shown once. The recovery key wraps the vault key; the server/local store verifies only a one-way derived `recoveryAuthKey` (scrypt/PBKDF2 hashed). Wrong codes are rejected server-side with equalized timing |
| Content encryption | AES-256-GCM with a fresh 96-bit IV per envelope; tampering fails authentication |
| User enumeration (login) | Unknown usernames receive deterministic HMAC-derived decoy salts (both the password and recovery salts); login timing is equalized with a dummy scrypt run |
| Session tokens | 256-bit random, stored server-side only as SHA-256 hashes, TTL-bounded |
| XSS | All rendering goes through `textContent`/DOM APIs; a strict CSP (`default-src 'self'`) blocks inline scripts |
| Path traversal | Static serving resolves and confines paths to `public/`; tested |
| Supply chain | Zero npm dependencies; Android wrapper has zero Gradle dependencies |
| Clipboard | Copied passwords are auto-cleared after 25 seconds (best effort) |
| At-rest writes | Atomic tmp-file + rename, response sent only after the write completes |

## Local mode (100% local)

When no server is reachable, the app stores the same zero-knowledge records
(KDF salts, hashed verifiers, wrapped vault-key envelopes, AES-GCM item
envelopes) in **IndexedDB** in the browser. No plaintext is ever stored, and
the code paths are identical to server mode (covered by the test-suite via a
memory adapter). The Android APK uses this mode too: the web app is bundled
in the APK and served offline from an intercepted secure origin
(`appassets.androidplatform.net`) — the app makes zero network requests and
the vault lives in the app's private web storage. Trade-offs:

- Data lives in one browser profile. Clearing site data (or browser reset)
  deletes the vault — the app requests `navigator.storage.persist()` to
  reduce eviction of installed PWAs, but that is not a guarantee.
- Physical access to an unlocked device can read sessionStorage (the
  unwrapped vault key) — auto-lock mitigates, device encryption is assumed.
- There is no server-side rate limiting on the local verifier, but the
  verifier hashes a 256-bit key, so brute force is not a practical concern.

## Known limitations

- **No password recovery.** Losing the master password means losing the vault.
  Keep exports (Settings → Export backup) somewhere safe — they are encrypted
  with the same key.
- **Session storage of the derived key.** While unlocked, the raw master key
  bits sit in `sessionStorage` (per-tab, cleared when the app/tab closes) so
  reloads don't re-prompt. XSS in the app would defeat this — hence the
  strict CSP and no-inline-script rules. Auto-lock (default 5 min) bounds
  exposure.
- **No rate limiting / account lockout** on the server. Don't expose an
  instance directly to the open internet; use a VPN, or put an authenticating
  reverse proxy in front.
- **Metadata is visible** (see above) — an attacker can learn how many items
  you have and when you edit them.
- **Single-user-per-account, single-file storage** — personal/family scale.
  Not a multi-tenant SaaS.
- **PWA/service worker** caches the app shell only; `/api` responses are never
  cached.
- **Change-password crash window:** items are re-encrypted and replaced before
  credentials are swapped. A crash *between* those two steps leaves the vault
  encrypted with the new key while the old password still authenticates —
  the client detects undecryptable items on next unlock.

## Reporting a vulnerability

Please open a private security advisory (GitHub → Security → Advisories) or
contact the maintainers directly. Do not open public issues for
vulnerabilities. Please allow up to 90 days for a response/remediation.
