// Sell Action sheet (brief 5.6): percentage, markup (default 1.0), backer
// name. Lists existing actions with delete; total sold can never exceed 100%.
//
// The sheet is storage-agnostic: the start form keeps pending actions in its
// own state (a store mutation would re-render and reset the form), while live
// and detail screens persist straight through domain.addSellAction.

import { icon } from '../icons.js';
import { esc, openSheet } from '../ui.js';
import { fmtNum } from '../format.js';
import { sellActionError, soldPercent } from '../staking.js';

export function sellSummary(actions) {
  const p = soldPercent(actions);
  return p > 0 ? `${fmtNum(p)}% sold` : 'None';
}

function actionLine(a) {
  const mk = a.markup === null || a.markup === undefined ? 1 : Number(a.markup);
  return `${fmtNum(a.percentage)}% · x${fmtNum(mk)}${a.backer_name ? ' · ' + esc(a.backer_name) : ''}`;
}

// actions: current list. onAdd({percentage, markup, backer_name}); onDelete(id).
export function openSellSheet({ actions, onAdd, onDelete }) {
  const sold = soldPercent(actions);
  const list = actions.length
    ? `<div class="field-label" style="margin-top:6px">Sold so far · ${fmtNum(sold)}% (${fmtNum(Math.max(0, 100 - sold))}% left)</div>
       ${actions.map(a => `
         <div class="sheet-row sell-row" data-sell="${esc(a.id)}">
           <span class="sr-label">${actionLine(a)}</span>
           <button class="topbtn sell-del" data-del="${esc(a.id)}" aria-label="Delete sell action">${icon('trash')}</button>
         </div>`).join('')}`
    : '<p class="hint" style="padding:4px 0 2px">No action sold yet.</p>';
  openSheet({
    title: 'Sell action',
    bodyHtml: `
      ${list}
      <div class="stakes-inputs">
        <label class="field"><span class="field-label">Percentage (%)</span>
          <input class="input" data-role="pct" type="number" inputmode="decimal" step="0.1" min="0" max="100" placeholder="e.g. 30"></label>
        <label class="field"><span class="field-label">Markup</span>
          <input class="input" data-role="mk" type="number" inputmode="decimal" step="0.01" min="0" value="1.0"></label>
      </div>
      <label class="field"><span class="field-label">Backer name</span>
        <input class="input" data-role="backer" type="text" placeholder="Optional"></label>
      <p class="hint" style="margin-top:8px">Markup 1.2 = 20% premium on the share's buy-in.</p>
      <div class="sheet-error" data-role="err" hidden></div>
      <button class="btn-primary" data-act="save" ${sold >= 100 ? 'disabled' : ''}>Save</button>`,
    onMount(sheet, close) {
      const err = sheet.querySelector('[data-role=err]');
      sheet.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
        close(); onDelete(b.dataset.del);
      }));
      sheet.querySelector('[data-act=save]').addEventListener('click', () => {
        const pct = sheet.querySelector('[data-role=pct]').value;
        const mk = sheet.querySelector('[data-role=mk]').value;
        const msg = sellActionError(actions, pct, mk);
        if (msg) { err.textContent = msg; err.hidden = false; return; }
        const backer = sheet.querySelector('[data-role=backer]').value;
        close();
        onAdd({ percentage: pct, markup: mk, backer_name: backer });
      });
      sheet.querySelector('[data-role=pct]').focus();
    },
  });
}
