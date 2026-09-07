/**
 * Auth guard for the API proxies.
 *
 * WHY THIS EXISTS. The dev-server versions of these proxies were safe by
 * accident: they only ever listened on localhost, so the only person who could
 * reach /ps/leads was the person sitting at the machine. On Pages the same
 * routes are on the public internet. Without a check here, anyone who knows
 * the URL can GET /ps/leads?per_page=100 and page out the entire CRM — tens of
 * thousands of leads with names, emails and phone numbers — with no sign-in at
 * all. The Supabase login on the front end would be decorative.
 *
 * So every request to /ps, /pf and /api must carry the caller's Supabase
 * session as a bearer token. The token is verified against Supabase itself
 * rather than by checking a signature locally: the project uses the newer
 * publishable-key format, whose JWTs may be signed asymmetrically, and
 * /auth/v1/user is correct regardless of the signing algorithm.
 *
 * Everything else — the HTML, the JS bundle, the logo — passes through
 * untouched. The app has to be able to load in order to show a login form.
 *
 * This does NOT do authorisation. Any signed-in user can read everything the
 * proxies expose. Scoping brokers to their own numbers and line managers to
 * their team is a separate job, and it belongs here, once profiles carry a
 * role and the upstream queries can be filtered by it.
 */

import { getSupabaseConfig } from './_lib/env.js';
import { isValidSession } from './_lib/session.js';

const GUARDED = ['/ps/', '/pf/', '/api/', '/meta/'];

/**
 * Routes that a signed-in human is not the one calling.
 *
 * Apollo delivers a revealed mobile number by POSTing it back to us, minutes
 * or hours later, from its own servers. It has no Supabase session and never
 * will, so a session check here would reject the callback and the number would
 * be paid for and lost.
 *
 * This is NOT an unauthenticated route. It carries a single-use token in the
 * path which the handler checks against the pending reveal row that generated
 * it — see functions/api/apollo/[[path]].js. The exemption is from the session
 * guard only, because the caller is a machine, not from authentication.
 */
const MACHINE_CALLERS = ['/api/apollo/webhook/'];

const json = (body, status) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

export async function onRequest(context) {
  const { request, env, next } = context;
  const { pathname } = new URL(request.url);

  if (!GUARDED.some((p) => pathname.startsWith(p))) return next();
  if (MACHINE_CALLERS.some((p) => pathname.startsWith(p))) return next();

  // Misconfiguration must fail closed. The app may be configured with either
  // the Pages names or the public Vite/NEXT_PUBLIC names. Accept either form so
  // we do not block a valid signed-in user because of a naming mismatch.
  const { url, anonKey } = getSupabaseConfig(env);
  if (!url || !anonKey) {
    return json(
      {
        error: 'Auth is not configured on this deployment.',
        detail:
          'Set SUPABASE_URL and SUPABASE_ANON_KEY (or the NEXT_PUBLIC equivalent) ' +
          'in the Pages project so the proxy can verify sessions. Refusing to proxy without them.',
      },
      503
    );
  }

  context.data.supabase = { url, anonKey };

  const auth = request.headers.get('Authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;

  if (!token) {
    return json({ error: 'Not signed in.' }, 401);
  }

  let user;
  try {
    user = await isValidSession(token, context.data.supabase ?? getSupabaseConfig(env));
  } catch (err) {
    // Supabase itself was unreachable. That is not the caller's session being
    // invalid, and calling it a 401 would send a signed-in user back to a login
    // form that works fine. Say what actually happened.
    return json(
      { error: 'Could not verify your session.', detail: String(err.message ?? err) },
      503
    );
  }

  if (!user) {
    return json({ error: 'Session expired or invalid. Sign in again.' }, 401);
  }

  // Handed downstream so the proxies can scope the data to this caller without
  // re-verifying. `token` travels with it because the profile lookup is made
  // AS the user, so their own RLS policies decide what they can read.
  context.data.user = user;
  context.data.token = token;

  return next();
}
