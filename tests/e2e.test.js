'use strict';

const test = require('node:test');
const assert = require('node:assert');
const nodeCrypto = require('node:crypto');

const VC = require('../public/js/crypto.js');
const { startServer, jsonFetch } = require('./helpers.js');

/**
 * Full end-to-end simulation of the browser client against the real server
 * over HTTP, using the real client crypto module. Covers the vault-key model:
 * register with a wrapped key + recovery code, unlock, instant password
 * changes (no item re-encryption), and the forgot-password reset flow.
 */

const MASTER_PASSWORD = 'correct horse battery staple';
const NEW_MASTER_PASSWORD = 'another very long passphrase 42!';
const RESET_PASSWORD = 'third passphrase after reset!';

async function fullRegister(base, username, password) {
  const salt = VC.randomSaltB64();
  const material = await VC.deriveAuthMaterial(password, salt);
  const vaultKeyBytes = new Uint8Array(nodeCrypto.randomBytes(32));
  const vault = await VC.encryptBytes(material.masterKey, vaultKeyBytes);
  const recoveryCode = VC.generateRecoveryCode();
  const recoverySalt = VC.randomSaltB64();
  const rec = await VC.deriveRecoveryMaterial(recoveryCode, recoverySalt);
  const recovery = {
    salt: recoverySalt,
    authKey: rec.recoveryAuthKey,
    envelope: await VC.encryptBytes(rec.recoveryKey, vaultKeyBytes)
  };
  const { res, data } = await jsonFetch(`${base}/api/auth/register`, 'POST', {
    username,
    salt,
    authKey: material.authKey,
    vault,
    recovery
  });
  assert.strictEqual(res.status, 201, 'register should succeed');
  return { salt, vaultKeyBytes, recoveryCode, recoverySalt, token: data.token, user: data.user };
}

async function login(base, username, password) {
  const { data: salts } = await jsonFetch(`${base}/api/auth/salt?username=${encodeURIComponent(username)}`);
  const material = await VC.deriveAuthMaterial(password, salts.salt);
  const { res, data } = await jsonFetch(`${base}/api/auth/login`, 'POST', {
    username,
    authKey: material.authKey
  });
  return { res, data, material };
}

