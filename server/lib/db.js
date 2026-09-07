'use strict';

const fs = require('node:fs');
const path = require('node:path');
const nodeCrypto = require('node:crypto');
const { JsonStore } = require('./store');
const {
  randomId,
  randomToken,
  hashToken,
  hmac,
  computeVerifier,
  constantTimeEqualHex
} = require('./crypto');
const { HttpError } = require('./http-utils');

const ITEM_TYPES = new Set(['password', 'note', 'image']);

function validateUsername(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'username is required');
  const t = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._@+-]{2,63}$/.test(t)) {
    throw new HttpError(400, 'Invalid username: use 3-64 characters (letters, digits, . _ @ + -)');
  }
  return t;
}

/** Validate a base64 string and return its decoded byte length. */
function b64ByteLength(value) {
  if (typeof value !== 'string' || value.length === 0) return -1;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return -1;
  const pad = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return Math.floor((value.length * 6) / 8) - pad;
}

function validateB64(value, minBytes, maxBytes, name) {
  const len = b64ByteLength(value);
  if (len < minBytes || len > maxBytes) {
    throw new HttpError(400, `Invalid base64 field "${name}"`);
  }
  return len;
}

/** Envelope = { v:1, iv:<b64 12 bytes>, ct:<b64 ciphertext+tag> } produced client-side. */
function validateEnvelope(env, name, maxCtB64) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    throw new HttpError(400, `Encrypted field "${name}" is required`);
  }
  validateB64(env.iv, 8, 16, `${name}.iv`);
  const ctLen = validateB64(env.ct, 16, maxCtB64, `${name}.ct`);
  return { v: 1, iv: env.iv, ct: env.ct, bytes: ctLen };
}

function validateType(value) {
  if (!ITEM_TYPES.has(value)) {
    throw new HttpError(400, 'type must be one of: password, note, image');
  }
  return value;
}

/**
 * In-memory database over a single JSON file.
 * Everything item-related is opaque ciphertext to this server (zero-knowledge).
 */
