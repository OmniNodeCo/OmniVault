#!/usr/bin/env node
'use strict';

const config = require('./lib/config');
const { createApp } = require('./lib/app');

const server = createApp(config);

server.listen(config.port, config.host, () => {
  const scheme = server.isTls ? 'https' : 'http';
  console.log(`[omnivault] v${require('./lib/app').VERSION} listening on ${scheme}://${config.host}:${config.port}`);
  console.log(`[omnivault] data directory: ${config.dataDir}`);
  if (!server.isTls) {
    console.log('[omnivault] note: serving over plain HTTP. Web Crypto (client-side encryption) and');
    console.log('[omnivault] PWA install require a secure context — use localhost, HTTPS, or set');
    console.log('[omnivault] OMNIVAULT_TLS_CERT / OMNIVAULT_TLS_KEY.');
  }
});

function shutdown(signal) {
  console.log(`[omnivault] received ${signal}, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