test('e2e: vault-key lifecycle — register, unlock, instant password change, reset via recovery code', async () => {
  const s = await startServer();
  const base = s.base;

  // ---- register ------------------------------------------------------------
  const reg = await fullRegister(base, 'endtoend', MASTER_PASSWORD);

  // ---- login returns the wrapped vault key; unwrap it ----------------------
  const loginRes = await login(base, 'endtoend', MASTER_PASSWORD);
  assert.strictEqual(loginRes.res.status, 200);
  assert.ok(loginRes.data.user.vault, 'login response carries the wrapped vault key');
  assert.strictEqual(loginRes.data.user.recoverySalt, reg.recoverySalt);
  const vaultKeyBytes = await VC.decryptBytes(loginRes.material.masterKey, loginRes.data.user.vault);
  assert.deepStrictEqual(vaultKeyBytes, reg.vaultKeyBytes);
  const itemKey = await VC.importAesKey(vaultKeyBytes);

  // ---- add items of every type --------------------------------------------
  const imageBytes = new Uint8Array(nodeCrypto.randomBytes(4096));
  const plains = [
    {
      type: 'password',
      title: 'GitHub',
      plain: { url: 'github.com', username: 'octocat@example.com', password: 's3cr3t-hunter2', totpSecret: 'JBSWY3DPEHPK3PXP', notes: 'work account' }
    },
    { type: 'note', title: 'Wifi at home', plain: { text: 'SSID: Batcave-5G\nPassphrase: bruce-wayne-rocks' } },
    { type: 'image', title: 'Passport scan', plain: { mime: 'image/png', data: VC.bytesToB64(imageBytes), name: 'passport.png', size: imageBytes.length } }
  ];
  for (const p of plains) {
    const { res } = await jsonFetch(
      `${base}/api/items`,
      'POST',
      {
        type: p.type,
        title: await VC.encryptJson(itemKey, p.title),
        data: await VC.encryptJson(itemKey, p.plain)
      },
      loginRes.data.token
    );
    assert.strictEqual(res.status, 201, `create ${p.type}`);
  }

  const raw = await jsonFetch(`${base}/api/items`, 'GET', undefined, loginRes.data.token);
  assert.strictEqual(raw.data.items.length, 3);
  const rawJson = JSON.stringify(raw.data.items);
  assert.ok(!rawJson.includes('octocat'), 'username must not appear in plaintext');
  assert.ok(!rawJson.includes('Batcave-5G'), 'note text must not appear in plaintext');

  // ciphertext snapshot before the password change
  const ciphertextBefore = raw.data.items.map((i) => i.data.ct);

  // ---- change master password: only the vault key is re-wrapped ------------
  const newSalt = VC.randomSaltB64();
  const next = await VC.deriveAuthMaterial(NEW_MASTER_PASSWORD, newSalt);
  const newVaultEnv = await VC.encryptBytes(next.masterKey, vaultKeyBytes);
  const upd = await jsonFetch(
    `${base}/api/auth/update-auth`,
    'POST',
    { salt: newSalt, authKey: next.authKey, vault: newVaultEnv },
    loginRes.data.token
  );
  assert.strictEqual(upd.res.status, 200);

  const oldLogin = await login(base, 'endtoend', MASTER_PASSWORD);
  assert.strictEqual(oldLogin.res.status, 401, 'old password must stop working');

  const newLogin = await login(base, 'endtoend', NEW_MASTER_PASSWORD);
  assert.strictEqual(newLogin.res.status, 200);
  const vk2 = await VC.decryptBytes(newLogin.material.masterKey, newLogin.data.user.vault);
  assert.deepStrictEqual(vk2, vaultKeyBytes, 'same vault key after password change');

  const after = await jsonFetch(`${base}/api/items`, 'GET', undefined, newLogin.data.token);
  assert.deepStrictEqual(
    after.data.items.map((i) => i.data.ct),
    ciphertextBefore,
    'password change must not touch item ciphertext'
  );
  for (const it of after.data.items) {
    await VC.decryptJson(itemKey, it.data); // still decrypts with the same key
  }

  // ---- forgot password: reset via the recovery code ------------------------
  const salts = await jsonFetch(`${base}/api/auth/salt?username=endtoend`);
  assert.ok(salts.data.recoverySalt);

  const wrongRec = await VC.deriveRecoveryMaterial(VC.generateRecoveryCode(), salts.data.recoverySalt);
  const wrong = await jsonFetch(`${base}/api/auth/recovery-login`, 'POST', {
    username: 'endtoend',
    recoveryAuthKey: wrongRec.recoveryAuthKey
  });
  assert.strictEqual(wrong.res.status, 401, 'wrong recovery code must fail');

  const rec = await VC.deriveRecoveryMaterial(reg.recoveryCode, salts.data.recoverySalt);
  const recLogin = await jsonFetch(`${base}/api/auth/recovery-login`, 'POST', {
    username: 'endtoend',
    recoveryAuthKey: rec.recoveryAuthKey
  });
  assert.strictEqual(recLogin.res.status, 200);
  assert.ok(recLogin.data.recovery.envelope, 'recovery login returns the wrapped vault key');
  const vk3 = await VC.decryptBytes(rec.recoveryKey, recLogin.data.recovery.envelope);
  assert.deepStrictEqual(vk3, vaultKeyBytes, 'recovery code unwraps the same vault key');

  // set a brand-new master password using the recovery session
  const resetSalt = VC.randomSaltB64();
  const resetMaterial = await VC.deriveAuthMaterial(RESET_PASSWORD, resetSalt);
  const resetVaultEnv = await VC.encryptBytes(resetMaterial.masterKey, vk3);
  const upd2 = await jsonFetch(
    `${base}/api/auth/update-auth`,
    'POST',
    { salt: resetSalt, authKey: resetMaterial.authKey, vault: resetVaultEnv },
    recLogin.data.token
  );
  assert.strictEqual(upd2.res.status, 200);

  const finalLogin = await login(base, 'endtoend', RESET_PASSWORD);
  assert.strictEqual(finalLogin.res.status, 200, 'reset password must work');
  const finalItems = await jsonFetch(`${base}/api/items`, 'GET', undefined, finalLogin.data.token);
  assert.strictEqual(finalItems.data.items.length, 3, 'no data lost during reset');
  for (const it of finalItems.data.items) {
    await VC.decryptJson(itemKey, it.data); // does not throw
  }

  await s.close();
});

test('e2e: data persists across a server restart', async () => {
  const s = await startServer();
  const reg = await fullRegister(s.base, 'phoenix', 'restart-test-password');
  const itemKey = await VC.importAesKey(reg.vaultKeyBytes);
  await jsonFetch(
    `${s.base}/api/items`,
    'POST',
    {
      type: 'note',
      title: await VC.encryptJson(itemKey, 'survives'),
      data: await VC.encryptJson(itemKey, { text: 'persisted' })
    },
    reg.token
  );

  const dataDir = s.config.dataDir;
  await s.close();

  const s2 = await startServer({ dataDir, sessionTtlMs: 3600 * 1000, maxBodyBytes: 512 * 1024, maxItems: 1000 });
  const me = await jsonFetch(`${s2.base}/api/me`, 'GET', undefined, reg.token);
  assert.strictEqual(me.res.status, 200, 'session survives restart');

  const login2 = await login(s2.base, 'phoenix', 'restart-test-password');
  assert.strictEqual(login2.res.status, 200);
  const list = await jsonFetch(`${s2.base}/api/items`, 'GET', undefined, login2.data.token);
  assert.strictEqual(list.data.items.length, 1);
  const title = await VC.decryptJson(itemKey, list.data.items[0].title);
  assert.strictEqual(title, 'survives');

  await s2.close();
});
