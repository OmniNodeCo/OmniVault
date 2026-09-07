'use strict';

const http = require('node:https');
const plainHttp = require('node:http');
const fs = require('node:fs');

const { createDb } = require('./db');
const { handleApi } = require('./api');
const { serveStatic } = require('./static');
const { HttpError, sendJson } = require('./http-utils');

const VERSION = require('../../package.json').version;

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' blob: data:",
      "connect-src 'self'",
      "font-src 'self'",
      "manifest-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'"
    ].join('; ')
  );
}

function clientIp(req) {
  return req.socket.remoteAddress || '-';
}

/**
 * Build the OmniVault HTTP(S) server. Returns a Node server with a `db`
 * property attached — used by the test-suite and by server.js.
 */
function createApp(config) {
  const db = createDb(config.dataDir, {
    scrypt: config.scrypt,
    maxDataB64: Math.floor(config.maxBodyBytes * 1.4),
    maxItems: config.maxItems
  });

  const handler = async (req, res) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      if (process.env.OMNIVAULT_QUIET !== '1') {
        console.log(`${new Date().toISOString()} ${clientIp(req)} "${req.method} ${req.url}" ${res.statusCode} ${ms.toFixed(1)}ms`);
      }
    });

    setSecurityHeaders(res);

    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      sendJson(res, 400, { error: 'Bad request' });
      return;
    }

    try {
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url, config, db);
      } else {
        serveStatic(config.publicDir, url.pathname, res);
      }
    } catch (err) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message });
      } else {
        console.error('[omnivault] unhandled error:', err);
        sendJson(res, 500, { error: 'Internal server error' });
      }
    }
  };

  let server;
  if (config.tlsCert && config.tlsKey) {
    server = http.createServer(
      {
        cert: fs.readFileSync(config.tlsCert),
        key: fs.readFileSync(config.tlsKey)
      },
      handler
    );
  } else {
    server = plainHttp.createServer(handler);
  }

  server.db = db;
  server.isTls = Boolean(config.tlsCert && config.tlsKey);

  const sweeper = setInterval(() => {
    try {
      db.cleanupSessions();
    } catch {
      /* ignore */
    }
  }, 30 * 60 * 1000);
  sweeper.unref();

  return server;
}

module.exports = { createApp, VERSION };
