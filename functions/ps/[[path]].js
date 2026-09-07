/**
 * PropSpace proxy — the edge version of the dev middleware in vite.config.js.
 *
 * Same two reasons it exists there: the browser only ever talks to this origin
 * so there is no CORS, and the client secret stays server-side instead of
 * being inlined into a bundle anyone can read.
 *
 * Everything under /ps/* is forwarded verbatim to api.propspace.com, so the
 * front end reaches any endpoint on the key without a change here.
 *
 * TWO DIFFERENCES FROM THE NODE VERSION, both forced by the Workers runtime:
 *
 *   1. No Buffer. Not needed for this proxy (PropSpace takes JSON credentials,
 *      not Basic auth) but see the Property Finder one, which uses btoa.
 *   2. Module scope is per-isolate, not per-process. The token cache below
 *      still works — an isolate handling a burst of requests exchanges once —
 *      but a cold isolate starts empty, so expect more token exchanges than
 *      the single long-lived Node process produced. The single-flight guard
 *      matters more here, not less: a cold start takes four concurrent page
 *      requests at once, which is exactly the pattern that had the account's
 *      WAF throttling the auth endpoint before.
 */

import {
  resolveScope, applyAgentScope, filterPayload,
  isForwardable, canSeeOwnerContacts, redactOwnerContacts,
} from '../_lib/scope.js';

const AUTH = 'https://api.propspace.com/auth/token';
const API = 'https://api.propspace.com';

/**
 * PropSpace sits behind "Talsion IronWall", and like the Property Finder /
 * CloudFront pairing, it rejects requests with no User-Agent before they ever
 * reach the application. Workers send none by default — unlike Node, whose
 * fetch sets one — which is why this proxy works from a laptop (`vite.config.js`
 * runs under Node) and came back 502 from the edge, with a 403 HTML challenge
 * page arriving in place of the token response.
 *
 * Sent on every hop: the auth exchange and the forwarded API call. These are
 * our own account's credentialled requests, so this is about getting past a
 * bot rule, not disguising anything.
 */
const REQUEST_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept: 'application/json',
};

/**
 * A WAF block arrives as an HTML page, not JSON — dumping the whole IronWall
 * error document into an error field (as raw text used to) tells nobody
 * anything actionable. Detected by content type, falling back to sniffing the
 * first character, because the WAF does not always label what it returns.
 */
const looksLikeHtml = (res, text) =>
  (res.headers.get('content-type') ?? '').includes('text/html') || /^\s*</.test(text);

const BLOCKED =
  "Blocked by PropSpace's firewall (Talsion IronWall). The request was " +
  'rejected before reaching their API, so this is not an authentication ' +
  'problem and the credentials are probably fine.';

let token = null;
let expiresAt = 0;
let inFlight = null;

