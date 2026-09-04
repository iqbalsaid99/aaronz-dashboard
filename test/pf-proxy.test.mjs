import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from '../functions/pf/[[path]].js';

/**
 * The Property Finder proxy's retry and blocked-upstream handling.
 *
 * Two real incidents are pinned here. A CloudFront WAF block returned a 403
 * HTML page in place of JSON, which the client then failed to parse with an
 * error that said nothing about the cause. And listing-verifications returned
 * 500 for a spell before recovering on its own.
 */

const env = {
  PROPERTYFINDER_API_KEY: 'key',
  PROPERTYFINDER_API_SECRET: 'secret',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'anon',
};

const req = (path = '/pf/v1/listing-verifications?perPage=50', method = 'GET') =>
  new Request(`https://dash.example.com${path}`, { method });

/**
 * Scripted fetch. Auth always succeeds; `atlas` is the queue of responses the
 * API hands back, last one repeating.
 */
function withFetch(atlas) {
  const calls = [];
  const original = globalThis.fetch;
  let i = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('auth.propertyfinder.com')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 1800 }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    const r = atlas[Math.min(i++, atlas.length - 1)];
    return new Response(r.body ?? '{}', {
      status: r.status,
      headers: { 'Content-Type': r.type ?? 'application/json' },
    });
  };
  return {
    atlasCalls: () => calls.filter((u) => u.includes('atlas')),
    restore: () => { globalThis.fetch = original; },
  };
}

test('a transient upstream 500 is retried once and succeeds', async () => {
  const f = withFetch([
    { status: 500, body: '{"title":"Internal Server Error"}' },
    { status: 200, body: '{"submissions":[],"pageMetadata":{"total":132}}' },
  ]);
  try {
    const res = await onRequest({ request: req(), env });
    assert.equal(res.status, 200);
    assert.equal(f.atlasCalls().length, 2, 'one retry');
    assert.match(await res.text(), /submissions/);
  } finally { f.restore(); }
});

test('a persistent 500 is passed through, not retried forever', async () => {
  const f = withFetch([{ status: 500, body: '{"title":"Internal Server Error"}' }]);
  try {
    const res = await onRequest({ request: req(), env });
    assert.equal(res.status, 500, 'upstream status is preserved, not turned into a 502');
    assert.equal(f.atlasCalls().length, 2, 'exactly one retry, then give up');
  } finally { f.restore(); }
});

/** Capture console.error while a block runs. */
async function withCapturedErrors(fn) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.join(' '));
  try { await fn(); } finally { console.error = original; }
  return lines;
}

test('a retry is logged even when it succeeds, with path and status', async () => {
  const f = withFetch([
    { status: 500, body: '{}' },
    { status: 200, body: '{"submissions":[]}' },
  ]);
  try {
    const lines = await withCapturedErrors(() => onRequest({ request: req(), env }));
    assert.equal(lines.length, 2, 'the attempt and its outcome, not just failures');
    assert.match(lines[0], /listing-verifications/, 'path is named');
    assert.match(lines[0], /500/, 'upstream status is named');
    assert.match(lines[1], /500 → 200/);
    assert.match(lines[1], /recovered/);
  } finally { f.restore(); }
});

test('a retry that keeps failing is logged as still failing', async () => {
  const f = withFetch([{ status: 503, body: '{}' }]);
  try {
    const lines = await withCapturedErrors(() => onRequest({ request: req(), env }));
    assert.equal(lines.length, 2);
    assert.match(lines[1], /503 → 503/);
    assert.match(lines[1], /still failing/);
  } finally { f.restore(); }
});

test('a healthy request logs nothing', async () => {
  const f = withFetch([{ status: 200, body: '{}' }]);
  try {
    const lines = await withCapturedErrors(() => onRequest({ request: req(), env }));
    assert.deepEqual(lines, [], 'the tail must stay quiet when nothing is wrong');
  } finally { f.restore(); }
});

test('a 4xx is never retried', async () => {
  const f = withFetch([{ status: 422, body: '{"title":"Unprocessable"}' }]);
  try {
    const res = await onRequest({ request: req(), env });
    assert.equal(res.status, 422);
    assert.equal(f.atlasCalls().length, 1, 'client errors are the caller\'s problem');
  } finally { f.restore(); }
});

test('a non-GET is never retried', async () => {
  const f = withFetch([{ status: 500, body: '{}' }]);
  try {
    await onRequest({ request: req('/pf/v1/anything', 'POST'), env });
    assert.equal(f.atlasCalls().length, 1, 'retrying a write turns one action into two');
  } finally { f.restore(); }
});

test('a WAF page becomes a clear message, not the HTML', async () => {
  const f = withFetch([{ status: 403, type: 'text/html', body: '<!DOCTYPE HTML><html>Request blocked</html>' }]);
  try {
    const res = await onRequest({ request: req(), env });
    const body = JSON.parse(await res.text());
    assert.equal(res.status, 502);
    assert.match(body.detail, /firewall/i);
    assert.ok(!body.detail.includes('DOCTYPE'), 'the page itself must not be dumped into the error');
  } finally { f.restore(); }
});

test('an unlabelled HTML body is still detected', async () => {
  // The WAF does not always set text/html, so the first character is sniffed.
  const f = withFetch([{ status: 403, type: 'application/json', body: '  <html>blocked</html>' }]);
  try {
    const res = await onRequest({ request: req(), env });
    assert.match(JSON.parse(await res.text()).detail, /firewall/i);
  } finally { f.restore(); }
});

test('a healthy response passes straight through', async () => {
  const f = withFetch([{ status: 200, body: '{"remaining":15815}' }]);
  try {
    const res = await onRequest({ request: req('/pf/v1/credits/balance'), env });
    assert.equal(res.status, 200);
    assert.equal(f.atlasCalls().length, 1);
    assert.match(await res.text(), /15815/);
  } finally { f.restore(); }
});
