// DOM helpers: escaping, toasts, bottom sheets, and the small editors
// (number / text / datetime / select) used across screens.

let toastEl = null;
let toastTimer = null;

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Toasts double as a polite live region so screen readers hear confirmations
// ("Session saved") without focus moving. tone 'error' styles the pill red and
// stays up longer, since those messages usually need acting on.
export function toast(msg, { tone = 'info' } = {}) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    toastEl.setAttribute('role', 'status');
    toastEl.setAttribute('aria-live', 'polite');
    toastEl.setAttribute('aria-atomic', 'true');
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.classList.toggle('error', tone === 'error');
  // Restart the entrance even when a toast is already showing.
  toastEl.classList.remove('show');
  void toastEl.offsetWidth;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), tone === 'error' ? 4000 : 2400);
}

// Rows built as <div> (field rows in the start / live / detail screens) get
// button semantics when a screen wires a tap handler on them, so keyboard and
// screen-reader users can reach and activate them. Idempotent.
export function makeActivatable(el) {
  if (!el || el.dataset.activatable) return el;
  el.dataset.activatable = '1';
  if (!/^(BUTTON|A|INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) {
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    el.addEventListener('keydown', e => {
      if (e.target !== el) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); }
    });
  }
  return el;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(container) {
  return [...container.querySelectorAll(FOCUSABLE)].filter(el => el.offsetParent !== null || el === document.activeElement);
}

let currentSheet = null;

export function isSheetOpen() { return currentSheet !== null; }

// Close any open sheet; called on every route change so navigation always
// dismisses overlays (a sheet must never survive a route render).
export function closeSheets() {
  // The route render that follows owns focus, so do not bounce it back to the
  // (about to be replaced) opener.
  if (currentSheet) currentSheet.close({ restoreFocus: false });
}

let sheetSeq = 0;

// Bottom sheet. onMount(sheetEl, close) attaches listeners.
export function openSheet({ title = '', bodyHtml = '', onMount = null }) {
  // Focus returns to whatever opened the sheet (a row, a + button) on close.
  const opener = currentSheet ? currentSheet.opener : document.activeElement;
  if (currentSheet) currentSheet.close({ restoreFocus: false });
  const titleId = `sheet-title-${++sheetSeq}`;
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  backdrop.innerHTML =
    `<div class="sheet" role="dialog" aria-modal="true" tabindex="-1" ${title ? `aria-labelledby="${titleId}"` : 'aria-label="Options"'}>
      <div class="sheet-grab" aria-hidden="true"></div>
      ${title ? `<div class="sheet-title" id="${titleId}">${esc(title)}</div>` : ''}
      <div class="sheet-body">${bodyHtml}</div>
    </div>`;
  document.body.appendChild(backdrop);
  const sheet = backdrop.querySelector('.sheet');
  const close = ({ restoreFocus = true } = {}) => {
    backdrop.remove();
    if (currentSheet === api) currentSheet = null;
    if (restoreFocus && opener && opener.isConnected && typeof opener.focus === 'function') {
      opener.focus({ preventScroll: true });
    }
  };
  const api = { close, sheet, opener };
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });
  // Escape dismisses; Tab cycles inside the sheet while it is open.
  backdrop.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    const items = focusables(sheet);
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    const a = document.activeElement;
    if (e.shiftKey && (a === first || a === sheet)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  currentSheet = api;
  if (onMount) onMount(sheet, close);
  // Editors focus their own input in onMount. Otherwise focus the dialog
  // itself (not its first control): screen readers announce the title, and no
  // date picker or keyboard pops open on mobile. Tab then enters the sheet.
  if (!sheet.contains(document.activeElement)) sheet.focus({ preventScroll: true });
  return api;
}

export function confirmSheet({ title, message, confirmLabel = 'Confirm', danger = false, onConfirm }) {
  openSheet({
    title,
    bodyHtml:
      `<p class="confirm-msg" style="padding:12px 4px;color:var(--text-secondary);font-size:15px;line-height:1.5">${esc(message)}</p>
       <div class="sheet-actions">
         <button class="btn-secondary" data-act="cancel" style="margin-top:0">Cancel</button>
         <button class="${danger ? 'btn-primary danger' : 'btn-primary'}" data-act="ok" style="margin-top:0">${esc(confirmLabel)}</button>
       </div>`,
    onMount(sheet, close) {
      sheet.querySelector('[data-act=cancel]').addEventListener('click', close);
      sheet.querySelector('[data-act=ok]').addEventListener('click', () => { close(); onConfirm(); });
    },
  });
}

