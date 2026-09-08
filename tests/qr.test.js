'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const { qrMatrix, qrAscii, pickVersion, MAX_INPUT } = require('../server/lib/qr');

test('qr: rejects empty and too-long input', () => {
  assert.throws(() => qrMatrix(''));
  assert.throws(() => qrMatrix('x'.repeat(MAX_INPUT + 1)));
  assert.throws(() => qrMatrix(null));
});

test('qr: picks the smallest version that fits', () => {
  assert.equal(pickVersion('HELLO'), 1);
  assert.equal(pickVersion('https://192.168.1.42:53117'), 2);
  assert.equal(pickVersion('A'.repeat(106)), 5);
});

test('qr: matrix sizes, finder patterns and dark module', () => {
  const cases = [
    ['HELLO', 21],
    ['https://192.168.1.42:53117', 25],
    ['A'.repeat(78), 33],
    ['B'.repeat(106), 37]
  ];
  for (const [text, size] of cases) {
    const m = qrMatrix(text);
    assert.equal(m.length, size, `${text} size`);
    for (const row of m) {
      assert.equal(row.length, size);
      for (const v of row) assert.ok(v === true || v === false, 'modules are booleans');
    }
    // Three finder patterns (7×7) in the corners.
    for (const [r0, c0] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
      assert.equal(m[r0][c0], true, 'finder outer dark');
      assert.equal(m[r0 + 3][c0 + 3], true, 'finder center dark');
      assert.equal(m[r0 + 1][c0 + 1], false, 'finder ring light');
    }
    // The permanently dark module.
    assert.equal(m[size - 8][8], true);
  }
});

test('qr: golden matrices (decoder-verified with OpenCV)', () => {
  // These exact matrices were decoded successfully by cv2.QRCodeDetector.
  const goldens = [
    ['https://192.168.1.42:53117', '67f57136cc34f8992005b996345fa744aaca18fd5b9aee34cb1159e9020a6af7'],
    ['http://10.0.0.5:3000', 'db38c748b08ad8ee0b6e991fdbb949b0f218bfe7ef90d7957d7b8f2dba3e1630'],
    ['HELLO', 'e6f5b7b9432adf3f1376f85204fdcc95d76dd53ab25adf2046027348ebecc82b'],
    ['A'.repeat(106), '87ef0a674de5f3a008f8e7e94f3a0b3b664e06a7b994595008e5dbf16a1db262']
  ];
  for (const [text, hash] of goldens) {
    const digest = crypto.createHash('sha256').update(JSON.stringify(qrMatrix(text))).digest('hex');
    assert.equal(digest, hash, `matrix changed for ${JSON.stringify(text)}`);
  }
});

test('qr: ascii rendering has a quiet zone and stable width', () => {
  const lines = qrAscii('HELLO');
  assert.equal(lines.length, 21 + 8); // 4-module quiet zone on each side
  const width = lines[0].length;
  assert.ok(lines.every((line) => line.length === width));
  assert.equal(lines[0].trim().length, 0);
  assert.ok(lines[4].includes('██'));
});
