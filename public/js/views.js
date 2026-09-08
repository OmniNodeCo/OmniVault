/**
 * OmniVault views — pure rendering. All user data goes through textContent.
 * `app` is the App object from app.js (state + actions).
 */
(function (global) {
  'use strict';

  const { $, $$, el, clear, icon, iconBtn, chipBtn, toast, openModal, confirmModal, fmtDate, fmtBytes } = global.UI;

  const TAB_LABELS = { password: 'Passwords', note: 'Notes', image: 'Images' };

  // ============================================================ AUTH SCREEN

  function renderAuth(container, opts) {
    clear(container);
    const app = opts.app;
    const mode = opts.mode || 'login';

    const errorText = el('span', { text: '' });
    const errorBox = el('div', { class: 'auth-error', hidden: true, html: icon('alert', 15) }, [errorText]);
    app._authError = (msg) => {
      errorText.textContent = msg || '';
      errorBox.hidden = !msg;
    };

    const username = el('input', {
      type: 'text',
      id: 'auth-username',
      autocomplete: 'username',
      placeholder: 'e.g. alex',
      value: global.VaultSession.getUsername()
    });

    const password = el('input', {
      type: 'password',
      id: 'auth-password',
      autocomplete: mode === 'register' ? 'new-password' : 'current-password',
      placeholder: mode === 'register' ? 'A long, unique master password' : 'Master password'
    });

    const submit = el('button', { type: 'submit', class: 'btn btn-primary btn-block', text: mode === 'register' ? 'Create encrypted vault' : 'Unlock vault' });

    const form = el('form', { novalidate: true }, [
      errorBox,
      el('div', { class: 'field' }, [el('label', { text: 'Username', for: 'auth-username' }), username]),
      el('div', { class: 'field' }, [el('label', { text: 'Master password', for: 'auth-password' }), password]),
      mode === 'register' ? strengthBlock(password) : null,
      mode === 'register'
        ? el('div', { class: 'notice', html: icon('alert', 15) }, [
            el('span', { text: 'There is no password recovery. Your master password encrypts everything — if you forget it, the vault cannot be opened by anyone, including us.' })
          ])
        : null,
      submit
    ]);

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const pass = password.value;
      if (!username.value.trim() || !pass) {
        app._authError('Please fill in both fields.');
        return;
      }
      if (mode === 'register' && pass.length < 8) {
        app._authError('Master password must be at least 8 characters — longer is strongly recommended.');
        return;
      }
      opts.onAuth(mode, username.value.trim(), pass);
    });

      const tabLogin = el('button', { type: 'button', class: 'auth-tab', role: 'tab', text: 'Log in', 'aria-selected': String(mode === 'login') });
      const tabRegister = el('button', { type: 'button', class: 'auth-tab', role: 'tab', text: 'Create vault', 'aria-selected': String(mode === 'register') });
      tabLogin.addEventListener('click', () => opts.onSwitchMode('login'));
      tabRegister.addEventListener('click', () => opts.onSwitchMode('register'));

      // mode line: where data lives + how to switch
      const isLocal = app.state.mode === 'local';
      const modeLine = el('p', { class: 'small muted', style: { textAlign: 'center', marginTop: '14px' } });
      modeLine.appendChild(el('span', { text: isLocal ? '📱 This device — 100% local, no server' : `☁ Server · ${location.host || 'remote'}` }));
      modeLine.appendChild(el('span', { text: ' · ' }));
      modeLine.appendChild(
        el('button', {
          type: 'button',
          class: 'btn-link',
          text: isLocal ? 'Connect to a server' : 'Use this device only',
          onclick: () => opts.onSwitchBackend(isLocal ? 'server' : 'local')
        })
      );

      const card = el('div', { class: 'auth-card' }, [
        el('div', { class: 'auth-brand' }, [
          el('div', { class: 'brand-logo', html: icon('shield', 28) }),
          el('h1', { text: 'OmniVault' }),
          el('p', { text: 'Zero-knowledge vault for passwords, notes and images. Everything is encrypted in your browser before it leaves this device.' })
        ]),
        el('div', { class: 'auth-tabs', role: 'tablist' }, [tabLogin, tabRegister]),
        form,
        modeLine
      ]);

      if (mode === 'login') {
        card.appendChild(
          el('p', { class: 'small', style: { textAlign: 'center', marginTop: '4px' } }, [
            el('button', {
              type: 'button',
              class: 'btn-link',
              text: 'Forgot master password?',
              onclick: () => openResetModal(app, { username: username.value.trim() })
            })
          ])
        );
      }

      container.appendChild(el('div', { class: 'auth-wrap' }, [card]));
      const userInput = $('#auth-username', card);
      if (userInput && !userInput.value) userInput.focus();
      else if (userInput) $('#auth-password', card).focus();
    }

  function strengthBlock(passwordInput) {
    const bars = [1, 2, 3, 4].map(() => el('div', { class: 'strength-bar' }));
    const label = el('span', { class: 'strength-label', text: '' });
    const block = el('div', { class: 'strength' }, [el('div', { class: 'strength-bars' }, bars), label]);
    const update = () => {
      const score = global.VaultCrypto.passwordStrength(passwordInput.value);
      const words = ['too weak', 'weak', 'okay', 'strong', 'excellent'];
      bars.forEach((b, i) => {
        b.className = 'strength-bar' + (i < score ? ` on-${score}` : '');
      });
      label.textContent = passwordInput.value ? words[score] : '';
    };
    passwordInput.addEventListener('input', update);
    setTimeout(update, 0);
    return el('div', { class: 'field' }, [
      el('div', { class: 'hint', text: 'Strength' }),
      block
    ]);
  }

  // ============================================================ LOCK SCREEN

  function renderLock(container, opts) {
    clear(container);
    const app = opts.app;
    const card = el('div', { class: 'auth-card' });

    const password = el('input', { type: 'password', id: 'lock-password', autocomplete: 'current-password', placeholder: 'Master password', autofocus: true });
    const errorBox = el('div', { class: 'auth-error', hidden: true, html: icon('alert', 15) });
    const errorText = el('span', { text: opts.error || '' });
    errorBox.appendChild(errorText);

    const showErr = (msg) => {
      errorText.textContent = msg;
      errorBox.hidden = !msg;
    };
    // Surface unlock errors (and app.init()'s offline notice) in this box.
    app._lockError = showErr;

    const form = el('form', { novalidate: true }, [
      errorBox,
      el('div', { class: 'field' }, [
        el('label', { text: `Master password for ${opts.username}`, for: 'lock-password' }),
        password
      ]),
      el('button', { type: 'submit', class: 'btn btn-primary btn-block', text: 'Unlock' })
    ]);

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!password.value) return;
      showErr('');
      opts.onUnlock(password.value, showErr);
    });

    card.appendChild(el('div', { class: 'auth-brand' }, [
      el('div', { class: 'brand-logo', html: icon('lock', 26) }),
      el('h1', { text: 'Vault locked' }),
      el('p', { text: 'Re-enter your master password to decrypt your vault.' })
    ]));
    card.appendChild(form);
    card.appendChild(
      el('p', { class: 'small muted', style: { textAlign: 'center', marginTop: '14px' } }, [
        el('span', { text: 'Locked as ' }),
        el('b', { text: opts.username }),
        el('span', { text: ' · ' }),
        el('button', { type: 'button', class: 'btn-link', text: 'Switch user', onclick: opts.onSwitchUser })
      ])
    );
    card.appendChild(
      el('p', { class: 'small', style: { textAlign: 'center', marginTop: '4px' } }, [
        el('button', {
          type: 'button',
          class: 'btn-link',
          text: 'Forgot master password?',
          onclick: () => openResetModal(app, { username: opts.username })
        })
      ])
    );

    container.appendChild(el('div', { class: 'auth-wrap' }, [card]));
    password.focus();
  }

  // ============================================================ VAULT VIEW

  function renderVault(container, app) {
    clear(container);
    const { state } = app;
    const items = app.filteredItems();
    const totalInTab = state.items.filter((i) => i.type === state.filter).length;

    const head = el('div', { class: 'section-head' }, [
      el('h2', { text: `${TAB_LABELS[state.filter]} (${totalInTab})` }),
      el('span', {
        class: 'muted',
        text: state.search ? `${items.length} match${items.length === 1 ? '' : 'es'}` : ''
      })
    ]);
    container.appendChild(head);

    if (!totalInTab) {
      container.appendChild(emptyState(state.filter, app));
      return;
    }

    if (!items.length) {
      container.appendChild(
        el('div', { class: 'empty' }, [
          el('div', { class: 'empty-icon', html: icon('search', 26) }),
          el('h3', { text: 'No matches' }),
          el('p', { text: `Nothing in ${TAB_LABELS[state.filter].toLowerCase()} matches “${state.search}”.` })
        ])
      );
      return;
    }

    const grid = el('div', { class: 'grid' });
    for (const item of items) grid.appendChild(card(app, item));
    container.appendChild(grid);

    app.attachThumbs(grid);
    app.updateTotpWidgets(true);
  }

  function emptyState(filter, app) {
    const config = {
      password: ['key', 'No passwords yet', 'Store website logins with usernames, passwords and 2FA codes.'],
      note: ['note', 'No notes yet', 'Keep encrypted notes, recovery codes and anything text-based.'],
      image: ['image', 'No images yet', 'Upload photos, screenshots and scans — encrypted before upload.']
    }[filter];
    return el('div', { class: 'empty' }, [
      el('div', { class: 'empty-icon', html: icon(config[0], 26) }),
      el('h3', { text: config[1] }),
      el('p', { text: config[2] }),
      el('button', { class: 'btn btn-primary', type: 'button', html: icon('plus', 16) + '<span>Add your first</span>', onclick: () => app.openItemModal(null, filter) })
    ]);
  }

  // ------------------------------------------------------------------ cards

  function card(app, item) {
    if (item.type === 'password') return passwordCard(app, item);
    if (item.type === 'note') return noteCard(app, item);
    return imageCard(app, item);
  }

  function cardShell(item, headChildren, onclick) {
    const c = el('article', { class: 'card', role: 'button', tabindex: '0', 'aria-label': item.title });
    c.addEventListener('click', onclick);
    c.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onclick(e);
      }
    });
    c.appendChild(el('div', { class: 'card-head' }, headChildren));
    return c;
  }

  function titleBlock(item, sub) {
    return el('div', { class: 'card-title-wrap' }, [
      el('div', { class: 'card-title', text: item.title || 'Untitled' }),
      sub ? el('div', { class: 'card-sub' }, [sub]) : null
    ]);
  }

  function passwordCard(app, item) {
    const p = item.plain;
    const sub = el('span', { text: p.username || p.url || '—' });
    if (p.url) {
      let host = p.url;
      try {
        const u = new URL(p.url.includes('://') ? p.url : `https://${p.url}`);
        host = u.hostname;
      } catch { /* keep raw */ }
      sub.textContent = '';
      if (p.username) sub.appendChild(el('span', { text: `${p.username} · ` }));
      sub.appendChild(el('a', { href: p.url.includes('://') ? p.url : `https://${p.url}`, target: '_blank', rel: 'noopener noreferrer', text: host }));
    }

    const c = cardShell(item, [el('div', { class: 'card-icon', html: icon('key', 18) }), titleBlock(item, sub)], () => app.openItemModal(item));

    if (p.totpSecret) c.appendChild(totpWidget(app, item));

    c.appendChild(
      el('div', { class: 'card-actions' }, [
        p.username ? chipBtn('User', 'user', () => app.copyText(p.username, 'Username copied')) : null,
        chipBtn('Password', 'copy', () => app.copyPassword(p.password)),
        chipBtn('', 'edit', () => app.openItemModal(item), 'Edit')
      ])
    );
    return c;
  }

  function noteCard(app, item) {
    const c = cardShell(item, [el('div', { class: 'card-icon note', html: icon('note', 18) }), titleBlock(item, el('span', { text: `Updated ${fmtDate(item.updatedAt)}` }))], () => app.openItemModal(item));
    if (item.plain.text) c.appendChild(el('div', { class: 'card-body', text: item.plain.text }));
    c.appendChild(el('div', { class: 'card-actions' }, [chipBtn('Edit', 'edit', () => app.openItemModal(item))]));
    return c;
  }

  function imageCard(app, item) {
    const thumb = el('img', { class: 'thumb', alt: item.title || 'encrypted image', loading: 'lazy' });
    thumb.dataset.thumbId = item.id;
    // Head row is just icon + title (like other cards); the full-width
    // thumbnail is inserted above it so the title is always readable.
    const c = cardShell(
      item,
      [
        el('div', { class: 'card-icon image', html: icon('image', 18) }),
        titleBlock(item, el('span', { text: `${fmtBytes(item.plain.size)} · ${fmtDate(item.updatedAt)}` }))
      ],
      () => app.openImageView(item)
    );
    c.insertBefore(thumb, c.firstChild);
    c.appendChild(
      el('div', { class: 'card-actions' }, [
        chipBtn('View', 'eye', () => app.openImageView(item)),
        chipBtn('Save', 'download', () => app.downloadImage(item)),
        chipBtn('Edit', 'edit', () => app.openItemModal(item)),
        chipBtn('Delete', 'trash', () => confirmAndDelete(app, item))
      ])
    );
    return c;
  }

  /** "Delete item?" confirmation shared by cards and the item modal. */
  async function confirmAndDelete(app, item, modalToClose) {
    const sure = await confirmModal({
      title: 'Delete item?',
      message: `“${item.title || 'Untitled'}” will be permanently removed from your vault.`,
      confirmLabel: 'Delete',
      danger: true
    });
    if (!sure) return;
    await app.deleteItem(item);
    if (modalToClose) modalToClose.close();
  }

  // ------------------------------------------------------------ TOTP widget

  const RING_R = 8;
  const RING_C = 2 * Math.PI * RING_R;

  function totpWidget(app, item) {
    const secret = item.plain.totpSecret || '';
    const parsed = global.VaultCrypto.parseOtpauth(secret);
    const cleanSecret = parsed ? parsed.secret : secret;
    const digits = parsed ? parsed.digits : 6;
    const period = parsed ? parsed.period : 30;

    // SVG must be built via markup — document.createElement would make HTML elements.
    const ring = el('span', {
      class: 'totp-count',
      html:
        `<svg class="totp-ring" viewBox="0 0 20 20" aria-hidden="true">` +
        `<circle class="track" cx="10" cy="10" r="${RING_R}"/>` +
        `<circle class="bar" cx="10" cy="10" r="${RING_R}" style="stroke-dasharray:${RING_C}"/>` +
        `</svg>`
    });
    ring.appendChild(el('span', { class: 'secs', text: String(period) }));

    const widget = el('div', {
      class: 'totp',
      dataset: { totpSecret: cleanSecret, totpDigits: String(digits), totpPeriod: String(period), totpCode: '' }
    });
    widget.appendChild(el('span', { class: 'totp-code', text: '·'.repeat(digits) }));
    widget.appendChild(ring);
    widget.appendChild(chipBtn('', 'copy', () => app.copyText(widget.dataset.totpCode || '', 'One-time code copied'), 'Copy one-time code'));
    return widget;
  }

  // ============================================================ ITEM MODAL

  function openItemModal(app, existing, typeOverride) {
    const type = existing ? existing.type : typeOverride || app.state.filter;
    const isNew = !existing;
    let chosenFile = null;

    const titleInput = el('input', { type: 'text', value: existing ? existing.title : '', placeholder: type === 'password' ? 'e.g. GitHub' : type === 'note' ? 'e.g. Wifi details' : 'e.g. Passport scan', autocomplete: 'off' });

    // --- password-specific controls -------------------------------------
    let passwordInput = null;
    let totpInput = null;

    function passwordRow() {
      passwordInput = el('input', { type: 'password', class: 'mono', autocomplete: 'new-password', value: existing ? existing.plain.password || '' : '' });
      const eye = iconBtn('eye', 'Show / hide', () => {
        const show = passwordInput.type === 'password';
        passwordInput.type = show ? 'text' : 'password';
        eye.innerHTML = icon(show ? 'eyeOff' : 'eye', 16);
      });
      const gen = iconBtn('refresh', 'Generate password', () => {
        openGeneratorModal((pw) => {
          passwordInput.value = pw;
          passwordInput.type = 'text';
        });
      });
      return el('div', { class: 'input-group' }, [
        passwordInput,
        el('div', { class: 'input-group-append' }, [eye, gen])
      ]);
    }

    const m = openModal({
      title: isNew ? `New ${type === 'password' ? 'password' : type === 'note' ? 'note' : 'image'}` : 'Edit item',
      content: (body) => {
        body.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Title *' }), titleInput]));

        if (type === 'password') {
          const urlInput = el('input', { type: 'text', inputmode: 'url', placeholder: 'example.com', value: existing ? existing.plain.url || '' : '' });
          const userInput = el('input', { type: 'text', autocomplete: 'off', placeholder: 'you@example.com', value: existing ? existing.plain.username || '' : '' });
          totpInput = el('input', { type: 'text', class: 'mono', autocomplete: 'off', placeholder: 'JBSWY3DPEHPK3PXP or otpauth://…', value: existing ? existing.plain.totpSecret || '' : '' });
          const notesInput = el('textarea', { placeholder: 'Extra details (optional)' });
          if (existing && existing.plain.notes) notesInput.value = existing.plain.notes;

          body.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Website / URL' }), urlInput]));
          body.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Username / email' }), userInput]));
          body.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Password' }), passwordRow()]));
          body.appendChild(
            el('div', { class: 'field' }, [
              el('label', { text: 'Two-factor (TOTP) secret' }),
              totpInput,
              el('div', { class: 'hint', text: 'Base32 secret or otpauth:// URI — shows a live login code on the card.' })
            ])
          );
          body.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Notes' }), notesInput]));
          body._collect = () => ({
            type: 'password',
            title: titleInput.value.trim(),
            plain: {
              url: urlInput.value.trim(),
              username: userInput.value.trim(),
              password: passwordInput.value,
              totpSecret: totpInput.value.trim(),
              notes: notesInput.value
            }
          });
        } else if (type === 'note') {
          const textArea = el('textarea', { style: { minHeight: '170px' }, placeholder: 'Write anything — it is encrypted before leaving this device.' });
          if (existing) textArea.value = existing.plain.text || '';
          body.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Content *' }), textArea]));
          body._collect = () => ({
            type: 'note',
            title: titleInput.value.trim(),
            plain: { text: textArea.value }
          });
        } else {
          // image
          const preview = el('img', { class: 'image-preview', alt: 'preview', hidden: true });
          const fileName = el('span', { class: 'file-name' });
          const drop = el('div', { class: 'dropzone', html: icon('upload', 26) });
          const fileInput = el('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });

          drop.appendChild(el('div', {}, [el('strong', { text: 'Choose an image' }), el('span', { class: 'muted', text: ' or drop it here · up to 15 MB · encrypted before upload' })]));
          drop.appendChild(fileName);
          drop.appendChild(fileInput);

          const setFile = (file) => {
            if (!file) return;
            if (!file.type.startsWith('image/')) {
              toast('That file is not an image', 'error');
              return;
            }
            if (file.size > app.MAX_IMAGE_BYTES) {
              toast(`Image too large (max ${fmtBytes(app.MAX_IMAGE_BYTES)})`, 'error');
              return;
            }
            chosenFile = file;
            fileName.textContent = `${file.name} · ${fmtBytes(file.size)}`;
            preview.src = URL.createObjectURL(file);
            preview.hidden = false;
          };

          drop.addEventListener('click', (e) => {
            if (e.target === fileInput) return;
            fileInput.click();
          });
          fileInput.addEventListener('change', () => setFile(fileInput.files && fileInput.files[0]));
          ['dragenter', 'dragover'].forEach((ev) =>
            drop.addEventListener(ev, (e) => {
              e.preventDefault();
              drop.classList.add('dragover');
            })
          );
          ['dragleave', 'drop'].forEach((ev) =>
            drop.addEventListener(ev, (e) => {
              e.preventDefault();
              drop.classList.remove('dragover');
            })
          );
          drop.addEventListener('drop', (e) => {
            const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
            setFile(f);
          });

          if (existing) {
            app.imageUrl(existing).then((url) => {
              if (url) {
                preview.src = url;
                preview.hidden = false;
                fileName.textContent = 'Current image — choosing a new file replaces it';
              }
            });
          }

          body.appendChild(el('div', { class: 'field' }, [preview, drop]));
          body._collect = () => ({
            type: 'image',
            title: titleInput.value.trim(),
            plain: null // filled by app from chosenFile / existing
          });
          body._chosenFile = () => chosenFile;
        }

        if (existing) {
          body.appendChild(
            el('p', {
              class: 'small muted',
              text: `Created ${fmtDate(existing.createdAt)} · updated ${fmtDate(existing.updatedAt)}`
            })
          );
        }
      },
      actions: [
        ...(existing
          ? [
              {
                label: 'Delete',
                class: 'btn-danger',
                icon: 'trash',
                left: true,
                closeOnClick: false,
                onClick: async () => {
                  await confirmAndDelete(app, existing, m);
                  return false;
                }
              }
            ]
          : []),
        { label: 'Cancel', class: 'btn-ghost' },
        {
          label: isNew ? 'Add to vault' : 'Save changes',
          class: 'btn-primary',
          icon: 'save',
          closeOnClick: false,
          onClick: async ({ setBusy, body }) => {
            const data = body._collect();
            let plain = data.plain;
            if (data.type === 'image') {
              if (body._chosenFile()) {
                setBusy(true, 'Encrypting…');
                plain = await app.fileToPlain(body._chosenFile());
              } else if (existing) {
                plain = existing.plain;
              } else {
                toast('Choose an image first', 'error');
                return false;
              }
            }
            if (!data.title) {
              toast('Please give it a title', 'error');
              return false;
            }
            if (data.type === 'note' && !plain.text) {
              toast('Note content is empty', 'error');
              return false;
            }
            setBusy(true, isNew ? 'Encrypting…' : 'Saving…');
            try {
              await app.saveItem(existing, { type: data.type, title: data.title, plain });
            } finally {
              setBusy(false);
            }
            return true;
          }
        }
      ]
    });

    setTimeout(() => titleInput.focus(), 60);
    return m;
  }

  // ======================================================== IMAGE VIEWER

  function openImageView(app, item) {
    const img = el('img', { class: 'image-view', alt: item.title || 'encrypted image' });
    openModal({
      title: item.title || 'Image',
      wide: true,
      content: (body) => {
        body.appendChild(img);
        app.imageUrl(item).then((url) => {
          if (url) img.src = url;
          else body.appendChild(el('p', { class: 'muted', text: 'Could not decrypt image.' }));
        });
        body.appendChild(
          el('p', { class: 'small muted', style: { textAlign: 'center' } }, [
            el('span', { text: `${fmtBytes(item.plain.size)} · ${item.plain.mime || 'image'} · updated ${fmtDate(item.updatedAt)}` })
          ])
        );
      },
      actions: [
        { label: 'Download', class: 'btn-soft', icon: 'download', onClick: () => { app.downloadImage(item); return false; } },
        { label: 'Edit', class: 'btn-soft', icon: 'edit', onClick: () => { app.openItemModal(item); return false; } },
        { label: 'Close', class: 'btn-primary' }
      ]
    });
  }

  // ==================================================== PASSWORD GENERATOR

  function openGeneratorModal(onUse) {
    const output = el('input', { type: 'text', class: 'mono', readonly: true, style: { fontSize: '16px', textAlign: 'center', fontWeight: '700' } });
    const lengthInput = el('input', { type: 'number', min: 8, max: 80, value: 20 });
    const checks = {};
    const gen = () => {
      output.value = global.VaultCrypto.generatePassword({
        length: Math.max(8, Math.min(80, Number(lengthInput.value) || 20)),
        lower: checks.lower.checked,
        upper: checks.upper.checked,
        digits: checks.digits.checked,
        symbols: checks.symbols.checked
      });
    };
    const m = openModal({
      title: 'Password generator',
      content: (body) => {
        body.appendChild(el('div', { class: 'field' }, [output]));
        body.appendChild(el('div', { class: 'field' }, [el('label', { text: `Length` }), lengthInput]));
        lengthInput.addEventListener('input', gen);
        const checkRow = el('div', { class: 'row wrap', style: { gap: '14px' } });
        for (const [key, label, on] of [['lower', 'a-z', true], ['upper', 'A-Z', true], ['digits', '0-9', true], ['symbols', '!@#$', true]]) {
          checks[key] = el('input', { type: 'checkbox', checked: on });
          checks[key].addEventListener('change', gen);
          checkRow.appendChild(el('label', { class: 'check' }, [checks[key], el('span', { text: label })]));
        }
        body.appendChild(checkRow);
        gen();
      },
      actions: [
        { label: 'Regenerate', class: 'btn-soft', icon: 'refresh', onClick: () => { gen(); return false; } },
        {
          label: 'Copy',
          class: 'btn-soft',
          icon: 'copy',
          closeOnClick: false,
          onClick: async () => {
            await navigator.clipboard.writeText(output.value);
            toast('Generated password copied', 'success');
            return false;
          }
        },
        {
          label: 'Use password',
          class: 'btn-primary',
          onClick: async () => {
            if (onUse) onUse(output.value);
          }
        }
      ]
    });
    return m;
  }

  // ======================================================== RECOVERY CODE

  /** One-time display of a recovery code (after register or regenerate). */
  function showRecoveryCode(app, code, opts = {}) {
    const check = el('input', { type: 'checkbox' });
    const codeEl = el('div', { class: 'recovery-code', text: code });

    const copyBtn = el('button', { class: 'btn btn-soft btn-sm', type: 'button', html: icon('copy', 15) + '<span>Copy</span>' });
    copyBtn.addEventListener('click', async () => {
      await app.copyText(code, 'Recovery code copied', 2500);
    });

    const downloadBtn = el('button', { class: 'btn btn-soft btn-sm', type: 'button', html: icon('download', 15) + '<span>Download .txt</span>' });
    downloadBtn.addEventListener('click', () => {
      const blob = new Blob(
        [
          `OmniVault recovery code\n========================\n\n` +
            `Username: ${app.state.user ? app.state.user.username : '-'}\n` +
            `Code:     ${code}\n\n` +
            `Keep this somewhere safe and offline. It is the only way to reset\n` +
            `your master password if you forget it. Anyone with this code can\n` +
            `reset your master password, so treat it like a master key.\n`
        ],
        { type: 'text/plain' }
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'omnivault-recovery-code.txt';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    });

    openModal({
      title: opts.headline || 'Your recovery code',
      content: (body, modalApi) => {
        const contBtn = el('button', { class: 'btn btn-primary btn-block', type: 'button', text: 'Continue', disabled: true });
        check.addEventListener('change', () => {
          contBtn.disabled = !check.checked;
        });
        contBtn.addEventListener('click', () => modalApi.close());

        body.appendChild(el('p', { class: 'small', text: opts.intro || 'Write this down and keep it offline. It is shown only once.' }));
        body.appendChild(codeEl);
        body.appendChild(el('div', { class: 'row recovery-actions', style: { marginTop: '10px' } }, [copyBtn, downloadBtn]));
        body.appendChild(
          el('div', { class: 'notice', style: { marginTop: '14px' }, html: icon('alert', 15) }, [
            el('span', { text: 'Anyone with this code can reset your master password. If you lose it (and your master password), the vault cannot be recovered by anyone.' })
          ])
        );
        body.appendChild(
          el('label', { class: 'check', style: { marginTop: '12px' } }, [
            check,
            el('span', { text: 'I have saved this code somewhere safe' })
          ])
        );
        body.appendChild(el('div', { style: { marginTop: '16px' } }, [contBtn]));
      },
      actions: []
    });
  }

  // ========================================================= RESET MODAL

  /** Forgot-master-password flow: recover the vault key with the recovery code. */
  function openResetModal(app, opts = {}) {
    const username = el('input', { type: 'text', autocomplete: 'username', value: opts.username || '' });
    const code = el('input', { type: 'text', class: 'mono', autocomplete: 'off', placeholder: 'XXXX-XXXX-XXXX-XXXX-XXXX-XXXX', spellcheck: false });
    const next = el('input', { type: 'password', autocomplete: 'new-password' });
    const confirmPw = el('input', { type: 'password', autocomplete: 'new-password' });

    const errorText = el('span', { text: '' });
    const errorBox = el('div', { class: 'auth-error', hidden: true, html: icon('alert', 15) }, [errorText]);
    const showErr = (msg) => {
      errorText.textContent = msg || '';
      errorBox.hidden = !msg;
    };

    openModal({
      title: 'Reset master password',
      content: (body) => {
        body.appendChild(
          el('div', { class: 'notice', html: icon('alert', 15) }, [
            el('span', { text: 'Use the recovery code you saved when you created the vault. Your data is not lost — the vault key is recovered from the code.' })
          ])
        );
        body.appendChild(errorBox);
        body.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Username' }), username]));
        body.appendChild(
          el('div', { class: 'field' }, [
            el('label', { text: 'Recovery code' }),
            code,
            el('div', { class: 'hint', text: 'Dashes and lowercase are fine — the code is matched ignoring them.' })
          ])
        );
        body.appendChild(el('div', { class: 'field' }, [el('label', { text: 'New master password' }), next]));
        body.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Repeat new master password' }), confirmPw]));
      },
      actions: [
        { label: 'Cancel', class: 'btn-ghost' },
        {
          label: 'Reset & unlock',
          class: 'btn-primary',
          icon: 'key',
          closeOnClick: false,
          onClick: async ({ setBusy }) => {
            try {
              showErr('');
              if (!username.value.trim() || !code.value.trim()) throw new Error('Fill in the username and recovery code');
              if (next.value.length < 8) throw new Error('New master password must be at least 8 characters');
              if (next.value !== confirmPw.value) throw new Error('New passwords do not match');
              setBusy(true, 'Resetting…');
              await app.resetWithRecovery(username.value.trim(), code.value.trim(), next.value);
              return true;
            } catch (err) {
              setBusy(false);
              showErr((err && err.message) || 'Reset failed');
              return false;
            }
          }
        }
      ]
    });
    setTimeout(() => (username.value ? code.focus() : username.focus()), 60);
  }

  // ========================================================= EXPORT MODAL

  /** Prompt for the backup password before exporting. */
  function openExportModal(app) {
    const password = el('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Any password you choose (8+ characters)' });
    openModal({
      title: 'Export encrypted backup',
      content: (body) => {
        body.appendChild(
          el('p', { class: 'small', text: 'The backup file contains every item plus your vault key, encrypted with the password you choose here. You will need this exact password to import it.' })
        );
        body.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Backup password' }), password]));
      },
      actions: [
        { label: 'Cancel', class: 'btn-ghost' },
        {
          label: 'Export',
          class: 'btn-primary',
          icon: 'download',
          closeOnClick: false,
          onClick: async ({ setBusy }) => {
            setBusy(true, 'Exporting…');
            await app.exportBackup(password.value);
            return true;
          }
        }
      ]
    });
    setTimeout(() => password.focus(), 60);
  }

  // ========================================================= SETTINGS MODAL

  function openSettingsModal(app) {
    const s = app.state.settings;

    const themeSelect = el('select', {}, [
      el('option', { value: 'auto', text: 'Match system' }),
      el('option', { value: 'dark', text: 'Dark' }),
      el('option', { value: 'light', text: 'Light' })
    ]);
    themeSelect.value = s.theme;
    themeSelect.addEventListener('change', () => app.setSetting('theme', themeSelect.value));

    const lockSelect = el('select', {}, [
      el('option', { value: '1', text: 'After 1 minute' }),
      el('option', { value: '5', text: 'After 5 minutes' }),
      el('option', { value: '15', text: 'After 15 minutes' }),
      el('option', { value: '60', text: 'After 1 hour' }),
      el('option', { value: '0', text: 'Never (not recommended)' })
    ]);
    lockSelect.value = String(s.autolockMinutes);
    lockSelect.addEventListener('change', () => app.setSetting('autolockMinutes', Number(lockSelect.value)));

    const counts = { password: 0, note: 0, image: 0 };
    for (const it of app.state.items) counts[it.type] = (counts[it.type] || 0) + 1;

    const importFile = el('input', { type: 'file', accept: 'application/json,.json' });
    const importPassword = el('input', { type: 'password', autocomplete: 'off', placeholder: 'Backup password' });

    openModal({
      title: 'Settings',
      content: (body) => {
        body.appendChild(
          el('div', { class: 'settings-section' }, [
            el('h4', { text: 'General' }),
            el('div', { class: 'settings-row' }, [
              el('div', { class: 'label' }, [el('span', { text: 'Theme' })]),
              el('div', { class: 'control' }, [themeSelect])
            ]),
            el('div', { class: 'settings-row' }, [
              el('div', { class: 'label' }, [
                el('span', { text: 'Auto-lock' }),
                el('small', { text: 'Locks the vault after inactivity' })
              ]),
              el('div', { class: 'control' }, [lockSelect])
            ]),
            el('div', { class: 'settings-row' }, [
              el('div', { class: 'label' }, [
                el('span', { text: 'Storage' }),
                el('small', { text: app.state.mode === 'local' ? 'This device only (IndexedDB)' : `Server · ${location.host || 'remote'}` })
              ]),
              el('div', { class: 'control' }, [
                el('span', {
                  class: 'mode-chip' + (app.state.mode === 'local' ? ' local' : ''),
                  text: app.state.mode === 'local' ? 'On this device' : 'Server'
                })
              ])
            ])
          ])
        );

        body.appendChild(
          el('div', { class: 'settings-section' }, [
            el('h4', { text: 'Vault' }),
            el('div', { class: 'stats' }, [
              el('div', { class: 'stat' }, [el('b', { text: String(counts.password) }), el('span', { text: 'Passwords' })]),
              el('div', { class: 'stat' }, [el('b', { text: String(counts.note) }), el('span', { text: 'Notes' })]),
              el('div', { class: 'stat' }, [el('b', { text: String(counts.image) }), el('span', { text: 'Images' })])
            ]),
            el('div', { class: 'settings-row' }, [
              el('div', { class: 'label' }, [
                el('span', { text: 'Encrypted backup' }),
                el('small', { text: 'All items + vault key in one encrypted JSON file' })
              ]),
              el('div', { class: 'control' }, [
                el('button', {
                  class: 'btn btn-soft btn-sm',
                  type: 'button',
                  html: icon('download', 15) + '<span>Export…</span>',
                  onclick: () => openExportModal(app)
                })
              ])
            ]),
            el('div', { class: 'settings-row' }, [
              el('div', { class: 'label' }, [
                el('span', { text: 'Import backup' }),
                el('small', { text: 'Merge items from an OmniVault backup file' })
              ]),
              el('div', { class: 'control' }, [
                importFile,
                el('div', { style: { marginTop: '6px' } }, [importPassword]),
                el('button', {
                  class: 'btn btn-soft btn-sm',
                  type: 'button',
                  style: { marginTop: '8px' },
                  html: icon('upload', 15) + '<span>Import</span>',
                  onclick: async () => {
                    try {
                      await app.importBackup(importFile.files && importFile.files[0], importPassword.value);
                    } catch (err) {
                      toast((err && err.message) || 'Import failed', 'error');
                    }
                  }
                })
              ])
            ]),
            el('div', { class: 'settings-row' }, [
              el('div', { class: 'label' }, [
                el('span', { text: 'Master password' }),
                el('small', { text: 'Re-wraps your vault key — items are not re-uploaded' })
              ]),
              el('div', { class: 'control' }, [
                el('button', { class: 'btn btn-soft btn-sm', type: 'button', html: icon('key', 15) + '<span>Change…</span>', onclick: () => openChangePasswordModal(app) })
              ])
            ])
          ])
        );

        body.appendChild(
          el('div', { class: 'settings-section' }, [
            el('h4', { text: 'Recovery' }),
            el('div', { class: 'settings-row' }, [
              el('div', { class: 'label' }, [
                el('span', { text: 'Recovery code' }),
                el('small', { text: 'Resets your master password if you forget it — shown once' })
              ]),
              el('div', { class: 'control' }, [
                el('button', {
                  class: 'btn btn-soft btn-sm',
                  type: 'button',
                  html: icon('refresh', 15) + '<span>Regenerate…</span>',
                  onclick: async () => {
                    try {
                      const code = await app.regenerateRecoveryCode();
                      showRecoveryCode(app, code, {
                        headline: 'New recovery code',
                        intro: 'Your previous recovery code no longer works. Save this new one — it is shown only once.'
                      });
                    } catch (err) {
                      toast((err && err.message) || 'Could not regenerate the recovery code', 'error');
                    }
                  }
                })
              ])
            ])
          ])
        );

        body.appendChild(
          el('div', { class: 'settings-section' }, [
            el('h4', { text: 'Danger zone' }),
            el('div', { class: 'settings-row' }, [
              el('div', { class: 'label' }, [
                el('span', { text: 'Delete all items' }),
                el('small', { text: 'Permanently wipes every password, note and image' })
              ]),
              el('div', { class: 'control' }, [
                el('button', {
                  class: 'btn btn-danger btn-sm',
                  type: 'button',
                  html: icon('trash', 15) + '<span>Wipe vault…</span>',
                  onclick: () => openWipeModal(app)
                })
              ])
            ])
          ])
        );

        body.appendChild(
          el('div', { class: 'settings-section' }, [
            el('h4', { text: 'Session & about' }),
            el('div', { class: 'settings-row' }, [
              el('div', { class: 'label' }, [
                el('span', { text: 'Signed in as' }),
                el('small', { class: 'mono', text: app.state.user ? app.state.user.username : '' })
              ]),
              el('div', { class: 'control' }, [
                el('button', { class: 'btn btn-ghost btn-sm', type: 'button', html: icon('logout', 15) + '<span>Log out</span>', onclick: () => app.logout() })
              ])
            ]),
            el('div', { class: 'settings-row' }, [
              el('div', { class: 'label' }, [
                el('span', { text: 'Check for updates' }),
                el('small', { text: `You have v${app.APP_VERSION} — checks GitHub Releases` })
              ]),
              el('div', { class: 'control' }, [
                el('button', {
                  class: 'btn btn-soft btn-sm',
                  type: 'button',
                  html: icon('refresh', 15) + '<span>Check now</span>',
                  onclick: () => app.checkForUpdates()
                })
              ])
            ]),
            el('p', {
              class: 'small muted',
              text: `OmniVault v${app.APP_VERSION} · AES-256-GCM · PBKDF2-SHA256 ×${global.VaultCrypto.PBKDF2_ITERATIONS.toLocaleString()} · zero-knowledge`
            })
          ])
        );
      },
      actions: [{ label: 'Done', class: 'btn-primary' }]
    });
  }

  function openChangePasswordModal(app) {
    const current = el('input', { type: 'password', autocomplete: 'current-password' });
    const next = el('input', { type: 'password', autocomplete: 'new-password' });
    const confirmPw = el('input', { type: 'password', autocomplete: 'new-password' });

    openModal({
      title: 'Change master password',
      content: (body) => {
        body.appendChild(
          el('div', { class: 'notice info', html: icon('refresh', 15) }, [
            el('span', { text: 'Your vault key is simply re-wrapped with the new password — items are not re-encrypted or re-uploaded, so this is instant even for large vaults. Your recovery code keeps working.' })
          ])
        );
        body.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Current master password' }), current]));
        body.appendChild(el('div', { class: 'field' }, [el('label', { text: 'New master password' }), next]));
        body.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Repeat new password' }), confirmPw]));
      },
      actions: [
        { label: 'Cancel', class: 'btn-ghost' },
        {
          label: 'Change password',
          class: 'btn-primary',
          icon: 'key',
          closeOnClick: false,
          onClick: async ({ setBusy }) => {
            if (next.value.length < 8) throw new Error('New password must be at least 8 characters');
            if (next.value !== confirmPw.value) throw new Error('New passwords do not match');
            setBusy(true, 'Re-encrypting…');
            try {
              await app.changeMasterPassword(current.value, next.value);
            } finally {
              setBusy(false);
            }
            return true;
          }
        }
      ]
    });
  }

  function openWipeModal(app) {
    const password = el('input', { type: 'password', autocomplete: 'current-password' });
    openModal({
      title: 'Wipe vault',
      content: (body) => {
        body.appendChild(
          el('div', { class: 'notice', html: icon('alert', 15) }, [
            el('span', { text: 'This permanently deletes every item in your vault. Export a backup first if you might want it back.' })
          ])
        );
        body.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Confirm with master password' }), password]));
      },
      actions: [
        { label: 'Cancel', class: 'btn-ghost' },
        {
          label: 'Delete everything',
          class: 'btn-danger',
          icon: 'trash',
          closeOnClick: false,
          onClick: async ({ setBusy }) => {
            setBusy(true, 'Wiping…');
            try {
              await app.wipeVault(password.value);
            } finally {
              setBusy(false);
            }
            return true;
          }
        }
      ]
    });
  }

  // ========================================================== VAULT HEALTH

  /**
   * Analyse every password item: weak, reused, stale (>1 year) and missing
   * passwords. 100% client-side — nothing leaves the decrypted session.
   */
  function healthReport(app) {
    const passwords = app.state.items.filter((i) => i.type === 'password' && i.plain);
    const weak = [];
    const empty = [];
    const stale = [];
    const byPassword = new Map();
    for (const item of passwords) {
      const password = item.plain.password || '';
      if (!password) {
        empty.push(item);
        continue;
      }
      if (global.VaultCrypto.passwordStrength(password) <= 1) weak.push(item);
      const updated = new Date(item.updatedAt).getTime();
      if (Number.isFinite(updated) && Date.now() - updated > 365 * 86400000) stale.push(item);
      if (!byPassword.has(password)) byPassword.set(password, []);
      byPassword.get(password).push(item);
    }
    const reused = Array.from(byPassword.values()).filter((group) => group.length > 1);
    const flagged = new Set([...weak, ...empty, ...stale]);
    for (const group of reused) for (const item of group) flagged.add(item);
    const healthy = passwords.length - flagged.size;
    return {
      total: passwords.length,
      weak,
      reused,
      stale,
      empty,
      healthy,
      score: passwords.length ? Math.round((healthy / passwords.length) * 100) : null
    };
  }

  function openHealthModal(app) {
    const report = healthReport(app);
    openModal({
      title: 'Vault health',
      wide: true,
      content: (body, modalApi) => {
        if (!report.total) {
          body.appendChild(
            el('div', { class: 'empty', style: { padding: '18px 0' } }, [
              el('div', { class: 'empty-icon', html: icon('activity', 26) }),
              el('h3', { text: 'Nothing to check yet' }),
              el('p', { text: 'Add a few passwords and come back — this report checks them for weak, reused, stale and missing passwords, entirely on this device.' })
            ])
          );
          return;
        }

        const grade =
          report.score >= 90 ? ['Excellent', 'good'] :
          report.score >= 70 ? ['Good', 'okay'] :
          report.score >= 40 ? ['Could be better', 'warn'] :
          ['Needs work', 'bad'];
        const issues = report.total - report.healthy;

        body.appendChild(
          el('div', { class: 'stats' }, [
            el('div', { class: 'stat' }, [
              el('b', { text: `${report.score}%` }),
              el('span', { text: `Health score · ${grade[0]}` })
            ]),
            el('div', { class: 'stat' }, [el('b', { text: String(report.total) }), el('span', { text: 'Passwords' })]),
            el('div', { class: 'stat' }, [el('b', { text: String(issues) }), el('span', { text: issues === 1 ? 'Needs attention' : 'Need attention' })])
          ])
        );

        if (!issues) {
          body.appendChild(
            el('div', { class: 'notice ok', style: { marginTop: '14px' }, html: icon('check', 15) }, [
              el('span', { text: 'No weak, reused, stale or missing passwords. Keep it up!' })
            ])
          );
          return;
        }

        const itemRow = (item) =>
          el('button', {
            class: 'health-item',
            type: 'button',
            onclick: () => {
              modalApi.close();
              app.openItemModal(item);
            }
          }, [
            el('span', { class: 'health-item-title', text: item.title || 'Untitled' }),
            el('span', { class: 'small muted', text: item.plain.username || item.plain.url || '' })
          ]);

        const section = (title, hint, children) =>
          el('div', { class: 'settings-section' }, [
            el('h4', { text: title }),
            hint ? el('p', { class: 'small muted', style: { margin: '0 0 8px' }, text: hint }) : null,
            el('div', { class: 'health-list' }, children)
          ]);

        if (report.weak.length) {
          body.appendChild(section(`Weak passwords (${report.weak.length})`, 'Easy to guess — replace them with generated ones.', report.weak.map(itemRow)));
        }
        if (report.reused.length) {
          body.appendChild(
            section(`Reused passwords (${report.reused.length} groups)`, 'The same password on several sites — one leak opens them all.', report.reused.map((group) =>
              el('div', { class: 'health-group' }, [
                el('div', { class: 'small muted', text: `Used ${group.length}×` }),
                el('div', { class: 'health-list' }, group.map(itemRow))
              ])
            ))
          );
        }
        if (report.stale.length) {
          body.appendChild(section(`Not updated in over a year (${report.stale.length})`, 'Old passwords deserve a refresh now and then.', report.stale.map(itemRow)));
        }
        if (report.empty.length) {
          body.appendChild(section(`Missing passwords (${report.empty.length})`, 'These items have no password stored.', report.empty.map(itemRow)));
        }
      },
      actions: [{ label: 'Done', class: 'btn-primary' }]
    });
  }

  // ====================================================== UPDATE AVAILABLE

  /** Shown by Settings → "Check for updates" when a newer release exists. */
  function openUpdateModal(info) {
    openModal({
      title: 'Update available',
      content: (body) => {
        body.appendChild(
          el('p', { class: 'small', text: `OmniVault ${info.latest} is available — you are running v${info.current}.` })
        );
        body.appendChild(
          el('p', {
            class: 'small muted',
            text: 'Grab the new APK from the release page and install it over this one. On Android the app can also update itself from the system menu (⋮ → Check for updates).'
          })
        );
        body.appendChild(
          el('a', {
            href: info.url,
            target: '_blank',
            rel: 'noopener noreferrer',
            class: 'btn btn-primary',
            style: { display: 'inline-flex', alignItems: 'center', gap: '8px', marginTop: '4px' },
            html: icon('external', 16) + '<span>Open release page</span>'
          })
        );
      },
      actions: [{ label: 'Later', class: 'btn-ghost' }]
    });
  }

  global.Views = {
    renderAuth,
    renderLock,
    renderVault,
    openItemModal,
    openImageView,
    openGeneratorModal,
    openSettingsModal,
    openChangePasswordModal,
    openWipeModal,
    openHealthModal,
    showRecoveryCode,
    openResetModal,
    openExportModal,
    openUpdateModal,
    TAB_LABELS
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.Views;
})(typeof window !== 'undefined' ? window : globalThis);
