// DOM helpers: escaping, toasts, bottom sheets, and the small editors
// (number / text / datetime / select) used across screens.

let toastEl = null;
let toastTimer = null;

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function toast(msg) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2400);
}

let currentSheet = null;

// Close any open sheet; called on every route change so navigation always
// dismisses overlays (a sheet must never survive a route render).
export function closeSheets() {
  if (currentSheet) currentSheet.close();
}

// Bottom sheet. onMount(sheetEl, close) attaches listeners.
export function openSheet({ title = '', bodyHtml = '', onMount = null }) {
  if (currentSheet) currentSheet.close();
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  backdrop.innerHTML =
    `<div class="sheet" role="dialog" aria-modal="true">
      <div class="sheet-grab"></div>
      ${title ? `<div class="sheet-title">${esc(title)}</div>` : ''}
      <div class="sheet-body">${bodyHtml}</div>
    </div>`;
  document.body.appendChild(backdrop);
  const close = () => { backdrop.remove(); if (currentSheet === api) currentSheet = null; };
  const api = { close, sheet: backdrop.querySelector('.sheet') };
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });
  currentSheet = api;
  if (onMount) onMount(api.sheet, close);
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
