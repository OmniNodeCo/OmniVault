#!/usr/bin/env node
'use strict';

const config = require('./lib/config');
const { createApp, VERSION } = require('./lib/app');
const { lanIPv4s, randomFreePort, ensureSelfSignedCert } = require('./lib/network');
const { qrAscii } = require('./lib/qr');

const lanMode = process.argv.includes('--lan') || process.env.OMNIVAULT_LAN === '1';

async function main() {
  let effective = config;

  if (lanMode) {
    // A fresh random port every run (unless PORT is set explicitly) so the
    // share never collides with something already running.
    const port = process.env.PORT ? config.port : await randomFreePort();
    const ips = lanIPv4s();
    let host = config.host;

    if (!ips.length) {
      console.log('');
      console.log('  ! No WiFi / LAN network detected.');
      console.log('    Connect this computer to a WiFi network first — that is what lets');
      console.log('    other devices reach the vault. Starting anyway, localhost only.');
      host = '127.0.0.1';
    }

    // Phones need HTTPS for the browser crypto APIs (WebCrypto refuses plain
    // http:// everywhere except localhost) → provision a local self-signed
    // certificate unless real TLS was configured.
    let tlsCert = config.tlsCert;
    let tlsKey = config.tlsKey;
    if (!tlsCert && ips.length) {
      const cert = ensureSelfSignedCert(config.dataDir, { ips });
      if (cert) {
        tlsCert = cert.cert;
        tlsKey = cert.key;
      } else {
        console.log('  ! openssl not found — serving plain HTTP. The desktop (localhost)');
        console.log('    still works, but phone browsers cannot use the vault over plain');
        console.log('    http://. Install openssl or set OMNIVAULT_TLS_CERT / OMNIVAULT_TLS_KEY.');
      }
    }

    effective = Object.assign({}, config, { port, host, tlsCert, tlsKey });
  }

  const server = createApp(effective);

  server.listen(effective.port, effective.host, () => {
    const scheme = server.isTls ? 'https' : 'http';

    if (!lanMode) {
      console.log(`[omnivault] v${VERSION} listening on ${scheme}://${effective.host}:${effective.port}`);
      console.log(`[omnivault] data directory: ${effective.dataDir}`);
      if (!server.isTls) {
        console.log('[omnivault] note: serving over plain HTTP. Web Crypto (client-side encryption) and');
        console.log('[omnivault] PWA install require a secure context — use localhost, HTTPS, or set');
        console.log('[omnivault] OMNIVAULT_TLS_CERT / OMNIVAULT_TLS_KEY.');
      }
      return;
    }

    const ips = lanIPv4s();
    const primary = ips[0];
    console.log('');
    console.log(`  OmniVault v${VERSION} — WiFi share mode`);
    console.log('');
    console.log(`  On this computer:  ${scheme}://localhost:${effective.port}`);
    if (primary) {
      console.log(`  On your WiFi:      ${scheme}://${primary}:${effective.port}`);
      console.log('');
      console.log('  Scan this with any device on the same WiFi network:');
      console.log('');
      for (const line of qrAscii(`${scheme}://${primary}:${effective.port}`)) {
        console.log('  ' + line);
      }
      console.log('');
      if (server.isTls && !config.tlsCert) {
        console.log('  First visit on a new device: the certificate is self-signed (generated');
        console.log('  locally on this machine) — the browser will warn once; choose');
        console.log('  Advanced → Proceed anyway. That is expected and safe on your own LAN.');
        console.log('');
      }
    }
    console.log(`  Data directory: ${effective.dataDir}`);
    console.log('  Press Ctrl+C to stop sharing.');
    console.log('');
  });

  function shutdown(signal) {
    console.log(`[omnivault] received ${signal}, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[omnivault] failed to start:', err && err.message ? err.message : err);
  process.exit(1);
});
