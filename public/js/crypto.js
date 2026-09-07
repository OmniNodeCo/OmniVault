/**
 * OmniVault client-side crypto — the zero-knowledge core.
 *
 * Runs in the browser (WebCrypto) and in Node 18+ (same WebCrypto API),
 * which lets the test-suite exercise the exact code users run.
 *
 * Key model:
 *   masterBits  = PBKDF2-SHA256(masterPassword, salt, 600_000 iters, 256 bits)
 *   masterKey   = AES-GCM 256 key imported from masterBits (encrypts vault items)
 *   authKey     = PBKDF2(masterBits, "omnivault-auth-v1", 1 iter, 256 bits)
 *                 — sent to the server for authentication; never reveals masterBits
 *                 because PBKDF2 is one-way.
 *
 * Everything stored server-side is an opaque envelope { v:1, iv, ct }.
 */
(function (global) {
  'use strict';

  const subtle = global.crypto.subtle;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const PBKDF2_ITERATIONS = 600000;
  const AUTH_INFO = 'omnivault-auth-v1';
  const ENVELOPE_VERSION = 1;

  // ------------------------------------------------------------- base64

  function bytesToB64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function b64ToBytes(b64) {
    const binary = atob(String(b64));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }

  function bytesToB64url(bytes) {
    return bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function b64urlToBytes(s) {
    let b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    return b64ToBytes(b64);
  }

  function utf8ToBytes(str) {
    return encoder.encode(String(str));
  }

  // --------------------------------------------------------------- keys

  async function pbkdf2(password, salt, iterations, bits) {
    const pw = typeof password === 'string' ? utf8ToBytes(password) : password;
    const baseKey = await subtle.importKey('raw', pw, 'PBKDF2', false, ['deriveBits']);
    const derived = await subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: salt, iterations: iterations },
      baseKey,
      bits
    );
    return new Uint8Array(derived);
  }

  async function importAesKey(bits) {
    return subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  /** Derive master key + auth key from the master password and account salt. */
  async function deriveAuthMaterial(password, saltB64) {
    const salt = b64ToBytes(saltB64);
    const masterBits = await pbkdf2(password, salt, PBKDF2_ITERATIONS, 256);
    const authBits = await pbkdf2(masterBits, utf8ToBytes(AUTH_INFO), 1, 256);
    const masterKey = await importAesKey(masterBits);
    return {
      masterBits,
      masterKey,
      authKey: bytesToB64(authBits),
      salt: bytesToB64(salt)
    };
  }

  function randomSaltB64(bytes = 16) {
    return bytesToB64(global.crypto.getRandomValues(new Uint8Array(bytes)));
  }

  // ---------------------------------------------------------- envelopes

  async function encryptBytes(key, bytes) {
    const iv = global.crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, bytes));
    return { v: ENVELOPE_VERSION, iv: bytesToB64(iv), ct: bytesToB64(ct) };
  }

  async function decryptBytes(key, envelope) {
    if (!envelope || typeof envelope !== 'object' || typeof envelope.iv !== 'string' || typeof envelope.ct !== 'string') {
      throw new Error('Invalid encrypted envelope');
    }
    const iv = b64ToBytes(envelope.iv);
    const ct = b64ToBytes(envelope.ct);
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, ct);
    return new Uint8Array(pt);
  }

  async function encryptJson(key, value) {
    return encryptBytes(key, utf8ToBytes(JSON.stringify(value)));
  }

  async function decryptJson(key, envelope) {
    return JSON.parse(decoder.decode(await decryptBytes(key, envelope)));
  }

  // ---------------------------------------------------- password generator

  const CHARSETS = {
    lower: 'abcdefghijklmnopqrstuvwxyz',
    upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    digits: '0123456789',
    symbols: '!@#$%^&*()-_=+[]{};:,.<>?/~'
  };

  /** Unbiased random integer in [0, max) using rejection sampling. */
  function randomInt(max) {
    if (max <= 0 || max > 0x100000000) throw new RangeError('max out of range');
    const limit = Math.floor(0x100000000 / max) * max;
    const buf = new Uint32Array(1);
    for (;;) {
      global.crypto.getRandomValues(buf);
      if (buf[0] < limit) return buf[0] % max;
    }
  }

  function generatePassword(opts = {}) {
    const o = Object.assign({ length: 20, lower: true, upper: true, digits: true, symbols: true }, opts);
    const active = Object.keys(CHARSETS).filter((k) => o[k]);
    if (!active.length) active.push('lower');
    const all = active.map((k) => CHARSETS[k]).join('');
    const length = Math.max(1, Math.floor(Number(o.length) || 20));

    const chars = [];
    for (const name of active) {
      const set = CHARSETS[name];
      chars.push(set[randomInt(set.length)]);
    }
    while (chars.length < length) chars.push(all[randomInt(all.length)]);
    for (let i = chars.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      const t = chars[i];
      chars[i] = chars[j];
      chars[j] = t;
    }
    return chars.slice(0, length).join('');
  }

  // ----------------------------------------------------------------- TOTP

  const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

  function base32Decode(input) {
    const clean = String(input || '')
      .toUpperCase()
      .replace(/[\s-]/g, '')
      .replace(/=+$/, '');
    let bits = 0;
    let value = 0;
    const out = [];
    for (const ch of clean) {
      const idx = BASE32_ALPHABET.indexOf(ch);
      if (idx === -1) throw new Error(`Invalid base32 character: ${ch}`);
      value = (value << 5) | idx;
      bits += 5;
      if (bits >= 8) {
        out.push((value >>> (bits - 8)) & 0xff);
        bits -= 8;
      }
    }
    return new Uint8Array(out);
  }

  /** RFC 6238 TOTP (HMAC-SHA1/SHA256/SHA512). Returns the code as a string. */
  async function totp(secretB32, opts = {}) {
    const digits = Number(opts.digits) || 6;
    const period = Number(opts.period) || 30;
    const algorithm = opts.algorithm || 'SHA-1';
    const t = typeof opts.t === 'number' ? opts.t : Date.now();

    const keyBytes = base32Decode(secretB32);
    if (!keyBytes.length) throw new Error('Empty TOTP secret');

    const counter = Math.floor(t / 1000 / period);
    const msg = new Uint8Array(8);
    let c = counter;
    for (let i = 7; i >= 0; i--) {
      msg[i] = c & 0xff;
      c = Math.floor(c / 256);
    }

    const key = await subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: { name: algorithm } }, false, ['sign']);
    const mac = new Uint8Array(await subtle.sign('HMAC', key, msg));
    const offset = mac[mac.length - 1] & 0x0f;
    const code =
      ((mac[offset] & 0x7f) << 24) |
      ((mac[offset + 1] & 0xff) << 16) |
      ((mac[offset + 2] & 0xff) << 8) |
      (mac[offset + 3] & 0xff);
    return String(code % 10 ** digits).padStart(digits, '0');
  }

  /** Extract { secret, digits, period } from an otpauth:// URI (or return null). */
  function parseOtpauth(uri) {
    try {
      const u = new URL(String(uri));
      if (u.protocol !== 'otpauth:') return null;
      const secret = u.searchParams.get('secret');
      if (!secret) return null;
      return {
        secret,
        digits: Number(u.searchParams.get('digits')) || 6,
        period: Number(u.searchParams.get('period')) || 30
      };
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------- recovery codes

  const RECOVERY_INFO = 'omnivault-recovery-v1';
  const RECOVERY_CODE_BYTES = 15; // 120 bits → exactly 24 base32 chars

  function base32Encode(bytes) {
    let bits = 0;
    let value = 0;
    let out = '';
    for (const b of bytes) {
      value = (value << 8) | b;
      bits += 8;
      while (bits >= 5) {
        out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
        bits -= 5;
      }
    }
    if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
    return out;
  }

  /** Random recovery code, e.g. "MFRG-GZZE-K5A7-PB2W-3SDK-YQ4M" (120 bits). */
  function generateRecoveryCode() {
    const bytes = global.crypto.getRandomValues(new Uint8Array(RECOVERY_CODE_BYTES));
    return base32Encode(bytes).match(/.{1,4}/g).join('-');
  }

  /** Accepts dashes/spaces/lowercase; returns the clean uppercase base32. */
  function normalizeRecoveryCode(code) {
    return String(code || '')
      .toUpperCase()
      .replace(/[^A-Z2-7]/g, '');
  }

  /**
   * Derive key material from a recovery code. The recovery key unwraps the
   * vault key; recoveryAuthKey is what the server/local store verifies
   * (it never reveals the recovery key, same pattern as authKey).
   */
  async function deriveRecoveryMaterial(code, saltB64) {
    const clean = normalizeRecoveryCode(code);
    if (clean.length < 12) throw new Error('Recovery code looks too short');
    const salt = b64ToBytes(saltB64);
    const recoveryKeyBytes = await pbkdf2(clean, salt, PBKDF2_ITERATIONS, 256);
    const recoveryKey = await importAesKey(recoveryKeyBytes);
    const authBits = await pbkdf2(recoveryKeyBytes, utf8ToBytes(RECOVERY_INFO), 1, 256);
    return {
      recoveryKey,
      recoveryKeyBytes,
      recoveryAuthKey: bytesToB64(authBits),
      normalizedCode: clean
    };
  }

  /**
   * Local-mode verifier: a PBKDF2 hash of the (already high-entropy) auth key.
   * Used by the IndexedDB backend the same way the server uses scrypt.
   */
  async function hashForVerifier(authKey, saltB64) {
    const out = await pbkdf2(String(authKey), b64ToBytes(saltB64), 100000, 256);
    return bytesToB64(out);
  }

  // -------------------------------------------------------- strength meter

  /** Rough 0-4 strength score for UI feedback only. */
  function passwordStrength(pw) {
    const s = String(pw || '');
    if (!s) return 0;
    let score = 0;
    const pools = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/];
    const used = pools.filter((r) => r.test(s)).length;
    score += Math.min(2, used / 2);
    if (s.length >= 12) score += 1;
    if (s.length >= 16) score += 1;
    if (s.length >= 24) score += 0.5;
    if (/(.)\1\1/.test(s)) score -= 0.5;
    const words = s.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4);
    if (words.length && s.replace(/[^a-zA-Z]/g, '').length / s.length > 0.7) score -= 0.5;
    return Math.max(0, Math.min(4, Math.round(score)));
  }

  const api = {
    PBKDF2_ITERATIONS,
    ENVELOPE_VERSION,
    bytesToB64,
    b64ToBytes,
    bytesToB64url,
    b64urlToBytes,
    utf8ToBytes,
    pbkdf2,
    importAesKey,
    deriveAuthMaterial,
    randomSaltB64,
    encryptBytes,
    decryptBytes,
    encryptJson,
    decryptJson,
    generatePassword,
    randomInt,
    base32Decode,
    base32Encode,
    generateRecoveryCode,
    normalizeRecoveryCode,
    deriveRecoveryMaterial,
    hashForVerifier,
    totp,
    parseOtpauth,
    passwordStrength
  };

  global.VaultCrypto = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
