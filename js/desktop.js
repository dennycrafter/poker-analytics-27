// Desktop dialog behavior for modal routes (STEP C). On phones a modal route
// (start form, live, stack, detail, hand/note view) is a full-screen slide-up;
// at the desktop breakpoint CSS renders it as a centered card over a dimmed
// backdrop, and this module gives that card dialog semantics:
//   - role="dialog" + aria-modal + aria-labelledby (re-applied whenever a
//     screen re-renders its own markup),
//   - Escape triggers the screen's own Back / Cancel control,
//   - Tab stays inside the card,
//   - closing returns focus to the control that opened it.
// Below the breakpoint nothing here acts, so mobile behavior is unchanged.

import { isDesktop } from './layout.js';
import { isSheetOpen } from './ui.js';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Routes whose card holds unsaved typing: a stray backdrop click must not
// discard it (Escape and Cancel still close, as on mobile).
const NO_BACKDROP_CLOSE_RE = /^#?\/new\//;

let modalOpen = false;
let openerKey = null;

const screenEl = () => document.getElementById('screen');
const modalEl = () => {
  const s = screenEl();
  return s ? s.querySelector(':scope > .modal-screen') : null;
};

// A selector that finds "the same control" after the screen re-renders, since
// the element that opened the dialog is replaced while the dialog is open.
export function restoreKeyFor(el) {
  if (!el || !el.getAttribute || el.closest('.sheet-backdrop')) return null;
  const quote = v => `"${String(v).replace(/["\\]/g, '\\$&')}"`;
  const href = el.getAttribute('href');
  if (href) return `[href=${quote(href)}]`;
  for (const attr of ['data-act', 'data-tab', 'data-metric', 'data-row']) {
    const v = el.getAttribute(attr);
    if (v) return `[${attr}=${quote(v)}]`;
  }
  return null;
}

function decorate(modal) {
  if (modal.getAttribute('role') === 'dialog') return;
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.tabIndex = -1;
  const h1 = modal.querySelector('.topbar h1');
  if (h1) {
    if (!h1.id) h1.id = 'modal-route-title';
    modal.setAttribute('aria-labelledby', h1.id);
  }
}

function undecorate(modal) {
  for (const a of ['role', 'aria-modal', 'aria-labelledby', 'tabindex']) modal.removeAttribute(a);
}

// Called after every route render with the element that had focus before it.
export function syncModalDialog(prevActive, desktop = isDesktop()) {
  const modal = modalEl();
  if (modal && desktop) {
    if (!modalOpen) {
      openerKey = restoreKeyFor(prevActive);
      modalOpen = true;
    }
    decorate(modal);
    document.body.classList.add('modal-open');
    // The router focuses #screen after navigating; move that into the card so
    // screen readers announce the dialog and Tab starts inside it.
    if (document.activeElement === screenEl() || document.activeElement === document.body) {
      modal.focus({ preventScroll: true });
    }
    return;
  }
  if (modal && !desktop) undecorate(modal);
  document.body.classList.remove('modal-open');
  if (!modalOpen) return;
  modalOpen = false;
  const key = openerKey;
  openerKey = null;
  if (!desktop || modal || !key) return;
  const target = screenEl().querySelector(key);
  if (target) target.focus();
}

function closeControl(modal) {
  return modal.querySelector('.topbar [data-act=back], .topbar [data-act=cancel]');
}

function onKeydown(e) {
  if (!isDesktop() || e.defaultPrevented || isSheetOpen()) return;
  const modal = modalEl();
  if (!modal) return;
  if (e.key === 'Escape') {
    const btn = closeControl(modal);
    if (btn) { e.preventDefault(); btn.click(); }
    return;
  }
  if (e.key !== 'Tab') return;
  const items = [...modal.querySelectorAll(FOCUSABLE)].filter(el => el.offsetParent !== null);
  if (!items.length) { e.preventDefault(); return; }
  const first = items[0];
  const last = items[items.length - 1];
  const a = document.activeElement;
  if (!modal.contains(a) || a === modal) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  } else if (e.shiftKey && a === first) {
    e.preventDefault(); last.focus();
  } else if (!e.shiftKey && a === last) {
    e.preventDefault(); first.focus();
  }
}

// The backdrop is #screen's ::before, so a click on it targets #screen itself.
function onScreenClick(e) {
  if (!isDesktop() || e.target !== screenEl() || isSheetOpen()) return;
  const modal = modalEl();
  if (!modal || NO_BACKDROP_CLOSE_RE.test(location.hash)) return;
  const btn = closeControl(modal);
  if (btn) btn.click();
}

let installed = false;

// Wires the document-level listeners once the shell exists. Screens that
// re-render their own markup (live view edits) replace the card element, so a
// MutationObserver re-applies the dialog attributes.
export function installDesktopDialogs() {
  if (installed) return;
  installed = true;
  document.addEventListener('keydown', onKeydown);
  document.addEventListener('click', onScreenClick);
}

export function observeScreen(screen) {
  const mo = new MutationObserver(() => {
    const modal = modalEl();
    if (modal && isDesktop()) decorate(modal);
  });
  mo.observe(screen, { childList: true });
  return () => mo.disconnect();
}
