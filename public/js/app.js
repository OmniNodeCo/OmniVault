/**
 * OmniVault application controller.
 *
 * Key model (v2):
 *   vaultKey  — random 256-bit key generated at registration. Items are
 *               always encrypted with it. It is wrapped (AES-GCM) by:
 *                 • the master password  → stored as user.vault envelope
 *                 • the recovery code    → stored as recovery.envelope
 *               Changing the password only re-wraps the vault key — items
 *               never need re-encryption. Forgetting the password is
 *               recoverable with the recovery code (reset flow).
 *
 * Modes:
 *   server — sync through the OmniVault backend (zero-knowledge).
 *   local  — 100% local: users/items live in IndexedDB, no network at all.
 */
(function (global) {
  'use strict';

  const { $, $$, el, icon, toast, fmtBytes } = global.UI;
  const VC = global.VaultCrypto;
  const Session = global.VaultSession;
  const Views = () => global.Views;

  const App = {
    serverApi: global.VaultApi,
    localApi: null,
    api: global.VaultApi,

    MAX_IMAGE_BYTES: 15 * 1024 * 1024,
    CLIPBOARD_CLEAR_MS: 25000,

    /** Web-app version — shown in Settings and compared with GitHub Releases. */
    APP_VERSION: '1.0.3',
    /** Latest-release JSON used by "Check for updates" (Settings). */
    UPDATE_URL: 'https://api.github.com/repos/OmniNodeCo/OmniVault/releases/latest',
    /** Automatic (silent) update checks happen at most this often. */
    UPDATE_CHECK_INTERVAL_MS: 24 * 60 * 60 * 1000,

    state: {
      view: 'auth', // auth | lock | vault
      mode: 'server', // server | local
      user: null,
      itemKey: null, // CryptoKey (AES-GCM) for items
      vaultKeyBytes: null,
      items: [], // decrypted: { id, type, title, plain, createdAt, updatedAt }
      filter: 'password',
      search: '',
      settings: { autolockMinutes: 5, theme: 'auto' }
    },

    blobUrls: new Map(),
    lastActivity: Date.now(),
    deferredInstall: null,
    totpTimer: null,
    autolockTimer: null,
    hiddenAt: 0,

    // ================================================================ init

    async init() {
      this.loadSettings();
      this.applyTheme();
      this.bindChrome();
      this.bindActivity();
      this.registerServiceWorker();

      const params = new URLSearchParams(location.search);
      const tab = params.get('tab');
      if (tab === 'notes') this.state.filter = 'note';
      else if (tab === 'images') this.state.filter = 'image';
      else if (tab === 'passwords') this.state.filter = 'password';

      await this.setMode(await this.detectMode());

      // Silent daily update check (never on the APK origin — the native
      // updater already covers that build).
      this.maybeAutoCheckUpdates();

      const token = Session.getToken();
      if (token) {
        try {
          const { user } = await this.api.me();
          this.state.user = user;
          const storedVK = Session.getStoredVaultKey();
          if (storedVK) {
            this.state.vaultKeyBytes = VC.b64ToBytes(storedVK);
            this.state.itemKey = await VC.importAesKey(this.state.vaultKeyBytes);
            await this.loadItems();
            this.show('vault');
            this.startAutoLockWatch();
            return;
          }
          this.show('lock');
          return;
        } catch (err) {
          if (err && err.status === 401) {
            this.clearLocalSession();
          } else if (this.state.mode === 'server') {
            // network error — offer the lock screen; unlock needs the server
            const username = Session.getUsername();
            if (username) {
              this.state.user = { username };
              this.show('lock');
              if (this._lockError) this._lockError('Offline — reconnect to unlock, or switch to local mode.');
              return;
            }
          }
        }
      }
      this.show('auth');
    },

    /**
     * Backend selection: a stored 'local' preference wins; otherwise probe
     * the server. When no server answers (static hosting, offline, file://),
     * the app runs 100% locally.
     */
    async detectMode() {
      if (Session.getMode() === 'local') return 'local';
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 2500);
        const res = await fetch('/api/health', { signal: ctrl.signal, cache: 'no-store' });
        clearTimeout(timer);
        if (res.ok) return 'server';
      } catch (e) {
        /* no server → local */
      }
      return 'local';
    },

    async setMode(mode) {
      this.state.mode = mode;
      if (mode === 'local') {
        if (!this.localApi) {
          this.localApi = new global.VaultLocal.LocalBackend(new global.VaultLocal.IdbAdapter());
        }
        this.api = this.localApi;
        // Ask the browser to keep local vault data (prevents eviction of the
        // installed PWA's storage on Android/Chrome).
        try {
          if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
        } catch (e) {
          /* ignore */
        }
      } else {
        this.api = this.serverApi;
      }
      Session.setMode(mode);
      this.updateModeChip();
    },

    /** Switch backend from the auth screen (no session active). */
    async switchBackend(mode) {
      if (this.state.view !== 'auth') return;
      await this.setMode(mode);
      this.show('auth');
      toast(
        mode === 'local' ? 'Local mode — data stays on this device' : `Server mode — ${location.host || 'server'}`,
        'info',
        2400
      );
    },

    updateModeChip() {
      const chip = $('#mode-chip');
      if (!chip) return;
      chip.textContent =
        this.state.mode === 'local' ? 'On this device' : `Server · ${location.host || 'remote'}`;
      chip.classList.toggle('local', this.state.mode === 'local');
    },

    // ============================================================== updates

    /** Fetch the latest-release JSON from GitHub. Throws when offline. */
    async fetchLatestRelease() {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        const res = await fetch(this.UPDATE_URL, {
          signal: ctrl.signal,
          cache: 'no-store',
          headers: { Accept: 'application/vnd.github+json' }
        });
        if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status}`);
        return await res.json();
      } finally {
        clearTimeout(timer);
      }
    },

    /**
     * Silent check on app start (at most once a day). Contacts ONLY
     * api.github.com and never touches the vault server.
     */
    maybeAutoCheckUpdates() {
      if (location.hostname === 'appassets.androidplatform.net') return; // APK has its own updater
      if (!navigator.onLine) return;
      let last = 0;
      try {
        last = Number(localStorage.getItem('ov_update_check_at')) || 0;
      } catch (e) {
        /* private mode */
      }
      if (Date.now() - last < this.UPDATE_CHECK_INTERVAL_MS) return;
      try {
        localStorage.setItem('ov_update_check_at', String(Date.now()));
      } catch (e) {
        /* ignore */
      }
      this.fetchLatestRelease()
        .then((release) => {
          const tag = String((release && release.tag_name) || '');
          const latest = tag.startsWith('v') ? tag.slice(1) : tag;
          if (!latest || compareVersions(latest, this.APP_VERSION) <= 0) return;
          let dismissed = '';
          try {
            dismissed = localStorage.getItem('ov_update_dismissed') || '';
          } catch (e) {
            /* ignore */
          }
          if (dismissed === tag) return; // the user hid this version already
          this.showUpdateBanner(tag, release);
        })
        .catch(() => {}); // silent — the manual check reports errors
    },

    /** Non-intrusive banner when a newer release exists. */
    showUpdateBanner(tag, release) {
      this._latestVersionSeen = tag;
      this._latestReleaseInfo = {
        current: this.APP_VERSION,
        latest: tag,
        url: String((release && release.html_url) || 'https://github.com/OmniNodeCo/OmniVault/releases/latest')
      };
      const banner = $('#update-banner');
      if (!banner) return;
      $('#update-banner-version').textContent = tag;
      $('#update-banner-current').textContent = `v${this.APP_VERSION}`;
      banner.hidden = false;
    },

    /** Manual check from Settings — always reports the outcome. */
    async checkForUpdates() {
      let release;
      try {
        release = await this.fetchLatestRelease();
      } catch (e) {
        toast('Could not check for updates — are you online?', 'error', 3200);
        return;
      }
      const tag = String((release && release.tag_name) || '');
      const latest = tag.startsWith('v') ? tag.slice(1) : tag;
      if (!latest) {
        toast('Could not read the latest release', 'error');
        return;
      }
      if (compareVersions(latest, this.APP_VERSION) <= 0) {
        toast(`OmniVault v${this.APP_VERSION} is up to date`, 'success', 3000);
        return;
      }
      this.showUpdateBanner(tag, release);
      Views().openUpdateModal({
        current: this.APP_VERSION,
        latest: tag,
        url: String((release && release.html_url) || 'https://github.com/OmniNodeCo/OmniVault/releases/latest')
      });
    },

    loadSettings() {
      try {
        const raw = localStorage.getItem('ov_settings');
        if (raw) Object.assign(this.state.settings, JSON.parse(raw));
      } catch (e) {
        /* ignore */
      }
    },

    saveSettings() {
      try {
        localStorage.setItem('ov_settings', JSON.stringify(this.state.settings));
      } catch (e) {
        /* ignore */
      }
    },

    setSetting(key, value) {
      this.state.settings[key] = value;
      this.saveSettings();
      if (key === 'theme') this.applyTheme();
      if (key === 'autolockMinutes') this.startAutoLockWatch();
    },

    applyTheme() {
      document.documentElement.dataset.theme = this.state.settings.theme || 'auto';
    },

    registerServiceWorker() {
      if (!('serviceWorker' in navigator)) return;
      // The bundled Android APK serves the app from local assets — a service
      // worker adds nothing there and its install can churn, so skip it.
      if (location.hostname === 'appassets.androidplatform.net') return;
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(() => {
          /* insecure context or unsupported — app still works */
        });
      });
    },

    // ===================================================== chrome / events

    bindChrome() {
      $('#brand-logo').innerHTML = icon('shield', 20);
      $('#btn-health').innerHTML = icon('activity', 18);
      $('#btn-settings').innerHTML = icon('settings', 18);
      $('#btn-lock').innerHTML = icon('lock', 18);
      $('#search-icon').innerHTML = icon('search', 16);
      $('#offline-banner-icon').innerHTML = icon('offline', 15);
      $('#update-banner-icon').innerHTML = icon('refresh', 15);
      $('#footnote-lock-icon').innerHTML = icon('lock', 13);

      $('#btn-settings').addEventListener('click', () => Views().openSettingsModal(this));
      $('#btn-health').addEventListener('click', () => Views().openHealthModal(this));
      $('#btn-lock').addEventListener('click', () => this.lock('Vault locked'));
      $('#btn-add').addEventListener('click', () => Views().openItemModal(null, this.state.filter));

      $('#update-banner-action').addEventListener('click', () => {
        if (this._latestReleaseInfo) Views().openUpdateModal(this._latestReleaseInfo);
      });
      $('#update-banner-dismiss').addEventListener('click', () => {
        $('#update-banner').hidden = true;
        if (this._latestVersionSeen) {
          try {
            localStorage.setItem('ov_update_dismissed', this._latestVersionSeen);
          } catch (e) {
            /* private mode */
          }
        }
      });

      $('#tabs').addEventListener('click', (e) => {
        const tab = e.target.closest('.tab');
        if (!tab) return;
        this.setFilter(tab.dataset.filter);
      });

      const search = $('#search');
      search.addEventListener('input', () => {
        this.state.search = search.value.trim();
        this.renderVaultView();
      });

      $('#btn-install').addEventListener('click', async () => {
        if (!this.deferredInstall) return;
        this.deferredInstall.prompt();
        const choice = await this.deferredInstall.userChoice;
        if (choice && choice.outcome === 'accepted') toast('Installing OmniVault…', 'success');
        this.deferredInstall = null;
        $('#btn-install').hidden = true;
      });

      window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        this.deferredInstall = e;
        if (this.state.view === 'vault') $('#btn-install').hidden = false;
      });
      window.addEventListener('appinstalled', () => {
        $('#btn-install').hidden = true;
        toast('OmniVault installed', 'success');
      });

      const setOnline = (online) => {
        $('#offline-banner').hidden = online || this.state.mode === 'local';
        if (!online && this.state.view === 'vault' && this.state.mode === 'server') {
          toast('You are offline — changes will fail until reconnected', 'error');
        }
      };
      window.addEventListener('online', () => setOnline(true));
      window.addEventListener('offline', () => setOnline(false));
      setOnline(navigator.onLine);
    },

    bindActivity() {
      let last = 0;
      const bump = () => {
        const now = Date.now();
        if (now - last > 4000) {
          last = now;
          this.lastActivity = now;
        }
      };
      document.addEventListener('pointerdown', bump, { passive: true });
      document.addEventListener('keydown', bump);
      document.addEventListener('wheel', bump, { passive: true });

      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          this.hiddenAt = Date.now();
        } else if (this.hiddenAt) {
          const away = Date.now() - this.hiddenAt;
          const limit = this.state.settings.autolockMinutes;
          if (limit > 0 && away > limit * 60000 && this.state.view === 'vault') {
            this.lock('Auto-locked while you were away');
          }
          this.hiddenAt = 0;
          this.lastActivity = Date.now();
        }
      });
    },

    // ============================================================ rendering

    show(view, message) {
      this.state.view = view;
      const vault = view === 'vault';
      $('#topbar').hidden = !vault;
      $('#footnote').hidden = !vault;
      if (vault) {
        $('#btn-install').hidden = !this.deferredInstall;
        this.refreshTabState();
        this.startTotpTicker();
        this.startAutoLockWatch();
      } else {
        this.stopTotpTicker();
      }
      const container = $('#view');
      if (view === 'auth') {
        Views().renderAuth(container, {
          app: this,
          mode: this._authMode || 'login',
          onAuth: (mode, username, password) => this.authenticate(mode, username, password),
          onSwitchMode: (mode) => {
            this._authMode = mode;
            this.show('auth');
          },
          onSwitchBackend: (mode) => this.switchBackend(mode)
        });
      } else if (view === 'lock') {
        Views().renderLock(container, {
          app: this,
          username: (this.state.user && this.state.user.username) || Session.getUsername() || 'user',
          onUnlock: (password, showErr) => this.unlock(password, showErr),
          onSwitchUser: () => {
            this.clearLocalSession();
            this.show('auth');
          }
        });
      } else {
        this.renderVaultView();
      }
      if (message) toast(message, 'info');
    },

    renderVaultView() {
      if (this.state.view !== 'vault') return;
      Views().renderVault($('#view'), this);
    },

    refreshTabState() {
      this.refreshCounts();
      $$('#tabs .tab').forEach((tab) => {
        tab.setAttribute('aria-selected', String(tab.dataset.filter === this.state.filter));
      });
    },

    refreshCounts() {
      const counts = { password: 0, note: 0, image: 0 };
      for (const item of this.state.items) counts[item.type] = (counts[item.type] || 0) + 1;
      $$('[data-count]').forEach((el2) => {
        el2.textContent = counts[el2.dataset.count] || 0;
      });
    },

    setFilter(filter) {
      this.state.filter = filter;
      this.refreshTabState();
      this.renderVaultView();
    },

    /** Card/detail entry points (implemented in views.js). */
    openItemModal(existing, type) {
      return Views().openItemModal(this, existing, type);
    },

    openImageView(item) {
      return Views().openImageView(this, item);
    },

    filteredItems() {
      const q = this.state.search.toLowerCase();
      return this.state.items.filter((item) => {
        if (item.type !== this.state.filter) return false;
        if (!q) return true;
        const p = item.plain || {};
        const haystack = [item.title, p.username, p.url, p.text, p.notes].filter(Boolean).join(' ').toLowerCase();
        return haystack.includes(q);
      });
    },

    // ================================================================ auth

    async authenticate(mode, username, password) {
      const showErr = this._authError || (() => {});
      try {
        showErr('');
        toast('Deriving encryption key…', 'info', 1400);

        if (mode === 'register') {
          // 1. Fresh vault key + master-password wrap.
          const salt = VC.randomSaltB64();
          const material = await VC.deriveAuthMaterial(password, salt);
          const vaultKeyBytes = new Uint8Array(global.crypto.getRandomValues(new Uint8Array(32)));
          const vaultEnv = await VC.encryptBytes(material.masterKey, vaultKeyBytes);

          // 2. Recovery code + its wrap of the same vault key.
          const recoveryCode = VC.generateRecoveryCode();
          const recoverySalt = VC.randomSaltB64();
          const rec = await VC.deriveRecoveryMaterial(recoveryCode, recoverySalt);
          const recoveryEnv = await VC.encryptBytes(rec.recoveryKey, vaultKeyBytes);

          const res = await this.api.register({
            username,
            salt,
            authKey: material.authKey,
            vault: vaultEnv,
            recovery: {
              salt: recoverySalt,
              authKey: rec.recoveryAuthKey,
              envelope: recoveryEnv
            }
          });
          await this.establishSession(res, vaultKeyBytes);
          this._authMode = 'login';
          this.show('vault');
          toast('Vault created — welcome aboard', 'success');
          Views().showRecoveryCode(this, recoveryCode, {
            headline: 'Save your recovery code',
            intro:
              'This code is the only way back in if you ever forget your master password. ' +
              'It is shown once — write it down or download it now.'
          });
        } else {
          const { salt } = await this.api.getSalt(username);
          const material = await VC.deriveAuthMaterial(password, salt);
          const res = await this.api.login({ username, authKey: material.authKey });
          if (!res.user || !res.user.vault) {
            throw new Error('This account has no vault key envelope — please contact support or re-register.');
          }
          const vaultKeyBytes = await VC.decryptBytes(material.masterKey, res.user.vault);
          await this.establishSession(res, vaultKeyBytes);
          await this.loadItems();
          this.show('vault');
          toast('Vault unlocked', 'success', 1800);
        }
      } catch (err) {
        if (err && err.status === 401) showErr('Invalid username or master password.');
        else if (err && err.status === 409) showErr('That username is already taken.');
        else showErr((err && err.message) || 'Could not reach the vault server.');
      }
    },

    async establishSession(res, vaultKeyBytes) {
      Session.setToken(res.token);
      Session.setUsername(res.user.username);
      Session.setStoredVaultKey(VC.bytesToB64(vaultKeyBytes));
      this.state.user = res.user;
      this.state.vaultKeyBytes = vaultKeyBytes;
      this.state.itemKey = await VC.importAesKey(vaultKeyBytes);
      this.lastActivity = Date.now();
    },

    async unlock(password, showErr) {
      try {
        showErr('');
        const username = (this.state.user && this.state.user.username) || Session.getUsername();
        let salt = this.state.user && this.state.user.salt;
        if (!salt) {
          const r = await this.api.getSalt(username);
          salt = r.salt;
        }
        const material = await VC.deriveAuthMaterial(password, salt);
        await this.api.verify(material.authKey);

        let user = this.state.user && this.state.user.vault ? this.state.user : null;
        if (!user) user = (await this.api.me()).user;
        const vaultKeyBytes = await VC.decryptBytes(material.masterKey, user.vault);
        this.state.user = user;
        await this.establishSession({ token: Session.getToken() || 'local', user }, vaultKeyBytes);
        await this.loadItems();
        this.show('vault');
        toast('Vault unlocked', 'success', 1800);
      } catch (err) {
        if (err && err.status === 401) showErr('Wrong master password.');
        else showErr((err && err.message) || 'Could not reach the vault server.');
      }
    },

    /**
     * Reset the master password with the recovery code — works when logged
     * out and having forgotten the password. Recovers the vault key from the
     * recovery envelope, then wraps it with the new password. No data is lost.
     */
    async resetWithRecovery(username, recoveryCode, newPassword) {
      const salts = await this.api.getSalt(username);
      if (!salts.recoverySalt) {
        throw new Error('No recovery code is set for this account.');
      }
      const rec = await VC.deriveRecoveryMaterial(recoveryCode, salts.recoverySalt);
      const res = await this.api.recoveryLogin(username, rec.recoveryAuthKey);
      const vaultKeyBytes = await VC.decryptBytes(rec.recoveryKey, res.recovery.envelope);

      const newSalt = VC.randomSaltB64();
      const next = await VC.deriveAuthMaterial(newPassword, newSalt);
      const vaultEnv = await VC.encryptBytes(next.masterKey, vaultKeyBytes);
      await this.api.updateAuth({ salt: newSalt, authKey: next.authKey, vault: vaultEnv });

      await this.establishSession(res, vaultKeyBytes);
      await this.loadItems();
      this.show('vault');
      toast('Master password reset — vault unlocked', 'success', 3200);
      toast('Your recovery code is unchanged — keep it safe', 'info', 4200);
    },

    /** Generate a fresh recovery code for the unlocked vault. Returns the code. */
    async regenerateRecoveryCode() {
      if (!this.state.vaultKeyBytes) throw new Error('The vault must be unlocked');
      const code = VC.generateRecoveryCode();
      const recoverySalt = VC.randomSaltB64();
      const rec = await VC.deriveRecoveryMaterial(code, recoverySalt);
      const envelope = await VC.encryptBytes(rec.recoveryKey, this.state.vaultKeyBytes);
      await this.api.updateAuth({
        recovery: { salt: recoverySalt, authKey: rec.recoveryAuthKey, envelope }
      });
      return code;
    },

    lock(message) {
      this.revokeBlobUrls();
      this.state.itemKey = null;
      this.state.vaultKeyBytes = null;
      this.state.items = [];
      Session.setStoredVaultKey(null);
      this.state.search = '';
      const search = $('#search');
      if (search) search.value = '';
      this.show('lock');
      if (message) toast(message, 'info');
    },

    async logout() {
      try {
        await this.api.logout();
      } catch (e) {
        /* best effort */
      }
      this.clearLocalSession();
      this.revokeBlobUrls();
      this.state.items = [];
      this.show('auth');
      toast('Logged out', 'success', 1800);
    },

    clearLocalSession() {
      Session.setToken('');
      Session.setUsername('');
      Session.setStoredVaultKey(null);
      this.state.user = null;
      this.state.itemKey = null;
      this.state.vaultKeyBytes = null;
      this.state.items = [];
    },

    // ================================================================ items

    async loadItems() {
      let res;
      try {
        res = await this.api.listItems();
      } catch (err) {
        if (err && err.status === 401) {
          this.clearLocalSession();
          this.show('auth');
          throw new Error('Session expired — please log in again');
        }
        throw err;
      }
      const items = [];
      let broken = 0;
      for (const serverItem of res.items) {
        try {
          items.push(await this.decryptItem(serverItem));
        } catch (e) {
          broken += 1;
        }
      }
      this.state.items = items;
      if (broken) toast(`${broken} item(s) could not be decrypted with this key`, 'error', 5000);
    },

    async decryptItem(serverItem) {
      const title = await VC.decryptJson(this.state.itemKey, serverItem.title);
      const plain = await VC.decryptJson(this.state.itemKey, serverItem.data);
      return {
        id: serverItem.id,
        type: serverItem.type,
        title,
        plain,
        createdAt: serverItem.createdAt,
        updatedAt: serverItem.updatedAt
      };
    },

    async saveItem(existing, { type, title, plain }) {
      const titleEnv = await VC.encryptJson(this.state.itemKey, title);
      const dataEnv = await VC.encryptJson(this.state.itemKey, plain);
      try {
        if (existing) {
          const { item } = await this.api.updateItem(existing.id, { type, title: titleEnv, data: dataEnv });
          this.revokeBlobUrl(existing.id);
          Object.assign(existing, {
            type: item.type,
            title,
            plain,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt
          });
          toast('Saved', 'success', 1800);
        } else {
          const { item } = await this.api.createItem({ type, title: titleEnv, data: dataEnv });
          this.state.items.unshift({
            id: item.id,
            type: item.type,
            title,
            plain,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt
          });
          toast('Added to vault', 'success', 1800);
        }
        this.refreshTabState();
        this.renderVaultView();
      } catch (err) {
        if (err && err.status === 401) {
          this.clearLocalSession();
          this.show('auth');
        }
        throw err;
      }
    },

    async deleteItem(item) {
      await this.api.deleteItem(item.id);
      this.revokeBlobUrl(item.id);
      const idx = this.state.items.indexOf(item);
      if (idx !== -1) this.state.items.splice(idx, 1);
      this.refreshTabState();
      this.renderVaultView();
      toast('Deleted', 'success', 1800);
    },

    // ================================================================ images

    async fileToPlain(file) {
      if (file.size > this.MAX_IMAGE_BYTES) throw new Error(`Image too large (max ${fmtBytes(this.MAX_IMAGE_BYTES)})`);
      const buf = new Uint8Array(await file.arrayBuffer());
      return {
        mime: file.type || 'image/png',
        data: VC.bytesToB64(buf),
        name: file.name || '',
        size: file.size
      };
    },

    async imageUrl(item) {
      if (this.blobUrls.has(item.id)) return this.blobUrls.get(item.id);
      try {
        const bytes = VC.b64ToBytes(item.plain.data);
        const blob = new Blob([bytes], { type: item.plain.mime || 'image/png' });
        const url = URL.createObjectURL(blob);
        this.blobUrls.set(item.id, url);
        return url;
      } catch (e) {
        return null;
      }
    },

    async attachThumbs(grid) {
      const imgs = $$('img[data-thumb-id]', grid);
      for (const img of imgs) {
        const item = this.state.items.find((i) => i.id === img.dataset.thumbId);
        if (!item) continue;
        const url = await this.imageUrl(item);
        if (url && img.isConnected) img.src = url;
      }
    },

    async downloadImage(item) {
      const url = await this.imageUrl(item);
      if (!url) {
        toast('Could not decrypt image', 'error');
        return;
      }
      const a = document.createElement('a');
      a.href = url;
      const ext = (item.plain.mime || 'image/png').split('/')[1] || 'png';
      a.download = `${(item.title || 'omnivault-image').replace(/[^\w.-]+/g, '_')}.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    },

    revokeBlobUrl(id) {
      const url = this.blobUrls.get(id);
      if (url) {
        URL.revokeObjectURL(url);
        this.blobUrls.delete(id);
      }
    },

    revokeBlobUrls() {
      for (const url of this.blobUrls.values()) URL.revokeObjectURL(url);
      this.blobUrls.clear();
    },

    // ============================================================ clipboard

    async copyText(text, message, ms) {
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
      } catch (e) {
        try {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
        } catch (e2) {
          toast('Copy failed — long-press to copy manually', 'error');
          return;
        }
      }
      if (message) toast(message, 'success', ms || 2200);
    },

    async copyPassword(password) {
      await this.copyText(password, 'Password copied — clipboard clears in 25s', 2600);
      setTimeout(() => {
        navigator.clipboard.writeText(' ').catch(() => {});
      }, this.CLIPBOARD_CLEAR_MS);
    },

    // ================================================================= TOTP

    startTotpTicker() {
      this.stopTotpTicker();
      this.totpTimer = setInterval(() => this.updateTotpWidgets(false), 1000);
      this.updateTotpWidgets(true);
    },

    stopTotpTicker() {
      if (this.totpTimer) {
        clearInterval(this.totpTimer);
        this.totpTimer = null;
      }
    },

    async updateTotpWidgets(force) {
      const widgets = $$('[data-totp-secret]');
      const now = Date.now();
      const nowSec = Math.floor(now / 1000);
      for (const w of widgets) {
        const period = Number(w.dataset.totpPeriod) || 30;
        const digits = Number(w.dataset.totpDigits) || 6;
        const secsLeft = period - (nowSec % period);
        const secsEl = w.querySelector('.secs');
        if (secsEl) secsEl.textContent = String(secsLeft);
        const bar = w.querySelector('.totp-ring .bar');
        if (bar) {
          const C = 2 * Math.PI * 8;
          bar.style.strokeDashoffset = String(C * (1 - secsLeft / period));
        }
        const currentPeriod = Math.floor(nowSec / period);
        if (force || w.dataset.periodStart !== String(currentPeriod)) {
          w.dataset.periodStart = String(currentPeriod);
          const secret = w.dataset.totpSecret;
          VC.totp(secret, { digits, period })
            .then((code) => {
              w.dataset.totpCode = code;
              const codeEl = w.querySelector('.totp-code');
              if (codeEl) codeEl.textContent = code;
            })
            .catch(() => {
              const codeEl = w.querySelector('.totp-code');
              if (codeEl) codeEl.textContent = '—'.repeat(digits);
            });
        }
      }
    },

    // ====================================================== master password

    /**
     * Change the master password: verify the current one, then re-wrap the
     * (unchanged) vault key with the new password. Items are NOT re-encrypted
     * or re-uploaded — the server just stores a new small envelope.
     */
    async changeMasterPassword(currentPassword, newPassword) {
      const salt = this.state.user && this.state.user.salt;
      if (!salt) throw new Error('Missing account salt — please log in again');
      const current = await VC.deriveAuthMaterial(currentPassword, salt);
      await this.api.verify(current.authKey);

      const newSalt = VC.randomSaltB64();
      const next = await VC.deriveAuthMaterial(newPassword, newSalt);
      const vaultEnv = await VC.encryptBytes(next.masterKey, this.state.vaultKeyBytes);
      await this.api.updateAuth({ salt: newSalt, authKey: next.authKey, vault: vaultEnv });

      const meRes = await this.api.me().catch(() => null);
      if (meRes && meRes.user) this.state.user = meRes.user;
      toast('Master password changed — vault key re-wrapped', 'success', 3500);
    },

    // =============================================================== backup

    /** Export every item + the vault key (wrapped with a backup password). */
    async exportBackup(password) {
      if (!password || password.length < 8) {
        throw new Error('Choose a backup password of at least 8 characters');
      }
      const res = await this.api.listItems();
      const salt = VC.randomSaltB64();
      const material = await VC.deriveAuthMaterial(password, salt);
      const vaultEnv = await VC.encryptBytes(material.masterKey, this.state.vaultKeyBytes);
      const backup = {
        format: 'omnivault-backup',
        version: 2,
        app: 'OmniVault',
        exportedAt: new Date().toISOString(),
        kdf: { name: 'PBKDF2-SHA256', iterations: VC.PBKDF2_ITERATIONS },
        mode: this.state.mode,
        salt,
        vault: vaultEnv,
        items: res.items
      };
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `omnivault-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast(`Exported ${res.items.length} encrypted item(s)`, 'success');
    },

    async importBackup(file, backupPassword) {
      if (!file) {
        toast('Choose a backup file first', 'error');
        return;
      }
      if (!backupPassword) throw new Error('Enter the password the backup was encrypted with');
      let backup;
      try {
        backup = JSON.parse(await file.text());
      } catch (e) {
        throw new Error('That file is not valid JSON');
      }
      if (backup.format !== 'omnivault-backup' || !Array.isArray(backup.items) || !backup.vault || !backup.salt) {
        throw new Error('Not an OmniVault backup file (version 2)');
      }
      const material = await VC.deriveAuthMaterial(backupPassword, backup.salt);
      let vaultKeyBytes;
      try {
        vaultKeyBytes = await VC.decryptBytes(material.masterKey, backup.vault);
      } catch (e) {
        throw new Error('Could not decrypt backup — is the backup password correct?');
      }
      const backupKey = await VC.importAesKey(vaultKeyBytes);

      const decrypted = [];
      for (const it of backup.items) {
        try {
          decrypted.push({
            type: it.type,
            title: await VC.decryptJson(backupKey, it.title),
            plain: await VC.decryptJson(backupKey, it.data),
            createdAt: it.createdAt
          });
        } catch (e) {
          throw new Error('Could not decrypt backup items — file may be corrupted');
        }
      }

      let count = 0;
      for (const d of decrypted) {
        await this.api.createItem({
          type: d.type,
          title: await VC.encryptJson(this.state.itemKey, d.title),
          data: await VC.encryptJson(this.state.itemKey, d.plain)
        });
        count += 1;
      }
      await this.loadItems();
      this.refreshTabState();
      this.renderVaultView();
      toast(`Imported ${count} item(s)`, 'success');
    },

    async wipeVault(password) {
      const salt = this.state.user && this.state.user.salt;
      const material = await VC.deriveAuthMaterial(password, salt);
      await this.api.wipeItems(material.authKey);
      this.revokeBlobUrls();
      this.state.items = [];
      this.refreshTabState();
      this.renderVaultView();
      toast('Vault wiped — all items deleted', 'success', 3500);
    },

    // ============================================================ auto-lock

    startAutoLockWatch() {
      if (this.autolockTimer) clearInterval(this.autolockTimer);
      const minutes = this.state.settings.autolockMinutes;
      if (!minutes || minutes <= 0) {
        this.autolockTimer = null;
        return;
      }
      this.autolockTimer = setInterval(() => {
        if (this.state.view === 'vault' && Date.now() - this.lastActivity > minutes * 60000) {
          this.lock('Auto-locked after inactivity');
        }
      }, 10000);
    }
  };

  /** Numeric dotted-version compare ("1.10.0" > "1.9.2"), ignoring prefixes. */
  function compareVersions(a, b) {
    const pa = String(a).replace(/[^0-9.]/g, '').split('.');
    const pb = String(b).replace(/[^0-9.]/g, '').split('.');
    const n = Math.max(pa.length, pb.length);
    for (let i = 0; i < n; i++) {
      const x = parseInt(pa[i], 10) || 0;
      const y = parseInt(pb[i], 10) || 0;
      if (x !== y) return x > y ? 1 : -1;
    }
    return 0;
  }

  global.App = App;
  App.init();
})(typeof window !== 'undefined' ? window : globalThis);
