import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidSession } from '../functions/_lib/session.js';

/**
 * How a failed auth check is classified.
 *
 * The regression this pins: `if (!res.ok) return null` treated a 429 as an
 * invalid session, so under a burst the later pages of a lead pull told a
 * signed-in user their session had expired. Only the auth service saying the
 * token is bad may produce that; everything else has to surface as an outage.
 */

const env = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'anon' };

/** Swap global fetch for a scripted sequence, and count the calls. */
function withFetch(responses) {
  const calls = [];
  const original = globalThis.fetch;
  let i = 0;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const r = responses[Math.min(i++, responses.length - 1)];
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body ?? {},
      text: async () => JSON.stringify(r.body ?? {}),
    };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const uniqueToken = (() => { let n = 0; return () => `tok-${++n}-${process.pid}`; })();

test('a valid session resolves to the user', async () => {
  const f = withFetch([{ status: 200, body: { id: 'user-1' } }]);
  try {
    assert.deepEqual(await isValidSession(uniqueToken(), env), { id: 'user-1' });
  } finally { f.restore(); }
});

test('401 means the token really is invalid', async () => {
  const f = withFetch([{ status: 401 }]);
  try {
    assert.equal(await isValidSession(uniqueToken(), env), null);
  } finally { f.restore(); }
});

test('403 means the token really is invalid', async () => {
  const f = withFetch([{ status: 403 }]);
  try {
    assert.equal(await isValidSession(uniqueToken(), env), null);
  } finally { f.restore(); }
});

test('429 is rate limiting, not a signed-out user — it must throw', async () => {
  const f = withFetch([{ status: 429 }, { status: 429 }]);
  try {
    await assert.rejects(() => isValidSession(uniqueToken(), env), /429/);
    assert.equal(f.calls.length, 2, 'retried once before giving up');
  } finally { f.restore(); }
});

test('a 429 that clears on retry succeeds', async () => {
  const f = withFetch([{ status: 429 }, { status: 200, body: { id: 'user-2' } }]);
  try {
    assert.deepEqual(await isValidSession(uniqueToken(), env), { id: 'user-2' });
    assert.equal(f.calls.length, 2);
  } finally { f.restore(); }
});

test('a 500 throws rather than reporting the session invalid', async () => {
  const f = withFetch([{ status: 500 }, { status: 500 }]);
  try {
    await assert.rejects(() => isValidSession(uniqueToken(), env), /500/);
  } finally { f.restore(); }
});

test('a burst on one token costs one auth call', async () => {
  const f = withFetch([{ status: 200, body: { id: 'user-3' } }]);
  try {
    const token = uniqueToken();
    const results = await Promise.all(
      Array.from({ length: 28 }, () => isValidSession(token, env))
    );
    assert.equal(f.calls.length, 1, `28 concurrent checks made ${f.calls.length} calls`);
    assert.ok(results.every((r) => r?.id === 'user-3'));
  } finally { f.restore(); }
});

test('a failure is never cached', async () => {
  const token = uniqueToken();
  let f = withFetch([{ status: 401 }]);
  try { assert.equal(await isValidSession(token, env), null); } finally { f.restore(); }

  // Same token again: if the rejection had been remembered, a user who signed
  // back in would stay locked out for the rest of the TTL.
  f = withFetch([{ status: 200, body: { id: 'user-4' } }]);
  try {
    assert.deepEqual(await isValidSession(token, env), { id: 'user-4' });
  } finally { f.restore(); }
});

/**
 * The two decisions extracted from propspace.js, mirrored exactly. They live
 * inside a fetch loop that cannot run under node --test without a server, and
 * they are where the truncation bug lived, so they are pinned here directly.
 */
const upstreamCountFrom = (headerValue) => {
  const header = headerValue === null ? NaN : Number(headerValue);
  return Number.isFinite(header) ? header : null;
};

const shouldStop = ({ upstreamCount, rows, perPage }) => {
  const pageSize = Math.max(upstreamCount ?? 0, rows);
  return !pageSize || pageSize < perPage;
};

/* ------------------------- the paging cutoff ------------------------- */

/**
 * The bug these pin: X-Scope-Total is only sent when the edge actually filters
 * a page. An unscoped caller — an admin — never receives it, headers.get()
 * returned null, and Number(null) is 0, which is finite. upstreamCount became 0
 * rather than null, the pager read "this page held 0 records upstream", and
 * every pull stopped after the first batch. Admins saw the newest 400 leads on
 * every screen and nothing older.
 */

test('an absent scope header means "no hint", not "zero records"', () => {
  assert.equal(upstreamCountFrom(null), null, 'absent must not become 0');
  assert.equal(upstreamCountFrom('100'), 100);
  assert.equal(upstreamCountFrom('0'), 0, 'a real zero is still a real zero');
  assert.equal(upstreamCountFrom('nonsense'), null);
});

test('a full page never ends the pull, however the header reads', () => {
  // 100 visible rows is proof the page was full. Scoping only ever removes
  // rows, so a header claiming fewer than are actually present is wrong.
  assert.equal(shouldStop({ upstreamCount: null, rows: 100, perPage: 100 }), false);
  assert.equal(shouldStop({ upstreamCount: 0, rows: 100, perPage: 100 }), false,
    'the exact case that truncated every admin pull');
  assert.equal(shouldStop({ upstreamCount: 100, rows: 12, perPage: 100 }), false,
    'a scoped page is short but the data is not finished');
});

test('a genuinely short page still ends the pull', () => {
  assert.equal(shouldStop({ upstreamCount: null, rows: 42, perPage: 100 }), true);
  assert.equal(shouldStop({ upstreamCount: 42, rows: 12, perPage: 100 }), true);
  assert.equal(shouldStop({ upstreamCount: 0, rows: 0, perPage: 100 }), true);
});
