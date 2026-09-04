/**
 * Portal lead-stats proxy — the shared machinery behind /api/bayut.
 *
 * Bayut and dubizzle expose the SAME endpoint, the same query parameters, the
 * same response shapes and — on this account — the same API key. They differ
 * only in host and path prefix. So the difference lives in PORTALS below and
 * nowhere else: turning dubizzle on is an entry in that map plus a two-line
 * route file that re-exports this handler, never another copy of this logic.
 *
 * Underscore-prefixed paths in functions/ are not routed, so this is a module
 * the route files import rather than an endpoint of its own.
 *
 * AUTH. Everything under /api/ is already gated by functions/_middleware.js,
 * which rejects any request without a live Supabase session before this runs.
 * The re-check below is not redundant belt-and-braces for its own sake: it is
 * what makes this module fail closed if it is ever mounted on a path outside
 * that GUARDED list. Leads carry names, phone numbers and email addresses, and
 * an unauthenticated route that pages them out is the one failure worth being
 * paranoid about.
 *
 * The key never leaves the edge. It is read from env at call time and put in
 * an Authorization header here, so nothing about it can reach the bundle.
 */

/**
 * The one config map. Keyed by portal, and the only place a portal is defined.
 *
 * `keyVar` is named rather than assumed because the two portals sharing a key
 * today is an account fact, not a property of the API — a portal that later
 * gets its own credential is still a config entry, not a code change.
 */
export const PORTALS = {
  bayut: {
    label: 'Bayut',
    url: 'https://www.bayut.com/api-v7/stats/website-client-leads',
    keyVar: 'BAYUT_API_KEY',
  },
  // Ready to switch on. Same key, same parameters, same response shapes —
  // add functions/api/dubizzle.js re-exporting onRequest and nothing else.
  // dubizzle: {
  //   label: 'dubizzle',
  //   url: 'https://dubizzle.com/profolio/api-v7/stats/website-client-leads',
  //   keyVar: 'BAYUT_API_KEY',
  // },
};

/**
 * The only query parameters that travel upstream. Anything else the caller
 * sends is dropped rather than passed through — this endpoint is reachable by
 * every signed-in user, and a proxy that forwards whatever it is handed is a
 * proxy that will eventually forward something it should not have.
 */
export const FORWARDED = ['type', 'target', 'is_trulead', 'timestamp'];

/**
 * Build the upstream URL for a portal from a parameter source.
 *
 * `get` is a lookup function so this works with URLSearchParams and with a
 * plain object alike, which is what lets the dev middleware in vite.config.js
 * share this rather than reimplement the whitelist a second way.
 *
 * Values are encoded with encodeURIComponent rather than assembled by
 * URLSearchParams. timestamp is "YYYY-MM-DD HH:MM:SS" and that space matters:
 * URLSearchParams writes it as `+`, which is a form-encoding convention this
 * endpoint does not read back as a space. `%20` is what it expects.
 */
export function upstreamUrl(cfg, get) {
  const parts = [];
  for (const name of FORWARDED) {
    const v = get(name);
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${name}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `${cfg.url}?${parts.join('&')}` : cfg.url;
}

const json = (body, status) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

export async function onRequest(context) {
  const { request, env, data } = context;
  const url = new URL(request.url);

  // The route file's own name is the portal, so /api/bayut and a future
  // /api/dubizzle both land here and pick themselves out of PORTALS.
  const portal = url.pathname.split('/').filter(Boolean).pop();
  const cfg = PORTALS[portal];
  if (!cfg) return json({ error: `Unknown portal "${portal}".` }, 404);

  // See the header note. If the middleware did not run, refuse.
  if (!data?.user) return json({ error: 'Not signed in.' }, 401);

  if (request.method !== 'GET') return json({ error: 'GET only.' }, 405);

  const key = env[cfg.keyVar];
  if (!key) {
    return json(
      {
        error: `${cfg.label} is not configured on this deployment.`,
        detail:
          `Set ${cfg.keyVar} on the Pages project — ` +
          `wrangler pages secret put ${cfg.keyVar} — then redeploy. ` +
          'Refusing to call upstream without it.',
      },
      503
    );
  }

  const target = upstreamUrl(cfg, (n) => url.searchParams.get(n));

  let upstream;
  try {
    upstream = await fetch(target, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    });
  } catch (err) {
    console.error(`[${portal}]`, String(err.message ?? err));
    return json({ error: `Could not reach ${cfg.label}.`, detail: String(err.message ?? err) }, 502);
  }

  const text = await upstream.text();

  // Upstream failures do not reliably arrive as JSON — an edge or WAF layer in
  // front of the API answers with HTML, and handing that to a client that is
  // about to call .json() on it produces a parse error naming nothing. Read as
  // text first, and only claim it is JSON once it has parsed.
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    if (upstream.ok) {
      console.error(`[${portal}] non-JSON 2xx from upstream`, url.search);
      return json(
        { error: `${cfg.label} returned something that is not JSON.`, detail: text.slice(0, 300) },
        502
      );
    }
    console.error(`[${portal}] upstream ${upstream.status}`, url.search);
    return json(
      { error: `${cfg.label} returned ${upstream.status}.`, detail: text.slice(0, 300) },
      upstream.status
    );
  }

  if (!upstream.ok) {
    console.error(`[${portal}] upstream ${upstream.status}`, url.search);
    return json(
      {
        error: `${cfg.label} returned ${upstream.status}.`,
        detail: String(body?.message ?? body?.error ?? text.slice(0, 300)),
      },
      upstream.status
    );
  }

  return new Response(text, {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
