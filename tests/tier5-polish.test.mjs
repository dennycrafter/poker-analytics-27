// Tier 5 verification harness: route-transition choice, skeleton markup,
// WCAG contrast of the design tokens, 44px touch-target minimums, and a static
// audit that every icon-only button / link carries an accessible name.
// Usage: node tests/tier5-polish.test.mjs

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { transitionFor } from '../js/motion.js';
import { skeletonScreen, skeletonText } from '../js/skeleton.js';

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

const root = new URL('../', import.meta.url);
const read = p => readFileSync(new URL(p, root), 'utf8');
const css = read('css/styles.css');

// --- transitions -------------------------------------------------------------

test('transition: first paint and same-path re-render do not animate', () => {
  assert.equal(transitionFor(null, '/feed', null, 'feed'), null);
  assert.equal(transitionFor('/feed', '/feed', 'feed', 'feed'), null);
  assert.equal(transitionFor('/live/abc', '/live/abc', 'feed', 'feed'), null);
});

test('transition: opening a modal route rises, closing it fades', () => {
  assert.equal(transitionFor('/feed', '/new/cash', 'feed', 'feed'), 'up');
  assert.equal(transitionFor('/feed', '/session/x1', 'feed', 'feed'), 'up');
  assert.equal(transitionFor('/more/top10', '/session/x1', 'more', 'feed'), 'up');
  assert.equal(transitionFor('/session/x1', '/feed', 'feed', 'feed'), 'fade');
});

test('transition: modal-to-modal (live -> stack) slides by depth', () => {
  assert.equal(transitionFor('/live/a', '/live/a/stack', 'feed', 'feed'), 'push');
  assert.equal(transitionFor('/live/a/stack', '/live/a', 'feed', 'feed'), 'pop');
});

test('transition: tab switch fades, drill-down pushes, back pops', () => {
  assert.equal(transitionFor('/feed', '/stats', 'feed', 'stats'), 'fade');
  assert.equal(transitionFor('/more', '/more/settings', 'more', 'more'), 'push');
  assert.equal(transitionFor('/more/settings/games', '/more/settings', 'more', 'more'), 'pop');
  assert.equal(transitionFor('/stats', '/stats/cash/net_result', 'stats', 'stats'), 'push');
});

// --- skeletons ---------------------------------------------------------------