// Numeric field editor. onSave receives a number, or null when cleared (allowEmpty).
export function numberSheet({ title, label, value, step = '0.01', min = 0, allowEmpty = false, onSave }) {
  openSheet({
    title,
    bodyHtml:
      `<label class="field"><span class="field-label">${esc(label)}</span>
        <input class="input" data-role="val" type="number" inputmode="decimal" step="${step}"
          ${min === null ? '' : `min="${min}"`}
          value="${value === null || value === undefined ? '' : esc(String(value))}">
      </label>
      <div class="sheet-error" data-role="err" hidden></div>
      <button class="btn-primary" data-act="save">Save</button>`,
    onMount(sheet, close) {
      const input = sheet.querySelector('[data-role=val]');
      const err = sheet.querySelector('[data-role=err]');
      const fail = msg => { err.textContent = msg; err.hidden = false; input.classList.add('invalid'); };
      sheet.querySelector('[data-act=save]').addEventListener('click', () => {
        const raw = input.value.trim();
        if (raw === '') {
          if (allowEmpty) { close(); onSave(null); return; }
          fail('Enter a value'); return;
        }
        const v = Number(raw);
        if (!Number.isFinite(v)) { fail('Enter a valid number'); return; }
        close(); onSave(v);
      });
      input.focus();
    },
  });
}

// Free-text editor (comment, opponents, names). Empty -> null.
export function textSheet({ title, label, value, multiline = true, onSave }) {
  openSheet({
    title,
    bodyHtml:
      `<label class="field"><span class="field-label">${esc(label)}</span>
        ${multiline
          ? `<textarea class="input" data-role="val" rows="4">${esc(value ?? '')}</textarea>`
          : `<input class="input" data-role="val" type="text" value="${esc(value ?? '')}">`}
      </label>
      <button class="btn-primary" data-act="save">Save</button>`,
    onMount(sheet, close) {
      const input = sheet.querySelector('[data-role=val]');
      sheet.querySelector('[data-act=save]').addEventListener('click', () => {
        const v = input.value.trim();
        close(); onSave(v === '' ? null : v);
      });
      input.focus();
    },
  });
}

// datetime-local editor with optional future blocking. onSave receives a Date.
export function dateTimeSheet({ title, value, blockFuture = true, onSave }) {
  openSheet({
    title,
    bodyHtml:
      `<label class="field"><span class="field-label">Date and time</span>
        <input class="input" data-role="val" type="datetime-local" value="${esc(value)}">
      </label>
      <div class="sheet-error" data-role="err" hidden></div>
      <button class="btn-primary" data-act="save">Save</button>`,
    onMount(sheet, close) {
      const input = sheet.querySelector('[data-role=val]');
      const err = sheet.querySelector('[data-role=err]');
      sheet.querySelector('[data-act=save]').addEventListener('click', () => {
        const d = new Date(input.value);
        if (!input.value || Number.isNaN(d.getTime())) {
          err.textContent = 'Enter a valid date and time'; err.hidden = false; return;
        }
        if (blockFuture && d.getTime() > Date.now()) {
          err.textContent = 'Time cannot be in the future'; err.hidden = false; return;
        }
        close(); onSave(d);
      });
    },
  });
}

// Choice list. Options: [{id, name}]. onSave({id}) for existing, {newName} for added.
export function selectSheet({ title, options, selectedId, allowNone = false, addPlaceholder = null, onSave }) {
  const rows = [];
  if (allowNone) {
    rows.push(`<button class="sheet-row" data-id=""><span class="sr-label">None</span>${selectedId == null ? '<span class="icon check">✓</span>' : ''}</button>`);
  }
  for (const o of options) {
    const check = o.id === selectedId ? '<span class="icon check">✓</span>' : '';
    rows.push(`<button class="sheet-row" data-id="${esc(o.id)}"><span class="sr-label">${esc(o.name)}</span>${check}</button>`);
  }
  if (addPlaceholder) {
    rows.push(
      `<div class="field" style="margin-top:14px">
        <span class="field-label">${esc(addPlaceholder)}</span>
        <div style="display:flex;gap:8px">
          <input class="input" data-role="new" type="text" placeholder="Name">
          <button class="btn-primary" data-act="add" style="width:auto;margin:0;padding:12px 18px">Add</button>
        </div>
      </div>`);
  }
  openSheet({
    title,
    bodyHtml: rows.join(''),
    onMount(sheet, close) {
      sheet.querySelectorAll('.sheet-row[data-id]').forEach(btn => {
        btn.addEventListener('click', () => { close(); onSave({ id: btn.dataset.id || null }); });
      });
      const addBtn = sheet.querySelector('[data-act=add]');
      if (addBtn) {
        addBtn.addEventListener('click', () => {
          const v = sheet.querySelector('[data-role=new]').value.trim();
          if (!v) return;
          close(); onSave({ newName: v });
        });
      }
    },
  });
}
