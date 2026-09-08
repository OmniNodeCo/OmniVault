'use strict';

const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');

const { lanIPv4s, randomFreePort, isPrivateIPv4, ensureSelfSignedCert } = require('../server/lib/network');

test('network: randomFreePort returns a free, bindable port', async () => {
  const port = await randomFreePort();
  assert.ok(Number.isInteger(port));
  assert.ok(port > 1023 && port < 65536, `port ${port} outside ephemeral range`);
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => probe.close(resolve));
  });
});

test('network: two calls usually differ (randomised port)', async () => {
  const seen = new Set();
  for (let i = 0; i < 5; i++) seen.add(await randomFreePort());
  assert.ok(seen.size > 1, `expected variety, got ${[...seen].join(',')}`);
});

test('network: lanIPv4s only lists IPv4-shaped addresses', () => {
  for (const ip of lanIPv4s()) assert.match(ip, /^\d{1,3}(\.\d{1,3}){3}$/);
});

test('network: private-range classification', () => {
  assert.ok(isPrivateIPv4('192.168.1.5'));
  assert.ok(isPrivateIPv4('10.1.2.3'));
  assert.ok(isPrivateIPv4('172.16.0.1'));
  assert.ok(isPrivateIPv4('172.31.255.255'));
  assert.ok(!isPrivateIPv4('172.32.0.1'));
  assert.ok(!isPrivateIPv4('8.8.8.8'));
  assert.ok(!isPrivateIPv4('example.com'));
});

test('network: self-signed cert provisioning is reusable', () => {
  const dir = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'ov-cert-'));
  const fs = require('node:fs');
  const path = require('node:path');
  try {
    const first = ensureSelfSignedCert(dir, { ips: ['192.168.1.42'] });
    if (!first) return; // openssl unavailable in this environment — skip
    assert.ok(fs.existsSync(first.cert));
    assert.ok(fs.existsSync(first.key));
    // Second call must reuse the same (fresh) files instead of regenerating.
    const second = ensureSelfSignedCert(dir, { ips: ['192.168.1.42'] });
    assert.equal(second.cert, first.cert);
    assert.equal(second.key, first.key);
    // A negative cert path never collides with the key path.
    assert.notEqual(second.cert, second.key);
    assert.ok(path.basename(second.cert).endsWith('.pem'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
