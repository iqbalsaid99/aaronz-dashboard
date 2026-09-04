import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from '../functions/meta/[[path]].js';

/**
 * The allowlist on the Meta proxy.
 *
 * The token is a long-lived credential over a whole ad account, so the risk is
 * not a bad report — it is the proxy being used as a general Graph client. Each
 * of these asserts that a path the caller invents cannot reach the token.
 */

const env = {
  META_TOKEN: 'secret-token',
  META_AD_ACCOUNT_ID: 'act_999999',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'anon',
};

const data = { user: { id: 'user-1' }, token: 'session-jwt' };

const req = (path) => new Request(`https://dash.example.com${path}`);

/** Supabase answers the profile lookup; graph.facebook.com answers insights. */
function withFetch({ profile = [{ id: 'user-1', role: 'broker', is_active: true }], graph } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('supabase.co')) {
      return new Response(JSON.stringify(profile), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(graph?.body ?? '{"data":[]}', {
      status: graph?.status ?? 200,
      headers: { 'Content-Type': graph?.type ?? 'application/json' },
    });
  };
  return {
    graphCalls: () => calls.filter((u) => u.includes('graph.facebook.com')),
    restore: () => { globalThis.fetch = original; },
  };
}

test('the configured account is reachable', async () => {
  const f = withFetch();
  try {
    const res = await onRequest({ request: req('/meta/insights?level=campaign'), env, data });
    assert.equal(res.status, 200);
    assert.equal(f.graphCalls().length, 1);
    assert.match(f.graphCalls()[0], /act_999999\/insights/);
  } finally { f.restore(); }
});

test('another ad account is refused, and never reaches Meta', async () => {
  const f = withFetch();
  try {
    const res = await onRequest({ request: req('/meta/act_111111/insights'), env, data });
    assert.equal(res.status, 403);
    assert.equal(f.graphCalls().length, 0, 'the token must not be spent on someone else\'s account');
  } finally { f.restore(); }
});

test('paths outside the table are refused', async () => {
  const f = withFetch();
  try {
    for (const p of ['/meta/me', '/meta/act_999999/adsets', '/meta/act_999999/audiences',
                     '/meta/act_999999/insights/../adsets']) {
      const res = await onRequest({ request: req(p), env, data });
      assert.equal(res.status, 403, `${p} should be refused`);
    }
    assert.equal(f.graphCalls().length, 0);
  } finally { f.restore(); }
});

test('campaign objects are readable, but only on our own account', async () => {
  const f = withFetch();
  try {
    const ours = await onRequest({
      request: req('/meta/campaigns?fields=id,name,created_time'), env, data,
    });
    assert.equal(ours.status, 200);
    assert.match(f.graphCalls()[0], /act_999999\/campaigns/);

    // The route exists now, which makes the account check the only thing
    // standing between a caller and someone else's campaign list.
    const theirs = await onRequest({ request: req('/meta/act_111111/campaigns'), env, data });
    assert.equal(theirs.status, 403);
    assert.equal(f.graphCalls().length, 1, 'the refused one never reached Meta');
  } finally { f.restore(); }
});

test('a caller cannot substitute their own access token', async () => {
  const f = withFetch();
  try {
    await onRequest({ request: req('/meta/insights?access_token=attacker-token'), env, data });
    const url = f.graphCalls()[0];
    assert.match(url, /access_token=secret-token/, 'the secret is used');
    assert.ok(!url.includes('attacker-token'), 'the caller-supplied one is stripped');
    assert.equal((url.match(/access_token=/g) ?? []).length, 1, 'and not simply appended alongside');
  } finally { f.restore(); }
});

test('report parameters are passed through untouched', async () => {
  const f = withFetch();
  try {
    await onRequest({
      request: req('/meta/insights?level=campaign&use_unified_attribution_setting=true&limit=200'),
      env, data,
    });
    const url = f.graphCalls()[0];
    assert.match(url, /level=campaign/);
    assert.match(url, /use_unified_attribution_setting=true/);
    assert.match(url, /limit=200/);
  } finally { f.restore(); }
});

test('no profile row fails closed with 401', async () => {
  const f = withFetch({ profile: [] });
  try {
    const res = await onRequest({ request: req('/meta/insights'), env, data });
    assert.equal(res.status, 401);
    assert.equal(f.graphCalls().length, 0);
  } finally { f.restore(); }
});

test('a deactivated account fails closed too', async () => {
  const f = withFetch({ profile: [{ id: 'user-1', role: 'admin', is_active: false }] });
  try {
    assert.equal((await onRequest({ request: req('/meta/insights'), env, data })).status, 401);
  } finally { f.restore(); }
});

