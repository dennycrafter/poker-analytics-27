// Bankroll (brief 5.15): total-over-time chart, TOTAL + RISK OF RUIN, list of
// bankrolls; detail with Global section, transactions grouped by kind, and
// add / edit / delete transaction. Math lives in bankroll.js.

import { navigate } from '../router.js';
import { getState } from '../store.js';
import { icon } from '../icons.js';
import { esc, toast, openSheet, confirmSheet, textSheet } from '../ui.js';
import { fmtMoney, moneyClass, fmtDateShort, getCurrency, toLocalInputValue, fromLocalInputValue, fmtNum } from '../format.js';
import { lineChart } from '../charts/svg.js';
import { chartBox } from '../layout.js';
import { TXN_KINDS, txnSigned, signedAmount, transactionError, bankrollSummary, bankrollSeries, rorBand, bankrollTransactions } from '../bankroll.js';
import { buildWinrateSensitivityRows, rorPercent } from '../bankroll-ror-ui.js';
import { addTransaction, updateTransaction, deleteTransaction, addBankroll, renameMasterItem, setDefaultBankroll, deleteMasterItem } from '../domain.js';
import { masterNameError, masterDeleteError } from '../manage.js';

function topbar(title, right = '<span class="topbtn" style="visibility:hidden"></span>', back = '/more') {
  return `<header class="topbar">
    <button class="topbtn" data-act="back" data-to="${back}" aria-label="Back">${icon('back')}</button>
    <h1>${esc(title)}</h1>
    ${right}
  </header>`;
}

function wireBack(root) {
  const b = root.querySelector('[data-act=back]');
  if (b) b.addEventListener('click', () => navigate(b.dataset.to));
}

function rorHtml(ror) {
  return ror === null ? '<span class="dim">--</span>' : `<span class="${rorBand(ror)}">${ror}%</span>`;
}

// "What if your winrate is wrong?" (brief section 4): the same hourly mean
// and SD behind the headline RoR, replayed at 70% and 30% of the winrate and
// at break even, against the bankroll this screen already computes. The
// formulas live in bankroll-ror-ui.js (brief section 7).
function sensitivityHtml(summary, cur) {
  const m = summary.moments;
  if (!m) return '';
  const rows = buildWinrateSensitivityRows({
    winrate: m.mean, sd: Math.sqrt(m.variance), bankroll: summary.total,
  });
  if (!rows) return '';
  const body = rows.map(r => `<div class="field-row txn-row">
      <span class="field-name"><span>${esc(r.label)}</span><span class="hint">${esc(fmtMoney(r.winrate, cur))}/h</span></span>
      <span class="field-value">${rorHtml(rorPercent(r.ror))}<span class="hint">${r.bankrollFor5 === null ? '--' : 'need ' + esc(fmtMoney(Math.round(r.bankrollFor5), cur))}</span></span>
    </div>`).join('');
  return `
    <div class="section-label" style="padding-left:0">What if your winrate is wrong?</div>
    <p class="hint ror-note">Each row: risk of ruin at your current bankroll, and the bankroll that keeps risk at 5%.</p>
    <div class="rows" style="padding:0">${body}</div>
    <p class="hint ror-note">Assumes you never move down. Moving down when you lose a lot of your bankroll makes real risk much lower.</p>`;
}

function chartHtml(doc, bankrollId) {
  const pts = bankrollSeries(doc, bankrollId).map(p => ({ x: p.t, y: p.y }));
  return lineChart({ points: pts, ...chartBox(340, 140) });
}

export function defaultBankrollId(doc) {
  const b = doc.bankrolls.find(x => x.is_default) || doc.bankrolls[0];
  return b ? b.id : null;
}

