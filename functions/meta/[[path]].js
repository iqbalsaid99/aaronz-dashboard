import { requireProfile } from '../_lib/scope.js';

/**
 * Meta Marketing API proxy — ad insights only.
 *
 * The token is a long-lived credential over an entire ad account, so the
 * interesting question is not how to forward requests but how to make sure
 * this route cannot forward anything else. A general-purpose Graph proxy would
 * let any signed-in user read campaigns, audiences, creatives, connected
 * pages, and — depending on the token's scopes — other ad accounts the same
 * user administers. So the path is not taken from the caller at all.
 *
 * The client asks for one of a handful of named reports and nothing else. The
 * upstream URL is BUILT here from META_AD_ACCOUNT_ID; the request's own path is
 * only ever checked against a table, never interpolated into the target. That
 * is the difference between an allowlist and a filter you hope is airtight.
 *
 * Query parameters are passed through — fields, time_range, level, limit —
 * because those shape the report rather than choosing the account. access_token
 * is stripped from anything the caller sends and set from the secret, so a
 * caller cannot substitute their own.
 */

const GRAPH = 'https://graph.facebook.com/v26.0';

// Same reason as the Property Finder proxy: Workers send no User-Agent by
// default, and bot rules in front of large APIs treat that as a signal.
const REQUEST_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept: 'application/json',
  'Accept-Language': 'en',
};

const json = (body, status) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const looksLikeHtml = (res, text) =>
  (res.headers.get('content-type') ?? '').includes('text/html') || /^\s*</.test(text);

/** act_123 and 123 are the same account; accept either in the secret. */
const accountId = (raw) => {
  const id = String(raw ?? '').trim();
  return id.startsWith('act_') ? id : `act_${id}`;
};

/**
 * The only endpoints the caller may reach, and the ONLY place the upstream path
 * is decided. The request's own path is matched against this table and then
 * discarded — the target is built from the table's value and the configured
 * account, so nothing a caller sends is ever interpolated into the URL.
 *
 *   insights   campaign and ad-level reports (level= is a query parameter)
 *   ads        the ad objects, for creative images, headlines and delivery
 *   campaigns  the campaign objects, for created_time — insights has no such
 *              field, so the only way to date a campaign is to read the object
 *
 * Anything else — another account, /adsets, /me, /insights/../x — is refused
 * before the token is anywhere near it. Note that the account is still supplied
 * here rather than by the caller, so /campaigns can only ever list ours.
 */
const ROUTES = { '/insights': 'insights', '/ads': 'ads', '/campaigns': 'campaigns' };

/**
 * Video reads are the one route that needs an id from the caller, so they get
 * their own handling rather than a place in the table above.
 *
 * The id is never trusted. It is checked against the set of video ids that
 * actually appear on creatives in THIS ad account, and the URL is then built
 * from the copy held in that set rather than from the request — so even a
 * matching string cannot smuggle anything through. Without that check this
 * route would read any video the token can see, which on a page-linked token
 * is a great deal more than an ad account.
 *
 * Fields are fixed here too. source, picture and length are what the lightbox
 * needs; a caller asking for anything else gets those three anyway.
 */
const VIDEO_PATH = /^\/video\/([0-9]{1,32})$/;
const VIDEO_FIELDS = 'source,picture,length';

/**
 * Video ids on this account, cached per isolate.
 *
 * Validating means listing the account's creatives, which is a 125-row request
 * — far too expensive to repeat for every video a lightbox opens. Five minutes
 * is short enough that a newly uploaded creative becomes playable quickly, and
 * long enough that browsing a campaign costs one lookup. The in-flight promise
 * is held so a burst of opens collapses to a single fetch.
 */
let videoIds = null;
let videoIdsAt = 0;
let videoIdsInFlight = null;
const VIDEO_IDS_TTL_MS = 5 * 60 * 1000;