test('skeleton: every tab renders a busy screen with its real title', () => {
  const titles = { feed: 'Feed', stats: 'Statistics', calendar: 'Calendar', reports: 'Reports', more: 'More' };
  for (const [tab, title] of Object.entries(titles)) {
    const html = skeletonScreen(tab);
    assert.match(html, /aria-busy="true"/, tab);
    assert.match(html, new RegExp(`<h1>${title}</h1>`), tab);
    assert.match(html, /role="status"/, tab);
    assert.ok((html.match(/class="skel /g) || []).length >= 7, `${tab} has placeholder bars`);
  }
});

test('skeleton: placeholder bars are hidden from assistive tech', () => {
  assert.match(skeletonScreen('feed'), /<div aria-hidden="true">/);
  assert.match(skeletonText(), /aria-hidden="true"/);
  assert.match(skeletonText(), /class="sr-only">Loading</);
});

// --- contrast (WCAG 2.x relative luminance) ------------------------------------

function lum(hex) {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(x => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function ratio(a, b) {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const token = name => {
  const m = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  assert.ok(m, `token --${name} present`);
  return m[1].toLowerCase();
};

test('contrast: all text tokens pass AA (4.5:1) on every background', () => {
  const bgs = ['bg-primary', 'bg-secondary', 'bg-tertiary'].map(token);
  for (const fg of ['text-primary', 'text-secondary', 'text-tertiary', 'accent', 'negative']) {
    for (const bg of bgs) {
      const r = ratio(token(fg), bg);
      assert.ok(r >= 4.5, `--${fg} on ${bg} = ${r.toFixed(2)}`);
    }
  }
});

test('contrast: tertiary stays visibly dimmer than secondary', () => {
  assert.ok(lum(token('text-tertiary')) < lum(token('text-secondary')));
});

test('contrast: filled buttons pass AA', () => {
  assert.ok(ratio('#06280f', token('accent')) >= 4.5, 'btn-primary');
  assert.ok(ratio('#2d0a0a', token('negative')) >= 4.5, 'btn-primary.danger');
});

test('contrast: chart axis labels use the tertiary token, not a hard-coded grey', () => {
  const svg = read('js/charts/svg.js');
  assert.ok(!/fill="#6b6b6b"/.test(svg));
  assert.match(svg, /fill="var\(--text-tertiary\)"/);
});

// --- touch targets -------------------------------------------------------------

test('touch targets: icon buttons and small controls are at least 44px', () => {
  const rule = sel => {
    const re = new RegExp(`(^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g');
    return [...css.matchAll(re)].map(m => m[2]).join(';');
  };
  const px = (body, prop) => {
    const all = [...body.matchAll(new RegExp(`(?:^|[;\\s])${prop}:\\s*(\\d+)px`, 'g'))];
    return all.length ? Number(all[all.length - 1][1]) : null;
  };
  assert.ok(px(rule('.topbtn'), 'min-width') >= 44, '.topbtn min-width');
  assert.ok(px(rule('.topbtn'), 'min-height') >= 44, '.topbtn min-height');
  assert.ok(px(rule('.filter-pill-x'), 'width') >= 44, '.filter-pill-x');
  assert.ok(px(rule('.btn-icon'), 'height') >= 44, '.btn-icon');
  assert.ok(px(rule('.chip'), 'min-height') >= 44, '.chip');
  assert.ok(px(rule('.metric-tab'), 'min-height') >= 44, '.metric-tab');
  assert.ok(px(rule('.segmented .seg, .segmented button[role=tab]'), 'min-height') >= 44, 'segmented');
});

test('reduced motion: a prefers-reduced-motion block tones down transitions', () => {
  const i = css.indexOf('@media (prefers-reduced-motion: reduce)');
  assert.ok(i > 0);
  const block = css.slice(i, i + 1500);
  for (const sel of ['.route-enter', '.sheet', '.tab-indicator', '.live-dot', '.skel', '.toast']) {
    assert.ok(block.includes(sel), `reduced-motion covers ${sel}`);
  }
});

// --- accessible names ----------------------------------------------------------

test('a11y: every icon-only button or link has an aria-label', () => {
  const files = ['js/main.js', ...readdirSync(new URL('js/screens/', root)).map(f => 'js/screens/' + f)];
  const offenders = [];
  for (const f of files) {
    const src = read(f);
    // <button ...>${icon(...)}</button> or <a ...>${icon(...)}</a> with nothing else inside.
    for (const m of src.matchAll(/<(button|a)\b([^>]*)>\s*\$\{icon\([^)]*\)\}\s*(?:<span class="filter-dot"[^>]*><\/span>\s*)?(?:\$\{[^}]*\}\s*)?<\/\1>/g)) {
      if (!/aria-label=/.test(m[2])) offenders.push(`${f}: ${m[0].slice(0, 80)}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('a11y: toasts are a polite live region; sheets are labelled dialogs', () => {
  const ui = read('js/ui.js');
  assert.match(ui, /setAttribute\('aria-live', 'polite'\)/);
  assert.match(ui, /setAttribute\('role', 'status'\)/);
  assert.match(ui, /role="dialog" aria-modal="true"/);
  assert.match(ui, /aria-labelledby=/);
  assert.match(ui, /e\.key === 'Escape'/);
});

test('a11y: active tab is exposed with aria-current', () => {
  assert.match(read('js/main.js'), /setAttribute\('aria-current', 'page'\)/);
});

// --- empty states (brief section 8) ------------------------------------------

test('empty states: brief section 8 strings are present', () => {
  assert.match(read('js/screens/feed.js'), /No sessions yet\. Tap \+ to log your first one\./);
  assert.match(read('js/screens/stats.js'), /Play a session to see your stats\./);
  assert.match(read('js/screens/calendar.js'), /Play a session to see your stats\./);
  assert.match(read('js/screens/reports.js'), /Log at least 5 sessions to unlock reports\./);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
