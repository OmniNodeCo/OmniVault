'use strict';

const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');

const config = {
  root,

  /** Directory where the JSON database lives. Override with OMNIVAULT_DATA_DIR. */
  dataDir: process.env.OMNIVAULT_DATA_DIR
    ? path.resolve(process.env.OMNIVAULT_DATA_DIR)
    : path.join(root, 'data'),

  publicDir: path.join(root, 'public'),

  host: process.env.HOST || '0.0.0.0',
  port: Number(process.env.PORT || 3000),

  /** Optional TLS (recommended when serving over a LAN — the browser crypto APIs
   *  and PWA install require a secure context). */
  tlsCert: process.env.OMNIVAULT_TLS_CERT || null,
  tlsKey: process.env.OMNIVAULT_TLS_KEY || null,

  /** Max JSON request body (image items are uploaded as encrypted base64). */
  maxBodyBytes: Math.max(1, Number(process.env.MAX_BODY_MB || 32)) * 1024 * 1024,

  /** Session lifetime. */
  sessionTtlMs: Math.max(1, Number(process.env.SESSION_TTL_HOURS || 168)) * 3600 * 1000,

  /** scrypt parameters used to hash the client auth key. */
  scrypt: { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 128 * 1024 * 1024 },

  /** Hard cap on how many items a single bulk replace may contain. */
  maxItems: 10000,

  /** Per-item encrypted payload caps (base64 length of `ct`). */
  maxTitleB64: 16 * 1024,
  maxDataB64: null // computed from maxBodyBytes in db.js
};

module.exports = config;
