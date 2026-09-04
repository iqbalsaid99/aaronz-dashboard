import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest, PORTALS, upstreamUrl } from '../functions/_lib/portalLeads.js';

/**
 * The Bayut proxy.
 *
 * Two properties are worth a test here and the rest is plumbing. The first is
 * that the key never reaches the caller or the URL — it is an account-wide
 * credential over every lead Bayut holds for us, names and phone numbers
 * included. The second is the parameter whitelist: this route is reachable by
 * every signed-in user, so what the caller can steer has to be exactly the four
 * documented parameters and nothing they invent.
 */

const KEY = 'test-bayut-key';
const env = { BAYUT_API_KEY: KEY };
const data = { user: { id: 'user-1' }, token: 'session-jwt' };

const req = (qs = '', { path = '/api/bayut', method = 'GET' } = {}) =>
  new Request(`https://dash.example.com${path}${qs}`, { method });

/** Records what the proxy asked upstream, and answers with what you give it. */
function withFetch({ status = 200, body = '[]', contentType = 'application/json' } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(body, { status, headers: { 'Content-Type': contentType } });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const run = (request, opts, over = {}) => onRequest({ request, env, data, ...over });

test('no session — refuses, and never calls upstream', async () => {
  const f = withFetch();
  try {
    const res = await run(req('?type=call_logs'), null, { data: {} });
    assert.equal(res.status, 401);
    assert.equal(f.calls.length, 0, 'upstream must not be touched without a session');
  } finally { f.restore(); }
});

test('unknown portal — 404, and never calls upstream', async () => {
  const f = withFetch();
  try {
    const res = await run(req('?type=call_logs', { path: '/api/zoopla' }));
    assert.equal(res.status, 404);
    assert.equal(f.calls.length, 0);
  } finally { f.restore(); }
});

test('missing key — 503 naming the variable, and never calls upstream', async () => {
  const f = withFetch();
  try {
    const res = await onRequest({ request: req('?type=call_logs'), env: {}, data });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.match(body.detail, /BAYUT_API_KEY/);
    assert.equal(f.calls.length, 0);
  } finally { f.restore(); }
});

test('POST is refused — this is a read-only proxy', async () => {
  const f = withFetch();
  try {
    const res = await run(req('?type=call_logs', { method: 'POST' }));
    assert.equal(res.status, 405);
    assert.equal(f.calls.length, 0);
  } finally { f.restore(); }
});

test('only the four documented parameters are forwarded', async () => {
  const f = withFetch();
  try {
    await run(req(
      '?type=email&target=listing&is_trulead=1&timestamp=2026-07-22 00:00:00' +
      '&limit=99999&api_key=stolen&callback=evil'
    ));
    const { searchParams } = new URL(f.calls[0].url);
    assert.deepEqual([...searchParams.keys()].sort(), ['is_trulead', 'target', 'timestamp', 'type']);
    assert.equal(searchParams.get('limit'), null);
    assert.equal(searchParams.get('api_key'), null);
    assert.equal(searchParams.get('callback'), null);
  } finally { f.restore(); }
});

test('the key travels as a header, never in the URL or the response', async () => {
  const f = withFetch({ body: '[{"lead_id":"x"}]' });
  try {
    const res = await run(req('?type=call_logs&timestamp=2026-07-22 00:00:00'));
    const call = f.calls[0];
    assert.equal(call.init.headers.Authorization, `Bearer ${KEY}`);
    assert.ok(!call.url.includes(KEY), 'key must not be in the upstream URL');
    assert.ok(!(await res.text()).includes(KEY), 'key must not reach the caller');
  } finally { f.restore(); }
});

test('timestamp keeps its space as %20, not +', async () => {
  const f = withFetch();
  try {
    await run(req('?type=call_logs&timestamp=2026-07-22 00:00:00'));
    // The distinction is real: `+` is a form-encoding convention this endpoint
    // does not read back as a space.
    assert.match(f.calls[0].url, /timestamp=2026-07-22%2000%3A00%3A00/);
    assert.ok(!f.calls[0].url.includes('+'));
  } finally { f.restore(); }
});

test('empty parameters are dropped rather than sent blank', async () => {
  const f = withFetch();
  try {
    // call_logs and story_leads take no target and no is_trulead.
    await run(req('?type=call_logs&target=&is_trulead=&timestamp=2026-07-22 00:00:00'));
    const { searchParams } = new URL(f.calls[0].url);
    assert.deepEqual([...searchParams.keys()].sort(), ['timestamp', 'type']);
  } finally { f.restore(); }
});

test('a successful array passes through untouched', async () => {
  const f = withFetch({ body: '[{"lead_id":"a"},{"lead_id":"b"}]' });
  try {
    const res = await run(req('?type=call_logs'));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), [{ lead_id: 'a' }, { lead_id: 'b' }]);
  } finally { f.restore(); }
});

