'use strict';

const { HttpError, sendJson, readJson } = require('./http-utils');
const { computeVerifier } = require('./crypto');

const VERSION = require('../../package.json').version;

function bearerToken(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer ([A-Za-z0-9_-]{20,128})$/.exec(h);
  return m ? m[1] : null;
}

function requireUser(req, db) {
  const token = bearerToken(req);
  const user = token ? db.getSessionUser(token) : null;
  if (!user) throw new HttpError(401, 'Authentication required');
  return user;
}

/**
 * API surface (all item payloads are client-encrypted envelopes — the server
 * cannot read any of it):
 *
 *   GET    /api/health
 *   GET    /api/auth/salt?username=u        → { salt } (decoy salt for unknown users)
 *   POST   /api/auth/register               { username, salt, authKey } → { token, user }
 *   POST   /api/auth/login                  { username, authKey }      → { token, user }
 *   POST   /api/auth/verify          (auth) { authKey }                → { ok }
 *   POST   /api/auth/update-auth     (auth) { salt, authKey }          → { ok }
 *   POST   /api/auth/logout          (auth)                            → { ok }
 *   GET    /api/me                    (auth)                            → { user }
 *   GET    /api/items                 (auth)                            → { items }
 *   POST   /api/items                 (auth) { type, title, data }      → { item }
 *   GET    /api/items/:id             (auth)                            → { item }
 *   PUT    /api/items/:id             (auth) { type, title, data }      → { item }
 *   DELETE /api/items/:id             (auth)                            → { ok }
 *   PUT    /api/items                 (auth) { items: [...] }           → { items }  (replace all)
 *   DELETE /api/items                 (auth) { authKey }                → { ok }     (wipe vault)
 */
async function handleApi(req, res, url, config, db) {
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  const p = url.pathname;
  const route = `${method} ${p}`;

  if (p === '/api/health') {
    return sendJson(res, 200, { ok: true, name: 'omnivault', version: VERSION, time: new Date().toISOString() });
  }

  // ------------------------------------------------------------------ auth

  if (route === 'GET /api/auth/salt') {
    const username = url.searchParams.get('username') || '';
    const user = db.findUser(username);
    return sendJson(res, 200, {
      salt: user ? user.salt : db.fakeSalt(username, 'fake-salt'),
      recoverySalt: user && user.recovery ? user.recovery.salt : db.fakeSalt(username, 'fake-recovery-salt')
    });
  }

  if (route === 'POST /api/auth/register') {
    const body = await readJson(req, 128 * 1024);
    const { validateUsername } = require('./db');
    const username = validateUsername(body.username);
    if (db.findUser(username)) throw new HttpError(409, 'That username is already taken');
    const user = await db.createUser({
      username,
      salt: body.salt,
      authKey: body.authKey,
      vault: body.vault,
      recovery: body.recovery
    });
    const session = db.createSession(user.id, config.sessionTtlMs);
    return sendJson(res, 201, { token: session.token, user: db.publicUser(user) });
  }

  if (route === 'POST /api/auth/login') {
    const body = await readJson(req, 64 * 1024);
    const user = db.findUser(body.username || '');
    let ok = false;
    if (user) ok = await db.verifyUser(user, body.authKey);
    // Equalize timing for unknown users so logins are not distinguishable.
    await computeVerifier(String(body.authKey || ''), '00'.repeat(16), config.scrypt).catch(() => {});
    if (!ok) throw new HttpError(401, 'Invalid username or master password');
    const session = db.createSession(user.id, config.sessionTtlMs);
    return sendJson(res, 200, { token: session.token, user: db.publicUser(user) });
  }

  if (route === 'POST /api/auth/verify') {
    const user = requireUser(req, db);
    const body = await readJson(req, 64 * 1024);
    const ok = await db.verifyUser(user, body.authKey);
    if (!ok) throw new HttpError(401, 'Master password is incorrect');
    return sendJson(res, 200, { ok: true });
  }

  if (route === 'POST /api/auth/recovery-login') {
    const body = await readJson(req, 64 * 1024);
    const user = db.findUser(body.username || '');
    let ok = false;
    if (user) ok = await db.verifyRecovery(user, body.recoveryAuthKey);
    // Equalize timing for unknown users / missing recovery codes.
    await computeVerifier(String(body.recoveryAuthKey || ''), '00'.repeat(16), config.scrypt).catch(() => {});
    if (!ok) throw new HttpError(401, 'Invalid username or recovery code');
    const session = db.createSession(user.id, config.sessionTtlMs);
    return sendJson(res, 200, {
      token: session.token,
      user: db.publicUser(user),
      recovery: { envelope: user.recovery.envelope }
    });
  }

  if (route === 'POST /api/auth/update-auth') {
    const user = requireUser(req, db);
    const body = await readJson(req, 256 * 1024);
    await db.updateAuth(user, body);
    return sendJson(res, 200, { ok: true });
  }

  if (route === 'POST /api/auth/logout') {
    const user = requireUser(req, db);
    const token = bearerToken(req);
    if (token) db.destroySession(token);
    return sendJson(res, 200, { ok: true });
  }

  if (route === 'GET /api/me') {
    const user = requireUser(req, db);
    return sendJson(res, 200, { user: db.publicUser(user) });
  }

  // ----------------------------------------------------------------- items

  if (route === 'GET /api/items') {
    const user = requireUser(req, db);
    return sendJson(res, 200, { items: db.listItems(user.id) });
  }

  if (route === 'POST /api/items') {
    const user = requireUser(req, db);
    const body = await readJson(req, config.maxBodyBytes);
    const item = db.createItem(user.id, body);
    return sendJson(res, 201, { item });
  }

  const itemMatch = /^\/api\/items\/([A-Za-z0-9_-]{1,32})$/.exec(p);
  if (itemMatch) {
    const user = requireUser(req, db);
    const id = itemMatch[1];
    if (method === 'GET') {
      const raw = db.getRawItem(user.id, id);
      if (!raw) throw new HttpError(404, 'Item not found');
      return sendJson(res, 200, { item: db.stripItem(raw) });
    }
    if (method === 'PUT') {
      const body = await readJson(req, config.maxBodyBytes);
      const item = db.updateItem(user.id, id, body);
      return sendJson(res, 200, { item });
    }
    if (method === 'DELETE') {
      db.deleteItem(user.id, id);
      return sendJson(res, 200, { ok: true });
    }
  }

  if (route === 'PUT /api/items') {
    const user = requireUser(req, db);
    const body = await readJson(req, config.maxBodyBytes);
    const items = db.replaceItems(user.id, body.items);
    return sendJson(res, 200, { items });
  }

  if (route === 'DELETE /api/items') {
    const user = requireUser(req, db);
    const body = await readJson(req, 64 * 1024);
    const ok = await db.verifyUser(user, body.authKey);
    if (!ok) throw new HttpError(401, 'Master password is incorrect');
    db.wipeItems(user.id);
    return sendJson(res, 200, { ok: true });
  }

  throw new HttpError(404, 'Not found');
}

module.exports = { handleApi };
