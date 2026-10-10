// IT1 server tests (brief 1.3, server side): the zero-dependency AI proxy in
// server/handlers.js and server/server.js. Every AI interaction runs against
// recorded fixture replies in tests/fixtures/import-ai-server/ - no network,
// no API key. The one integration test boots the real http server on an
// ephemeral port with an injected fetch and closes it before finishing.
// Usage: TZ=UTC node tests/it1-server.test.mjs

import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  handleImportAi, chunkText, extractJson, parseMapping, parseRows,
  buildTablePrompt, buildTextRowsPrompt,
  ANTHROPIC_URL, ANTHROPIC_VERSION, MODEL,
  MAX_TABLE_ROWS, MAX_ROWS_PER_RUN, MAX_CALLS_PER_REQUEST,
  AiUnavailableError, AiBadReplyError,
} from '../server/handlers.js';
import {
  BODY_LIMIT, pickMime, resolveStaticPath, parseArgs, createRequestHandler,
} from '../server/server.js';

// Sequential queued runner: async tests finish in registration order, so
// output and side effects (shared captures) stay deterministic.
let pass = 0, fail = 0;
const tests = [];
let chain = Promise.resolve();
function test(name, fn) {
  chain = chain.then(async () => {
    try { await fn(); pass++; console.log('  ok   ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message ? e.message : e)); }
  });
}
function section(label) { chain = chain.then(() => console.log(label)); }

// Watchdog: an unhandled hang (server never closes, promise never settles)
// must fail loudly instead of stalling the suite forever.
setTimeout(() => { console.log('\n  TIMEOUT: suite hung'); process.exit(1); }, 60_000).unref();

const FIX = fileURLToPath(new URL('./fixtures/import-ai-server/', import.meta.url));
const load = name => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));
const MAPPING_REPLY = load('messages-mapping.json');
const ROWS_REPLY = load('messages-rows.json');
const NOT_JSON_REPLY = load('messages-notjson.json');
const WRONG_SHAPE_REPLY = load('messages-wrongshape.json');
const AUTH_ERROR_REPLY = load('messages-401.json');

const ENV = { ANTHROPIC_API_KEY: 'test-key-abc123' };
const TABLE_BODY = {
  kind: 'table',
  headers: ['Date Played', 'Stake', 'Won/Lost', 'Duration (h:mm)', 'Location'],
  rows: [['10/03/2025', '1/2', '+340', '5:00', 'Lodge']],
};
const TEXT_BODY = { kind: 'text', content: 'Oct 3 1/2 at Lodge +340 5h' };
const IMAGE_BODY = { kind: 'image', base64: 'aGVsbG8gd29ybGQ=', mime: 'image/png' };

// Injectable fetch: records every call and replays a recorded reply. A
// function reply gets the call index, so multi-call (split) tests can vary.
function fakeFetch(reply, capture = []) {
  return async (url, init) => {
    const r = typeof reply === 'function' ? reply(capture.length) : reply;
    capture.push({ url, init, body: JSON.parse(init.body) });
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    };
  };
}

const promptOf = capture => capture[0].body.messages[0].content[0].text;
const entryPrompt = entry => entry.body.messages[0].content[0].text;

// ---------- chunkText: the 300-row split math ----------

section('Split math (max 300 rows per run)');

test(`chunkText: ${750} lines -> 3 chunks of 300/300/150`, () => {
  const content = Array.from({ length: 750 }, (_, i) => 'line' + i).join('\n');
  const chunks = chunkText(content);
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks.map(c => c.split('\n').length), [MAX_ROWS_PER_RUN, MAX_ROWS_PER_RUN, 150]);
  assert.ok(chunks[0].startsWith('line0\n'));
  assert.ok(chunks[2].endsWith('line749'));
});

test('chunkText: blank lines are dropped, exactly 300 lines -> 1 chunk', () => {
  const lines = Array.from({ length: 300 }, (_, i) => 'L' + i);
  const content = ['', ...lines, '  ', ''].join('\n');
  const chunks = chunkText(content);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].split('\n').length, 300);
});

test('chunkText: whitespace-only content -> no chunks (400 downstream)', () => {
  assert.deepEqual(chunkText('   \n\n  \n'), []);
});

