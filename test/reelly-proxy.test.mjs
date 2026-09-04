import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest, upstreamPath, FORWARDED, DEFAULTS } from '../functions/api/reelly/[[path]].js';

/**
 * The Reelly proxy.
 *
 * Three properties earn a test. The key is a client-level credential over our
 * whole Reelly account, so it must never appear in a URL or a response body.
 * The route list must stay an allowlist — that key reaches developers, brokers
 * and every metadata endpoint, and a path-through proxy would hand all of it
 * to anyone with a dashboard login. And the edge cache must never be keyed on
 * anything about the caller, or it fragments per user and stops being a cache.
 */

const KEY = 'test-reelly-key';
const env = { REELLY_API_KEY: KEY };
const data = { user: { id: 'user-1' }, token: 'session-jwt' };

const req = (path, qs = '', method = 'GET') =>
  new Request(`https://dash.example.com${path}${qs}`, {
    method,
    headers: { Authorization: 'Bearer session-jwt' },
  });

/** A cache that records what it was asked to store, standing in for caches.default. */
function stubCaches({ preload = null } = {}) {
  const store = new Map();
  const keys = [];
  if (preload) store.set(preload.url, preload.response);
  const original = globalThis.caches;
  globalThis.caches = {
    default: {
      async match(request) {
        keys.push({ op: 'match', url: request.url });
        const hit = store.get(request.url);
        return hit ? hit.clone() : undefined;
      },
      async put(request, response) {
        keys.push({ op: 'put', url: request.url, headers: [...request.headers.keys()] });
        store.set(request.url, response);
      },
    },
  };
  return { keys, store, restore: () => { globalThis.caches = original; } };
}

