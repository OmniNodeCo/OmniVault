'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { createApp } = require('../server/lib/app');

/** Build a config pointing at a fresh temp data dir + the real public dir. */
function makeConfig(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnivault-test-'));
  return Object.assign(
    {
      dataDir,
      publicDir: path.join(__dirname, '..', 'public'),
      maxBodyBytes: 512 * 1024,
      sessionTtlMs: 3600 * 1000,
      scrypt: { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 128 * 1024 * 1024 },
      maxItems: 1000
    },
    overrides
  );
}

/** Start an app on an ephemeral port; returns { server, base, config, close }. */
async function startServer(overrides = {}) {
  const config = makeConfig(overrides);
  const server = createApp(config);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  return {
    server,
    base,
    config,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

async function jsonFetch(url, method = 'GET', body, token) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* not json */
  }
  return { res, data };
}

function b64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

module.exports = { makeConfig, startServer, jsonFetch, b64 };
