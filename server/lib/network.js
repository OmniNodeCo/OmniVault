'use strict';

/**
 * LAN helpers for "WiFi share" mode: detect the machine's LAN addresses,
 * pick a free port and (optionally) provision a local self-signed
 * certificate so phones get a secure context (browser crypto APIs refuse
 * plain http:// except on localhost).
 */

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/** Private-range test (RFC1918 + link-local). */
function isPrivateIPv4(ip) {
  return (
    ip.startsWith('192.168.') ||
    ip.startsWith('10.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    ip.startsWith('169.254.')
  );
}

/** Sort rank: real LAN/WiFi ranges first, link-local last. */
function ipRank(ip) {
  if (ip.startsWith('192.168.') || ip.startsWith('10.') || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
  if (ip.startsWith('169.254.')) return 0;
  return 1;
}

/**
 * LAN/WiFi IPv4 addresses of this machine (non-internal). Private ranges
 * (typical WiFi) are listed first. Empty array = not connected to any
 * network other than loopback.
 */
function lanIPv4s() {
  const out = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      out.push(iface.address);
    }
  }
  return out.sort((a, b) => ipRank(b) - ipRank(a));
}

/** Ask the OS for a free TCP port (ephemeral range). */
function randomFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '0.0.0.0', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const CERT_NAME = 'lan-cert.pem';
const KEY_NAME = 'lan-key.pem';
const CERT_MAX_AGE_MS = 25 * 24 * 60 * 60 * 1000; // regenerate after ~25 days

function hasFreshCert(dir) {
  try {
    const stat = fs.statSync(path.join(dir, CERT_NAME));
    return Date.now() - stat.mtimeMs < CERT_MAX_AGE_MS;
  } catch {
    return false;
  }
}

/**
 * Ensure a self-signed certificate exists in `dir` (created with the
 * system `openssl`, reused while fresh). Returns { cert, key } paths or
 * null when openssl is unavailable — callers then fall back to plain HTTP.
 */
function ensureSelfSignedCert(dir, opts) {
  const options = opts || {};
  const certPath = path.join(dir, CERT_NAME);
  const keyPath = path.join(dir, KEY_NAME);
  if (hasFreshCert(dir) && fs.existsSync(keyPath)) {
    return { cert: certPath, key: keyPath };
  }
  const subjectAltNames = (options.ips || [])
    .map((ip) => (/^\d+\.\d+\.\d+\.\d+$/.test(ip) ? `IP:${ip}` : `DNS:${ip}`))
    .concat(['IP:127.0.0.1', 'DNS:localhost'])
    .join(',');
  try {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes',
        '-days', '30',
        '-subj', '/CN=OmniVault LAN',
        '-addext', `subjectAltName=${subjectAltNames}`,
        '-keyout', keyPath,
        '-out', certPath
      ],
      { stdio: 'ignore' }
    );
    return { cert: certPath, key: keyPath };
  } catch {
    return null;
  }
}

module.exports = { lanIPv4s, randomFreePort, ensureSelfSignedCert, isPrivateIPv4 };
