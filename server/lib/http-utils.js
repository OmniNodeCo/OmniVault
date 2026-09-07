'use strict';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function isHead(res) {
  return Boolean(res && res.req && res.req.method === 'HEAD');
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(isHead(res) ? undefined : body);
}

/**
 * Read the request body with a hard size limit.
 * Rejections leave the response writable; Node closes the socket afterwards
 * because the body was not fully consumed.
 */
function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || '0');
    if (Number.isFinite(declared) && declared > limitBytes) {
      reject(new HttpError(413, 'Request body too large'));
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    const fail = (err) => {
      if (done) return;
      done = true;
      chunks.length = 0;
      req.removeAllListeners('data');
      req.removeAllListeners('end');
      req.removeAllListeners('error');
      reject(err);
    };
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limitBytes) {
        fail(new HttpError(413, 'Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => fail(err));
  });
}

async function readJson(req, limitBytes) {
  const buf = await readBody(req, limitBytes);
  if (!buf.length) throw new HttpError(400, 'JSON request body required');
  try {
    const parsed = JSON.parse(buf.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TypeError('not an object');
    }
    return parsed;
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

module.exports = { HttpError, sendJson, readBody, readJson };
