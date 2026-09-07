/**
 * OmniVault UI toolkit — DOM helpers, icons, modals, toasts.
 * No frameworks, no innerHTML with user data (XSS-safe by construction).
 */
(function (global) {
  'use strict';

  // ------------------------------------------------------------- selectors

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

  // -------------------------------------------------------------- elements

  /**
   * el('button', { class: 'btn', text: 'Save', onclick: fn }, [child, 'text'])
   * `text` is set via textContent (safe). `html` is only for trusted static
   * icon markup and must never receive user data.
   */
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    attrs = attrs || {};
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'html') node.innerHTML = value; // trusted static markup only
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
      else if (key === 'for') node.setAttribute('for', value);
      else if (value === true) node.setAttribute(key, '');
      else if (value !== false) node.setAttribute(key, String(value));
    }
    if (children !== undefined && children !== null) {
      for (const child of Array.isArray(children) ? children : [children]) {
        if (child === null || child === undefined) continue;
        node.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
      }
    }
    return node;
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  // ---------------------------------------------------------------- icons
  // Feather-style (MIT) outline icons.

  const ICONS = {
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    lock: '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    unlock: '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>',
    key: '<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3-3.5 3.5z"/>',
    note: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
    plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    check: '<polyline points="20 6 9 17 4 12"/>',
    eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>',
    trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
    settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
    refresh: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    alert: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
    offline: '<path d="M22.61 16.95A5 5 0 0 0 18 10h-1.26a8 8 0 0 0-7.05-6M5 5a8 8 0 0 0 4 15h9a5 5 0 0 0 1.7-.3"/><line x1="1" y1="1" x2="23" y2="23"/>',
    search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
    external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
    save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>',
    user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'
  };

  function icon(name, size) {
    const body = ICONS[name] || ICONS.shield;
    const s = size || 24;
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" ` +
      `stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
    );
  }

  function iconBtn(name, title, onclick, extraClass) {
    const btn = el('button', {
      type: 'button',
      class: 'icon-btn' + (extraClass ? ' ' + extraClass : ''),
      title: title || '',
      'aria-label': title || '',
      html: icon(name, 18),
      onclick: (e) => {
        e.stopPropagation();
        onclick(e);
      }
    });
    return btn;
  }

  function chipBtn(label, iconName, onclick, title) {
    return el('button', {
      type: 'button',
      class: 'chip-btn',
      title: title || label,
      html: icon(iconName, 13) + `<span>${label}</span>`,
      onclick: (e) => {
        e.stopPropagation();
        onclick(e);
      }
    });
  }

  // ---------------------------------------------------------------- toast

  function toast(message, kind, ms) {
    const root = $('#toast-root');
    if (!root) return;
    const iconName = kind === 'success' ? 'check' : kind === 'error' ? 'alert' : 'shield';
    const t = el('div', { class: 'toast ' + (kind || 'info'), html: icon(iconName, 16) });
    t.appendChild(el('span', { text: message }));
    root.appendChild(t);
    setTimeout(() => {
      t.style.opacity = '0';
      t.style.transition = 'opacity 0.25s';
      setTimeout(() => t.remove(), 260);
    }, ms || 3200);
  }

  // ---------------------------------------------------------------- modal

  const activeModals = [];

  function openModal(opts) {
    opts = opts || {};
    const root = $('#modal-root');
    const backdrop = el('div', { class: 'modal-backdrop' });
    const modal = el('div', { class: 'modal' + (opts.wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true' });
    if (opts.title) modal.setAttribute('aria-label', opts.title);

    const closeBtn = iconBtn('x', 'Close', () => close());
    const head = el('div', { class: 'modal-head' }, [
      el('h3', { text: opts.title || '' }),
      closeBtn
    ]);
    const body = el('div', { class: 'modal-body' });
    modal.appendChild(head);
    modal.appendChild(body);

    let footer = null;
    let closed = false;

    function close() {
      if (closed) return;
      closed = true;
      const idx = activeModals.indexOf(api);
      if (idx !== -1) activeModals.splice(idx, 1);
      backdrop.remove();
      if (opts.onClose) opts.onClose();
      document.removeEventListener('keydown', onKeydown);
    }

    function setBusy(busy, label) {
      $$('.btn', modal).forEach((b) => (b.disabled = busy));
      if (busy && label) {
        $$('.btn-primary', modal).forEach((b) => (b.textContent = label));
      }
    }

    function onKeydown(e) {
      if (e.key === 'Escape' && activeModals[activeModals.length - 1] === api) {
        e.preventDefault();
        close();
      }
    }

    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) close();
    });
    document.addEventListener('keydown', onKeydown);

    if (Array.isArray(opts.actions) && opts.actions.length) {
      footer = el('div', { class: 'modal-foot' });
      for (const action of opts.actions) {
        const btn = el('button', {
          type: 'button',
          class: 'btn ' + (action.class || 'btn-ghost'),
          text: action.label
        });
        if (action.icon) btn.insertAdjacentHTML('afterbegin', icon(action.icon, 16) + ' ');
        btn.addEventListener('click', async () => {
          if (!action.onClick) {
            close();
            return;
          }
          try {
            const result = await action.onClick({ close, body, modal, setBusy, btn });
            if (result !== false && action.closeOnClick !== false) close();
          } catch (err) {
            setBusy(false);
            toast(err && err.message ? err.message : 'Something went wrong', 'error');
          }
        });
        if (action.left) btn.classList.add('left');
        footer.appendChild(btn);
      }
      modal.appendChild(footer);
    }

    backdrop.appendChild(modal);
    root.appendChild(backdrop);

    const api = { backdrop, modal, body, close, setBusy };
    activeModals.push(api);

    if (typeof opts.content === 'function') opts.content(body, api);
    else if (opts.content) body.appendChild(opts.content);

    return api;
  }

  function confirmModal(opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      let decided = false;
      const m = openModal({
        title: opts.title || 'Are you sure?',
        content: (body) => {
          body.appendChild(el('p', { class: 'small', text: opts.message || '' }));
        },
        actions: [
          {
            label: opts.cancelLabel || 'Cancel',
            class: 'btn-ghost',
            onClick: () => {
              decided = true;
              resolve(false);
            }
          },
          {
            label: opts.confirmLabel || 'Confirm',
            class: opts.danger ? 'btn-danger' : 'btn-primary',
            onClick: () => {
              decided = true;
              resolve(true);
            }
          }
        ],
        onClose: () => {
          if (!decided) resolve(false);
        }
      });
      return m;
    });
  }

  // ------------------------------------------------------------- formatters

  function fmtDate(iso) {
    try {
      const d = new Date(iso);
      const now = Date.now();
      const diff = now - d.getTime();
      if (diff < 60_000) return 'just now';
      if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
      if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
      return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch {
      return '';
    }
  }

  function fmtBytes(n) {
    if (!Number.isFinite(n)) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  function debounce(fn, ms) {
    let t;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms || 200);
    };
  }

  global.UI = { $, $$, el, clear, icon, iconBtn, chipBtn, toast, openModal, confirmModal, fmtDate, fmtBytes, debounce };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.UI;
})(typeof window !== 'undefined' ? window : globalThis);
