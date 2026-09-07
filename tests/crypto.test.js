'use strict';

const test = require('node:test');
const assert = require('node:assert');
const nodeCrypto = require('node:crypto');

// Loads the exact browser crypto module (WebCrypto is global in Node 18+).
const VC = require('../public/js/crypto.js');

test('pbkdf2 matches known RFC vectors', async () => {
  const enc = new TextEncoder();
  const one = await VC.pbkdf2('password', enc.encode('salt'), 1, 256);
  assert.strictEqual(
    Buffer.from(one).toString('hex'),
    '120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b'
  );
  const two = await VC.pbkdf2('password', enc.encode('salt'), 2, 256);
  assert.strictEqual(
    Buffer.from(two).toString('hex'),
    'ae4d0c95af6b46d32d0adff928f06dd02a303f8ef3c251dfd6e2d85a95474c43'
  );
});

test('pbkdf2 agrees with node:crypto on random inputs', async () => {
  for (let i = 0; i < 3; i++) {
    const password = nodeCrypto.randomBytes(12).toString('hex');
    const salt = new Uint8Array(nodeCrypto.randomBytes(16));
    const expected = nodeCrypto.pbkdf2Sync(Buffer.from(password), Buffer.from(salt), 1000, 32, 'sha256');
    const got = await VC.pbkdf2(password, salt, 1000, 256);
    assert.deepStrictEqual(Buffer.from(got), expected);
  }
});

test('deriveAuthMaterial is deterministic and separates keys', async () => {
  const salt = VC.randomSaltB64();
  const a = await VC.deriveAuthMaterial('hunter2 but longer', salt);
  const b = await VC.deriveAuthMaterial('hunter2 but longer', salt);
  assert.strictEqual(VC.bytesToB64(a.masterBits), VC.bytesToB64(b.masterBits));
  assert.strictEqual(a.authKey, b.authKey);

  // authKey must not reveal masterBits and must differ from it
  assert.notStrictEqual(a.authKey, VC.bytesToB64(a.masterBits));

  // different salt -> different material
  const c = await VC.deriveAuthMaterial('hunter2 but longer', VC.randomSaltB64());
  assert.notStrictEqual(VC.bytesToB64(a.masterBits), VC.bytesToB64(c.masterBits));
  assert.notStrictEqual(a.authKey, c.authKey);

  // master key usable for AES-GCM round trip
  const env = await VC.encryptJson(a.masterKey, { hello: 'world' });
  assert.deepStrictEqual(await VC.decryptJson(a.masterKey, env), { hello: 'world' });

  // wrong key fails authentication (GCM tag)
  const other = await VC.deriveAuthMaterial('wrong password', salt);
  await assert.rejects(() => VC.decryptJson(other.masterKey, env));
});

test('envelopes: roundtrip, tamper detection, unique IVs', async () => {
  const { masterKey } = await VC.deriveAuthMaterial('pw', VC.randomSaltB64());
  const secret = { deep: { list: [1, 2, 3] }, n: null, s: 'é✓😀' };
  const env = await VC.encryptJson(masterKey, secret);
  assert.strictEqual(env.v, 1);
  assert.deepStrictEqual(await VC.decryptJson(masterKey, env), secret);

  const env2 = await VC.encryptJson(masterKey, secret);
  assert.notStrictEqual(env.iv, env2.iv, 'IVs must be unique per encryption');
  assert.notStrictEqual(env.ct, env2.ct);

  // tamper with ciphertext -> tag failure
  const bytes = VC.b64ToBytes(env.ct);
  bytes[0] ^= 0xff;
  await assert.rejects(() => VC.decryptJson(masterKey, { iv: env.iv, ct: VC.bytesToB64(bytes) }));

  // tamper with IV -> tag failure
  await assert.rejects(() =>
    VC.decryptJson(masterKey, { iv: VC.bytesToB64(VC.b64ToBytes(env.iv).map((b) => b ^ 1)), ct: env.ct })
  );
});

