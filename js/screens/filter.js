// Filter bottom sheet + header affordances (brief section 9).
// Each tab ('feed' | 'stats') owns its filter; the sheet edits a draft and
// only Apply (or Clear all) commits it through filters.setFilter().

import { getState } from '../store.js';
import { icon } from '../icons.js';
import { esc, openSheet } from '../ui.js';
import { RANGES, emptyFilter, getFilter, setFilter, clearFilter, isActive, summary, stakesOptions } from '../filters.js';
import { localInputValue } from '../dates.js';

// Filter button with the green "active" dot.
export function filterButtonHtml(doc, tab) {
  const active = isActive(getFilter(doc, tab));
  return `<button class="topbtn filter-btn" data-act="filter" aria-label="Filter${active ? ' (active)' : ''}">
    ${icon('filter')}${active ? '<span class="filter-dot" aria-hidden="true"></span>' : ''}
  </button>`;
}

// Summary pill under the header, e.g. "Last 30 days · Cash · UCD" with X.
export function filterPillHtml(doc, tab) {
  const f = getFilter(doc, tab);
  if (!isActive(f)) return '';
  return `<div class="filter-pill-row">
    <button class="filter-pill" data-act="filter" aria-label="Edit filter">
      <span class="filter-pill-text">${esc(summary(doc, f))}</span>
    </button>
    <button class="filter-pill-x" data-act="filter-clear" aria-label="Clear filter">${icon('x')}</button>
  </div>`;
}

export function wireFilter(root, tab) {
  root.querySelectorAll('[data-act=filter]').forEach(b => b.addEventListener('click', () => openFilterSheet(tab)));
  const x = root.querySelector('[data-act=filter-clear]');
  if (x) x.addEventListener('click', () => clearFilter(tab));
}

function chip(group, value, label, on) {
  return `<button type="button" class="chip${on ? ' active' : ''}" data-group="${group}" data-value="${esc(value)}"
    aria-pressed="${on}">${esc(label)}</button>`;
}

export function openFilterSheet(tab) {
  const doc = getState();
  const draft = JSON.parse(JSON.stringify(getFilter(doc, tab)));

  function multi(group, key, options, emptyText) {
    if (!options.length) return `<div class="filter-empty">${esc(emptyText)}</div>`;
    return `<div class="chips">${options.map(o => chip(group, o.id, o.name, draft[key].includes(o.id))).join('')}</div>`;
  }

  function body() {
    const today = localInputValue(new Date(), 'date');
    return `
      <div class="filter-section">
        <div class="field-label">Date range</div>
        <div class="chips">${RANGES.map(([k, label]) => chip('range', k, label, draft.range === k)).join('')}</div>
        ${draft.range === 'custom' ? `
          <div class="stakes-inputs" style="margin-top:10px">
            <label class="field" style="margin-top:0"><span class="field-label">From</span>
              <input class="input" type="date" data-role="from" max="${today}" value="${esc(draft.from || '')}"></label>
            <label class="field" style="margin-top:0"><span class="field-label">To</span>
              <input class="input" type="date" data-role="to" max="${today}" value="${esc(draft.to || '')}"></label>
          </div>` : ''}
      </div>
      <div class="filter-section">
        <div class="field-label">Session kind</div>
        <div class="chips">${[['cash', 'Cash'], ['tournament', 'Tournament'], ['both', 'Both']]
          .map(([k, l]) => chip('kind', k, l, draft.kind === k)).join('')}</div>
      </div>
      <div class="filter-section"><div class="field-label">Game</div>
        ${multi('game_ids', 'game_ids', doc.games, 'No games yet')}</div>
      <div class="filter-section"><div class="field-label">Stakes</div>
        ${multi('stakes', 'stakes', stakesOptions(doc).map(k => ({ id: k, name: k })), 'No cash stakes yet')}</div>
      <div class="filter-section"><div class="field-label">Tournament type</div>
        ${multi('tournament_type_ids', 'tournament_type_ids', doc.tournament_types, 'No tournament types yet')}</div>
      <div class="filter-section"><div class="field-label">Location</div>
        ${multi('location_ids', 'location_ids', doc.locations, 'No locations yet')}</div>
      <div class="filter-section"><div class="field-label">Bankroll</div>
        ${multi('bankroll_ids', 'bankroll_ids', doc.bankrolls, 'No bankrolls yet')}</div>
      <div class="filter-section"><div class="field-label">Group</div>
        ${multi('group_ids', 'group_ids', doc.groups || [], 'No groups yet')}</div>
      <div class="sheet-error" data-role="err" hidden></div>
      <div class="sheet-actions filter-actions">
        <button class="btn-secondary" data-act="clear">Clear all</button>
        <button class="btn-primary" data-act="apply">Apply</button>
      </div>`;
  }

  openSheet({
    title: tab === 'feed' ? 'Filter feed' : 'Filter statistics',
    bodyHtml: `<div data-role="filter-body">${body()}</div>`,
    onMount(sheet, close) {
      const host = sheet.querySelector('[data-role=filter-body]');
      const rerender = () => { host.innerHTML = body(); wire(); };
      function wire() {
        host.querySelectorAll('.chip[data-group]').forEach(btn => btn.addEventListener('click', () => {
          const g = btn.dataset.group, v = btn.dataset.value;
          if (g === 'range') {
            draft.range = v;
            if (v !== 'custom') { draft.from = null; draft.to = null; }
          } else if (g === 'kind') {
            draft.kind = v;
          } else {
            const arr = draft[g];
            const i = arr.indexOf(v);
            if (i >= 0) arr.splice(i, 1); else arr.push(v);
          }
          rerender();
        }));
        const from = host.querySelector('[data-role=from]');
        const to = host.querySelector('[data-role=to]');
        if (from) from.addEventListener('change', () => { draft.from = from.value || null; });
        if (to) to.addEventListener('change', () => { draft.to = to.value || null; });
        host.querySelector('[data-act=clear]').addEventListener('click', () => {
          close(); setFilter(tab, emptyFilter());
        });
        host.querySelector('[data-act=apply]').addEventListener('click', () => {
          const err = host.querySelector('[data-role=err]');
          if (draft.range === 'custom') {
            if (!draft.from && !draft.to) { err.textContent = 'Pick a start or end date'; err.hidden = false; return; }
            if (draft.from && draft.to && draft.from > draft.to) {
              err.textContent = 'Start date must be before end date'; err.hidden = false; return;
            }
          }
          close(); setFilter(tab, draft);
        });
      }
      wire();
    },
  });
}
