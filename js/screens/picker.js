// Shared selection sheets (list pickers and numeric ranges) used by the
// live and detail screens.

import { selectSheet } from '../ui.js';

// doc + listKey choose the entity list; onPick receives the chosen id.
export function pickRef(doc, title, listKey, onPick) {
  selectSheet({
    title,
    options: doc[listKey],
    selectedId: null,
    allowNone: false,
    onSave: sel => { if (sel && sel.id) onPick(sel.id); },
  });
}

export function pickNumber(title, value, min, max, onPick, suffix = '') {
  const opts = [];
  for (let i = min; i <= max; i++) opts.push({ id: String(i), name: i + suffix });
  selectSheet({
    title, options: opts, selectedId: String(value), allowNone: false,
    onSave: sel => onPick(Number(sel.id)),
  });
}