function createDb(dataDir, options = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const store = new JsonStore(path.join(dataDir, 'omnivault.json'), {
    secret: null,
    users: [],
    items: [],
    sessions: {}
  });
  const data = store.data;
  const scryptParams = options.scrypt || { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 128 * 1024 * 1024 };
  const maxDataB64 = options.maxDataB64 || 48 * 1024 * 1024;
  const maxItems = options.maxItems || 10000;

  if (!data.secret) {
    data.secret = nodeCrypto.randomBytes(32).toString('base64');
    store.save();
  }
  const secretBuf = Buffer.from(data.secret, 'base64');

  function findUser(username) {
    const key = String(username || '').trim().toLowerCase();
    if (!key) return null;
    return data.users.find((u) => u.username.toLowerCase() === key) || null;
  }

  /** Deterministic decoy salt so unknown usernames are indistinguishable from real ones. */
  function fakeSalt(username, kind = 'fake-salt') {
    return hmac(secretBuf, `${kind}:${String(username || '').toLowerCase()}`)
      .subarray(0, 16)
      .toString('base64');
  }

  function publicUser(user) {
    return {
      id: user.id,
      username: user.username,
      salt: user.salt,
      vault: user.vault || null,
      recoverySalt: user.recovery ? user.recovery.salt : null,
      createdAt: user.createdAt
    };
  }

  /** Validate an optional wrapped-key envelope ({iv, ct}) or return null. */
  function validateOptionalEnvelope(env, name, maxCtB64) {
    if (env === undefined || env === null) return null;
    const v = validateEnvelope(env, name, maxCtB64);
    return { v: 1, iv: v.iv, ct: v.ct };
  }

  /** Build the server-side recovery record {salt, serverSalt, verifier, envelope}. */
  async function buildRecovery(recovery, scryptParamsRef) {
    if (!recovery || typeof recovery !== 'object') {
      throw new HttpError(400, 'Invalid recovery payload');
    }
    validateB64(recovery.salt, 8, 64, 'recovery.salt');
    validateB64(recovery.authKey, 16, 128, 'recovery.authKey');
    const envelope = validateOptionalEnvelope(recovery.envelope, 'recovery.envelope', 64 * 1024);
    if (!envelope) throw new HttpError(400, 'recovery.envelope is required');
    const serverSalt = nodeCrypto.randomBytes(16).toString('hex');
    return {
      salt: recovery.salt,
      serverSalt,
      verifier: await computeVerifier(recovery.authKey, serverSalt, scryptParamsRef),
      envelope
    };
  }

  async function createUser({ username, salt, authKey, vault, recovery }) {
    validateB64(salt, 8, 64, 'salt');
    validateB64(authKey, 16, 128, 'authKey');
    const serverSalt = nodeCrypto.randomBytes(16).toString('hex');
    const verifier = await computeVerifier(authKey, serverSalt, scryptParams);
    const user = {
      id: randomId(),
      username,
      salt,
      serverSalt,
      verifier,
      vault: validateOptionalEnvelope(vault, 'vault', 64 * 1024),
      recovery: recovery ? await buildRecovery(recovery, scryptParams) : null,
      createdAt: new Date().toISOString()
    };
    data.users.push(user);
    store.save();
    return user;
  }

  async function verifyUser(user, authKey) {
    if (!user || typeof authKey !== 'string') return false;
    try {
      const candidate = await computeVerifier(authKey, user.serverSalt, scryptParams);
      return constantTimeEqualHex(candidate, user.verifier);
    } catch {
      return false;
    }
  }

  /** Verify possession of the recovery key (used by the reset flow). */
  async function verifyRecovery(user, recoveryAuthKey) {
    if (!user || !user.recovery || typeof recoveryAuthKey !== 'string') return false;
    try {
      const candidate = await computeVerifier(recoveryAuthKey, user.recovery.serverSalt, scryptParams);
      return constantTimeEqualHex(candidate, user.recovery.verifier);
    } catch {
      return false;
    }
  }

  async function updateAuth(user, body) {
    if (body.salt !== undefined && body.authKey !== undefined) {
      validateB64(body.salt, 8, 64, 'salt');
      validateB64(body.authKey, 16, 128, 'authKey');
      const serverSalt = nodeCrypto.randomBytes(16).toString('hex');
      user.salt = body.salt;
      user.serverSalt = serverSalt;
      user.verifier = await computeVerifier(body.authKey, serverSalt, scryptParams);
    }
    if (body.vault !== undefined) {
      user.vault = validateOptionalEnvelope(body.vault, 'vault', 64 * 1024);
    }
    if (body.recovery !== undefined) {
      user.recovery = body.recovery === null ? null : await buildRecovery(body.recovery, scryptParams);
    }
    store.save();
  }

  // --------------------------------------------------------------- sessions

  function createSession(userId, ttlMs) {
    const token = randomToken();
    const expiresAt = Date.now() + ttlMs;
    data.sessions[hashToken(token)] = { userId, expiresAt };
    // opportunistic cleanup of expired sessions
    const now = Date.now();
    for (const [k, s] of Object.entries(data.sessions)) {
      if (s.expiresAt <= now) delete data.sessions[k];
    }
    store.save();
    return { token, expiresAt };
  }

  function getSessionUser(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 128) return null;
    const entry = data.sessions[hashToken(token)];
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      delete data.sessions[hashToken(token)];
      store.save();
      return null;
    }
    return data.users.find((u) => u.id === entry.userId) || null;
  }

  function destroySession(token) {
    if (typeof token !== 'string') return;
    const key = hashToken(token);
    if (data.sessions[key]) {
      delete data.sessions[key];
      store.save();
    }
  }

  function cleanupSessions() {
    const now = Date.now();
    let changed = false;
    for (const [k, s] of Object.entries(data.sessions)) {
      if (s.expiresAt <= now) {
        delete data.sessions[k];
        changed = true;
      }
    }
    if (changed) store.save();
    return changed;
  }

  // ------------------------------------------------------------------ items

  function listItems(userId) {
    return data.items
      .filter((i) => i.userId === userId)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .map(stripItem);
  }

  function stripItem(item) {
    return {
      id: item.id,
      type: item.type,
      title: item.title,
      data: item.data,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt
    };
  }

  function getRawItem(userId, id) {
    const item = data.items.find((i) => i.userId === userId && i.id === id);
    return item || null;
  }

  function validateItemPayload(body) {
    const type = validateType(body.type);
    const title = validateEnvelope(body.title, 'title', 64 * 1024);
    const dataEnv = validateEnvelope(body.data, 'data', maxDataB64);
    return { type, title, data: dataEnv, bytes: dataEnv.bytes };
  }

  function createItem(userId, body) {
    const payload = validateItemPayload(body);
    const item = {
      id: randomId(),
      userId,
      type: payload.type,
      title: payload.title,
      data: payload.data,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    data.items.push(item);
    store.save();
    return stripItem(item);
  }

  function updateItem(userId, id, body) {
    const item = getRawItem(userId, id);
    if (!item) throw new HttpError(404, 'Item not found');
    const payload = validateItemPayload(body);
    item.type = payload.type;
    item.title = payload.title;
    item.data = payload.data;
    item.updatedAt = new Date().toISOString();
    store.save();
    return stripItem(item);
  }

  function deleteItem(userId, id) {
    const idx = data.items.findIndex((i) => i.userId === userId && i.id === id);
    if (idx === -1) throw new HttpError(404, 'Item not found');
    const [removed] = data.items.splice(idx, 1);
    store.save();
    return removed;
  }

  /** Replace the user's entire vault (used by the change-password re-encrypt flow). */
  function replaceItems(userId, list) {
    if (!Array.isArray(list)) throw new HttpError(400, 'items must be an array');
    if (list.length > maxItems) throw new HttpError(400, `Too many items (max ${maxItems})`);
    const oldById = new Map(
      data.items.filter((i) => i.userId === userId).map((i) => [i.id, i])
    );
    const now = new Date().toISOString();
    const next = [];
    const seen = new Set();
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') throw new HttpError(400, 'Invalid item');
      const payload = validateItemPayload(raw);
      let id = typeof raw.id === 'string' && /^[A-Za-z0-9_-]{6,32}$/.test(raw.id) ? raw.id : null;
      if (!id || seen.has(id)) id = randomId();
      seen.add(id);
      const previous = oldById.get(id);
      next.push({
        id,
        userId,
        type: payload.type,
        title: payload.title,
        data: payload.data,
        createdAt: previous ? previous.createdAt : (raw.createdAt && typeof raw.createdAt === 'string' ? raw.createdAt : now),
        updatedAt: now
      });
    }
    const others = data.items.filter((i) => i.userId !== userId);
    data.items = others.concat(next);
    store.save();
    return next
      .filter((i) => i.userId === userId)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .map(stripItem);
  }

  function wipeItems(userId) {
    const before = data.items.length;
    data.items = data.items.filter((i) => i.userId !== userId);
    store.save();
    return before - data.items.length;
  }

  return {
    store,
    findUser,
    fakeSalt,
    publicUser,
    createUser,
    verifyUser,
    verifyRecovery,
    updateAuth,
    createSession,
    getSessionUser,
    destroySession,
    cleanupSessions,
    listItems,
    getRawItem,
    stripItem,
    createItem,
    updateItem,
    deleteItem,
    replaceItems,
    wipeItems
  };
}

module.exports = { createDb, ITEM_TYPES, validateUsername };