function stubFetch({ status = 200, body = '{"count":0,"results":[]}', contentType = 'application/json' } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(body, { status, headers: { 'Content-Type': contentType } });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const run = (request, over = {}) =>
  onRequest({ request, env, data, waitUntil: (p) => p, ...over });

/* ------------------------------ the route list --------------------------- */

test('upstreamPath maps only the routes we serve', () => {
  assert.equal(upstreamPath('/api/reelly/projects'), '/api/v2/clients/projects');
  assert.equal(upstreamPath('/api/reelly/projects/'), '/api/v2/clients/projects');
  assert.equal(upstreamPath('/api/reelly/projects/12'), '/api/v2/clients/projects/12');
});

test('a word segment cannot reach the digits-only detail route', () => {
  assert.equal(upstreamPath('/api/reelly/projects/abc'), null);
});

test('upstreamPath refuses everything else, including traversal and sibling endpoints', () => {
  for (const p of [
    '/api/reelly/developers',
    '/api/reelly/brokers',
    '/api/reelly/projects/12/units',
    '/api/reelly/projects/abc',
    '/api/reelly/projects/../../admin',
    '/api/reelly/projects/12/../13',
    '/api/reelly',
    '/api/reelly/',
  ]) {
    assert.equal(upstreamPath(p), null, `${p} must not be proxied`);
  }
});

test('an unknown route is a 404 and never reaches Reelly', async () => {
  const c = stubCaches(); const f = stubFetch();
  try {
    const res = await run(req('/api/reelly/developers'));
    assert.equal(res.status, 404);
    assert.equal(f.calls.length, 0);
  } finally { f.restore(); c.restore(); }
});

/* --------------------------------- auth ---------------------------------- */

test('no session — refuses, and never reaches Reelly or the cache', async () => {
  const c = stubCaches(); const f = stubFetch();
  try {
    const res = await run(req('/api/reelly/projects'), { data: {} });
    assert.equal(res.status, 401);
    assert.equal(f.calls.length, 0);
    assert.equal(c.keys.length, 0, 'a cache hit must not be a way around the gate');
  } finally { f.restore(); c.restore(); }
});

test('POST is refused — this is a read-only proxy', async () => {
  const c = stubCaches(); const f = stubFetch();
  try {
    const res = await run(req('/api/reelly/projects', '', 'POST'));
    assert.equal(res.status, 405);
    assert.equal(f.calls.length, 0);
  } finally { f.restore(); c.restore(); }
});

test('missing key — 503 naming the variable, and never reaches Reelly', async () => {
  const c = stubCaches(); const f = stubFetch();
  try {
    const res = await onRequest({ request: req('/api/reelly/projects'), env: {}, data, waitUntil: (p) => p });
    assert.equal(res.status, 503);
    assert.match((await res.json()).detail, /REELLY_API_KEY/);
    assert.equal(f.calls.length, 0);
  } finally { f.restore(); c.restore(); }
});

/* ------------------------------ the whitelist ---------------------------- */

test('only whitelisted parameters are forwarded', async () => {
  const c = stubCaches(); const f = stubFetch();
  try {
    await run(req('/api/reelly/projects', '?search_query=palm&limit=24&evil=1&token=stolen&format=xml'));
    const { searchParams } = new URL(f.calls[0].url);
    assert.equal(searchParams.get('search_query'), 'palm');
    assert.equal(searchParams.get('limit'), '24');
    assert.equal(searchParams.get('evil'), null);
    assert.equal(searchParams.get('token'), null);
    assert.equal(searchParams.get('format'), null);
    for (const k of searchParams.keys()) {
      assert.ok(FORWARDED.includes(k), `${k} should not have been forwarded`);
    }
  } finally { f.restore(); c.restore(); }
});

test('the UAE / AED / sqft defaults are applied when the caller omits them', async () => {
  const c = stubCaches(); const f = stubFetch();
  try {
    await run(req('/api/reelly/projects', '?limit=24'));
    const { searchParams } = new URL(f.calls[0].url);
    assert.equal(searchParams.get('country'), 'United Arab Emirates');
    assert.equal(searchParams.get('preferred_currency'), 'AED');
    assert.equal(searchParams.get('preferred_area_unit'), 'sqft');
  } finally { f.restore(); c.restore(); }
});

test('a caller may still override a default', async () => {
  const c = stubCaches(); const f = stubFetch();
  try {
    await run(req('/api/reelly/projects', '?preferred_currency=USD'));
    assert.equal(new URL(f.calls[0].url).searchParams.get('preferred_currency'), 'USD');
  } finally { f.restore(); c.restore(); }
});

test('DEFAULTS are themselves forwardable, or they could never be overridden', () => {
  for (const k of Object.keys(DEFAULTS)) assert.ok(FORWARDED.includes(k), `${k} missing from FORWARDED`);
});

/* ---------------------------------- key ---------------------------------- */

test('the key travels as X-API-Key, never in the URL or the response', async () => {
  const c = stubCaches(); const f = stubFetch({ body: '{"count":1,"results":[{"id":12}]}' });
  try {
    const res = await run(req('/api/reelly/projects'));
    assert.equal(f.calls[0].init.headers['X-API-Key'], KEY);
    assert.equal(f.calls[0].init.headers.Authorization, undefined, 'not a Bearer API');
    assert.ok(!f.calls[0].url.includes(KEY));
    assert.ok(!(await res.text()).includes(KEY));
  } finally { f.restore(); c.restore(); }
});

/* --------------------------------- cache --------------------------------- */

test('the cache key carries no caller headers and is order-independent', async () => {
  const c = stubCaches(); const f = stubFetch();
  try {
    await run(req('/api/reelly/projects', '?limit=24&search_query=palm'));

    const puts = c.keys.filter((k) => k.op === 'put');
    assert.equal(puts.length, 1);
    assert.deepEqual(puts[0].headers, [], 'no caller headers may reach the cache key');
    assert.ok(!puts[0].url.includes(KEY));
    assert.ok(!puts[0].url.includes('session-jwt'));

    // The same question with the parameters in a different order must land on
    // the same entry. Serving it from cache IS the proof: a fragmented key
    // would miss and call upstream again.
    const before = f.calls.length;
    const res = await run(req('/api/reelly/projects', '?search_query=palm&limit=24'));
    assert.equal(res.headers.get('X-Reelly-Cache'), 'hit');
    assert.equal(f.calls.length, before, 'parameter order must not fragment the cache');
  } finally { f.restore(); c.restore(); }
});

test('a cache hit is served without calling Reelly', async () => {
  const c = stubCaches(); const f = stubFetch();
  try {
    await run(req('/api/reelly/projects', '?limit=24'));
    const first = f.calls.length;
    const res = await run(req('/api/reelly/projects', '?limit=24'));
    assert.equal(f.calls.length, first, 'second identical request must not hit upstream');
    assert.equal(res.headers.get('X-Reelly-Cache'), 'hit');
  } finally { f.restore(); c.restore(); }
});

test('a failure is never cached — an outage must not persist for an hour', async () => {
  const c = stubCaches(); const f = stubFetch({ status: 500, body: '{"detail":"boom"}' });
  try {
    const res = await run(req('/api/reelly/projects', '?limit=24'));
    assert.equal(res.status, 500);
    assert.equal(c.keys.filter((k) => k.op === 'put').length, 0);
  } finally { f.restore(); c.restore(); }
});

/* -------------------------------- upstream -------------------------------- */

test('a 404 from Reelly keeps its status and message', async () => {
  const c = stubCaches();
  const f = stubFetch({ status: 404, body: '{"detail":"No Project matches the given query."}' });
  try {
    const res = await run(req('/api/reelly/projects/999999'));
    assert.equal(res.status, 404);
    assert.match((await res.json()).detail, /No Project matches/);
  } finally { f.restore(); c.restore(); }
});

test('a non-JSON body becomes JSON rather than a parse error downstream', async () => {
  const c = stubCaches();
  const f = stubFetch({ status: 502, body: '<html>Application failed to respond</html>', contentType: 'text/html' });
  try {
    const res = await run(req('/api/reelly/projects'));
    assert.equal(res.status, 502);
    assert.equal(res.headers.get('Content-Type'), 'application/json');
    assert.match((await res.json()).detail, /Application failed to respond/);
  } finally { f.restore(); c.restore(); }
});

test('an unreachable upstream is a 502, not an unhandled throw', async () => {
  const c = stubCaches();
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
  try {
    const res = await run(req('/api/reelly/projects'));
    assert.equal(res.status, 502);
    assert.match((await res.json()).detail, /ECONNREFUSED/);
  } finally { globalThis.fetch = original; c.restore(); }
});
