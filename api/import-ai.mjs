// Vercel Function for POST /api/import-ai. Same contract as server/server.js:
// the shared handler in server/handlers.js does all the work. The Anthropic
// key comes from ANTHROPIC_API_KEY in Vercel; without it the route answers
// 503 ai_unavailable and the app falls back to its built-in importers.
import { handleImportAi } from '../server/handlers.js';

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: 'bad_json', detail: 'body is not valid JSON' });
  }
  try {
    const { status, json: out } = await handleImportAi(body, { fetch: globalThis.fetch, env: process.env });
    return json(status, out);
  } catch {
    return json(500, { error: 'server_error' });
  }
}

export function GET() {
  return json(405, { error: 'method_not_allowed' });
}
