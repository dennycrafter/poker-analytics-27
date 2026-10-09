// Session detail for saved sessions (brief 5.8): every row tappable and
// editable; red Delete session at the bottom. No ticking timer.

import { navigate } from '../router.js';
import { getState, genId } from '../store.js';
import { icon } from '../icons.js';
import { esc, toast, openSheet, confirmSheet, numberSheet, textSheet, selectSheet, makeActivatable } from '../ui.js';
import { pickNumber } from './picker.js';
import { fmtDur, fmtMoney, moneyClass, fmtClock, fmtDateShort, getCurrency, fmtNum } from '../format.js';
import { playSeconds, netResult, stackBuyIn, stackCashedOut, effectiveHands, hourlyRate, sessionNet, sessionHours, hasStaking } from '../stats.js';
import { updateSession, deleteSession, addStackEvent, addSellAction, deleteSellAction } from '../domain.js';
import { stakingMode } from './stats.js';
import { openSellSheet, sellSummary } from './sell.js';
import { sellActionsOf, sellLedger, makeSellAction } from '../staking.js';
import { localInputValue, utcFromLocalInputs } from '../dates.js';

export function DetailScreen(root, doc, sessionId) {
  let s = doc.sessions.find(x => x.id === sessionId);
  if (!s) { navigate('/feed'); return; }
  const cur = getCurrency(doc);
  const game = doc.games.find(g => g.id === s.game_id);
  const loc = doc.locations.find(l => l.id === s.location_id);
  const bank = doc.bankrolls.find(b => b.id === s.bankroll_id);

  // Staked tournaments follow the Statistics gross / net-of-staking
  // preference (formula 1) so this card and Statistics always agree.
  function headerHtml() {
    const secs = s.duration_seconds || 0;
    const staked = hasStaking(getState(), s);
    const mode = stakingMode(getState());
    const net = staked ? sessionNet(getState(), s, mode) : netResult(doc, s);
    const h = sessionHours(s);
    const rate = staked ? (h > 0 ? net / h : null) : hourlyRate(doc, s);
    const basis = staked
      ? `<div class="hint" style="margin-top:10px">${mode === 'net' ? 'Net of staking' : 'Gross (before staking)'} · gross ${fmtMoney(netResult(doc, s), cur)}</div>`
      : '';
    return `<div class="live-card">
      <div class="live-timer small">${fmtDur(secs)}</div>
      <div class="live-sub">
        <div class="live-sub-item">
          <span class="lbl">Net hourly rate</span>
          <span class="val ${moneyClass(rate)}">${rate === null ? '--' : fmtMoney(rate, cur) + '/h'}</span>
        </div>
        <div class="live-sub-item">
          <span class="lbl">Net result</span>
          <span class="val ${moneyClass(net)}">${fmtMoney(net, cur)}</span>
        </div>
      </div>
      ${basis}
    </div>`;
  }

  function ledgerHtml() {
    const d = getState();
    if (s.kind !== 'tournament' || !hasStaking(d, s)) return '';
    const L = sellLedger(d, s);
    const line = (label, v, cls = moneyClass(v)) =>
      `<div class="field-row ledger-row"><span class="field-name">${esc(label)}</span><span class="field-value ${cls}">${fmtMoney(v, cur)}</span></div>`;
    return `<div class="section-label" style="padding-left:0">Staking ledger</div>
      <div class="rows" style="padding:0">
        ${L.entries.map(e => `
          <div class="field-row ledger-row">
            <span class="field-name">${esc(e.backer_name || 'Backer')} · ${fmtNum(e.percentage)}% x${fmtNum(e.markup)}</span>
            <span class="field-value"><span class="hint">paid ${fmtMoney(e.cost, cur)} · gets ${fmtMoney(e.payout, cur)}</span></span>
          </div>`).join('')}
        ${line('Received from backers', L.received)}
        ${line('Paid to backers', -L.paidOut)}
        ${line('Gross result', L.gross)}
        ${line('Your result (net of staking)', L.retained)}
      </div>`;
  }

  function rowHtml(label, value, key, chevron = true) {
    return `<div class="field-row" data-field="${key}">
      <span class="field-name">${esc(label)}</span>
      <span class="field-value">${value}${chevron ? icon('chevron', 'chev') : ''}</span>
    </div>`;
  }

  function rowsHtml() {
    const est = effectiveHands(s);
    const handsVal = s.hands_count_estimated && s.hands_count == null
      ? `<span class="hint">~${est ?? '--'} (est.)</span>`
      : `${s.hands_count ?? '--'}`;
    if (s.kind === 'cash') {
      const buy = s.tracked_via_stack ? stackBuyIn(doc, s) : s.buy_in;
      const co = s.tracked_via_stack ? stackCashedOut(doc, s) : s.cashed_out;
      return `
        ${rowHtml('Start time', `${fmtDateShort(new Date(s.start_time))} ${fmtClock(new Date(s.start_time))}`, 'start')}
        ${rowHtml('End time', s.end_time ? `${fmtDateShort(new Date(s.end_time))} ${fmtClock(new Date(s.end_time))}` : '--', 'end')}
        ${rowHtml('Buy-in', fmtMoney(buy ?? 0, cur), 'buyin')}
        ${rowHtml('Cashed out', fmtMoney(co ?? 0, cur), 'cashed')}
        ${rowHtml('Tips', s.tips ? fmtMoney(-s.tips, cur) : '--', 'tips')}
        ${rowHtml('Hands count', handsVal, 'hands')}
        ${rowHtml('Comment', esc(s.comment || '--'), 'comment')}
        ${rowHtml('Opponents', esc(s.opponents || '--'), 'opponents')}
        ${rowHtml('Break time', fmtDur(s.break_seconds || 0), 'break')}
        ${rowHtml('Game', esc(game ? game.name : '--'), 'game')}
        ${rowHtml('Stakes', `${s.small_blind}/${s.big_blind}`, 'stakes')}
        ${rowHtml('Location', esc(loc ? loc.name : '--'), 'location')}
        ${rowHtml('Table size', `${s.table_size}-max`, 'table')}
        ${rowHtml('Bankroll', esc(bank ? bank.name : '--'), 'bank')}`;
    }
    return `
      ${rowHtml('Start time', `${fmtDateShort(new Date(s.start_time))} ${fmtClock(new Date(s.start_time))}`, 'start')}
      ${rowHtml('End time', s.end_time ? `${fmtDateShort(new Date(s.end_time))} ${fmtClock(new Date(s.end_time))}` : '--', 'end')}
      ${rowHtml('Buy-in', fmtMoney(s.total_buy_in, cur), 'buyin')}
      ${rowHtml('Prize', s.prize != null ? fmtMoney(s.prize, cur) : '--', 'prize')}
      ${rowHtml('Position', s.position ?? '--', 'position')}
      ${rowHtml('Entries', s.entries ?? '--', 'entries')}
      ${rowHtml('Sell action', esc(sellSummary(sellActionsOf(getState(), s.id))), 'sell')}
      ${rowHtml('Tips', s.tips ? fmtMoney(-s.tips, cur) : '--', 'tips')}
      ${rowHtml('Hands count', handsVal, 'hands')}
      ${rowHtml('Comment', esc(s.comment || '--'), 'comment')}
      ${rowHtml('Opponents', esc(s.opponents || '--'), 'opponents')}
      ${rowHtml('Break time', fmtDur(s.break_seconds || 0), 'break')}
      ${rowHtml('Game', esc(game ? game.name : '--'), 'game')}
      ${rowHtml('Type', esc((doc.tournament_types.find(t => t.id === s.tournament_type_id) || {}).name || '--'), 'ttype')}
      ${rowHtml('Name', esc(s.tournament_name || '--'), 'tname')}
      ${rowHtml('Location', esc(loc ? loc.name : '--'), 'location')}
      ${rowHtml('Table size', `${s.table_size}-max`, 'table')}
      ${rowHtml('Bankroll', esc(bank ? bank.name : '--'), 'bank')}`;
  }

  function render() {
    s = getState().sessions.find(x => x.id === sessionId) || s;
    const kind = s.kind === 'cash' ? 'Cash game' : 'Tournament';
    root.innerHTML = `
      <div class="modal-screen">
        <header class="topbar">
          <button class="topbtn" data-act="back" aria-label="Back">${icon('back')}</button>
          <h1>${kind}</h1>
          <span class="topbtn" style="visibility:hidden"></span>
        </header>
        <div class="form">
          ${headerHtml()}
          <div class="rows">${rowsHtml()}</div>
          ${ledgerHtml()}
          <button class="btn-danger" data-act="delete">Delete session</button>
          <div class="spacer-40"></div>
        </div>
      </div>`;
    wire();
  }

  // Helpers for the row editors -------------------------------------------
  function saveTime(key, iso) {
    const patch = {};
    patch[key === 'start' ? 'start_time' : 'end_time'] = iso;
    // Recompute duration from the (possibly) new times.
    const merged = { ...s, ...patch };
    if (merged.start_time && merged.end_time) {
      patch.duration_seconds = Math.max(0, Math.round((Date.parse(merged.end_time) - Date.parse(merged.start_time)) / 1000));
    }
    updateSession(sessionId, patch);
  }

  function editTimeSheet(key) {
    const currentIso = key === 'start' ? s.start_time : s.end_time;
    const d = currentIso ? new Date(currentIso) : new Date();
    openSheet({
      title: key === 'start' ? 'Start time' : 'End time',
      bodyHtml: `
        <label class="field"><span class="field-label">Date</span>
          <input class="input" data-role="d" type="date" value="${localInputValue(d, 'date')}"></label>
        <label class="field"><span class="field-label">Time</span>
          <input class="input" data-role="t" type="time" value="${localInputValue(d, 'time')}"></label>
        <div class="sheet-error" data-role="err" hidden></div>
        <button class="btn-primary" data-act="ok">Save</button>`,
      onMount(sheet, close) {
        sheet.querySelector('[data-act=ok]').addEventListener('click', () => {
          const dv = sheet.querySelector('[data-role=d]').value;
          const tv = sheet.querySelector('[data-role=t]').value;
          if (!dv || !tv) { toast('Pick date and time'); return; }
          const iso = utcFromLocalInputs(dv, tv);
          if (iso == null) { toast('Invalid date/time'); return; }
          if (key === 'start' && Date.parse(iso) > Date.now()) {
            const err = sheet.querySelector('[data-role=err]');
            err.textContent = 'Start time cannot be in the future'; err.hidden = false; return;
          }
          if (key === 'end' && Date.parse(iso) <= Date.parse(s.start_time)) {
            const err = sheet.querySelector('[data-role=err]');
            err.textContent = 'End time must be after start time'; err.hidden = false; return;
          }
          close();
          saveTime(key, iso);
        });
      },
    });
  }

  function wire() {
    root.querySelector('[data-act=back]').addEventListener('click', () => navigate('/feed'));
    root.querySelector('[data-act=delete]').addEventListener('click', () => {
      confirmSheet({
        title: 'Delete session?', message: 'This permanently removes the session and its stack events.',
        confirmLabel: 'Delete', danger: true,
        onConfirm() { deleteSession(sessionId); toast('Session deleted'); navigate('/feed'); },
      });
    });

    const on = (key, fn) => {
      const el = root.querySelector(`[data-field="${key}"]`);
      if (el) makeActivatable(el).addEventListener('click', fn);
    };
    on('start', () => editTimeSheet('start'));
    on('end', () => editTimeSheet('end'));
    on('tips', () => numberSheet({
      title: 'Tips', label: 'Tips given', value: s.tips || null, allowEmpty: true,
      onSave: v => updateSession(sessionId, { tips: v || 0 }),
    }));
    on('hands', () => numberSheet({
      title: 'Hands count', label: 'Hands played', value: s.hands_count, step: '1', allowEmpty: true,
      onSave: v => updateSession(sessionId, { hands_count: v, hands_count_estimated: v === null }),
    }));
    on('comment', () => textSheet({
      title: 'Comment', label: 'Comment', value: s.comment,
      onSave: v => updateSession(sessionId, { comment: v }),
    }));
    on('opponents', () => textSheet({
      title: 'Opponents', label: 'Opponents', value: s.opponents,
      onSave: v => updateSession(sessionId, { opponents: v }),
    }));
    on('break', () => numberSheet({
      title: 'Break time', label: 'Break minutes', value: s.break_seconds ? Math.round(s.break_seconds / 60) : null,
      step: '1', min: 0, allowEmpty: true,
      onSave: v => updateSession(sessionId, { break_seconds: (v || 0) * 60 }),
    }));
    on('game', () => selectSheet({
      title: 'Game', options: getState().games, selectedId: s.game_id, allowNone: false,
      onSave: sel => updateSession(sessionId, { game_id: sel.id }),
    }));
    on('location', () => selectSheet({
      title: 'Location', options: getState().locations, selectedId: s.location_id, allowNone: false,
      onSave: sel => updateSession(sessionId, { location_id: sel.id }),
    }));
    on('table', () => pickNumber('Table size', s.table_size, 2, 10, v => updateSession(sessionId, { table_size: v }), '-max'));
    on('bank', () => selectSheet({
      title: 'Bankroll', options: getState().bankrolls, selectedId: s.bankroll_id, allowNone: false,
      onSave: sel => updateSession(sessionId, { bankroll_id: sel.id }),
    }));
    if (s.kind === 'cash') {
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
        if (s.tracked_via_stack) {
          toast('Buy-in comes from stack events');
          return;
        }
        numberSheet({
          title: 'Buy-in', label: 'Buy-in', value: s.buy_in,
          onSave: v => updateSession(sessionId, { buy_in: v }),
        });
      });
      on('cashed', () => {
        if (s.tracked_via_stack) {
          toast('Cashed out comes from cash-out stack events');
          return;
        }
        numberSheet({
          title: 'Cashed out', label: 'Cashed out', value: s.cashed_out,
          onSave: v => updateSession(sessionId, { cashed_out: v }),
        });
      });
    } else {
      on('buyin', () => numberSheet({
        title: 'Total buy-in', label: 'Total buy-in (initial + rebuys)', value: s.total_buy_in,
        onSave: v => updateSession(sessionId, { total_buy_in: v }),
      }));
      on('prize', () => numberSheet({
        title: 'Prize', label: 'Prize won', value: s.prize, allowEmpty: true,
        onSave: v => updateSession(sessionId, { prize: v }),
      }));
      on('position', () => numberSheet({
        title: 'Position', label: 'Finishing position', value: s.position, step: '1', allowEmpty: true,
        onSave: v => updateSession(sessionId, { position: v }),
      }));
      on('entries', () => numberSheet({
        title: 'Entries', label: 'Entries', value: s.entries, step: '1', allowEmpty: true,
        onSave: v => updateSession(sessionId, { entries: v }),
      }));
      on('ttype', () => selectSheet({
        title: 'Tournament type', options: getState().tournament_types, selectedId: s.tournament_type_id, allowNone: false,
        onSave: sel => updateSession(sessionId, { tournament_type_id: sel.id }),
      }));
      on('sell', () => openSellSheet({
        actions: sellActionsOf(getState(), sessionId),
        onAdd: v => { addSellAction(sessionId, makeSellAction(genId('sell'), sessionId, v)); toast('Sell action saved'); },
        onDelete: id => { deleteSellAction(id); toast('Sell action removed'); },
      }));
      on('tname', () => textSheet({
        title: 'Tournament name', label: 'Name', value: s.tournament_name,
        onSave: v => updateSession(sessionId, { tournament_name: v }),
      }));
    }
  }

  render();
}
