// STEP C verification harness: web app manifest + icons, service worker
// (version stamp, shell precache coverage, never-intercept-API guard exercised
// in a sandboxed worker scope), desktop breakpoint + sidebar markup, chart
// sizing that leaves mobile untouched, and import hygiene of the new modules.
// Usage: node tests/stepc-desktop-pwa.test.mjs

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import vm from 'node:vm';
import { DESKTOP_MIN, DESKTOP_QUERY, chartBox } from '../js/layout.js';

let pass = 0, fail = 0;
const pending = [];
function test(name, fn) {
  const run = async () => {
    try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
  };
  pending.push(run);
}

const root = new URL('../', import.meta.url);
const read = p => readFileSync(new URL(p, root), 'utf8');
const exists = p => existsSync(new URL(p, root));
const css = read('css/styles.css');
const sw = read('sw.js');
const html = read('index.html');
const main = read('js/main.js');

// PNG width/height live in the IHDR chunk at bytes 16..23.
function pngSize(p) {
  const b = readFileSync(new URL(p, root));
  assert.equal(b.toString('hex', 0, 8), '89504e470d0a1a0a', `${p} is not a PNG`);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

function walkJs(dir) {
  const out = [];
  for (const e of readdirSync(new URL(dir, root), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...walkJs(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// --- manifest ----------------------------------------------------------------

const manifest = JSON.parse(read('manifest.webmanifest'));

test('manifest: parses and has the required install fields', () => {
  assert.equal(manifest.name, 'Poker Analytics 27');
  assert.ok(manifest.short_name && manifest.short_name.length <= 12, 'short_name present and short');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.background_color, '#0a0a0a');
  assert.equal(manifest.theme_color, '#0a0a0a');
});

test('manifest: 192 + 512 "any" icons and a maskable icon, files match declared sizes', () => {
  const any = manifest.icons.filter(i => (i.purpose || 'any').split(' ').includes('any'));
  const maskable = manifest.icons.filter(i => (i.purpose || '').split(' ').includes('maskable'));
  for (const size of ['192x192', '512x512']) {
    assert.ok(any.some(i => i.sizes === size), `any icon ${size}`);
  }
  assert.ok(maskable.some(i => i.sizes === '512x512'), 'maskable 512');
  for (const i of manifest.icons) {
    assert.equal(i.type, 'image/png');
    const [w, h] = i.sizes.split('x').map(Number);
    assert.deepEqual(pngSize(i.src), { w, h }, i.src);
  }
});

test('index.html: manifest link, apple-touch-icon, iOS standalone meta, theme-color', () => {
  assert.match(html, /<link rel="manifest" href="manifest\.webmanifest">/);
  assert.match(html, /<link rel="apple-touch-icon" href="icons\/apple-touch-icon\.png">/);
  assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes">/);
  assert.match(html, /<meta name="apple-mobile-web-app-status-bar-style" content="[a-z-]+">/);
  assert.match(html, /<meta name="theme-color" content="#0a0a0a">/);
  assert.deepEqual(pngSize('icons/apple-touch-icon.png'), { w: 180, h: 180 });
});

// --- service worker: static ---------------------------------------------------

test('sw: VERSION constant names the cache; skipWaiting + clients.claim', () => {
  assert.match(sw, /const VERSION = '[^']+';/);
  assert.match(sw, /const CACHE = `pa27-shell-\$\{VERSION\}`;/);
  assert.match(sw, /self\.skipWaiting\(\)/);
  assert.match(sw, /self\.clients\.claim\(\)/);
});

test('sw: precache covers index, css, manifest, icons and every js module; every entry exists', () => {
  const list = [...sw.matchAll(/^\s+'([^']+)',$/gm)].map(m => m[1]);
  const set = new Set(list);
  for (const p of ['./', 'index.html', 'manifest.webmanifest', 'css/styles.css']) assert.ok(set.has(p), p);
  for (const i of manifest.icons) assert.ok(set.has(i.src), i.src);
  const missing = walkJs('js').filter(p => !set.has(p));
  assert.deepEqual(missing, [], 'js modules missing from SHELL (bump VERSION when adding)');
  for (const p of list) if (p !== './') assert.ok(exists(p) && statSync(new URL(p, root)).isFile(), `${p} exists`);
});

test('main.js registers the service worker through js/pwa.js', () => {
  assert.match(main, /import \{ registerServiceWorker \} from '\.\/pwa\.js';/);
  assert.match(main, /^registerServiceWorker\(\);$/m);
  assert.match(read('js/pwa.js'), /navigator\.serviceWorker\.register\('\.\/sw\.js'\)/);
});

// --- service worker: behavior in a fake worker scope -----------------------------

const ORIGIN = 'https://pa27.example';

function loadWorker({ online = true } = {}) {
  const listeners = {};
  const store = new Map(); // cacheName -> Map(url -> body)
  const fetched = [];
  const keyOf = r => (typeof r === 'string' ? new URL(r, ORIGIN + '/').href : r.url);
  const mkRes = (url, body) => ({ ok: true, type: 'basic', url, body, clone() { return mkRes(url, body); } });
  const cacheApi = name => {
    if (!store.has(name)) store.set(name, new Map());
    const m = store.get(name);
    return {
      addAll: async reqs => { for (const r of reqs) m.set(keyOf(r), mkRes(keyOf(r), 'net:' + keyOf(r))); },
      put: async (r, res) => { m.set(keyOf(r), res); },
    };
  };
  const ctx = {
    URL,
    Request: class { constructor(p) { this.url = new URL(p, ORIGIN + '/').href; } },
    console,
    fetch: async r => {
      fetched.push(keyOf(r));
      if (!online) throw new TypeError('Failed to fetch');
      return mkRes(keyOf(r), 'net:' + keyOf(r));
    },
    caches: {
      open: async n => cacheApi(n),
      keys: async () => [...store.keys()],
      delete: async n => store.delete(n),
      match: async r => { for (const m of store.values()) if (m.has(keyOf(r))) return m.get(keyOf(r)); return undefined; },
    },
  };
  ctx.self = {
    location: new URL(ORIGIN + '/sw.js'),
    registration: { scope: ORIGIN + '/' },
    addEventListener: (t, fn) => { listeners[t] = fn; },
    skipWaiting: async () => { ctx.skipped = true; },
    clients: { claim: async () => { ctx.claimed = true; } },
  };
  vm.runInNewContext(sw, ctx, { filename: 'sw.js' });

  const lifecycle = async type => {
    let p;
    listeners[type]({ waitUntil: x => { p = x; } });
    await p;
  };
  const dispatchFetch = (url, { method = 'GET', mode = 'cors' } = {}) => {
    let responded = null;
    listeners.fetch({ request: { url, method, mode }, respondWith: p => { responded = p; } });
    return responded;
  };
  return { ctx, store, fetched, lifecycle, dispatchFetch };
}

test('sw: install precaches into the versioned cache; activate drops old shell caches', async () => {
  const w = loadWorker();
  w.store.set('pa27-shell-old', new Map());
  w.store.set('unrelated-cache', new Map());
  await w.lifecycle('install');
  await w.lifecycle('activate');
  const names = [...w.store.keys()];
  assert.ok(w.ctx.skipped && w.ctx.claimed, 'skipWaiting + claim ran');
  assert.ok(!names.includes('pa27-shell-old'), 'old shell cache deleted');
  assert.ok(names.includes('unrelated-cache'), 'foreign caches untouched');
  const shell = names.find(n => /^pa27-shell-/.test(n));
  assert.ok(w.store.get(shell).has(ORIGIN + '/js/main.js'));
});

test('sw: never intercepts Supabase REST/auth/realtime/storage or API paths, nor non-GET', () => {
  const w = loadWorker();
  const untouched = [
    'https://abcd.supabase.co/rest/v1/sessions?select=*',
    'https://abcd.supabase.co/auth/v1/token?grant_type=password',
    'https://abcd.supabase.co/realtime/v1/websocket',
    'https://abcd.supabase.co/storage/v1/object/x',
    ORIGIN + '/rest/v1/sessions',
    ORIGIN + '/auth/v1/user',
    ORIGIN + '/api/anything',
    'https://cdn.example.org/lib.js',
  ];
  for (const u of untouched) assert.equal(w.dispatchFetch(u), null, u);
  assert.equal(w.dispatchFetch(ORIGIN + '/js/main.js', { method: 'POST' }), null, 'POST');
  assert.ok(w.dispatchFetch(ORIGIN + '/js/main.js'), 'same-origin static asset is handled');
});

test('sw: static assets are cache-first; navigation is network-first with shell fallback offline', async () => {
  const on = loadWorker();
  await on.lifecycle('install');
  on.fetched.length = 0;
  const asset = await on.dispatchFetch(ORIGIN + '/js/main.js');
  assert.equal(asset.body, 'net:' + ORIGIN + '/js/main.js');
  assert.deepEqual(on.fetched, [], 'cached asset served without network');
  const nav = await on.dispatchFetch(ORIGIN + '/', { mode: 'navigation' });
  assert.deepEqual(on.fetched, [ORIGIN + '/'], 'navigation goes to the network first');
  assert.equal(nav.body, 'net:' + ORIGIN + '/');

  const off = loadWorker({ online: false });
  off.store.set('pa27-shell-seed', new Map([[ORIGIN + '/index.html', { body: 'shell' }]]));
  const fallback = await off.dispatchFetch(ORIGIN + '/#/stats', { mode: 'navigation' });
  assert.equal(fallback.body, 'shell', 'offline navigation gets the cached shell');
  await assert.rejects(off.dispatchFetch(ORIGIN + '/js/not-cached.js'), /Failed to fetch/, 'uncached asset offline surfaces the network error');
});

// --- desktop layout -------------------------------------------------------------

test('breakpoint: CSS desktop block uses DESKTOP_MIN from js/layout.js', () => {
  assert.equal(DESKTOP_MIN, 880);
  assert.equal(DESKTOP_QUERY, '(min-width: 880px)');
  assert.ok(css.includes(`@media (min-width: ${DESKTOP_MIN}px) {`), 'desktop media block');
  assert.ok(css.includes(`@media (min-width: ${DESKTOP_MIN}px) and (hover: hover) {`), 'hover block gated to desktop');
  const others = [...css.matchAll(/@media \(min-width: (\d+)px\)/g)].map(m => +m[1]).filter(n => n !== DESKTOP_MIN && n !== 520);
  assert.deepEqual(others, [], 'no other width breakpoints');
});

test('sidebar: one nav landmark with the five tab links, brand hidden from AT and on mobile', () => {
  assert.match(main, /<nav id="tabbar" aria-label="Main navigation">/);
  assert.match(main, /<div class="sidebar-brand" aria-hidden="true">/);
  for (const id of ['feed', 'stats', 'calendar', 'reports', 'more']) assert.match(main, new RegExp(`\\{ id: '${id}'`));
  assert.match(main, /setAttribute\('aria-current', 'page'\)/);
  // The brand rule outside the media block hides it at phone widths.
  const desktopStart = css.indexOf(`@media (min-width: ${DESKTOP_MIN}px) {`);
  const hideAt = css.indexOf('.sidebar-brand { display: none; }');
  assert.ok(hideAt > -1 && hideAt < desktopStart, 'brand hidden by default');
});

test('desktop CSS: sidebar, wide grids, dialog modal routes and backdrop live only inside the breakpoint', () => {
  const start = css.indexOf(`@media (min-width: ${DESKTOP_MIN}px) {`);
  const block = css.slice(start);
  for (const needle of ['--sidebar-w', 'flex-direction: column', '.stat-section {', '.cal-list {', '.hm-months {', '.rep-list {', 'body.modal-open #screen::before', 'border-radius: 18px']) {
    assert.ok(block.includes(needle), needle);
  }
  assert.ok(!css.slice(0, start).includes('modal-open'), 'no modal-open rules leak to mobile');
});

test('desktop dialogs: role/aria-modal, Escape, Tab trap and focus restore are wired', () => {
  const d = read('js/desktop.js');
  assert.match(d, /setAttribute\('role', 'dialog'\)/);
  assert.match(d, /setAttribute\('aria-modal', 'true'\)/);
  assert.match(d, /setAttribute\('aria-labelledby'/);
  assert.match(d, /e\.key === 'Escape'/);
  assert.match(d, /e\.key !== 'Tab'/);
  assert.match(d, /if \(!isDesktop\(\) \|\| e\.defaultPrevented \|\| isSheetOpen\(\)\) return;/, 'defers to open sheets and is inert on mobile');
  assert.match(main, /syncModalDialog\(prevActive\);/);
});

test('chartBox: mobile keeps the exact original chart sizes, desktop widens', () => {
  for (const [w, h] of [[340, 140], [340, 180], [340, 210]]) {
    assert.deepEqual(chartBox(w, h, { desktop: false }), { width: w, height: h });
  }
  assert.deepEqual(chartBox(340, 210, { desktop: true }), { width: 680, height: 315 });
  assert.deepEqual(chartBox(340, 180, { desktop: true, desktopWidth: 560 }), { width: 560, height: 270 });
  // No matchMedia in Node: defaults to the mobile box.
  assert.deepEqual(chartBox(340, 180), { width: 340, height: 180 });
});

// --- hygiene --------------------------------------------------------------------

test('new STEP C code does not import store.js or stats.js', () => {
  for (const p of ['js/layout.js', 'js/desktop.js', 'js/pwa.js', 'sw.js']) {
    const src = read(p);
    assert.ok(!/from ['"][./]*\/?(store|stats)\.js['"]/.test(src), `${p} imports store/stats`);
    assert.ok(!/importScripts|import\(/.test(src), `${p} dynamic import`);
  }
});

for (const run of pending) await run();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
