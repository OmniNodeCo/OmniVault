'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scryptAsync = promisify(crypto.scrypt);

/** URL-safe random id (12 chars, ~72 bits). */
function randomId() {
  return crypto.randomBytes(9).toString('base64url');
}

/** Opaque session token (43 chars, 256 bits). */
function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/** Sessions are stored keyed by the SHA-256 of the token, never the token itself. */
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function hmac(secretBuf, info) {
  return crypto.createHmac('sha256', secretBuf).update(info).digest();
}

/**
 * The client sends an auth key derived from the master password via PBKDF2
 * (client side). The server still never sees the password — and it re-hashes
 * the auth key with a per-user random salt using scrypt before storing it.
 */
async function computeVerifier(authKey, serverSaltHex, params) {
  const derived = await scryptAsync(
    Buffer.from(String(authKey), 'utf8'),
    Buffer.from(String(serverSaltHex), 'hex'),
    params.keylen,
    { N: params.N, r: params.r, p: params.p, maxmem: params.maxmem }
  );
  return derived.toString('hex');
}

function constantTimeEqualHex(a, b) {
  const ba = Buffer.from(String(a || ''), 'hex');
  const bb = Buffer.from(String(b || ''), 'hex');
  return ba.length === bb.length && ba.length > 0 && crypto.timingSafeEqual(ba, bb);
}

module.exports = {
  randomId,
  randomToken,
  hashToken,
  hmac,
  computeVerifier,
  constantTimeEqualHex
};
