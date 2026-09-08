'use strict';

const test = require('node:test');
const assert = require('node:assert');
const nodeCrypto = require('node:crypto');

const { startServer, jsonFetch, b64 } = require('./helpers.js');

function fakeMaterial() {
  return { salt: b64(nodeCrypto.randomBytes(16)), authKey: b64(nodeCrypto.randomBytes(32)) };
}

function envelope() {
  return { v: 1, iv: b64(nodeCrypto.randomBytes(12)), ct: b64(nodeCrypto.randomBytes(64)) };
}

async function registerUser(base, username) {
  const material = fakeMaterial();
  const { res, data } = await jsonFetch(`${base}/api/auth/register`, 'POST', { username, ...material });
  assert.strictEqual(res.status, 201, 'register should succeed');
  return { ...material, token: data.token, user: data.user };
}

test('health endpoint reports ok', async () => {
  const s = await startServer();
  const { res, data } = await jsonFetch(`${s.base}/api/health`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(data.ok, true);
  assert.strictEqual(data.name, 'omnivault');
  await s.close();
});

test('register → login → me → logout lifecycle', async () => {
  const s = await startServer();
  const username = 'alice';
  const material = fakeMaterial();

  const reg = await jsonFetch(`${s.base}/api/auth/register`, 'POST', { username, ...material });
  assert.strictEqual(reg.res.status, 201);
  assert.strictEqual(reg.data.user.username, username);
  assert.strictEqual(typeof reg.data.token, 'string');

  // duplicate username
  const dup = await jsonFetch(`${s.base}/api/auth/register`, 'POST', { username, ...fakeMaterial() });
  assert.strictEqual(dup.res.status, 409);

  // salt endpoint returns the real salt + a recovery salt (decoy-safe)
  const salt = await jsonFetch(`${s.base}/api/auth/salt?username=${username}`);
  assert.strictEqual(salt.res.status, 200);
  assert.strictEqual(salt.data.salt, material.salt);
  assert.ok(typeof salt.data.recoverySalt === 'string');

  // login with correct key
  const login = await jsonFetch(`${s.base}/api/auth/login`, 'POST', { username, authKey: material.authKey });
  assert.strictEqual(login.res.status, 200);
  assert.strictEqual(login.data.user.username, username);

  // login with wrong key
  const bad = await jsonFetch(`${s.base}/api/auth/login`, 'POST', { username, authKey: b64(nodeCrypto.randomBytes(32)) });
  assert.strictEqual(bad.res.status, 401);

  // login for unknown user also 401 (indistinguishable)
  const ghost = await jsonFetch(`${s.base}/api/auth/login`, 'POST', { username: 'ghost', authKey: b64(nodeCrypto.randomBytes(32)) });
  assert.strictEqual(ghost.res.status, 401);

  // unknown user gets a plausible decoy salt
  const decoy = await jsonFetch(`${s.base}/api/auth/salt?username=ghost`);
  assert.strictEqual(decoy.res.status, 200);
  assert.ok(decoy.data.salt.length >= 16);
  // decoy is stable per username (so it cannot be used to enumerate)
  const decoy2 = await jsonFetch(`${s.base}/api/auth/salt?username=ghost`);
  assert.strictEqual(decoy.data.salt, decoy2.data.salt);

  // me with token
  const me = await jsonFetch(`${s.base}/api/me`, 'GET', undefined, login.data.token);
  assert.strictEqual(me.res.status, 200);
  assert.strictEqual(me.data.user.username, username);

  // me without token
  const noTok = await jsonFetch(`${s.base}/api/me`);
  assert.strictEqual(noTok.res.status, 401);

  // verify endpoint
  const ok = await jsonFetch(`${s.base}/api/auth/verify`, 'POST', { authKey: material.authKey }, login.data.token);
  assert.strictEqual(ok.res.status, 200);
  const badVerify = await jsonFetch(`${s.base}/api/auth/verify`, 'POST', { authKey: b64(nodeCrypto.randomBytes(32)) }, login.data.token);
  assert.strictEqual(badVerify.res.status, 401);

  // logout invalidates the session
  const out = await jsonFetch(`${s.base}/api/auth/logout`, 'POST', {}, login.data.token);
  assert.strictEqual(out.res.status, 200);
  const meAfter = await jsonFetch(`${s.base}/api/me`, 'GET', undefined, login.data.token);
  assert.strictEqual(meAfter.res.status, 401);

  await s.close();
});

test('sessions expire after TTL', async () => {
  const s = await startServer({ sessionTtlMs: 150 });
  const u = await registerUser(s.base, 'bob');
  await new Promise((r) => setTimeout(r, 250));
  const me = await jsonFetch(`${s.base}/api/me`, 'GET', undefined, u.token);
  assert.strictEqual(me.res.status, 401);
  await s.close();
});

test('item CRUD enforces auth and validation', async () => {
  const s = await startServer();
  const u = await registerUser(s.base, 'carol');

  // requires auth
  const anon = await jsonFetch(`${s.base}/api/items`, 'GET');
  assert.strictEqual(anon.res.status, 401);

  // invalid type
  const badType = await jsonFetch(
    `${s.base}/api/items`,
    'POST',
    { type: 'evil', title: envelope(), data: envelope() },
    u.token
  );
  assert.strictEqual(badType.res.status, 400);

  // invalid envelope (missing iv)
  const badEnv = await jsonFetch(
    `${s.base}/api/items`,
    'POST',
    { type: 'note', title: { ct: 'AAAA' }, data: envelope() },
    u.token
  );
  assert.strictEqual(badEnv.res.status, 400);

  // create
  const created = await jsonFetch(
    `${s.base}/api/items`,
    'POST',
    { type: 'note', title: envelope(), data: envelope() },
    u.token
  );
  assert.strictEqual(created.res.status, 201);
  const id = created.data.item.id;
  assert.ok(id);

  // list
  const list = await jsonFetch(`${s.base}/api/items`, 'GET', undefined, u.token);
  assert.strictEqual(list.res.status, 200);
  assert.strictEqual(list.data.items.length, 1);
  assert.strictEqual(list.data.items[0].id, id);

  // get one
  const one = await jsonFetch(`${s.base}/api/items/${id}`, 'GET', undefined, u.token);
  assert.strictEqual(one.res.status, 200);

  // update
  const updated = await jsonFetch(
    `${s.base}/api/items/${id}`,
    'PUT',
    { type: 'note', title: envelope(), data: envelope() },
    u.token
  );
  assert.strictEqual(updated.res.status, 200);
  assert.notStrictEqual(updated.data.item.title.ct, created.data.item.title.ct);

  // second user cannot see or touch carol's item
  const mallory = await registerUser(s.base, 'mallory');
  const foreign = await jsonFetch(`${s.base}/api/items/${id}`, 'GET', undefined, mallory.token);
  assert.strictEqual(foreign.res.status, 404);
  const foreignDel = await jsonFetch(`${s.base}/api/items/${id}`, 'DELETE', undefined, mallory.token);
  assert.strictEqual(foreignDel.res.status, 404);

  // delete
  const del = await jsonFetch(`${s.base}/api/items/${id}`, 'DELETE', undefined, u.token);
  assert.strictEqual(del.res.status, 200);
  const gone = await jsonFetch(`${s.base}/api/items/${id}`, 'GET', undefined, u.token);
  assert.strictEqual(gone.res.status, 404);

  await s.close();
});

test('bulk replace + wipe', async () => {
  const s = await startServer();
  const u = await registerUser(s.base, 'dave');

  for (let i = 0; i < 3; i++) {
    await jsonFetch(`${s.base}/api/items`, 'POST', { type: 'note', title: envelope(), data: envelope() }, u.token);
  }

  const list = await jsonFetch(`${s.base}/api/items`, 'GET', undefined, u.token);
  const oldIds = list.data.items.map((i) => i.id);

  // replace all with two items, keeping one old id
  const replacement = [
    { id: oldIds[0], type: 'password', title: envelope(), data: envelope() },
    { type: 'image', title: envelope(), data: envelope() }
  ];
  const replaced = await jsonFetch(`${s.base}/api/items`, 'PUT', { items: replacement }, u.token);
  assert.strictEqual(replaced.res.status, 200);
  assert.strictEqual(replaced.data.items.length, 2);
  assert.ok(replaced.data.items.some((i) => i.id === oldIds[0]), 'kept id should survive');
  assert.ok(replaced.data.items.every((i) => i.type === 'password' || i.type === 'image'));

  // update-auth: rotate credentials
  const newMaterial = fakeMaterial();
  const upd = await jsonFetch(`${s.base}/api/auth/update-auth`, 'POST', newMaterial, u.token);
  assert.strictEqual(upd.res.status, 200);
  const relogin = await jsonFetch(`${s.base}/api/auth/login`, 'POST', { username: 'dave', authKey: newMaterial.authKey });
  assert.strictEqual(relogin.res.status, 200);

  // wipe requires the master auth key
  const badWipe = await jsonFetch(`${s.base}/api/items`, 'DELETE', { authKey: b64(nodeCrypto.randomBytes(32)) }, relogin.data.token);
  assert.strictEqual(badWipe.res.status, 401);
  const wipe = await jsonFetch(`${s.base}/api/items`, 'DELETE', { authKey: newMaterial.authKey }, relogin.data.token);
  assert.strictEqual(wipe.res.status, 200);
  const empty = await jsonFetch(`${s.base}/api/items`, 'GET', undefined, relogin.data.token);
  assert.strictEqual(empty.data.items.length, 0);

  await s.close();
});

test('recovery-login rejects accounts without a recovery code', async () => {
  const s = await startServer();
  const u = await registerUser(s.base, 'norecovery');
  const res = await jsonFetch(`${s.base}/api/auth/recovery-login`, 'POST', {
    username: 'norecovery',
    recoveryAuthKey: b64(nodeCrypto.randomBytes(32))
  });
  assert.strictEqual(res.res.status, 401);
  // unknown user is indistinguishable
  const ghost = await jsonFetch(`${s.base}/api/auth/recovery-login`, 'POST', {
    username: 'ghost',
    recoveryAuthKey: b64(nodeCrypto.randomBytes(32))
  });
  assert.strictEqual(ghost.res.status, 401);
  await s.close();
});

test('body size limit returns 413', async () => {
  const s = await startServer({ maxBodyBytes: 64 * 1024 });
  const u = await registerUser(s.base, 'erin');
  const big = b64(nodeCrypto.randomBytes(128 * 1024));
  const res = await fetch(`${s.base}/api/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.token}` },
    body: JSON.stringify({ type: 'note', title: { iv: b64(nodeCrypto.randomBytes(12)), ct: big }, data: envelope() })
  });
  assert.strictEqual(res.status, 413);
  await s.close();
});

