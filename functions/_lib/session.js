/**
 * Shared helpers for the Pages Functions.
 *
 * Underscore-prefixed paths in functions/ are not routed, so this is a module
 * the other Functions import rather than an endpoint of its own.
 */

/**
 * Verified sessions, keyed by access token.
 *
 * An entry is one of two shapes:
 *   { promise }      a validation currently in flight
 *   { until, user }  a validation that succeeded, good until this timestamp
 *
 * HOLDING THE PROMISE IS THE POINT. Caching only the result leaves the
 * thundering herd untouched: a dashboard load fires dozens of proxy requests
 * at once — the lead pull alone pages four at a time — and on a cold isolate
 * every one of them misses an empty cache and calls /auth/v1/user
 * independently. Twenty-eight requests, twenty-eight auth round trips, all
 * asking the identical question. Storing the promise means late arrivals await
 * the check already running: one auth call, twenty-eight answers.
 *
 * The resolved user is kept, not just a boolean, because scoping needs the
 * caller's uid to look up their profile. Throwing it away would cost a second
 * identical round trip on every request.
 *
 * Module scope in a Worker survives between requests on one isolate but is not
 * shared across them, and isolates are recycled freely. Treat this as a
 * hit-rate optimisation, never as state to rely on.
 */
import { getSupabaseConfig } from './env.js';

const sessions = new Map();

const TTL_MS = 60_000;
const MAX_ENTRIES = 200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Ask Supabase whether this token is a live session.
 *
 * Resolves to the user, or null ONLY when the auth service actually says the
 * token is bad. Anything else throws.
 *
 * That distinction is the whole point. This used to be `if (!res.ok) return
 * null`, which turned a 429 into "your session expired" — so under a burst,
 * pages 2-4 of a lead pull told a perfectly signed-in user they were signed
 * out. Rate limiting is not a credential problem and must not be reported as
 * one; the caller turns a throw into a 503.
 *
 * One retry, because a 429 under a burst is usually over in a moment and
 * failing the whole page load for it is worse than waiting 300ms.
 */
async function check(token, env, attempt = 0) {
  const { url, anonKey } = getSupabaseConfig(env);
  const res = await fetch(`${url}/auth/v1/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: anonKey,
    },
  });

  if (res.status === 401 || res.status === 403) return null;   // genuinely invalid

  if (!res.ok) {
    if (attempt === 0 && (res.status === 429 || res.status >= 500)) {
      await sleep(300);
      return check(token, env, 1);
    }
    throw new Error(`auth check ${res.status}: ${(await res.text()).slice(0, 160)}`);
  }

  const user = await res.json().catch(() => null);
  return user?.id ? user : null;
}

/**
 * Resolves to the Supabase user for a live session, or null if the token is
 * not valid. Rejects only when Supabase itself could not be reached.
 *
 * Only successes are cached. A rejection must not be remembered — a token that
 * failed because Supabase was briefly unreachable would otherwise stay
 * rejected for a full minute, locking out a user who is perfectly signed in.
 */
export function isValidSession(token, env) {
  const hit = sessions.get(token);
  if (hit) {
    if (hit.promise) return hit.promise;
    if (Date.now() < hit.until) return Promise.resolve(hit.user);
    sessions.delete(token);
  }

  // Logged once per token per TTL, not once per request — useful for seeing in
  // Cloudflare's logs whether the cache is doing its job.
  console.log('[auth] verifying session with Supabase');

  const promise = check(token, env)
    .then((user) => {
      if (user) {
        if (sessions.size > MAX_ENTRIES) sessions.clear();
        sessions.set(token, { until: Date.now() + TTL_MS, user });
      } else {
        sessions.delete(token);
      }
      return user;
    })
    .catch((err) => {
      sessions.delete(token);
      throw err;
    });

  sessions.set(token, { promise });
  return promise;
}
