'use strict';

const test = require('node:test');
const assert = require('node:assert');
const nodeCrypto = require('node:crypto');

// crypto.js sets global.VaultCrypto (works in Node — WebCrypto is global).
const VC = require('../public/js/crypto.js');
const { MemoryAdapter, LocalBackend } = require('../public/js/localstore.js');

/**
 * 100% local mode: the LocalBackend must behave exactly like the server API —
 * register/login, items, instant password change and the recovery-code reset
 * — with zero network involvement (these tests run with no server at all).
 */

const PASSWORD = 'local-device-master-pw';
const NEW_PASSWORD = 'rotated local password 99';
const RESET_PASSWORD = 'reset local password 77';

async function registerLocal(backend, username, password) {
  const salt = VC.randomSaltB64();
  const material = await VC.deriveAuthMaterial(password, salt);
  const vaultKeyBytes = new Uint8Array(nodeCrypto.randomBytes(32));
  const vault = await VC.encryptBytes(material.masterKey, vaultKeyBytes);
  const recoveryCode = VC.generateRecoveryCode();
  const recoverySalt = VC.randomSaltB64();
  const rec = await VC.deriveRecoveryMaterial(recoveryCode, recoverySalt);
  const res = await backend.register({
    username,
    salt,
    authKey: material.authKey,
    vault,
    recovery: {
      salt: recoverySalt,
      authKey: rec.recoveryAuthKey,
      envelope: await VC.encryptBytes(rec.recoveryKey, vaultKeyBytes)
    }
  });
  return { salt, vaultKeyBytes, recoveryCode, recoverySalt, res };
}

test('local: register, login, items — full parity without any server', async () => {
  const backend = new LocalBackend(new MemoryAdapter());

  const reg = await registerLocal(backend, 'LocalUser', PASSWORD);
  assert.strictEqual(reg.res.token, 'local');
  assert.strictEqual(reg.res.user.username, 'LocalUser');
  assert.ok(reg.res.user.vault);

  // duplicate username
  await assert.rejects(() => registerLocal(backend, 'localuser', PASSWORD), (e) => e.status === 409);

  // login: unwrap vault key from the login response
  const salts = await backend.getSalt('LocalUser');
  const material = await VC.deriveAuthMaterial(PASSWORD, salts.salt);
  const login = await backend.login({ username: 'LocalUser', authKey: material.authKey });
  assert.strictEqual(login.user.username, 'LocalUser');
  const vaultKeyBytes = await VC.decryptBytes(material.masterKey, login.user.vault);
  assert.deepStrictEqual(vaultKeyBytes, reg.vaultKeyBytes);
  const itemKey = await VC.importAesKey(vaultKeyBytes);

  // wrong password
  await assert.rejects(
    () => backend.login({ username: 'LocalUser', authKey: VC.bytesToB64(nodeCrypto.randomBytes(32)) }),
    (e) => e.status === 401
  );

  // unknown user gets decoy salts (deterministic)
  const ghost1 = await backend.getSalt('ghost');
  const ghost2 = await backend.getSalt('ghost');
  assert.strictEqual(ghost1.salt, ghost2.salt);
  assert.ok(ghost1.recoverySalt);
  await assert.rejects(() => backend.login({ username: 'ghost', authKey: 'AAAA' }), (e) => e.status === 401);

  // items
  const item = (await backend.createItem({
    type: 'password',
    title: await VC.encryptJson(itemKey, 'Bank'),
    data: await VC.encryptJson(itemKey, { username: 'me', password: 's3cret' })
  })).item;
  const list = await backend.listItems();
  assert.strictEqual(list.items.length, 1);
  assert.strictEqual(list.items[0].id, item.id);
  const plain = await VC.decryptJson(itemKey, list.items[0].data);
  assert.strictEqual(plain.password, 's3cret');

  // update + delete + isolation
  await backend.updateItem(item.id, {
    type: 'note',
    title: await VC.encryptJson(itemKey, 'Bank note'),
    data: await VC.encryptJson(itemKey, { text: 'changed' })
  });
  await backend.deleteItem(item.id);
  assert.strictEqual((await backend.listItems()).items.length, 0);

  // second local user is fully isolated
  await backend.logout();
  await registerLocal(backend, 'SecondUser', 'second-user-password-1');
  await backend.login({ username: 'SecondUser', authKey: (await VC.deriveAuthMaterial('second-user-password-1', (await backend.getSalt('SecondUser')).salt)).authKey });
  assert.strictEqual((await backend.listItems()).items.length, 0);
});

