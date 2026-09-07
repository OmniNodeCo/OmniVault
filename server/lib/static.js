'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

const NO_CACHE = new Set(['/', '/index.html', '/sw.js', '/manifest.webmanifest', '/offline.html']);

function send404(res) {
  const body = '<!doctype html><meta charset="utf-8"><title>404</title>' +
    '<body style="font-family:system-ui;background:#0b1020;color:#e2e8f0;display:grid;place-items:center;height:100vh;margin:0">' +
    '<div style="text-align:center"><h1>404</h1><p>That page is not in the vault.</p></div>';
  res.writeHead(404, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(res.req && res.req.method === 'HEAD' ? undefined : body);
}

function statSafe(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function serveStatic(publicDir, pathname, res) {
  const root = path.resolve(publicDir);
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return send404(res);
  }
  if (rel.includes('\0')) return send404(res);
  if (rel.endsWith('/')) rel += 'index.html';

  let file = path.resolve(root, '.' + path.posix.normalize('/' + rel));
  if (file !== root && !file.startsWith(root + path.sep)) return send404(res);

  let stats = statSafe(file);
  if (stats && stats.isDirectory()) {
    file = path.join(file, 'index.html');
    stats = statSafe(file);
  }
  if (!stats || !stats.isFile()) return send404(res);

  const ext = path.extname(file).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  const cacheControl = NO_CACHE.has(pathname)
    ? 'no-cache'
    : 'public, max-age=3600';

  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': stats.size,
    'Cache-Control': cacheControl
  });
  if (res.req && res.req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(file).pipe(res);
}

module.exports = { serveStatic, send404, MIME };
