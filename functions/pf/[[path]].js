/**
 * Property Finder Enterprise proxy — edge version of the dev middleware.
 *
 * Two hosts, not one. Credentials are exchanged for a JWT at
 * auth.propertyfinder.com using HTTP Basic — base64("key:secret") — and that
 * token is then presented as a Bearer to atlas.propertyfinder.com, where every
 * resource actually lives. Tokens last about half an hour (expires_in 1784s),
 * so the same cache-and-single-flight arrangement as the PropSpace proxy
 * applies for the same reasons.
 *
 * Node's Buffer does not exist in Workers, so the Basic header is built with
 * btoa instead. btoa is latin1-only; API keys are ASCII so that is safe here,
 * and anything non-ASCII would need a TextEncoder round trip.
 */

const AUTH = 'https://auth.propertyfinder.com/auth/oauth/v1/token';
const API = 'https://atlas.propertyfinder.com';

/**
 * Both Property Finder hosts sit behind CloudFront, and its WAF rejects
 * requests with no User-Agent before they ever reach the application. Workers
 * send none by default — unlike Node, whose fetch sets one — which is why this
 * proxy worked from a laptop and returned 502 from the edge, with a 403 HTML
 * challenge page arriving in place of the token response.
 *
 * Sent on both hops: the auth exchange and every Atlas call. These are our own
 * account's credentialled API calls, so this is about getting past a bot rule,
 * not disguising anything.
 */
const REQUEST_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept: 'application/json',
  'Accept-Language': 'en',
};

/**
 * A WAF block arrives as an HTML page, not JSON — and dumping a full CloudFront
 * error document into an error field tells nobody anything. Detected by content
 * type, falling back to sniffing the first character, because the WAF does not
 * always label what it returns.
 */
const looksLikeHtml = (res, text) =>
  (res.headers.get('content-type') ?? '').includes('text/html') || /^\s*</.test(text);

const BLOCKED =
  "Blocked by Property Finder's firewall. The request was rejected by " +
  'CloudFront before reaching their API, so this is not an authentication ' +
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
  const key = env.PROPERTYFINDER_API_KEY;
  const secret = env.PROPERTYFINDER_API_SECRET;

  if (!key || !secret) {
    throw new Error(
      'PROPERTYFINDER_API_KEY / PROPERTYFINDER_API_SECRET are not set on this ' +
        'deployment. Generate a pair in PF Expert under Developer Resources → ' +
        'API Credentials, then add them with wrangler pages secret put.'
    );
  }

  const res = await fetch(AUTH, {
    method: 'POST',
    headers: {
      ...REQUEST_HEADERS,
      Authorization: 'Basic ' + btoa(`${key}:${secret}`),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ grant_type: 'client_credentials', scope: 'openid' }),
  });

  if (!res.ok) {
    const text = await res.text();
    if (looksLikeHtml(res, text)) {
      throw new Error(`${BLOCKED} (auth hop, HTTP ${res.status})`);
    }
    throw new Error(`propertyfinder auth failed ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  token = data.access_token;
  expiresAt = Date.now() + (data.expires_in ?? 1800) * 1000;
  return token;
}

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/pf/, '') || '/';

  const call = async (bearer) =>
    fetch(API + path + url.search, {
      headers: { ...REQUEST_HEADERS, Authorization: `Bearer ${bearer}` },
    });

  try {
    let upstream = await call(await getToken(env));

    if (upstream.status === 401) {
      token = null;
      expiresAt = 0;
      upstream = await call(await getToken(env));
    }

    /**
     * One retry on an upstream 5xx.
     *
     * Property Finder's listing-verifications endpoint returned 500 for a
     * spell and then recovered on its own — 24 identical calls afterwards all
     * came back 200. A blip like that currently costs a whole section of the
     * tab until someone notices and hits Refresh, and the section renders
     * empty rather than obviously broken, so it is easy not to notice.
     *
     * Only for GET and HEAD. Nothing here issues anything else today, but a
     * blanket retry on a write is how one action becomes two.
     *
     * Deliberately once. If PF is genuinely down, retrying harder turns a
     * visible failure into a slow one, and the banner already names what
     * broke.
     */
    if (upstream.status >= 500 && (request.method === 'GET' || request.method === 'HEAD')) {
      const first = upstream.status;
      console.error('[propertyfinder]', path, `upstream ${first} — retrying once`);

      await new Promise((r) => setTimeout(r, 400));
      upstream = await call(await getToken(env));

      // Logged on success too, not just on failure. A retry that works is
      // exactly the case worth seeing: the user notices nothing, so a fault
      // that is becoming routine would otherwise be absorbed silently and show
      // up only as the tab feeling slow. Two lines per incident in the tail is
      // what makes "once" distinguishable from "every few minutes".
      console.error(
        '[propertyfinder]', path,
        `retry after ${first} → ${upstream.status}`,
        upstream.status < 400 ? '(recovered)' : '(still failing)'
      );
    }

    const text = await upstream.text();

    // The WAF can block the Atlas hop too, not just auth. Passing its HTML
    // through would hand the client a page where it expects JSON, and the
    // parse error it then throws says nothing about what went wrong.
    if (looksLikeHtml(upstream, text)) {
      console.error('[propertyfinder] WAF block on', path, upstream.status);
      return new Response(
        JSON.stringify({ title: 'Blocked upstream', detail: `${BLOCKED} (HTTP ${upstream.status})` }),
        { status: 502, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response(text, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    // Logged as well as returned. Everything below this line used to travel
    // only in the response body, which made every edge failure invisible in
    // `wrangler pages deployment tail` — the one place you look when it works
    // locally and not in production.
    console.error('[propertyfinder]', path, String(err.message ?? err));

    // The client reads { title, detail } off PF errors, so keep that shape
    // rather than the bare { error } the PropSpace proxy returns.
    return new Response(
      JSON.stringify({ title: 'Proxy error', detail: String(err.message ?? err) }),
      { status: 502, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