// Add / edit transaction. `txn` = existing row to edit, else a new one.
export function openTransactionSheet({ bankrollId = null, txn = null } = {}) {
  const doc = getState();
  const cur = getCurrency(doc);
  if (!doc.bankrolls.length) { toast('Create a bankroll first'); return; }
  const st = {
    kind: txn ? txn.kind : 'deposit',
    direction: txn && txn.kind === 'other' && Number(txn.amount) > 0 ? 'in' : 'out',
    bankroll_id: txn ? txn.bankroll_id : (bankrollId || defaultBankrollId(doc)),
  };
  const amount = txn ? fmtNum(Math.abs(Number(txn.amount))) : '';
  const when = txn ? new Date(txn.occurred_at) : new Date();
  const bankOpts = doc.bankrolls.map(b =>
    `<option value="${esc(b.id)}" ${b.id === st.bankroll_id ? 'selected' : ''}>${esc(b.name)}</option>`).join('');
  openSheet({
    title: txn ? 'Edit transaction' : 'Add transaction',
    bodyHtml: `
      <div class="segmented" role="tablist" style="padding:0 0 12px">
        ${TXN_KINDS.map(k => `<button role="tab" data-kind="${k.id}" aria-selected="${st.kind === k.id}" class="${st.kind === k.id ? 'active' : ''}">${k.label}</button>`).join('')}
      </div>
      <div class="segmented" role="tablist" data-role="dir" style="padding:0 0 12px" ${st.kind === 'other' ? '' : 'hidden'}>
        <button role="tab" data-dir="out" class="${st.direction === 'out' ? 'active' : ''}">Expense</button>
        <button role="tab" data-dir="in" class="${st.direction === 'in' ? 'active' : ''}">Income</button>
      </div>
      <label class="field"><span class="field-label">Amount (${esc(cur)})</span>
        <input class="input" data-role="amt" type="number" inputmode="decimal" step="0.01" min="0" value="${esc(amount)}" placeholder="0"></label>
      <label class="field"><span class="field-label">Description</span>
        <input class="input" data-role="desc" type="text" value="${esc(txn ? txn.description || '' : '')}" placeholder="Optional"></label>
      <div class="stakes-inputs">
        <label class="field"><span class="field-label">Date</span>
          <input class="input" data-role="when" type="datetime-local" value="${toLocalInputValue(when)}"></label>
        <label class="field"><span class="field-label">Bankroll</span>
          <select class="input" data-role="bank">${bankOpts}</select></label>
      </div>
      <div class="sheet-error" data-role="err" hidden></div>
      <button class="btn-primary" data-act="save">Save</button>
      ${txn ? '<button class="btn-danger" data-act="del" style="margin-top:10px">Delete transaction</button>' : ''}`,
    onMount(sheet, close) {
      const err = sheet.querySelector('[data-role=err]');
      const dir = sheet.querySelector('[data-role=dir]');
      sheet.querySelectorAll('[data-kind]').forEach(b => b.addEventListener('click', () => {
        st.kind = b.dataset.kind;
        sheet.querySelectorAll('[data-kind]').forEach(x => {
          x.classList.toggle('active', x === b); x.setAttribute('aria-selected', String(x === b));
        });
        dir.hidden = st.kind !== 'other';
      }));
      sheet.querySelectorAll('[data-dir]').forEach(b => b.addEventListener('click', () => {
        st.direction = b.dataset.dir;
        sheet.querySelectorAll('[data-dir]').forEach(x => x.classList.toggle('active', x === b));
      }));
      sheet.querySelector('[data-act=save]').addEventListener('click', () => {
        const amountRaw = sheet.querySelector('[data-role=amt]').value;
        const occurred = fromLocalInputValue(sheet.querySelector('[data-role=when]').value);
        const msg = transactionError({ kind: st.kind, amountRaw, occurredAt: occurred || NaN });
        if (msg) { err.textContent = msg; err.hidden = false; return; }
        const fields = {
          bankroll_id: sheet.querySelector('[data-role=bank]').value,
          kind: st.kind,
          amount: signedAmount(st.kind, amountRaw, st.direction),
          description: sheet.querySelector('[data-role=desc]').value.trim() || null,
          occurred_at: occurred.toISOString(),
        };
        close();
        if (txn) { updateTransaction(txn.id, fields); toast('Transaction updated'); } else { addTransaction(fields); toast('Transaction added'); }
      });
      const del = sheet.querySelector('[data-act=del]');
      if (del) del.addEventListener('click', () => {
        close();
        confirmSheet({
          title: 'Delete transaction?', message: 'This removes it from the bankroll total.',
          confirmLabel: 'Delete', danger: true,
          onConfirm() { deleteTransaction(txn.id); toast('Transaction deleted'); },
        });
      });
      if (!txn) sheet.querySelector('[data-role=amt]').focus();
    },
  });
}