test('chunkText: default max is MAX_ROWS_PER_RUN=300 and custom max is honoured', () => {
  const content = Array.from({ length: 5 }, (_, i) => 'x' + i).join('\n');
  assert.equal(chunkText(content).length, 1);
  const two = chunkText(content, 2);
  assert.deepEqual(two.map(c => c.split('\n').length), [2, 2, 1]);
});

// ---------- extractJson: fence and prose stripping ----------

section('Reply JSON extraction');

test('extractJson: raw object, fenced json, and prose-wrapped array all parse', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Here you go: ["x","y"] hope this helps'), ['x', 'y']);
});

test('extractJson: garbage and truncated JSON throw AiBadReplyError', () => {
  assert.throws(() => extractJson('no json here at all'), AiBadReplyError);
  assert.throws(() => extractJson('{"a": 1'), AiBadReplyError);
  assert.throws(() => extractJson(''), AiBadReplyError);
});

// ---------- 503: missing/unusable key, transport trouble ----------

section('503 ai_unavailable paths');

test('missing, empty, or whitespace key: 503 for table, text and image, no fetch', async () => {
  let called = 0;
  const fetchImpl = async () => { called++; return { ok: true, status: 200, json: async () => MAPPING_REPLY }; };
  for (const body of [TABLE_BODY, TEXT_BODY, IMAGE_BODY]) {
    for (const env of [{}, { ANTHROPIC_API_KEY: '' }, { ANTHROPIC_API_KEY: '   ' }]) {
      const res = await handleImportAi(body, { fetch: fetchImpl, env });
      assert.deepEqual(res.json, { error: 'ai_unavailable' });
      assert.equal(res.status, 503);
    }
  }
  assert.equal(called, 0, 'the AI must never be called without a key');
});

test('network failure (fetch throws) and broken fetch: 503 ai_unavailable', async () => {
  const throwing = async () => { throw new Error('ECONNREFUSED'); };
  const res1 = await handleImportAi(TEXT_BODY, { fetch: throwing, env: ENV });
  assert.equal(res1.status, 503);
  assert.deepEqual(res1.json, { error: 'ai_unavailable' });
  const broken = async () => undefined; // not a Response at all
  const res2 = await handleImportAi(TEXT_BODY, { fetch: broken, env: ENV });
  assert.equal(res2.status, 503);
});

test('anthropic http 401 with error envelope: 503 ai_unavailable (unusable key)', async () => {
  const capture = [];
  const res = await handleImportAi(TABLE_BODY, {
    fetch: fakeFetch({ status: 401, body: AUTH_ERROR_REPLY }, capture), env: ENV,
  });
  assert.equal(res.status, 503);
  assert.deepEqual(res.json, { error: 'ai_unavailable' });
  assert.equal(capture.length, 1, 'one attempt was made before the 503');
});

test('anthropic 200 but error envelope body: 503 ai_unavailable', async () => {
  const res = await handleImportAi(TABLE_BODY, {
    fetch: fakeFetch({ status: 200, body: AUTH_ERROR_REPLY }, []), env: ENV,
  });
  assert.equal(res.status, 503);
  assert.deepEqual(res.json, { error: 'ai_unavailable' });
});

// ---------- 400: malformed client requests ----------

section('400 bad_request paths');

test('bad kind, bad headers, whitespace content, bad mime, bad base64 -> 400', async () => {
  const cases = [
    {},
    { kind: 'wat' },
    { kind: 'table', rows: [] },
    { kind: 'table', headers: ['Date'] },
    { kind: 'table', headers: ['Date', ''], rows: [] },
    { kind: 'table', headers: ['Date', 5], rows: [] },
    { kind: 'text', content: '   ' },
    { kind: 'text' },
    { kind: 'image', base64: 'aGk=', mime: 'application/pdf' },
    { kind: 'image', base64: 'not base64!!', mime: 'image/png' },
    { kind: 'image', mime: 'image/png' },
  ];
  for (const body of cases) {
    const res = await handleImportAi(body, { fetch: fakeFetch({ body: MAPPING_REPLY }, []), env: ENV });
    assert.equal(res.status, 400, 'case: ' + JSON.stringify(body));
    assert.equal(res.json.error, 'bad_request');
    assert.ok(typeof res.json.detail === 'string' && res.json.detail.length > 0);
  }
});

// ---------- table: mapping from headers + 20 rows ----------

