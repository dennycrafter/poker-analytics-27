// PA27 import server (brief 1.3, server side). Zero npm dependencies: plain
// node:http + node:fs. Two jobs:
//   1. serve the static app from --static <dir> (correct mime map, path
//      traversal guarded, index.html at /)
//   2. expose POST /api/import-ai (see handlers.js) with a ~10MB body limit
//
// Usage: node server/server.js --port 8090 --static /path/to/app
// Both flags are optional: the port defaults to 8787 (PORT env is honoured
// when --port is absent); without --static the server is API-only. The
// Anthropic key comes from ANTHROPIC_API_KEY in the environment and is never
// logged.
//
// Everything is exported so tests can exercise arg parsing, mime picking,
// path resolution and the full request handler without sockets or network.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { handleImportAi } from './handlers.js';

export const BODY_LIMIT = 10 * 1024 * 1024; // ~10MB request bodies

const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
});

export function pickMime(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

// Resolve a URL path inside staticRoot, or null when it escapes (.., encoded
// dots, NUL bytes, absolute hosts). '/' and directory URLs serve index.html.
export function resolveStaticPath(staticRoot, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent((urlPath || '/').split('?')[0]);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  if (decoded.endsWith('/')) decoded += 'index.html';
  if (!decoded.startsWith('/')) decoded = '/' + decoded;
  const root = path.resolve(staticRoot);
  const abs = path.resolve(root, '.' + decoded);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

// Collect the request body, rejecting anything over `limit`. Bytes past the
// limit are drained (not destroyed) so the 413 response still reaches the
// client before the socket closes.
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        const err = new Error('request body too large');
        err.code = 'BODY_TOO_LARGE';
        reject(err);
        return;
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function respond(res, status, json) {
  const body = JSON.stringify(json);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

// Build the http request handler. deps: { staticRoot, fetch, env, bodyLimit },
// all injectable so tests run the whole server without network or real keys.
export function createRequestHandler(deps = {}) {
  const staticRoot = deps.staticRoot ? path.resolve(deps.staticRoot) : null;
  const fetchImpl = deps.fetch || globalThis.fetch;
  const env = deps.env || {};
  const bodyLimit = deps.bodyLimit ?? BODY_LIMIT;

  return async function handle(req, res) {
    const url = req.url || '/';
    if (url === '/api/import-ai' || url.startsWith('/api/import-ai?')) {
      if (req.method !== 'POST') {
        respond(res, 405, { error: 'method_not_allowed' });
        return;
      }
      let raw;
      try {
        raw = await readBody(req, bodyLimit);
      } catch (err) {
        if (err && err.code === 'BODY_TOO_LARGE') {
          respond(res, 413, { error: 'body_too_large' });
          return;
        }
        throw err;
      }
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        respond(res, 400, { error: 'bad_json', detail: 'body is not valid JSON' });
        return;
      }
      const { status, json } = await handleImportAi(body, { fetch: fetchImpl, env });
      respond(res, status, json);
      return;
    }
    if (url.startsWith('/api/') || url.startsWith('/api?')) {
      respond(res, 404, { error: 'not_found' });
      return;
    }
    if (!staticRoot) {
      respond(res, 404, { error: 'no_static', detail: 'start the server with --static <dir> to serve the app' });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      respond(res, 405, { error: 'method_not_allowed' });
      return;
    }
    const abs = resolveStaticPath(staticRoot, url);
    if (!abs) {
      respond(res, 404, { error: 'not_found' });
      return;
    }
    try {
      const data = await fs.promises.readFile(abs);
      res.writeHead(200, {
        'content-type': pickMime(abs),
        'content-length': data.length,
        'cache-control': 'no-cache',
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch {
      respond(res, 404, { error: 'not_found' });
    }
  };
}

export function createServer(deps = {}) {
  return http.createServer(createRequestHandler(deps));
}

// --port 8090 or --port=8090, --static <dir> or --static=<dir>. Unknown
// arguments are ignored so future flags do not crash older scripts. A port
// that is not a positive integer becomes null (then the default applies).
export function parseArgs(argv) {
  const args = { port: null, staticDir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') args.port = Number(argv[++i]);
    else if (a.startsWith('--port=')) args.port = Number(a.slice('--port='.length));
    else if (a === '--static') args.staticDir = argv[++i] || null;
    else if (a.startsWith('--static=')) args.staticDir = a.slice('--static='.length) || null;
  }
  if (!Number.isInteger(args.port) || args.port <= 0 || args.port > 65535) args.port = null;
  return args;
}

// Entry point. Returns the server so callers (and tests) can close it.
export function main(argv = [], { env = process.env } = {}) {
  const args = parseArgs(argv);
  const envPort = Number(env.PORT);
  const port = args.port || (Number.isInteger(envPort) && envPort > 0 ? envPort : 8787);
  const server = createServer({ staticRoot: args.staticDir, env });
  server.listen(port, () => {
    const mode = args.staticDir ? 'static: ' + args.staticDir : 'API only';
    console.log('PA27 import server listening on port ' + port + ' (' + mode + ')');
  });
  return server;
}

// Run only when executed directly (node server/server.js ...).
const isMain = process.argv[1] && (() => {
  try { return import.meta.url === pathToFileURL(process.argv[1]).href; }
  catch { return false; }
})();
if (isMain) main(process.argv.slice(2));