async function allowedVideoIds(env, account) {
  if (videoIds && Date.now() - videoIdsAt < VIDEO_IDS_TTL_MS) return videoIds;
  if (videoIdsInFlight) return videoIdsInFlight;

  videoIdsInFlight = (async () => {
    const url = `${GRAPH}/${account}/ads?` + new URLSearchParams({
      fields: 'creative{object_story_spec}',
      limit: '500',
      access_token: env.META_TOKEN,
    });
    const res = await fetch(url, { headers: REQUEST_HEADERS });
    if (!res.ok) throw new Error(`ad creative lookup ${res.status}`);
    const body = await res.json();

    const ids = new Set();
    for (const ad of body.data ?? []) {
      const v = ad?.creative?.object_story_spec?.video_data?.video_id;
      if (v) ids.add(String(v));
    }
    videoIds = ids;
    videoIdsAt = Date.now();
    return ids;
  })().finally(() => { videoIdsInFlight = null; });

  return videoIdsInFlight;
}

function upstreamFor(path, account) {
  let p = path;

  // An explicit account prefix is accepted only when it is OUR account.
  const prefixed = p.match(/^\/(act_[0-9]+)(\/.+)$/);
  if (prefixed) {
    if (prefixed[1] !== account) return null;
    p = prefixed[2];
  }

  return Object.prototype.hasOwnProperty.call(ROUTES, p) ? ROUTES[p] : null;
}

export async function onRequest(context) {
  const { request, env, data } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/meta/, '') || '/';

  if (!env.META_TOKEN || !env.META_AD_ACCOUNT_ID) {
    console.error('[meta] not configured');
    return json(
      { error: 'Meta reporting is not configured on this deployment.',
        detail: 'Set META_TOKEN and META_AD_ACCOUNT_ID on the Pages project, then redeploy.' },
      503
    );
  }

  const account = accountId(env.META_AD_ACCOUNT_ID);

  // Shape check before anything expensive. A video read is handled below, once
  // the caller has been authorised — an unauthorised one must not be able to
  // probe which video ids exist.
  const video = path.match(VIDEO_PATH);
  const endpoint = video ? null : upstreamFor(path, account);
  if (!video && !endpoint) {
    console.error('[meta] refused path', path);
    return json(
      { error: 'That endpoint is not available through this dashboard.',
        detail: `No proxy route for ${path}.` },
      403
    );
  }

  // _middleware has already rejected anyone without a session; this is the
  // second half — a Supabase user with no active profile row has never been
  // granted access to reporting, so fail closed.
  let profile;
  try {
    profile = await requireProfile(data.user, data.token, env);
  } catch (err) {
    console.error('[meta] profile lookup failed', String(err.message ?? err));
    return json(
      { error: 'Could not verify your access.', detail: String(err.message ?? err) },
      503
    );
  }
  if (!profile) {
    return json({ error: 'Your account is not set up for reporting access.' }, 401);
  }

  // Video reads: validate ownership, then build the URL from our own copy of
  // the id rather than from the request.
  if (video) {
    let owned;
    try {
      owned = await allowedVideoIds(env, account);
    } catch (err) {
      console.error('[meta] video ownership lookup failed', String(err.message ?? err));
      return json(
        { error: 'Could not verify that video belongs to this account.',
          detail: String(err.message ?? err) },
        503
      );
    }

    if (!owned.has(video[1])) {
      console.error('[meta] refused video id not on this account', video[1]);
      return json(
        { error: 'That video is not part of this ad account.',
          detail: 'Only videos used by creatives on the configured account can be read.' },
        403
      );
    }

    // The id used is the one from OUR set, not the caller's string.
    const id = [...owned].find((v) => v === video[1]);
    const target = `${GRAPH}/${id}?` + new URLSearchParams({
      fields: VIDEO_FIELDS,
      access_token: env.META_TOKEN,
    });
    return forward(target, path, context);
  }


  // Built here, not taken from the request. access_token is dropped from
  // whatever the caller sent and set from the secret.
  const params = new URLSearchParams(url.searchParams);
  params.delete('access_token');
  params.set('access_token', env.META_TOKEN);

  const target = `${GRAPH}/${account}/${endpoint}?${params.toString()}`;
  return forward(target, path, context);
}