test('missing configuration is a 503, not a broken request to Meta', async () => {
  const f = withFetch();
  try {
    const res = await onRequest({ request: req('/meta/insights'), env: { ...env, META_TOKEN: '' }, data });
    assert.equal(res.status, 503);
    assert.equal(f.graphCalls().length, 0);
  } finally { f.restore(); }
});

test('an HTML response is never passed through as JSON', async () => {
  const f = withFetch({ graph: { status: 403, type: 'text/html', body: '<!DOCTYPE html><html>blocked</html>' } });
  try {
    const res = await onRequest({ request: req('/meta/insights'), env, data });
    const body = JSON.parse(await res.text());
    assert.equal(res.status, 502);
    assert.ok(!JSON.stringify(body).includes('DOCTYPE'));
  } finally { f.restore(); }
});

test('a Graph error is passed through intact — it says what is wrong', async () => {
  const f = withFetch({ graph: { status: 400, body: '{"error":{"message":"Error validating access token","code":190}}' } });
  try {
    const res = await onRequest({ request: req('/meta/insights'), env, data });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /validating access token/);
  } finally { f.restore(); }
});

/* --------------------------- video ownership --------------------------- */

/**
 * The video route is the only one that takes an id from the caller, so it is
 * the only one that could be turned into a general Graph reader. These pin
 * that it cannot.
 */
function withVideoFetch({ accountVideoIds = ['907241858673560'], video } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('supabase.co')) {
      return new Response(JSON.stringify([{ id: 'user-1', role: 'admin', is_active: true }]),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (u.includes('/ads?')) {
      return new Response(JSON.stringify({
        data: accountVideoIds.map((id) => ({
          creative: { object_story_spec: { video_data: { video_id: id } } },
        })),
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(video?.body ?? '{"source":"https://cdn/x.mp4","picture":"P","length":61}',
      { status: video?.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  };
  return {
    videoCalls: () => calls.filter((u) => /graph\.facebook\.com\/v[\d.]+\/\d+\?/.test(u)),
    restore: () => { globalThis.fetch = original; },
  };
}

test('a video on this account is readable', async () => {
  const f = withVideoFetch();
  try {
    const res = await onRequest({ request: req('/meta/video/907241858673560'), env, data });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /source/);
    assert.equal(f.videoCalls().length, 1);
    assert.match(f.videoCalls()[0], /fields=source%2Cpicture%2Clength/);
  } finally { f.restore(); }
});

test('a video NOT on this account is refused and never fetched', async () => {
  const f = withVideoFetch({ accountVideoIds: ['111'] });
  try {
    const res = await onRequest({ request: req('/meta/video/999999999'), env, data });
    assert.equal(res.status, 403);
    assert.equal(f.videoCalls().length, 0, 'the token must not be spent on a foreign video');
  } finally { f.restore(); }
});

test('the caller cannot widen the fields', async () => {
  const f = withVideoFetch();
  try {
    await onRequest({
      request: req('/meta/video/907241858673560?fields=source,permalink_url,from,privacy'),
      env, data,
    });
    const url = f.videoCalls()[0];
    assert.match(url, /fields=source%2Cpicture%2Clength/);
    assert.ok(!url.includes('privacy'), 'requested extra fields are discarded');
    assert.ok(!url.includes('permalink'), 'requested extra fields are discarded');
  } finally { f.restore(); }
});

test('a non-numeric video id is not a route at all', async () => {
  const f = withVideoFetch();
  try {
    for (const p of ['/meta/video/me', '/meta/video/123abc', '/meta/video/', '/meta/video/1;2']) {
      const res = await onRequest({ request: req(p), env, data });
      assert.equal(res.status, 403, p);
    }
    assert.equal(f.videoCalls().length, 0);
  } finally { f.restore(); }
});

test('a traversal in the path normalises before we see it', async () => {
  // "/meta/video/../ads" is not a video request that escapes — URL parsing
  // collapses it to "/meta/ads" before the handler runs, which is an allowed
  // route on our own account with fields we control. Worth pinning so nobody
  // later reads the 200 as a bypass.
  const f = withVideoFetch();
  try {
    assert.equal(new URL('https://d.example.com/meta/video/../ads').pathname, '/meta/ads');
    const res = await onRequest({ request: req('/meta/video/../ads'), env, data });
    assert.equal(res.status, 200);
    assert.equal(f.videoCalls().length, 0, 'it went to the ads edge, not a video read');
  } finally { f.restore(); }
});

test('an unauthorised caller cannot probe which videos exist', async () => {
  // No profile row: refused before the ownership lookup runs, so the account's
  // creatives are never even listed.
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('supabase.co')) {
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 200 });
  };
  try {
    const res = await onRequest({ request: req('/meta/video/907241858673560'), env, data });
    assert.equal(res.status, 401);
    assert.equal(calls.filter((u) => u.includes('graph.facebook.com')).length, 0);
  } finally { globalThis.fetch = original; }
});