section('Table mapping (headers + first 20 rows)');

test('table: mapping parsed from recorded reply, roles and rules intact', async () => {
  const capture = [];
  const res = await handleImportAi(TABLE_BODY, {
    fetch: fakeFetch({ body: MAPPING_REPLY }, capture), env: ENV,
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.kind, 'table');
  assert.deepEqual(res.json.mapping.roles, {
    'Date Played': 'date',
    Stake: 'stakes',
    'Won/Lost': 'net_result',
    'Duration (h:mm)': 'duration',
    Location: 'location',
  });
  assert.deepEqual(res.json.mapping.rules, {
    date_format: 'MM/DD/YYYY', currency: 'USD', session_type: 'cash', notes: 'Won/Lost is signed profit',
  });
});

test('table: request hits the Anthropic Messages API with model, version header and key', async () => {
  const capture = [];
  await handleImportAi(TABLE_BODY, { fetch: fakeFetch({ body: MAPPING_REPLY }, capture), env: ENV });
  assert.equal(capture[0].url, ANTHROPIC_URL);
  assert.equal(capture[0].init.method, 'POST');
  assert.equal(capture[0].body.model, MODEL);
  assert.equal(capture[0].body.model, 'claude-sonnet-5-5');
  assert.equal(capture[0].init.headers['anthropic-version'], ANTHROPIC_VERSION);
  assert.equal(capture[0].init.headers['x-api-key'], ENV.ANTHROPIC_API_KEY);
  assert.equal(capture[0].body.temperature, 0);
  assert.equal(capture[0].body.messages.length, 1);
  assert.equal(capture[0].body.messages[0].role, 'user');
});

test(`table: exactly ${MAX_TABLE_ROWS} sample rows are sent, row 21 never leaves`, async () => {
  const rows = Array.from({ length: 25 }, (_, i) => ['row-' + (i + 1)]);
  const capture = [];
  await handleImportAi({ ...TABLE_BODY, rows }, { fetch: fakeFetch({ body: MAPPING_REPLY }, capture), env: ENV });
  const prompt = promptOf(capture);
  assert.ok(prompt.includes('"row-20"'), 'row 20 must be in the prompt');
  assert.ok(!prompt.includes('"row-21"'), 'row 21 must not be in the prompt');
  assert.ok(prompt.includes('"row-1"'));
});

test('table prompt names the importer role vocabulary so mappings plug into the client', () => {
  const prompt = buildTablePrompt(['A'], [['1']]);
  for (const role of ['date', 'stakes', 'buy_in', 'cashed_out', 'net_result', 'duration', 'position', 'entries', 'ignore']) {
    assert.ok(prompt.includes(role), 'role ' + role + ' missing from prompt');
  }
  const textPrompt = buildTextRowsPrompt('Oct 3 1/2 at Lodge +340 5h');
  assert.ok(textPrompt.includes('confidence'), 'row prompt must ask for confidence');
  assert.ok(textPrompt.includes('tournament'), 'row prompt must mention tournaments');
});

// ---------- text: rows returned directly ----------

section('Text to rows');

test('text: rows parsed from fenced recorded reply, confidence normalized', async () => {
  const capture = [];
  const res = await handleImportAi(TEXT_BODY, { fetch: fakeFetch({ body: ROWS_REPLY }, capture), env: ENV });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.kind, 'text');
  assert.equal(res.json.calls, 1);
  assert.equal(res.json.rows.length, 2);
  assert.equal(res.json.rows[0].date, '2025-10-03');
  assert.equal(res.json.rows[0].confidence, 0.95);
  assert.equal(res.json.rows[1].confidence, 0.5, 'missing confidence must default to 0.5');
  assert.ok(capture[0].body.messages[0].content[0].text.includes('Oct 3 1/2 at Lodge +340 5h'));
});

test('parseRows: clamps confidence into [0,1], accepts bare arrays, rejects junk', () => {
  const parsed = parseRows('{"rows":[{"confidence":1.7},{"confidence":-3},{"confidence":"x"},{}]}');
  assert.deepEqual(parsed.map(r => r.confidence), [1, 0, 0.5, 0.5]);
  assert.equal(parseRows('[{"a":1}]')[0].a, 1);
  assert.throws(() => parseRows('{"rows":"nope"}'), AiBadReplyError);
  assert.throws(() => parseRows('{"rows":[null]}'), AiBadReplyError);
  assert.throws(() => parseRows('{"rows":["flat string"]}'), AiBadReplyError);
});

