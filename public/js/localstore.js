/**
 * OmniVault local backend — 100% local mode.
 *
 * Implements the exact same API surface as the server backend, but keeps
 * everything in the browser: users and (already client-encrypted) items are
 * stored in IndexedDB, auth is verified against a local PBKDF2 verifier.
 * No network calls are ever made.
 *
 * Pluggable adapters:
 *   - IdbAdapter   (browser, IndexedDB — durable, supports MB-sized images)
 *   - MemoryAdapter (tests / Node)
 *
 * The records stored here are the same zero-knowledge shapes the server
 * keeps: KDF salts, verifiers, wrapped vault-key envelopes and AES-GCM
 * item envelopes. Nothing is ever stored in plaintext.
 */
(function (global) {
  'use strict';

  const VC = global.VaultCrypto;

  function err(status, message) {
    const e = new Error(message);
    e.status = status;
    return e;
  }

  const ITEM_TYPES = { password: 1, note: 1, image: 1 };

  // ============================================================== adapters
  // Interface: get(store, key) → value | undefined
  //            put(store, key, value)
  //            del(store, key)
  //            list(store) → [value, …]

  function MemoryAdapter() {
    this.maps = new Map();
  }
  MemoryAdapter.prototype._map = function (store) {
    if (!this.maps.has(store)) this.maps.set(store, new Map());
    return this.maps.get(store);
  };
  MemoryAdapter.prototype.get = function (store, key) {
    return Promise.resolve(this._map(store).get(key));
  };
  MemoryAdapter.prototype.put = function (store, key, value) {
    this._map(store).set(key, value);
    return Promise.resolve();
  };
  MemoryAdapter.prototype.del = function (store, key) {
    this._map(store).delete(key);
    return Promise.resolve();
  };
  MemoryAdapter.prototype.list = function (store) {
    return Promise.resolve(Array.from(this._map(store).values()));
  };

  function IdbAdapter(dbName) {
    this.dbName = dbName || 'omnivault-local';
    this.stores = ['users', 'items'];
    this._openPromise = null;
  }
  IdbAdapter.prototype._open = function () {
    if (this._openPromise) return this._openPromise;
    if (typeof indexedDB === 'undefined') {
      this._openPromise = Promise.reject(err(0, 'IndexedDB is not available in this browser'));
      return this._openPromise;
    }
    const self = this;
    this._openPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(self.dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const s of self.stores) {
          if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || err(0, 'Could not open the local vault database'));
    });
    return this._openPromise;
  };
  IdbAdapter.prototype._run = function (store, mode, op) {
    return this._open().then(
      (db) =>
        new Promise((resolve, reject) => {
          let request;
          const tx = db.transaction(store, mode);
          const os = tx.objectStore(store);
          try {
            request = op(os);
          } catch (e) {
            reject(e);
            return;
          }
          tx.oncomplete = () => resolve(request);
          tx.onerror = () => reject(tx.error || err(0, 'Local storage error'));
          tx.onabort = () => reject(tx.error || err(0, 'Local storage aborted'));
        })
    );
  };
  IdbAdapter.prototype.get = function (store, key) {
    return this._run(store, 'readonly', (os) => os.get(key)).then((req) =>
      req && req.result ? req.result.value : undefined
    );
  };
  IdbAdapter.prototype.put = function (store, key, value) {
    return this._run(store, 'readwrite', (os) => os.put({ key, value }));
  };
  IdbAdapter.prototype.del = function (store, key) {
    return this._run(store, 'readwrite', (os) => os.delete(key));
  };
  IdbAdapter.prototype.list = function (store) {
    return this._run(store, 'readonly', (os) => os.getAll()).then((req) =>
      (req.result || []).map((r) => r.value)
    );
  };

  // ================================================================ backend

  function LocalBackend(adapter) {
    this.adapter = adapter || new MemoryAdapter();
    this.mode = 'local';
    this._mem = {}; // kv fallback when localStorage is unavailable (Node tests)
  }

  LocalBackend.prototype._kv = function (key, value) {
    try {
      if (arguments.length === 1) return localStorage.getItem(key);
      if (value === null || value === undefined) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
      return null;
    } catch (e) {
      /* private mode / Node */
    }
    if (arguments.length === 1) return Object.prototype.hasOwnProperty.call(this._mem, key) ? this._mem[key] : null;
    if (value === null || value === undefined) delete this._mem[key];
    else this._mem[key] = value;
    return null;
  };

  LocalBackend.prototype._secret = function () {
    let s = this._kv('ov_local_secret');
    if (!s) {
      s = VC.bytesToB64url(global.crypto.getRandomValues(new Uint8Array(32)));
      this._kv('ov_local_secret', s);
    }
    return s;
  };

  /** Deterministic decoy salt so unknown usernames are indistinguishable. */
  LocalBackend.prototype._fakeSalt = async function (username, kind) {
    const input = new TextEncoder().encode(`${kind}:${this._secret()}:${String(username).toLowerCase()}`);
    const digest = new Uint8Array(await global.crypto.subtle.digest('SHA-256', input));
    return VC.bytesToB64(digest.subarray(0, 16));
  };

  LocalBackend.prototype._key = function (username) {
    return String(username || '').trim().toLowerCase();
  };

  LocalBackend.prototype._getUser = async function (username) {
    const key = this._key(username);
    if (!key) return null;
    return (await this.adapter.get('users', key)) || null;
  };

  LocalBackend.prototype._publicUser = function (record) {
    return {
      username: record.username,
      salt: record.salt,
      vault: record.vault || null,
      recoverySalt: record.recovery ? record.recovery.salt : null,
      createdAt: record.createdAt
    };
  };

  LocalBackend.prototype._currentKey = function () {
    return this._kv('ov_local_user');
  };

  LocalBackend.prototype._requireCurrent = async function () {
    const key = this._currentKey();
    if (!key) throw err(401, 'Authentication required');
    const record = (await this.adapter.get('users', key)) || null;
    if (!record) throw err(401, 'Authentication required');
    return record;
  };

  function _checkEnvelope(env, name) {
    if (!env || typeof env !== 'object' || typeof env.iv !== 'string' || typeof env.ct !== 'string') {
      throw err(400, `Encrypted field "${name}" is required`);
    }
  }

  function _checkItem(body) {
    if (!body || !ITEM_TYPES[body.type]) throw err(400, 'type must be one of: password, note, image');
    _checkEnvelope(body.title, 'title');
    _checkEnvelope(body.data, 'data');
    return {
      type: body.type,
      title: { v: 1, iv: body.title.iv, ct: body.title.ct },
      data: { v: 1, iv: body.data.iv, ct: body.data.ct }
    };
  }

  function _newId() {
    return VC.bytesToB64url(global.crypto.getRandomValues(new Uint8Array(9)));
  }

  // ------------------------------------------------------------------ auth

  LocalBackend.prototype.getSalt = async function (username) {
    const record = await this._getUser(username);
    if (!record) {
      return {
        salt: await this._fakeSalt(username, 'fake-salt'),
        recoverySalt: await this._fakeSalt(username, 'fake-recovery-salt')
      };
    }
    return {
      salt: record.salt,
      recoverySalt: record.recovery ? record.recovery.salt : await this._fakeSalt(username, 'fake-recovery-salt')
    };
  };

  LocalBackend.prototype.register = async function (body) {
    const key = this._key(body && body.username);
    if (!key) throw err(400, 'username is required');
    if (await this.adapter.get('users', key)) throw err(409, 'That username is already taken');
    if (typeof body.salt !== 'string' || typeof body.authKey !== 'string') {
      throw err(400, 'salt and authKey are required');
    }
    if (body.vault) _checkEnvelope(body.vault, 'vault');
    let recovery = null;
    if (body.recovery) {
      if (typeof body.recovery.salt !== 'string' || typeof body.recovery.authKey !== 'string') {
        throw err(400, 'recovery.salt and recovery.authKey are required');
      }
      _checkEnvelope(body.recovery.envelope, 'recovery.envelope');
      const verifierSalt = VC.randomSaltB64();
      recovery = {
        salt: body.recovery.salt,
        verifierSalt,
        verifier: await VC.hashForVerifier(body.recovery.authKey, verifierSalt),
        envelope: { v: 1, iv: body.recovery.envelope.iv, ct: body.recovery.envelope.ct }
      };
    }
    const verifierSalt = VC.randomSaltB64();
    const record = {
      username: String(body.username).trim(),
      salt: body.salt,
      vault: body.vault ? { v: 1, iv: body.vault.iv, ct: body.vault.ct } : null,
      recovery,
      verifierSalt,
      verifier: await VC.hashForVerifier(body.authKey, verifierSalt),
      createdAt: new Date().toISOString()
    };
    await this.adapter.put('users', key, record);
    this._kv('ov_local_user', key);
    return { token: 'local', user: this._publicUser(record) };
  };

  LocalBackend.prototype.login = async function (body) {
    const record = await this._getUser(body && body.username);
    let ok = false;
    if (record && typeof body.authKey === 'string') {
      const candidate = await VC.hashForVerifier(body.authKey, record.verifierSalt);
      ok = candidate === record.verifier;
    }
    if (!ok) throw err(401, 'Invalid username or master password');
    this._kv('ov_local_user', this._key(body.username));
    return { token: 'local', user: this._publicUser(record) };
  };

  LocalBackend.prototype.verify = async function (authKey) {
    const record = await this._requireCurrent();
    const candidate = await VC.hashForVerifier(String(authKey || ''), record.verifierSalt);
    if (candidate !== record.verifier) throw err(401, 'Master password is incorrect');
    return { ok: true };
  };

  LocalBackend.prototype.recoveryLogin = async function (body) {
    const record = await this._getUser(body && body.username);
    let ok = false;
    if (record && record.recovery && typeof body.recoveryAuthKey === 'string') {
      const candidate = await VC.hashForVerifier(body.recoveryAuthKey, record.recovery.verifierSalt);
      ok = candidate === record.recovery.verifier;
    }
    if (!ok) throw err(401, 'Invalid username or recovery code');
    this._kv('ov_local_user', this._key(body.username));
    return {
      token: 'local',
      user: this._publicUser(record),
      recovery: { envelope: record.recovery.envelope }
    };
  };

  LocalBackend.prototype.updateAuth = async function (body) {
    const record = await this._requireCurrent();
    if (body.salt !== undefined && body.authKey !== undefined) {
      if (typeof body.salt !== 'string' || typeof body.authKey !== 'string') {
        throw err(400, 'salt and authKey must be strings');
      }
      const verifierSalt = VC.randomSaltB64();
      record.salt = body.salt;
      record.verifierSalt = verifierSalt;
      record.verifier = await VC.hashForVerifier(body.authKey, verifierSalt);
    }
    if (body.vault !== undefined) {
      if (body.vault === null) record.vault = null;
      else {
        _checkEnvelope(body.vault, 'vault');
        record.vault = { v: 1, iv: body.vault.iv, ct: body.vault.ct };
      }
    }
    if (body.recovery !== undefined) {
      if (body.recovery === null) record.recovery = null;
      else {
        if (typeof body.recovery.salt !== 'string' || typeof body.recovery.authKey !== 'string') {
          throw err(400, 'recovery.salt and recovery.authKey are required');
        }
        _checkEnvelope(body.recovery.envelope, 'recovery.envelope');
        const verifierSalt = VC.randomSaltB64();
        record.recovery = {
          salt: body.recovery.salt,
          verifierSalt,
          verifier: await VC.hashForVerifier(body.recovery.authKey, verifierSalt),
          envelope: { v: 1, iv: body.recovery.envelope.iv, ct: body.recovery.envelope.ct }
        };
      }
    }
    await this.adapter.put('users', this._key(record.username), record);
    return { ok: true };
  };

  LocalBackend.prototype.logout = async function () {
    this._kv('ov_local_user', null);
    return { ok: true };
  };

  LocalBackend.prototype.me = async function () {
    const record = await this._requireCurrent();
    return { user: this._publicUser(record) };
  };

  // ----------------------------------------------------------------- items

  LocalBackend.prototype.listItems = async function () {
    const key = this._currentKey();
    if (!key) throw err(401, 'Authentication required');
    const all = await this.adapter.list('items');
    return {
      items: all
        .filter((i) => i.userId === key)
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
        .map((i) => ({
          id: i.id,
          type: i.type,
          title: i.title,
          data: i.data,
          createdAt: i.createdAt,
          updatedAt: i.updatedAt
        }))
    };
  };

  LocalBackend.prototype.createItem = async function (body) {
    await this._requireCurrent();
    const payload = _checkItem(body);
    const now = new Date().toISOString();
    const record = {
      id: _newId(),
      userId: this._currentKey(),
      type: payload.type,
      title: payload.title,
      data: payload.data,
      createdAt: now,
      updatedAt: now
    };
    await this.adapter.put('items', record.id, record);
    return { item: Object.assign({}, record) };
  };

  LocalBackend.prototype.updateItem = async function (id, body) {
    const key = this._currentKey();
    if (!key) throw err(401, 'Authentication required');
    const record = await this.adapter.get('items', String(id));
    if (!record || record.userId !== key) throw err(404, 'Item not found');
    const payload = _checkItem(body);
    record.type = payload.type;
    record.title = payload.title;
    record.data = payload.data;
    record.updatedAt = new Date().toISOString();
    await this.adapter.put('items', record.id, record);
    return { item: Object.assign({}, record) };
  };

  LocalBackend.prototype.deleteItem = async function (id) {
    const key = this._currentKey();
    if (!key) throw err(401, 'Authentication required');
    const record = await this.adapter.get('items', String(id));
    if (!record || record.userId !== key) throw err(404, 'Item not found');
    await this.adapter.del('items', record.id);
    return { ok: true };
  };

  LocalBackend.prototype.replaceItems = async function (items) {
    const key = this._currentKey();
    if (!key) throw err(401, 'Authentication required');
    if (!Array.isArray(items)) throw err(400, 'items must be an array');
    const all = await this.adapter.list('items');
    for (const record of all) {
      if (record.userId === key) await this.adapter.del('items', record.id);
    }
    const now = new Date().toISOString();
    const out = [];
    for (const raw of items) {
      const payload = _checkItem(raw);
      const id = typeof raw.id === 'string' && /^[A-Za-z0-9_-]{6,32}$/.test(raw.id) ? raw.id : _newId();
      const record = {
        id,
        userId: key,
        type: payload.type,
        title: payload.title,
        data: payload.data,
        createdAt: raw.createdAt && typeof raw.createdAt === 'string' ? raw.createdAt : now,
        updatedAt: now
      };
      await this.adapter.put('items', record.id, record);
      out.push(Object.assign({}, record));
    }
    return { items: out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)) };
  };

  LocalBackend.prototype.wipeItems = async function (authKey) {
    const record = await this._requireCurrent();
    const candidate = await VC.hashForVerifier(String(authKey || ''), record.verifierSalt);
    if (candidate !== record.verifier) throw err(401, 'Master password is incorrect');
    const key = this._currentKey();
    const all = await this.adapter.list('items');
    for (const item of all) {
      if (item.userId === key) await this.adapter.del('items', item.id);
    }
    return { ok: true };
  };

  global.VaultLocal = { IdbAdapter, MemoryAdapter, LocalBackend };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.VaultLocal;
  }
})(typeof window !== 'undefined' ? window : globalThis);