test('static files: shell, manifest, sw, icons, traversal blocked', async () => {
  const s = await startServer();

  const index = await fetch(`${s.base}/`);
  assert.strictEqual(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);
  const html = await index.text();
  assert.match(html, /OmniVault/);
  assert.match(index.headers.get('content-security-policy') || '', /default-src 'self'/);

  const manifest = await fetch(`${s.base}/manifest.webmanifest`);
  assert.strictEqual(manifest.status, 200);
  assert.match(manifest.headers.get('content-type'), /manifest\+json/);
  assert.match(manifest.headers.get('cache-control'), /no-cache/);

  const sw = await fetch(`${s.base}/sw.js`);
  assert.strictEqual(sw.status, 200);
  assert.match(await sw.text(), /omnivault-v\d+/); // cache version must exist

  const icon = await fetch(`${s.base}/icons/icon-192.png`);
  assert.strictEqual(icon.status, 200);
  assert.match(icon.headers.get('content-type'), /image\/png/);

  // traversal attempts must not escape public/
  const trav = await fetch(`${s.base}/%2e%2e/%2e%2e/package.json`);
  assert.ok([403, 404].includes(trav.status), `expected 403/404, got ${trav.status}`);
  const trav2 = await fetch(`${s.base}/icons/..%2f..%2fserver%2fserver.js`);
  assert.ok([403, 404].includes(trav2.status));

  const missing = await fetch(`${s.base}/nope-does-not-exist.js`);
  assert.strictEqual(missing.status, 404);

  // HEAD works
  const head = await fetch(`${s.base}/`, { method: 'HEAD' });
  assert.strictEqual(head.status, 200);
  assert.strictEqual(head.headers.get('content-type'), 'text/html; charset=utf-8');

  await s.close();
});
