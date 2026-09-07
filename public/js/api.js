/**
 * OmniVault API layer.
 *
 * - VaultSession: durable browser-session helpers (token, username, wrapped
 *   vault key). The vault key lives in sessionStorage: reloads keep the vault
 *   open, closing the tab/PWA locks it.
 * - VaultApi: the server backend (fetch). The local backend with the exact
 *   same interface lives in localstore.js (VaultLocal.LocalBackend).
 */
(function (global) {
  'use strict';

  const TOKEN_KEY = 'ov_token';
  const USERNAME_KEY = 'ov_username';
  const VAULT_KEY_KEY = 'ov_vault';
  const MODE_KEY = 'ov_mode';

  function lsGet(key) {
    try {
      return localStorage.getItem(key) || '';
    } catch (e) {
      return '';
    }
  }
  function lsSet(key, value) {
    try {
      if (value) localStorage.setItem(key, value);
      else localStorage.removeItem(key);
    } catch (e) {
      /* private mode */
    }
  }
  function ssGet(key) {
    try {
      return sessionStorage.getItem(key) || '';
    } catch (e) {
      return '';
    }
  }
  function ssSet(key, value) {
    try {
      if (value) sessionStorage.setItem(key, value);
      else sessionStorage.removeItem(key);
    } catch (e) {
      /* ignore */
    }
  }

  const Session = {
    getToken: () => lsGet(TOKEN_KEY),
    setToken: (t) => lsSet(TOKEN_KEY, t),
    getUsername: () => lsGet(USERNAME_KEY),
    setUsername: (n) => lsSet(USERNAME_KEY, n),
    getStoredVaultKey: () => ssGet(VAULT_KEY_KEY),
    setStoredVaultKey: (v) => ssSet(VAULT_KEY_KEY, v),
    getMode: () => lsGet(MODE_KEY),
    setMode: (m) => lsSet(MODE_KEY, m)
  };

  function request(method, path, body) {
    const opts = { method, headers: {} };
    const token = lsGet(TOKEN_KEY);
    if (token) opts.headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    let res;
    return fetch(path, opts)
      .then((r) => {
        res = r;
        return r.json().catch(() => null);
      })
      .then((data) => {
        if (!res.ok) {
          const err = new Error((data && data.error) || `Request failed (${res.status})`);
          err.status = res.status;
          throw err;
        }
        return data;
      });
  }

  const ServerApi = {
    mode: 'server',

    health: () => request('GET', '/api/health'),
    /** → { salt, recoverySalt } (decoy-safe for unknown users) */
    getSalt: (username) => request('GET', `/api/auth/salt?username=${encodeURIComponent(username)}`),
    /** { username, salt, authKey, vault, recovery } → { token, user } */
    register: (body) => request('POST', '/api/auth/register', body),
    /** { username, authKey } → { token, user } (user.vault = wrapped vault key) */
    login: (body) => request('POST', '/api/auth/login', body),
    verify: (authKey) => request('POST', '/api/auth/verify', { authKey }),
    /** { salt?, authKey?, vault?, recovery? } — swaps credentials/envelopes */
    updateAuth: (body) => request('POST', '/api/auth/update-auth', body),
    /** { username, recoveryAuthKey } → { token, user, recovery: { envelope } } */
    recoveryLogin: (body) => request('POST', '/api/auth/recovery-login', body),
    logout: () => request('POST', '/api/auth/logout', {}),
    me: () => request('GET', '/api/me'),

    listItems: () => request('GET', '/api/items'),
    createItem: (body) => request('POST', '/api/items', body),
    getItem: (id) => request('GET', `/api/items/${encodeURIComponent(id)}`),
    updateItem: (id, body) => request('PUT', `/api/items/${encodeURIComponent(id)}`, body),
    deleteItem: (id) => request('DELETE', `/api/items/${encodeURIComponent(id)}`),
    replaceItems: (items) => request('PUT', '/api/items', { items }),
    wipeItems: (authKey) => request('DELETE', '/api/items', { authKey })
  };

  global.VaultApi = ServerApi;
  global.VaultSession = Session;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ServerApi, Session };
  }
})(typeof window !== 'undefined' ? window : globalThis);