/** One place that talks to Graph, so both routes get the same handling. */
/**
 * Edge cache policy, by how fast the thing behind it actually changes.
 *
 *   /ads        creative metadata — the headline and image of an ad are the
 *               same whatever window is being looked at, and this is the
 *               expensive call: it pages three times sequentially because the
 *               creative fields are too big for one response. Fifteen minutes.
 *   /campaigns  a campaign's created_time never changes. An hour.
 *   /insights   sixty seconds, and no more. Meta keeps revising attribution
 *               for weeks, which is why this file must not hold figures for
 *               long — but a minute cannot put this dashboard and Ads Manager
 *               into disagreement, and it collapses the burst of identical
 *               requests a reload or a second broker produces.
 *
 * Video sources are never cached: those CDN URLs carry a signed expiry and
 * stop working within hours.
 */
export function metaCacheTtl(path) {
  if (path.startsWith('/ads')) return 900;
  if (path.startsWith('/campaigns')) return 3600;
  if (path.startsWith('/insights')) return 60;
  return 0;
}

async function forward(target, path, context) {
  // Keyed on the upstream URL WITHOUT the access token. The key still
  // separates every time_range and paging cursor, which is what makes two
  // different windows unable to share an entry — but the secret has no
  // business being a cache key, where it would outlive a rotation and show up
  // in anything that ever enumerates the cache.
  const ttl = context && context.request.method === 'GET' ? metaCacheTtl(path) : 0;
  let cacheKey = null;
  if (ttl) {
    const keyUrl = new URL(target);
    keyUrl.searchParams.delete('access_token');
    cacheKey = new Request(keyUrl.toString(), { method: 'GET' });
  }
  const bypass = ttl
    ? /no-cache|no-store/i.test(context.request.headers.get('Cache-Control') || '')
    : false;
  // `caches` is a Workers global and does not exist under Node, where these
  // handlers are unit tested. Reaching for it unconditionally threw before the
  // request was even made — in the tests only, since the runtime that actually
  // serves this always has it. Absent cache, the proxy simply forwards.
  const cache = cacheKey && typeof caches !== 'undefined' ? caches.default : null;

  if (cache && !bypass) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const body = await hit.text();
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'X-Meta-Cache': 'hit' },
      });
    }
  }

  try {
    const upstream = await fetch(target, { headers: REQUEST_HEADERS });
    const text = await upstream.text();

    if (looksLikeHtml(upstream, text)) {
      console.error('[meta] HTML response, status', upstream.status);
      return json(
        { error: 'Meta returned a web page rather than data.',
          detail: `The request was likely blocked or redirected (HTTP ${upstream.status}).` },
        502
      );
    }

    if (!upstream.ok) {
      // Graph errors are JSON and genuinely useful — an expired token, a
      // permissions problem — so they are passed through intact rather than
      // flattened into a generic failure.
      console.error('[meta] upstream', upstream.status, text.slice(0, 200));
      return new Response(text, {
        status: upstream.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (cache) {
      // waitUntil so storing the entry does not hold up the response. Errors
      // are never stored — a cached expired-token message would outlive the
      // token being fixed.
      context.waitUntil(cache.put(cacheKey, new Response(text, {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `public, max-age=${ttl}`,
        },
      })));
    }

    return new Response(text, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'X-Meta-Cache': ttl ? (bypass ? 'revalidated' : 'miss') : 'bypass',
      },
    });
  } catch (err) {
    console.error('[meta]', path, String(err.message ?? err));
    return json({ error: 'Could not reach Meta.', detail: String(err.message ?? err) }, 502);
  }
}