test('an empty array is a result, not an error', async () => {
  const f = withFetch({ body: '[]' });
  try {
    const res = await run(req('?type=story_leads'));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
  } finally { f.restore(); }
});

test("upstream's own error message survives as detail", async () => {
  // The real 422 when timestamp reaches past the ~6-month floor. The sentence
  // is the only thing that tells the user what to do, so it must not be
  // flattened into a bare status code.
  const f = withFetch({
    status: 422,
    body: JSON.stringify({
      message: 'The timestamp must be a date after or equal to 2026-02-21 13:06:04.',
      errors: { timestamp: ['The timestamp must be a date after or equal to 2026-02-21 13:06:04.'] },
    }),
  });
  try {
    const res = await run(req('?type=email&target=listing&is_trulead=1&timestamp=2025-01-01 00:00:00'));
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.match(body.error, /422/);
    assert.match(body.detail, /after or equal to 2026-02-21/);
  } finally { f.restore(); }
});

test('a non-JSON error body becomes JSON, with the status kept', async () => {
  const f = withFetch({ status: 502, body: '<html><body>Bad gateway</body></html>', contentType: 'text/html' });
  try {
    const res = await run(req('?type=call_logs'));
    assert.equal(res.status, 502);
    assert.equal(res.headers.get('Content-Type'), 'application/json');
    const body = await res.json();
    assert.match(body.detail, /Bad gateway/);
  } finally { f.restore(); }
});

test('a non-JSON 200 is treated as broken, not as data', async () => {
  const f = withFetch({ status: 200, body: '<html>login</html>', contentType: 'text/html' });
  try {
    const res = await run(req('?type=call_logs'));
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /not JSON/);
  } finally { f.restore(); }
});

test('an unreachable upstream is a 502, not an unhandled throw', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
  try {
    const res = await run(req('?type=call_logs'));
    assert.equal(res.status, 502);
    assert.match((await res.json()).detail, /ECONNREFUSED/);
  } finally { globalThis.fetch = original; }
});

test('adding a portal is a config entry — the URL builder is portal-agnostic', () => {
  // Standing in for the dubizzle entry that is commented out in PORTALS. If
  // this ever needs code rather than config, this test is where it shows.
  const dubizzle = {
    label: 'dubizzle',
    url: 'https://dubizzle.com/profolio/api-v7/stats/website-client-leads',
    keyVar: 'BAYUT_API_KEY',
  };
  const params = { type: 'email', target: 'listing', is_trulead: 1, timestamp: '2026-07-22 00:00:00' };
  const built = upstreamUrl(dubizzle, (n) => params[n]);

  assert.ok(built.startsWith(dubizzle.url + '?'));
  assert.match(built, /timestamp=2026-07-22%2000%3A00%3A00/);
  assert.equal(PORTALS.bayut.url, 'https://www.bayut.com/api-v7/stats/website-client-leads');
});