test('parseMapping: mapping wrapper accepted, wrong shapes rejected', () => {
  assert.deepEqual(parseMapping('{"mapping":{"roles":{"A":"date"}}}').roles, { A: 'date' });
  assert.deepEqual(parseMapping('{"roles":{"A":"date"},"rules":{"currency":"EUR"}}').rules, { currency: 'EUR' });
  assert.deepEqual(parseMapping('{"roles":{"A":"date"}}').rules, {}, 'missing rules defaults to {}');
  assert.throws(() => parseMapping('{"rules":{}}'), AiBadReplyError, 'no roles -> bad reply');
  assert.throws(() => parseMapping('{"roles":{}}'), AiBadReplyError, 'empty roles -> bad reply');
  assert.throws(() => parseMapping('{"roles":{"A":"ignore"}}'), AiBadReplyError, 'all-ignore -> bad reply');
  assert.throws(() => parseMapping('{"roles":{"A":5}}'), AiBadReplyError, 'non-string role -> bad reply');
  assert.throws(() => parseMapping('{"roles":{"A":"date"},"rules":[1]}'), AiBadReplyError, 'rules array -> bad reply');
});

// ---------- the 300-row split over sequential calls ----------

section('Splitting bigger pastes into sequential calls');

test('300-row split: 601 lines -> 3 sequential calls, chunks in order, rows concatenated', async () => {
  const lines = Array.from({ length: 601 }, (_, i) => 'L' + String(i + 1).padStart(3, '0') + ' 1/2 at Lodge +340 5h');
  const capture = [];
  const res = await handleImportAi({ kind: 'text', content: lines.join('\n') }, {
    fetch: fakeFetch({ body: ROWS_REPLY }, capture), env: ENV,
  });
  assert.equal(res.status, 200);
  assert.equal(capture.length, 3, 'exactly 3 AI calls');
  assert.equal(res.json.calls, 3);
  assert.equal(res.json.rows.length, 6, '2 fixture rows per call, concatenated');
  const prompts = capture.map(entryPrompt);
  assert.ok(prompts[0].includes('L001') && prompts[0].includes('L300'));
  assert.ok(!prompts[0].includes('L301'), 'call 1 must not see line 301');
  assert.ok(prompts[1].includes('L301') && prompts[1].includes('L600'));
  assert.ok(!prompts[1].includes('L300') && !prompts[1].includes('L601'));
  assert.ok(prompts[2].includes('L601') && !prompts[2].includes('L600'));
});