function getToken(env) {
  if (token && Date.now() < expiresAt - 60_000) return Promise.resolve(token);
  if (inFlight) return inFlight;
  inFlight = exchange(env).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function exchange(env) {
  if (!env.PROPSPACE_CLIENT_ID || !env.PROPSPACE_CLIENT_SECRET) {
    throw new Error(
      'PROPSPACE_CLIENT_ID / PROPSPACE_CLIENT_SECRET are not set on this ' +
        'deployment. Add them with: wrangler pages secret put PROPSPACE_CLIENT_ID'
    );
  }

  const res = await fetch(AUTH, {
    method: 'POST',
    headers: { ...REQUEST_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: env.PROPSPACE_CLIENT_ID,
      client_secret: env.PROPSPACE_CLIENT_SECRET,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    if (looksLikeHtml(res, text)) {
      throw new Error(`${BLOCKED} (auth hop, HTTP ${res.status})`);
    }
    throw new Error(`auth failed ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  token = data.access_token;
  expiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
  return token;
}

/**
 * Edge cache policy.
 *
 * WHY THIS IS SAFE. What gets cached is the response as PROPSPACE returned it,
 * keyed on the already-scoped upstream URL — not the answer this dashboard
 * sends back. Scoping happens in two places and both still run on every single
 * request: applyAgentScope has already rewritten `assigned_to` before the key
 * is built, so a broker and an admin asking for "leads" are asking for
 * different URLs and cannot share an entry; and filterPayload plus the owner
 * redaction run *after* the cache read, on the caller's own permissions. A hit
 * is a saved round trip to PropSpace, never a saved authorisation check.
 *
 * WHY THE TTLS DIFFER. Leads are the thing a broker acts on, so two minutes is
 * about as stale as a "never contacted" queue can be without being wrong. The
 * listing book changes a few times a day. The option taxonomies — statuses,
 * sources, agents — change when somebody edits the CRM's settings, which is
 * roughly never.
 */
export function cacheTtl(path) {
  if (path.startsWith('/options/')) return 3600;
  if (path.startsWith('/listings')) return 600;
  if (path.startsWith('/leads')) return 120;
  return 0;                                   // anything else: no cache
}

const json = (body, status, extra = {}) =>
  new Response(body === null ? 'null' : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extra },
  });

export async function onRequest(context) {
  const { request, env, data } = context;
  const url = new URL(request.url);

  // Connect strips the mount prefix for us in dev; here we do it by hand.
  // "/ps/leads" -> "/leads". Built from pathname + search rather than a
  // regex over the whole URL so query strings survive untouched.
  const path = url.pathname.replace(/^\/ps/, '') || '/';

  // Checked before the profile lookup — an unroutable path is not a question
  // about who is asking. (_middleware has already rejected anyone without a
  // session, so an anonymous caller sees 401 here rather than 403.) /contacts
  // is the one that matters: it returns the entire contact book, and carries
  // no agent attribution to scope on.
  if (!isForwardable(path)) {
    return json(
      { error: 'That endpoint is not available through this dashboard.',
        detail: `No proxy route for ${path}.` },
      403
    );
  }

  // _middleware has already proved the session; this is the authorisation half.
  let allowed;
  let profile;
  try {
    ({ profile, allowed } = await resolveScope(data.user, data.token, env));
    if (!profile) {
      return json(
        { error: 'Your account is not set up for reporting access.',
          detail: 'No active profile row. Ask an admin to add one.' },
        403
      );
    }
  } catch (err) {
    // Scope could not be established. Refusing is the only safe answer —
    // serving unscoped data on a failed authorisation check is the failure
    // this whole file exists to prevent.
    return json(
      { error: 'Could not determine what you are allowed to see.',
        detail: String(err.message ?? err) },
      503
    );
  }

  const scoped = applyAgentScope(path, url.searchParams, allowed);
  const qs = scoped.toString();
  const target = API + path + (qs ? `?${qs}` : '');

  // GET only. A cache that answered a write would be a correctness bug, and
  // nothing under /ps is written to today anyway.
  const ttl = request.method === 'GET' ? cacheTtl(path) : 0;
  const cacheKey = ttl ? new Request(target, { method: 'GET' }) : null;
  // The Refresh button sends no-cache, so "re-read the CRM" means it.
  const bypass = /no-cache|no-store/i.test(request.headers.get('Cache-Control') || '');
  const cache = caches.default;

  try {
    let text = null;
    let status = 200;
    let cacheState = ttl ? 'miss' : 'bypass';

    if (cacheKey && !bypass) {
      const hit = await cache.match(cacheKey);
      if (hit) {
        text = await hit.text();
        cacheState = 'hit';
      }
    } else if (cacheKey && bypass) {
      cacheState = 'revalidated';
    }

    if (text === null) {
      const t = await getToken(env);
      let upstream = await fetch(target, {
        headers: { ...REQUEST_HEADERS, Authorization: `Bearer ${t}` },
      });

      // A 401 here means the cached token went stale earlier than its stated
      // expiry — revoked, or the account re-issued credentials. Drop it and try
      // once more so a single bad token does not poison the isolate until it
      // happens to be recycled.
      if (upstream.status === 401) {
        token = null;
        expiresAt = 0;
        upstream = await fetch(target, {
          headers: { ...REQUEST_HEADERS, Authorization: `Bearer ${await getToken(env)}` },
        });
      }

      text = await upstream.text();
      status = upstream.status;

      // The WAF can block this hop too, not just auth. Passing its HTML
      // through would hand the client a page where it expects JSON.
      if (!upstream.ok && looksLikeHtml(upstream, text)) {
        return json({ error: `${BLOCKED} (HTTP ${upstream.status})` }, 502);
      }

      // Errors are passed through untouched — there is nothing to scope, and
      // rewriting them would hide what upstream actually said. Never cached:
      // a cached 403 would outlive whatever caused it.
      if (!upstream.ok) {
        return new Response(text, {
          status: upstream.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (cacheKey) {
        // waitUntil so storing the entry does not hold up the response.
        context.waitUntil(cache.put(cacheKey, new Response(text, {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': `public, max-age=${ttl}`,
          },
        })));
      }
    }

    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return new Response(text, {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Always, whatever the upstream filter did or did not do.
    let { json: filtered, total, kept } = filterPayload(body, allowed);

    // Who owns a property is need-to-know. Everything else about the listing —
    // price, project, community, status, agent, images — stays visible, so the
    // screens that read those are unaffected.
    if (!canSeeOwnerContacts(profile)) filtered = redactOwnerContacts(filtered);

    // The client stops paging when a page comes back short. Filtering makes
    // pages short, so the pre-filter count travels back and the client counts
    // on that instead — otherwise a broker's own history would be truncated
    // at the first page that happened to hold mostly other people's leads.
    const headers = { 'X-PS-Cache': cacheState };
    if (total !== null) {
      headers['X-Scope-Total'] = String(total);
      headers['X-Scope-Kept'] = String(kept);
    }
    headers['Access-Control-Expose-Headers'] =
      'X-Scope-Total, X-Scope-Kept, X-PS-Cache';

    return json(filtered, status, headers);
  } catch (err) {
    // Logged as well as returned — otherwise an edge failure like a WAF block
    // is invisible in `wrangler pages deployment tail`, the one place you look
    // when it works locally and not in production.
    console.error('[propspace]', path, String(err.message ?? err));
    return json({ error: String(err.message ?? err) }, 502);
  }
}
