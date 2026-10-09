// Live session screen (brief 5.3 cash / 5.7 tournament): ticking header card,
// editable rows, pause/resume, action sheet, end session flow.

import { addCleanup, navigate } from '../router.js';
import { getState } from '../store.js';
import { icon } from '../icons.js';
import { esc, toast, openSheet, confirmSheet, numberSheet, textSheet } from '../ui.js';
import { pickRef, pickNumber } from './picker.js';
import { onTick } from '../tick.js';
import { fmtTimer, fmtDur, fmtMoney, moneyClass, fmtClock, fmtDateShort, getCurrency } from '../format.js';
import { playSeconds, netResult, stackBuyIn, stackCashedOut, effectiveHands } from '../stats.js';
import { endLiveCash, endLiveTournament, updateSession, deleteSession } from '../domain.js';

export function LiveScreen(root, doc, sessionId) {
  let s = doc.sessions.find(x => x.id === sessionId);
  if (!s || !s.is_live) { navigate(s ? '/session/' + sessionId : '/feed'); return; }
  const cur = getCurrency(doc);
  const game = doc.games.find(g => g.id === s.game_id);
  const loc = doc.locations.find(l => l.id === s.location_id);
  const bank = doc.bankrolls.find(b => b.id === s.bankroll_id);

  function headerHtml() {
    const t = fmtTimer(playSeconds(s));
    const net = netResult(doc, s);
    const h = playSeconds(s) / 3600;
    const rate = h > 0 ? net / h : null;
    return `<div class="live-card">
      <div class="live-timer">${t.main}<span class="sec">${t.sec}</span></div>
      <div class="live-sub">
        <div class="live-sub-item">
          <span class="lbl">Net hourly rate</span>
          <span class="val ${moneyClass(rate)}">${rate === null ? '--' : fmtMoney(rate, cur) + '/h'}</span>
        </div>
        <div class="live-sub-item">
          <span class="lbl">Net result</span>
          <span class="val ${moneyClass(net)}" data-role="net">${fmtMoney(net, cur)}</span>
        </div>
      </div>
    </div>`;
  }

  function rowHtml(label, value, opts = {}) {
    return `<div class="field-row" data-field="${opts.key || ''}">
      <span class="field-name">${esc(label)}</span>
      <span class="field-value">${value}${opts.chevron === false ? '' : icon('chevron', 'chev')}</span>
    </div>`;
  }

  function rowsHtml() {
    const est = effectiveHands(s);
    const handsVal = s.hands_count_estimated
      ? `<span class="hint">~${est ?? '--'} (est.)</span>`
      : `${s.hands_count ?? '--'}`;
    if (s.kind === 'cash') {
      const buy = stackBuyIn(doc, s);
      const co = stackCashedOut(doc, s);
      return `
        ${rowHtml('Buy-in', fmtMoney(buy, cur), { key: 'buyin' })}
        ${rowHtml('Cashed out', s.end_time ? fmtMoney(co, cur) : '<span class="hint">on end</span>', { key: 'cashed', chevron: false })}
        ${rowHtml('Tips', s.tips ? fmtMoney(-s.tips, cur) : '--', { key: 'tips' })}
        ${rowHtml('Hands count', handsVal, { key: 'hands' })}
        ${rowHtml('Comment', esc(s.comment || '--'), { key: 'comment' })}
        ${rowHtml('Opponents', esc(s.opponents || '--'), { key: 'opponents' })}
        ${rowHtml('Break time', fmtDur(s.break_seconds + (s.paused_at ? (Date.now() - Date.parse(s.paused_at)) / 1000 : 0)), { key: 'break', chevron: false })}
        ${rowHtml('Game', esc(game ? game.name : '--'), { key: 'game' })}
        ${rowHtml('Stakes', `${s.small_blind}/${s.big_blind}`, { key: 'stakes' })}
        ${rowHtml('Location', esc(loc ? loc.name : '--'), { key: 'location' })}
        ${rowHtml('Table size', `${s.table_size}-max`, { key: 'table' })}
        ${rowHtml('Bankroll', esc(bank ? bank.name : '--'), { key: 'bank' })}
        ${rowHtml('Date', `${fmtDateShort(new Date(s.start_time))} ${fmtClock(new Date(s.start_time))}`, { key: 'date', chevron: false })}`;
    }
    // tournament
    return `
      ${rowHtml('Buy-in', fmtMoney(s.total_buy_in, cur), { key: 'buyin' })}
      ${rowHtml('Prize', s.prize != null ? fmtMoney(s.prize, cur) : '<span class="hint">on end</span>', { key: 'prize', chevron: false })}
      ${rowHtml('Position', s.position ?? '--', { key: 'position' })}
      ${rowHtml('Entries', s.entries ?? '--', { key: 'entries' })}
      ${rowHtml('Tips', s.tips ? fmtMoney(-s.tips, cur) : '--', { key: 'tips' })}
      ${rowHtml('Hands count', handsVal, { key: 'hands' })}
      ${rowHtml('Comment', esc(s.comment || '--'), { key: 'comment' })}
      ${rowHtml('Opponents', esc(s.opponents || '--'), { key: 'opponents' })}
      ${rowHtml('Break time', fmtDur(s.break_seconds + (s.paused_at ? (Date.now() - Date.parse(s.paused_at)) / 1000 : 0)), { key: 'break', chevron: false })}
      ${rowHtml('Game', esc(game ? game.name : '--'), { key: 'game' })}
      ${rowHtml('Type', esc((doc.tournament_types.find(t => t.id === s.tournament_type_id) || {}).name || '--'), { key: 'ttype' })}
      ${rowHtml('Location', esc(loc ? loc.name : '--'), { key: 'location' })}
      ${rowHtml('Table size', `${s.table_size}-max`, { key: 'table' })}
      ${rowHtml('Bankroll', esc(bank ? bank.name : '--'), { key: 'bank' })}
      ${rowHtml('Date', `${fmtDateShort(new Date(s.start_time))} ${fmtClock(new Date(s.start_time))}`, { key: 'date', chevron: false })}`;
  }

  function render() {
    s = getState().sessions.find(x => x.id === sessionId) || s;
    const paused = !!s.paused_at;
    const title = s.kind === 'cash'
      ? `${cur} ${s.small_blind}/${s.big_blind} ${(game || {}).name || ''}`
      : `${cur} ${s.initial_buy_in} ${(game || {}).name || ''}${s.tournament_name ? ' · ' + s.tournament_name : ''}`;
    root.innerHTML = `
      <div class="modal-screen">
        <header class="topbar">
          <button class="topbtn" data-act="back" aria-label="Back">${icon('back')}</button>
          <h1>${s.kind === 'cash' ? 'Live cash game' : 'Live tournament'}</h1>
          <span class="topbtn" style="visibility:hidden"></span>
        </header>
        <div class="form">
          <div class="live-title">${esc(title)}</div>
          <div data-role="live-header">${headerHtml()}</div>
          <div class="rows">${rowsHtml()}</div>
          <div class="spacer-80"></div>
        </div>
        <div class="live-actions">
          <button class="btn-icon" data-act="pause" aria-label="${paused ? 'Resume' : 'Pause'}">${icon(paused ? 'play' : 'pause')}</button>
          <button class="btn-icon" data-act="more" aria-label="Actions">${icon('plus')}</button>
          ${s.kind === 'cash' ? `<button class="btn-icon" data-act="stack" aria-label="Stack">${icon('stack')}</button>` : ''}
        </div>
        <div class="sticky-end">
          <button class="btn-primary danger" data-act="end">${s.kind === 'cash' ? 'End session' : 'Finish tournament'}</button>
        </div>
      </div>`;
    wire();
  }

  function wire() {
    root.querySelector('[data-act=back]').addEventListener('click', () => navigate('/feed'));

    root.querySelector('[data-act=pause]').addEventListener('click', () => {
      const cur1 = getState().sessions.find(x => x.id === sessionId);
      if (cur1.paused_at) {
        // Resume: fold elapsed pause into break_seconds.
        const extra = Math.max(0, Math.round((Date.now() - Date.parse(cur1.paused_at)) / 1000));
        updateSession(sessionId, { paused_at: null, break_seconds: (cur1.break_seconds || 0) + extra });
        toast('Resumed');
      } else {
        updateSession(sessionId, { paused_at: new Date().toISOString() });
        toast('Paused — break time is being recorded');
      }
    });

    root.querySelector('[data-act=more]').addEventListener('click', () => {
      openSheet({
        title: 'Actions',
        bodyHtml: `
          <button class="sheet-row" data-a="hand">${icon('hand')}<span>Add hand history</span></button>
          <button class="sheet-row" data-a="txn">${icon('wallet')}<span>Add transaction</span></button>
          <button class="sheet-row" data-a="note">${icon('note')}<span>Add player note</span></button>
          <button class="sheet-row danger" data-a="del">${icon('trash')}<span>Delete session</span></button>`,
        onMount(sheet, close) {
          for (const a of ['hand', 'txn', 'note']) {
            sheet.querySelector(`[data-a=${a}]`).addEventListener('click', () => {
              close();
              toast('Full management arrives in a later update');
            });
          }
          sheet.querySelector('[data-a=del]').addEventListener('click', () => {
            close();
            confirmSheet({
              title: 'Delete session?', message: 'This permanently removes the session and its stack events.',
              confirmLabel: 'Delete', danger: true,
              onConfirm() { deleteSession(sessionId); toast('Session deleted'); navigate('/feed'); },
            });
          });
        },
      });
    });

    const stackBtn = root.querySelector('[data-act=stack]');
    if (stackBtn) stackBtn.addEventListener('click', () => navigate(`/live/${sessionId}/stack`));

    root.querySelector('[data-act=end]').addEventListener('click', () => endFlow());

    // --- row editors ---
    const on = (key, fn) => {
      const el = root.querySelector(`[data-field="${key}"]`);
      if (el) el.addEventListener('click', fn);
    };
    on('tips', () => numberSheet({
      title: 'Tips', label: 'Tips given', value: s.tips || null, allowEmpty: true,
      onSave: v => updateSession(sessionId, { tips: v || 0 }),
    }));
    on('hands', () => numberSheet({
      title: 'Hands count', label: 'Hands played', value: s.hands_count_estimated ? null : s.hands_count,
      step: '1', allowEmpty: true,
      onSave: v => {
        if (v === null) {
          updateSession(sessionId, { hands_count: null, hands_count_estimated: true });
        } else {
          updateSession(sessionId, { hands_count: v, hands_count_estimated: false });
        }
      },
    }));
    on('comment', () => textSheet({
      title: 'Comment', label: 'Comment', value: s.comment,
      onSave: v => updateSession(sessionId, { comment: v }),
    }));
    on('opponents', () => textSheet({
      title: 'Opponents', label: 'Opponents', value: s.opponents,
      onSave: v => updateSession(sessionId, { opponents: v }),
    }));
    on('location', () => pickRef(doc, 'Location', 'locations', v => updateSession(sessionId, { location_id: v })));
    on('game', () => pickRef(doc, 'Game', 'games', v => updateSession(sessionId, { game_id: v })));
    on('table', () => pickNumber('Table size', s.table_size, 2, 10, v => updateSession(sessionId, { table_size: v }), '-max'));
    on('bank', () => pickRef(doc, 'Bankroll', 'bankrolls', v => updateSession(sessionId, { bankroll_id: v })));
    on('stakes', () => {
      openSheet({
        title: 'Stakes',
        bodyHtml: `
          <div class="stakes-inputs">
            <label class="field"><span class="field-label">Small blind</span>
              <input class="input" data-role="sb" type="number" step="0.01" min="0" value="${s.small_blind}"></label>
            <label class="field"><span class="field-label">Big blind</span>
              <input class="input" data-role="bb" type="number" step="0.01" min="0" value="${s.big_blind}"></label>
          </div>
          <button class="btn-primary" data-act="ok">Save</button>`,
        onMount(sheet, close) {
          sheet.querySelector('[data-act=ok]').addEventListener('click', () => {
            const sb = Number(sheet.querySelector('[data-role=sb]').value);
            const bb = Number(sheet.querySelector('[data-role=bb]').value);
            if (!Number.isFinite(sb) || !Number.isFinite(bb) || sb <= 0 || bb <= 0) {
              toast('Enter valid blinds'); return;
            }
            close();
            updateSession(sessionId, { small_blind: sb, big_blind: bb });
          });
        },
      });
    });
    on('buyin', () => {
      if (s.kind === 'cash' && s.tracked_via_stack) {
        navigate(`/live/${sessionId}/stack`);
        return;
      }
      numberSheet({
        title: 'Buy-in', label: 'Total buy-in', value: s.total_buy_in || s.initial_buy_in,
        onSave: v => updateSession(sessionId, { total_buy_in: v }),
      });
    });
    if (s.kind === 'tournament') {
      on('position', () => numberSheet({
        title: 'Position', label: 'Finishing position', value: s.position, step: '1', allowEmpty: true,
        onSave: v => updateSession(sessionId, { position: v }),
      }));
      on('entries', () => numberSheet({
        title: 'Entries', label: 'Entries', value: s.entries, step: '1', allowEmpty: true,
        onSave: v => updateSession(sessionId, { entries: v }),
      }));
      on('ttype', () => pickRef(doc, 'Tournament type', 'tournament_types', v => updateSession(sessionId, { tournament_type_id: v })));
    }
  }

  function endFlow() {
    if (s.kind === 'cash') {
      openSheet({
        title: 'End session',
        bodyHtml: `
          <label class="field"><span class="field-label">Cashed out</span>
            <input class="input" data-role="co" type="number" inputmode="decimal" step="0.01" min="0"
              placeholder="Amount you left the table with"></label>
          <div class="sheet-error" data-role="err" hidden></div>
          <button class="btn-primary" data-act="ok">End session</button>`,
        onMount(sheet, close) {
          sheet.querySelector('[data-act=ok]').addEventListener('click', () => {
            const raw = sheet.querySelector('[data-role=co]').value.trim();
            const v = Number(raw);
            if (raw === '' || !Number.isFinite(v) || v < 0) {
              const err = sheet.querySelector('[data-role=err]');
              err.textContent = 'Enter the amount you cashed out'; err.hidden = false; return;
            }
            close();
            endLiveCash(sessionId, v);
            toast('Session ended');
            navigate('/feed');
          });
        },
      });
    } else {
      openSheet({
        title: 'Finish tournament',
        bodyHtml: `
          <div class="stakes-inputs">
            <label class="field"><span class="field-label">Position</span>
              <input class="input" data-role="pos" type="number" step="1" min="1" placeholder="e.g. 3"></label>
            <label class="field"><span class="field-label">Prize</span>
              <input class="input" data-role="prize" type="number" inputmode="decimal" step="0.01" min="0" placeholder="0 if busted"></label>
          </div>
          <button class="btn-primary" data-act="ok">Finish</button>`,
        onMount(sheet, close) {
          sheet.querySelector('[data-act=ok]').addEventListener('click', () => {
            const posRaw = sheet.querySelector('[data-role=pos]').value.trim();
            const prizeRaw = sheet.querySelector('[data-role=prize]').value.trim();
            const prize = prizeRaw === '' ? 0 : Number(prizeRaw);
            if (prizeRaw !== '' && !Number.isFinite(prize)) {
              toast('Enter a valid prize'); return;
            }
            close();
            endLiveTournament(sessionId, { position: posRaw === '' ? null : Number(posRaw), prize });
            toast('Tournament finished');
            navigate('/feed');
          });
        },
      });
    }
  }

  // Per-second refresh of the ticking header only (never a full re-render —
  // that would steal focus from open editors).
  const off = onTick(() => {
    const slot = root.querySelector('[data-role=live-header]');
    const live = getState().sessions.find(x => x.id === sessionId);
    if (!live || !live.is_live) return;
    s = live;
    if (slot) slot.innerHTML = headerHtml();
  });
  addCleanup(off);

  render();
}
