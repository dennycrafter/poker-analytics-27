// Stack screen (brief 5.4) for a live cash session: header, profit/loss line
// chart over hours, reverse-chronological stack events, record stack change.

import { addCleanup, navigate } from '../router.js';
import { getState } from '../store.js';
import { icon } from '../icons.js';
import { esc, toast, openSheet } from '../ui.js';
import { onTick } from '../tick.js';
import { fmtMoney, moneyClass, fmtClock, getCurrency, fmtNum } from '../format.js';
import { playSeconds, netResult, stackBuyIn, stackCashedOut, stackSeries } from '../stats.js';
import { addStackEvent } from '../domain.js';
import { lineChart } from '../charts/svg.js';
import { chartBox } from '../layout.js';

export function StackScreen(root, doc, sessionId) {
  let s = doc.sessions.find(x => x.id === sessionId);
  if (!s) { navigate('/feed'); return; }
  const cur = getCurrency(doc);

  function headerHtml() {
    const secs = playSeconds(s);
    const mm = String(Math.floor(secs / 60) % 60).padStart(2, '0');
    const hh = Math.floor(secs / 3600);
    const net = s.end_time ? stackCashedOut(doc, s) - stackBuyIn(doc, s) : netResult(doc, s);
    return `<div class="stack-head">
      <div class="stack-head-item">
        <span class="lbl">Time</span>
        <span class="big-num">${hh}:${mm}</span>
      </div>
      <div class="stack-head-item">
        <span class="lbl">Net result</span>
        <span class="big-num ${moneyClass(net)}">${fmtMoney(net, cur)}</span>
      </div>
    </div>`;
  }

  function chartHtml() {
    const pts = stackSeries(doc, s);
    if (pts.length < 2) {
      return `<div class="empty-box">Add a top-up or cash out to see the line.</div>`;
    }
    return lineChart({
      points: pts, // [hoursSinceStart, cumulativeNet]
      ...chartBox(340, 180, { desktopWidth: 560 }),
      color: 'var(--accent)',
      dashed: true,
      xLabel: h => `${h}h`,
    });
  }

  function eventsHtml() {
    const start = Date.parse(s.start_time);
    const evs = getState().stack_events
      .filter(e => e.session_id === sessionId)
      .sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at));
    if (!evs.length) return `<div class="empty-box">No stack events yet.</div>`;
    let total = 0;
    const rows = evs.map(e => {
      // running total in chronological order
      return { e };
    });
    // compute cumulative in chronological order then display reverse
    const chron = [...evs].reverse();
    let run = 0;
    const withRun = new Map();
    for (const e of chron) {
      run += e.kind === 'cash_out' ? -e.amount : e.amount;
      withRun.set(e.id, run);
    }
    return rows.map(({ e }) => {
      const mins = Math.max(0, Math.round((Date.parse(e.occurred_at) - start) / 60000));
      const t = `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
      const sign = e.kind === 'cash_out' ? '−' : '+';
      const cls = e.kind === 'cash_out' ? 'neg' : 'pos';
      const totalNow = withRun.get(e.id);
      const label = e.kind === 'buy_in' ? 'Buy-in' : e.kind === 'top_up' ? 'Top up' : 'Cash out';
      return `<div class="stack-row">
        <span class="stack-time">${t}</span>
        <span class="stack-label">${label}</span>
        <span class="stack-amt ${cls}">${sign}${fmtNum(e.amount)}</span>
        <span class="stack-total">${fmtNum(totalNow)}</span>
      </div>`;
    }).join('');
  }

  function render() {
    s = getState().sessions.find(x => x.id === sessionId) || s;
    root.innerHTML = `
      <div class="modal-screen">
        <header class="topbar">
          <button class="topbtn" data-act="back" aria-label="Back">${icon('back')}</button>
          <h1>Stack</h1>
          <span class="topbtn" style="visibility:hidden"></span>
        </header>
        <div class="form">
          <div data-role="stack-head">${headerHtml()}</div>
          <div class="card" data-role="chart">${chartHtml()}</div>
          <div class="section-label">Stack events</div>
          <div class="stack-list">${eventsHtml()}</div>
          <div class="spacer-80"></div>
        </div>
        <div class="sticky-end">
          <button class="btn-primary" data-act="record">Record stack change</button>
        </div>
      </div>`;
    wire();
  }

  function wire() {
    root.querySelector('[data-act=back]').addEventListener('click', () => {
      navigate(s.is_live ? `/live/${sessionId}` : `/session/${sessionId}`);
    });
    root.querySelector('[data-act=record]').addEventListener('click', () => {
      openSheet({
        title: 'Record stack change',
        bodyHtml: `
          <div class="segmented">
            <button class="seg active" data-role="kind" data-v="top_up">Top up</button>
            <button class="seg" data-v="cash_out">Cash out</button>
          </div>
          <label class="field"><span class="field-label">Amount</span>
            <input class="input" data-role="amt" type="number" inputmode="decimal" step="0.01" min="0" placeholder="0.00"></label>
          <div class="sheet-error" data-role="err" hidden></div>
          <button class="btn-primary" data-act="ok">Add</button>`,
        onMount(sheet, close) {
          let kind = 'top_up';
          for (const seg of sheet.querySelectorAll('.seg')) {
            seg.addEventListener('click', () => {
              kind = seg.dataset.v;
              for (const o of sheet.querySelectorAll('.seg')) o.classList.remove('active');
              seg.classList.add('active');
            });
          }
          sheet.querySelector('[data-act=ok]').addEventListener('click', () => {
            const raw = sheet.querySelector('[data-role=amt]').value.trim();
            const v = Number(raw);
            if (raw === '' || !Number.isFinite(v) || v <= 0) {
              const err = sheet.querySelector('[data-role=err]');
              err.textContent = 'Enter a valid amount'; err.hidden = false; return;
            }
            close();
            addStackEvent(sessionId, { kind, amount: v, occurred_at: new Date().toISOString() });
            toast(kind === 'top_up' ? 'Top up recorded' : 'Cash out recorded');
          });
        },
      });
    });
  }

  const off = onTick(() => {
    const live = getState().sessions.find(x => x.id === sessionId);
    if (!live || !live.is_live) return;
    s = live;
    const head = root.querySelector('[data-role=stack-head]');
    if (head) head.innerHTML = headerHtml();
  });
  addCleanup(off);

  render();
}