export function openNewBankrollSheet() {
  textSheet({
    title: 'New bankroll', label: 'Name', value: '', multiline: false,
    onSave(v) {
      const err = masterNameError(getState(), 'bankrolls', v);
      if (err) { toast(err); return; }
      const id = addBankroll(v.trim());
      toast('Bankroll created');
      navigate('/more/bankroll/' + id);
    },
  });
}

export function BankrollScreen(root, doc) {
  const cur = getCurrency(doc);
  const all = bankrollSummary(doc, null);
  const rows = doc.bankrolls.map(b => {
    const s = bankrollSummary(doc, b.id);
    return `<a class="field-row" href="#/more/bankroll/${esc(b.id)}" data-bank="${esc(b.id)}">
      <span class="field-name">${esc(b.name)}${b.is_default ? ' <span class="hint">default</span>' : ''}</span>
      <span class="field-value"><span class="${moneyClass(s.total)}">${fmtMoney(s.total, cur)}</span>${icon('chevron', 'chev')}</span>
    </a>`;
  }).join('');
  root.innerHTML = `
    <div class="screen bankroll-screen">
      ${topbar('Bankroll', `<button class="topbtn accent" data-act="add-bank" aria-label="Add bankroll">${icon('plus')}</button>`)}
      <div class="card bank-card">
        <div class="bank-top">
          <div class="bank-col"><span class="lbl">Total</span><span class="big-num ${moneyClass(all.total)}" data-role="total">${fmtMoney(all.total, cur)}</span></div>
          <div class="bank-col right"><span class="lbl">Risk of ruin</span><span class="big-num" data-role="ror">${rorHtml(all.ror)}</span></div>
        </div>
        ${chartHtml(doc, null)}
        <div class="chart-caption">Bankroll over time</div>
      </div>
      <p class="hint ror-note">Risk of ruin = exp(-2 · mean · bankroll / variance) from your cash hourly results${all.moments ? ` (mean ${fmtMoney(all.moments.mean, cur)}/h, SD ${fmtMoney(Math.sqrt(all.moments.variance), cur)}/h)` : ''}.</p>
      ${sensitivityHtml(all, cur)}
      <div class="section-label" style="padding-left:0">Bankrolls</div>
      <div class="rows" style="padding:0">${rows || '<div class="empty-block">No bankrolls yet.</div>'}</div>
      <button class="btn-primary" data-act="add-txn">Add transaction</button>
      <div class="spacer-40"></div>
    </div>`;
  wireBack(root);
  root.querySelector('[data-act=add-bank]').addEventListener('click', openNewBankrollSheet);
  root.querySelector('[data-act=add-txn]').addEventListener('click', () => openTransactionSheet());
}

