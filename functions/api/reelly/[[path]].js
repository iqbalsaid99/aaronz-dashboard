/**
 * Reelly proxy — the off-plan project catalogue.
 *
 * Reelly is a market-wide database of UAE off-plan projects: developers,
 * handover dates, payment plans, unit inventory. It is NOT our stock. The
 * PropSpace half of the Off-plan tab is our own listings; this is everything
 * being sold in the market, which is what makes it useful to an agent sitting
 * with a buyer.
 *
 * TWO THINGS DIFFER FROM THE OTHER PROXIES.
 *
 * The credential is a header key, not a Bearer token — `X-API-Key`. It is a
 * client-level key over our whole Reelly account, so it stays at the edge for
 * the same reason every other key here does.
 *
 * And responses are CACHED at the edge for an hour. Reelly refreshes roughly
 * daily, so a live upstream hit per user per page of a catalogue nobody has
 * changed is pure waste — a grid of 24 cards with a filter bar is a lot of
 * requests for data that is the same all day. The cache is deliberately shared
 * across users: the API key is the account's, not the caller's, so every
 * signed-in user is asking the identical question and gets the identical
 * answer. Nothing user-specific passes through here.
 *
 * Auth is still per user. functions/_middleware.js rejects anything without a
 * live Supabase session before this runs, and the cache is only consulted
 * after that — a cache hit is not a way around the gate.
 */

export const API = 'https://api-reelly.up.railway.app';

/** How long a list or detail response is considered fresh. */
const TTL_SECONDS = 60 * 60;

/**
 * The only query parameters that travel upstream.
 *
 * Reelly's docs carry a warning worth repeating here: "Only some filters are
 * currently active on the backend. Others are declared but do not affect the
 * output yet — the API returns the full dataset regardless of the parameter
 * value." An inactive filter does not error; it silently returns everything,
 * which looks like a filter that matched all of it.
 *
 * So this list is what is ALLOWED to be forwarded, not what is known to work.
 * What actually works was measured against live responses — see FILTERS in
 * src/reelly.js, which is what the UI is built from.
 */
export const FORWARDED = [
  'limit', 'offset', 'ordering', 'search_query',
  'country', 'region', 'districts', 'developer',
  'sale_status', 'status', 'bedrooms', 'unit_bedrooms', 'unit_types',
  'unit_price_from', 'unit_price_to', 'unit_area_from', 'unit_area_to',
  'price_type', 'preferred_currency', 'preferred_area_unit',
  'completion_quarters', 'completion_date_ranges',
  'post_handover', 'has_escrow', 'project_ids',
  'updated_at_after', 'updated_at_before', 'language',
];

/**
 * Applied when the caller does not set them.
 *
 * Defaulted here rather than left to each call site so that "every list call
 * sends these" is a property of the proxy instead of a habit the front end has
 * to remember. A caller that wants USD can still say so.
 */
export const DEFAULTS = {
  country: 'United Arab Emirates',
  preferred_currency: 'AED',
  preferred_area_unit: 'sqft',
};

const json = (body, status) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/**
 * Map our path onto Reelly's, or null if it is not one of the two we serve.
 *
 * An allowlist rather than a passthrough. This key reaches every endpoint on
 * the account — developers, brokers, units, metadata — and a proxy that
 * forwards whatever path it is handed is a general-purpose client for that key
 * available to anyone with a dashboard login.
 */
export function upstreamPath(pathname) {
  const rest = pathname.replace(/^\/api\/reelly/, '').replace(/\/+$/, '') || '/';

  if (rest === '/projects') return '/api/v2/clients/projects';

  // Numeric ids only. Anything else is not an id, and letting a path segment
  // through unchecked is how /projects/../../something becomes reachable.
  const detail = rest.match(/^\/projects\/(\d+)$/);
  if (detail) return `/api/v2/clients/projects/${detail[1]}`;

  return null;
}

export async function onRequest(context) {
  const { request, env, data } = context;
  const url = new URL(request.url);

  // The middleware already refused anything without a session. This is what
  // keeps that true if the route is ever mounted outside the guarded prefix.
  if (!data?.user) return json({ error: 'Not signed in.' }, 401);

  if (request.method !== 'GET') return json({ error: 'GET only.' }, 405);

  const path = upstreamPath(url.pathname);
  if (!path) {
    return json(
      { error: 'Unknown Reelly route.', detail: 'Only /api/reelly/projects and /api/reelly/projects/:id are served.' },
      404
    );
  }

  const key = env.REELLY_API_KEY;
  if (!key) {
    return json(
      {
        error: 'Reelly is not configured on this deployment.',
        detail:
          'Set REELLY_API_KEY on the Pages project — wrangler pages secret put ' +
          'REELLY_API_KEY — then redeploy. Refusing to call upstream without it.',
      },
      503
    );
  }

  // Build the upstream query from the whitelist, then fill the defaults.
  const params = new URLSearchParams();
  for (const name of FORWARDED) {
    const v = url.searchParams.get(name);
    if (v !== null && v !== '') params.set(name, v);
  }
  for (const [k, v] of Object.entries(DEFAULTS)) if (!params.has(k)) params.set(k, v);

  // Sorted so two callers asking the same question in a different parameter
  // order share one cache entry rather than each paying for their own.
  params.sort();
  const qs = params.toString();
  const target = `${API}${path}${qs ? `?${qs}` : ''}`;

  /**
   * The cache key is a bare GET on the canonical upstream query.
   *
   * Deliberately built from `target` rather than from the incoming request:
   * the incoming one carries the caller's Authorization header and their own
   * parameter ordering, and either would fragment the cache per user — which
   * is the opposite of the point. Constructing a fresh Request drops the
   * headers entirely, so nothing about who asked survives into the key.
   */
  const cacheKey = new Request(target, { method: 'GET' });
  const cache = caches.default;

  const hit = await cache.match(cacheKey);
  if (hit) {
    const res = new Response(hit.body, hit);
    res.headers.set('X-Reelly-Cache', 'hit');
    return res;
  }

  let upstream;
  try {
    upstream = await fetch(target, {
      headers: { 'X-API-Key': key, Accept: 'application/json' },
    });
  } catch (err) {
    console.error('[reelly]', path, String(err.message ?? err));
    return json({ error: 'Could not reach Reelly.', detail: String(err.message ?? err) }, 502);
  }

  const text = await upstream.text();

  // Upstream errors are not reliably JSON — Railway answers with a plain-text
  // or HTML page when the app is down, and handing that to a caller about to
  // call .json() on it produces a parse error that names nothing.
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    console.error('[reelly]', path, `non-JSON ${upstream.status}`);
    return json(
      {
        error: upstream.ok
          ? 'Reelly returned something that is not JSON.'
          : `Reelly returned ${upstream.status}.`,
        detail: text.slice(0, 300),
      },
      upstream.ok ? 502 : upstream.status
    );
  }

  if (!upstream.ok) {
    console.error('[reelly]', path, `upstream ${upstream.status}`);
    return json(
      {
        error: `Reelly returned ${upstream.status}.`,
        detail: String(body?.detail ?? body?.message ?? body?.error ?? text.slice(0, 300)),
      },
      upstream.status
    );
  }

  const res = new Response(text, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      // Only successes are stored. Caching a 500 for an hour would turn a
      // momentary Reelly outage into an hour-long one with no way to clear it
      // from this side.
      'Cache-Control': `public, max-age=${TTL_SECONDS}`,
      'X-Reelly-Cache': 'miss',
    },
  });

  // waitUntil so storing the entry does not hold up the response.
  context.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}