test('base64 helpers roundtrip arbitrary bytes', () => {
  for (let i = 0; i < 20; i++) {
    const bytes = new Uint8Array(nodeCrypto.randomBytes(1 + Math.floor(Math.random() * 200)));
    const b64 = VC.bytesToB64(bytes);
    assert.deepStrictEqual(VC.b64ToBytes(b64), bytes);
    const url = VC.bytesToB64url(bytes);
    assert.deepStrictEqual(VC.b64urlToBytes(url), bytes);
  }
});

test('password generator: length, charset guarantees, no obvious bias', () => {
  const pw = VC.generatePassword({ length: 24 });
  assert.strictEqual(pw.length, 24);
  assert.match(pw, /[a-z]/);
  assert.match(pw, /[A-Z]/);
  assert.match(pw, /[0-9]/);
  assert.match(pw, /[^a-zA-Z0-9]/);

  const digitsOnly = VC.generatePassword({ length: 12, lower: false, upper: false, symbols: false });
  assert.match(digitsOnly, /^[0-9]{12}$/);

  const noSymbols = VC.generatePassword({ length: 16, symbols: false });
  assert.strictEqual(noSymbols.replace(/[^a-zA-Z0-9]/g, '').length, 16);

  // rough balance check over many draws
  const counts = {};
  const N = 4000;
  for (let i = 0; i < N; i++) {
    const c = VC.generatePassword({ length: 1, lower: true, upper: false, digits: false, symbols: false });
    counts[c] = (counts[c] || 0) + 1;
  }
  const letters = 'abcdefghijklmnopqrstuvwxyz'.split('');
  for (const letter of letters) {
    assert.ok(counts[letter] > N / letters.length * 0.5, `letter ${letter} underrepresented: ${counts[letter]}`);
  }
});

test('TOTP: RFC 6238 SHA-1 test vectors (8 digits)', async () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // base32 of RFC secret
  const vectors = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130']
  ];
  for (const [t, expected] of vectors) {
    const code = await VC.totp(secret, { t: t * 1000, digits: 8 });
    assert.strictEqual(code, expected, `T=${t}`);
  }
});

test('TOTP: 6-digit mode, base32 cleanup, invalid secrets', async () => {
  const code = await VC.totp('gezd gnbv gy3t qojq gezd gnbv gy3t qojq=', { t: 59_000, digits: 6 });
  assert.strictEqual(code.length, 6);
  assert.match(code, /^[0-9]{6}$/);

  await assert.rejects(() => VC.totp('not!base32!!', { t: 0 }));
  await assert.rejects(() => VC.totp('', { t: 0 }));
});

test('parseOtpauth extracts secret, digits and period', () => {
  const parsed = VC.parseOtpauth('otpauth://totp/Acme:alice?secret=JBSWY3DPEHPK3PXP&digits=8&period=60');
  assert.deepStrictEqual(parsed, { secret: 'JBSWY3DPEHPK3PXP', digits: 8, period: 60 });
  assert.strictEqual(VC.parseOtpauth('https://example.com'), null);
  assert.strictEqual(VC.parseOtpauth('otpauth://totp/x'), null);
});

test('passwordStrength is sane', () => {
  assert.strictEqual(VC.passwordStrength(''), 0);
  assert.ok(VC.passwordStrength('a') <= 1, 'single char should be near-zero');
  assert.ok(VC.passwordStrength('correct horse battery staple') >= 3);
  assert.ok(VC.passwordStrength('Tr0ub4dor&3xxxxxxxxxxxx!') >= 3);
  assert.ok(VC.passwordStrength('aaaaaaaaaaaa') < VC.passwordStrength('aB3$xY9$kL2#mN8@'));
});

test('randomInt stays in range and covers the domain', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const n = VC.randomInt(10);
    assert.ok(n >= 0 && n < 10);
    seen.add(n);
  }
  assert.strictEqual(seen.size, 10);
});