export function BankrollDetailScreen(root, doc, bankrollId) {
  const b = doc.bankrolls.find(x => x.id === bankrollId);
  if (!b) { navigate('/more/bankroll'); return; }
  const cur = getCurrency(doc);
  const s = bankrollSummary(doc, b.id);
  const txns = bankrollTransactions(doc, b.id).slice()
    .sort((x, y) => Date.parse(y.occurred_at) - Date.parse(x.occurred_at));
  const line = (label, v) => `<div class="field-row"><span class="field-name">${esc(label)}</span>
    <span class="field-value"><span class="${moneyClass(v)}">${fmtMoney(v, cur)}</span></span></div>`;
  const groups = TXN_KINDS.map(k => {
    const list = txns.filter(t => t.kind === k.id);
    if (!list.length) return '';
    const total = list.reduce((a, t) => a + txnSigned(t), 0);
    return `<div class="month-head"><span>${k.plural}</span><span class="net ${moneyClass(total)}">${fmtMoney(total, cur)}</span></div>
      ${list.map(t => `<button class="field-row txn-row" data-txn="${esc(t.id)}">
        <span class="field-name"><span>${esc(t.description || k.label)}</span><span class="hint txn-date">${esc(fmtDateShort(new Date(t.occurred_at)))}</span></span>
        <span class="field-value"><span class="${moneyClass(txnSigned(t))}">${fmtMoney(txnSigned(t), cur)}</span>${icon('chevron', 'chev')}</span>
      </button>`).join('')}`;
  }).join('');
  root.innerHTML = `
    <div class="screen bankroll-screen">
      ${topbar(b.name, `<button class="topbtn" data-act="rename" aria-label="Rename bankroll">${icon('note')}</button>`, '/more/bankroll')}
      <div class="card chart-card">${chartHtml(doc, b.id)}<div class="chart-caption">${esc(b.name)} over time · RoR ${s.ror === null ? '--' : s.ror + '%'}</div></div>
      <div class="section-label" style="padding-left:0">Global</div>
      <div class="rows" style="padding:0">
        ${line('Bankroll total', s.total)}
        ${line('Net result', s.net)}
        ${line('Net banked amount', s.banked)}
        <div class="field-row"><span class="field-name">Risk of ruin</span><span class="field-value">${rorHtml(s.ror)}</span></div>
        <div class="field-row"><span class="field-name">Sessions · transactions</span><span class="field-value">${s.sessionCount} · ${s.txnCount}</span></div>
      </div>
      <div class="section-label" style="padding-left:0">Transactions</div>
      <div class="list">${groups || '<div class="empty-block">No transactions yet.</div>'}</div>
      <button class="btn-primary" data-act="add-txn">Add transaction</button>
      ${b.is_default ? '' : '<button class="btn-secondary" data-act="default">Make default</button>'}
      <button class="btn-danger" data-act="delete">Delete bankroll</button>
      <div class="spacer-40"></div>
    </div>`;
  wireBack(root);
  root.querySelector('[data-act=add-txn]').addEventListener('click', () => openTransactionSheet({ bankrollId: b.id }));
  root.querySelectorAll('[data-txn]').forEach(el => el.addEventListener('click', () => {
    const t = getState().transactions.find(x => x.id === el.dataset.txn);
    if (t) openTransactionSheet({ txn: t });
  }));
  root.querySelector('[data-act=rename]').addEventListener('click', () => textSheet({
    title: 'Rename bankroll', label: 'Name', value: b.name, multiline: false,
    onSave(v) {
      const err = masterNameError(getState(), 'bankrolls', v, b.id);
      if (err) { toast(err); return; }
      renameMasterItem('bankrolls', b.id, v.trim());
    },
  }));
  const def = root.querySelector('[data-act=default]');
  if (def) def.addEventListener('click', () => { setDefaultBankroll(b.id); toast(`${b.name} is now the default`); });
  root.querySelector('[data-act=delete]').addEventListener('click', () => {
    const err = masterDeleteError(getState(), 'bankrolls', b.id);
    if (err) { toast(err); return; }
    confirmSheet({
      title: 'Delete bankroll?', message: `"${b.name}" has no sessions or transactions. Delete it?`,
      confirmLabel: 'Delete', danger: true,
      onConfirm() { deleteMasterItem('bankrolls', b.id); toast('Bankroll deleted'); navigate('/more/bankroll'); },
    });
  });
}