test('local: instant password change keeps items and vault key', async () => {
  const backend = new LocalBackend(new MemoryAdapter());
  const reg = await registerLocal(backend, 'changer', PASSWORD);
  const itemKey = await VC.importAesKey(reg.vaultKeyBytes);

  await backend.createItem({
    type: 'note',
    title: await VC.encryptJson(itemKey, 'sticky'),
    data: await VC.encryptJson(itemKey, { text: 'do not lose me' })
  });
  const before = (await backend.listItems()).items.map((i) => i.data.ct);

  // re-wrap the vault key with a new password
  const newSalt = VC.randomSaltB64();
  const next = await VC.deriveAuthMaterial(NEW_PASSWORD, newSalt);
  await backend.updateAuth({
    salt: newSalt,
    authKey: next.authKey,
    vault: await VC.encryptBytes(next.masterKey, reg.vaultKeyBytes)
  });

  // old password fails, new password works and unwraps the same key
  const oldSalt = (await backend.getSalt('changer')).salt;
  const oldMaterial = await VC.deriveAuthMaterial(PASSWORD, oldSalt);
  await assert.rejects(() => backend.login({ username: 'changer', authKey: oldMaterial.authKey }), (e) => e.status === 401);

  const salts = (await backend.getSalt('changer')).salt;
  const newMaterial = await VC.deriveAuthMaterial(NEW_PASSWORD, salts);
  const login = await backend.login({ username: 'changer', authKey: newMaterial.authKey });
  const vk = await VC.decryptBytes(newMaterial.masterKey, login.user.vault);
  assert.deepStrictEqual(vk, reg.vaultKeyBytes);

  const after = (await backend.listItems()).items;
  assert.deepStrictEqual(after.map((i) => i.data.ct), before, 'item ciphertext untouched');
  assert.strictEqual((await VC.decryptJson(itemKey, after[0].data)).text, 'do not lose me');
});

test('local: forgot password → recovery code reset, no data lost', async () => {
  const backend = new LocalBackend(new MemoryAdapter());
  const reg = await registerLocal(backend, 'forgetful', PASSWORD);
  const itemKey = await VC.importAesKey(reg.vaultKeyBytes);

  await backend.createItem({
    type: 'password',
    title: await VC.encryptJson(itemKey, 'Critical'),
    data: await VC.encryptJson(itemKey, { username: 'a', password: 'b' })
  });

  await backend.logout(); // forgot password, logged out

  // wrong recovery code fails
  const salts = await backend.getSalt('forgetful');
  const wrong = await VC.deriveRecoveryMaterial(VC.generateRecoveryCode(), salts.recoverySalt);
  await assert.rejects(
    () => backend.recoveryLogin({ username: 'forgetful', recoveryAuthKey: wrong.recoveryAuthKey }),
    (e) => e.status === 401
  );

  // right recovery code unwraps the vault key and mints a session
  const rec = await VC.deriveRecoveryMaterial(reg.recoveryCode, salts.recoverySalt);
  const rl = await backend.recoveryLogin({ username: 'forgetful', recoveryAuthKey: rec.recoveryAuthKey });
  const vk = await VC.decryptBytes(rec.recoveryKey, rl.recovery.envelope);
  assert.deepStrictEqual(vk, reg.vaultKeyBytes);

  // set a new master password
  const resetSalt = VC.randomSaltB64();
  const resetMaterial = await VC.deriveAuthMaterial(RESET_PASSWORD, resetSalt);
  await backend.updateAuth({
    salt: resetSalt,
    authKey: resetMaterial.authKey,
    vault: await VC.encryptBytes(resetMaterial.masterKey, vk)
  });

  // login with the new password; data intact
  const finalSalts = (await backend.getSalt('forgetful')).salt;
  const finalMaterial = await VC.deriveAuthMaterial(RESET_PASSWORD, finalSalts);
  const login = await backend.login({ username: 'forgetful', authKey: finalMaterial.authKey });
  const items = (await backend.listItems()).items;
  assert.strictEqual(items.length, 1);
  const plain = await VC.decryptJson(itemKey, items[0].data);
  assert.strictEqual(plain.password, 'b');

  // wipe requires the master password
  await assert.rejects(
    () => backend.wipeItems('not-the-auth-key'),
    (e) => e.status === 401
  );
  await backend.wipeItems(finalMaterial.authKey);
  assert.strictEqual((await backend.listItems()).items.length, 0);
});