test(`too-long input (more than ${MAX_CALLS_PER_REQUEST} chunks): 400 before any AI call`, async () => {
  const lines = Array.from({ length: MAX_CALLS_PER_REQUEST * MAX_ROWS_PER_RUN + 1 }, (_, i) => 'L' + i);
  const capture = [];
  const res = await handleImportAi({ kind: 'text', content: lines.join('\n') }, {
    fetch: fakeFetch({ body: ROWS_REPLY }, capture), env: ENV,
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.error, 'bad_request');
  assert.equal(capture.length, 0);
});

// ---------- 502: malformed AI replies ----------

section('502 ai_bad_reply paths');

test('prose reply (no JSON): 502 on the mapping path and on the rows path', async () => {
  const res1 = await handleImportAi(TABLE_BODY, { fetch: fakeFetch({ body: NOT_JSON_REPLY }, []), env: ENV });
  assert.equal(res1.status, 502);
  assert.deepEqual(res1.json, { error: 'ai_bad_reply' });
  const res2 = await handleImportAi(TEXT_BODY, { fetch: fakeFetch({ body: NOT_JSON_REPLY }, []), env: ENV });
  assert.equal(res2.status, 502);
  assert.deepEqual(res2.json, { error: 'ai_bad_reply' });
});

test('wrong-shape JSON reply: 502 on both paths', async () => {
  for (const body of [TABLE_BODY, TEXT_BODY]) {
    const res = await handleImportAi(body, { fetch: fakeFetch({ body: WRONG_SHAPE_REPLY }, []), env: ENV });
    assert.equal(res.status, 502);
    assert.deepEqual(res.json, { error: 'ai_bad_reply' });
  }
});

test('200 with no text blocks in content: 502 ai_bad_reply', async () => {
  const noText = { type: 'message', content: [{ type: 'tool_use', id: 't1', input: {} }] };
  const res = await handleImportAi(TEXT_BODY, { fetch: fakeFetch({ body: noText }, []), env: ENV });
  assert.equal(res.status, 502);
  assert.deepEqual(res.json, { error: 'ai_bad_reply' });
});

// ---------- image ----------

section('Image to rows');

test('image: single call, base64 image block plus text prompt, rows returned', async () => {
  const capture = [];
  const res = await handleImportAi(IMAGE_BODY, { fetch: fakeFetch({ body: ROWS_REPLY }, capture), env: ENV });
  assert.equal(res.status, 200);
  assert.equal(res.json.kind, 'image');
  assert.equal(res.json.rows.length, 2);
  assert.equal(capture.length, 1, 'images cannot be split: one call');
  const parts = capture[0].body.messages[0].content;
  assert.equal(parts[0].type, 'image');
  assert.deepEqual(parts[0].source, { type: 'base64', media_type: 'image/png', data: 'aGVsbG8gd29ybGQ=' });
  assert.equal(parts[1].type, 'text');
  assert.ok(parts[1].text.includes('poker session list'));
});

// ---------- the key never leaks ----------

section('Key handling');

test('the key is sent to the API but never appears in any response body', async () => {
  const leaky = 'SPECIAL_SECRET_KEY_XYZ';
  const env = { ANTHROPIC_API_KEY: leaky };
  const happy = [
    [TABLE_BODY, MAPPING_REPLY],
    [TEXT_BODY, ROWS_REPLY],
    [IMAGE_BODY, ROWS_REPLY],
  ];
  for (const [body, reply] of happy) {
    const res = await handleImportAi(body, { fetch: fakeFetch({ body: reply }, []), env });
    assert.equal(res.status, 200);
    assert.ok(!JSON.stringify(res.json).includes(leaky), 'key leaked in 200 body');
  }
  for (const body of [TABLE_BODY, TEXT_BODY]) {
    for (const reply of [{ status: 401, body: AUTH_ERROR_REPLY }, { status: 200, body: NOT_JSON_REPLY }]) {
      const res = await handleImportAi(body, { fetch: fakeFetch(reply, []), env });
      assert.ok(res.status === 502 || res.status === 503);
      assert.ok(!JSON.stringify(res.json).includes(leaky), 'key leaked in error body');
    }
  }
});

// ---------- server.js units ----------

section('server.js units: args, mime, static paths');

test('parseArgs: both flag forms, defaults, invalid ports become null', () => {
  assert.deepEqual(parseArgs(['--port', '8090', '--static', '/srv/app']), { port: 8090, staticDir: '/srv/app' });
  assert.deepEqual(parseArgs(['--port=1234', '--static=/tmp/x']), { port: 1234, staticDir: '/tmp/x' });
  assert.deepEqual(parseArgs([]), { port: null, staticDir: null });
  assert.deepEqual(parseArgs(['--port=abc']), { port: null, staticDir: null });
  assert.deepEqual(parseArgs(['--port=99999']), { port: null, staticDir: null });
  assert.deepEqual(parseArgs(['--wat', '--port']), { port: null, staticDir: null });
});

test('pickMime: js, mjs, css, svg, png, webmanifest, json, html and the fallback', () => {
  assert.equal(pickMime('a.js'), 'text/javascript; charset=utf-8');
  assert.equal(pickMime('a.mjs'), 'text/javascript; charset=utf-8');
  assert.equal(pickMime('a.css'), 'text/css; charset=utf-8');
  assert.equal(pickMime('a.svg'), 'image/svg+xml');
  assert.equal(pickMime('a.PNG'), 'image/png');
  assert.equal(pickMime('manifest.webmanifest'), 'application/manifest+json; charset=utf-8');
  assert.equal(pickMime('data.json'), 'application/json; charset=utf-8');
  assert.equal(pickMime('index.html'), 'text/html; charset=utf-8');
  assert.equal(pickMime('archive.xyz'), 'application/octet-stream');
});

test('resolveStaticPath: index at /, query strings, traversal and NUL rejected', () => {
  const ROOT = '/srv/app';
  assert.equal(resolveStaticPath(ROOT, '/'), path.resolve(ROOT, 'index.html'));
  assert.equal(resolveStaticPath(ROOT, '/js/app.js?x=1'), path.resolve(ROOT, 'js/app.js'));
  assert.equal(resolveStaticPath(ROOT, '/css/style.css'), path.resolve(ROOT, 'css/style.css'));
  assert.equal(resolveStaticPath(ROOT, '/../etc/passwd'), null);
  assert.equal(resolveStaticPath(ROOT, '/..%2f..%2fetc%2fpasswd'), null);
  assert.equal(resolveStaticPath(ROOT, '/%2e%2e/etc/passwd'), null);
  assert.equal(resolveStaticPath(ROOT, '/a\0b'), null);
  assert.equal(resolveStaticPath(ROOT, '/dir/'), path.resolve(ROOT, 'dir/index.html'));
});

// ---------- server integration on an ephemeral port ----------

section('Server integration (real http, ephemeral port, injected fetch)');

test('static mime + index + 404 + traversal guard over real http', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa27-it1-'));
  fs.writeFileSync(path.join(tmp, 'index.html'), '<!doctype html><title>pa27</title>');
  fs.mkdirSync(path.join(tmp, 'js'));
  fs.writeFileSync(path.join(tmp, 'js', 'app.js'), 'export const x = 1;');
  const server = http.createServer(createRequestHandler({ staticRoot: tmp, env: {} }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const html = await fetch(base + '/');
    assert.equal(html.status, 200);
    assert.match(html.headers.get('content-type'), /text\/html/);
    assert.match(await html.text(), /pa27/);
    const js = await fetch(base + '/js/app.js');
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /text\/javascript/);
    const missing = await fetch(base + '/nope.css');
    assert.equal(missing.status, 404);
    const trav = await fetch(base + '/..%2f..%2fetc%2fpasswd');
    assert.equal(trav.status, 404);
  } finally {
    await new Promise(r => server.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('POST /api/import-ai over real http with injected fetch: 200 mapping', async () => {
  const capture = [];
  const server = http.createServer(createRequestHandler({
    fetch: fakeFetch({ body: MAPPING_REPLY }, capture),
    env: ENV,
  }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const res = await fetch(base + '/api/import-ai', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(TABLE_BODY),
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.equal(json.mapping.roles['Date Played'], 'date');
    assert.equal(capture.length, 1);
    assert.equal(capture[0].init.headers['x-api-key'], ENV.ANTHROPIC_API_KEY);
    const getRes = await fetch(base + '/api/import-ai');
    assert.equal(getRes.status, 405);
    const other = await fetch(base + '/api/unknown');
    assert.equal(other.status, 404);
  } finally {
    await new Promise(r => server.close(r));
  }
});

test('request bodies over 10MB: 413 body_too_large; invalid JSON: 400 bad_json', async () => {
  const server = http.createServer(createRequestHandler({ fetch: async () => { throw new Error('no calls'); }, env: ENV }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const big = JSON.stringify({ kind: 'text', content: 'x'.repeat(BODY_LIMIT) });
    assert.ok(big.length > BODY_LIMIT);
    const res = await fetch(base + '/api/import-ai', { method: 'POST', body: big });
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), { error: 'body_too_large' });
    const bad = await fetch(base + '/api/import-ai', { method: 'POST', body: '{not json' });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, 'bad_json');
  } finally {
    await new Promise(r => server.close(r));
  }
});

test('API-only mode (no --static): / serves 404 no_static, api still works', async () => {
  const capture = [];
  const server = http.createServer(createRequestHandler({
    fetch: fakeFetch({ body: ROWS_REPLY }, capture), env: ENV,
  }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const noStatic = await fetch(base + '/');
    assert.equal(noStatic.status, 404);
    assert.equal((await noStatic.json()).error, 'no_static');
    const api = await fetch(base + '/api/import-ai', { method: 'POST', body: JSON.stringify(TEXT_BODY) });
    assert.equal(api.status, 200);
    assert.equal((await api.json()).kind, 'text');
  } finally {
    await new Promise(r => server.close(r));
  }
});

// --- run + summary ------------------------------------------------------------
await chain;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
