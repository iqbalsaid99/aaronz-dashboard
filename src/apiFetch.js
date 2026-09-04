import { supabase } from './lib/supabase.js';

/**
 * fetch() for our own proxy routes — /ps, /pf and /api/lookup.
 *
 * On Pages these routes sit on the public internet, so functions/_middleware.js
 * rejects anything without a valid Supabase session. This attaches that
 * session. Use it for every call to those three prefixes; plain fetch() is
 * still correct for anything else, such as the static JSON in public/data.
 *
 * The dev server has no such guard and ignores the header, so the same code
 * path works locally and deployed.
 *
 * getSession() reads the persisted session out of localStorage and only hits
 * the network when the access token needs refreshing, so this is cheap enough
 * to call per request. When nobody is signed in it resolves to null and the
 * request goes out bare — which the edge answers with a 401, correctly.
 */
export async function apiFetch(input, init = {}) {
  let token = null;
  try {
    const { data } = await supabase.auth.getSession();
    token = data?.session?.access_token ?? null;
  } catch {
    // Never let an auth hiccup swallow the request — send it unauthenticated
    // and let the 401 surface, rather than failing with a confusing local error.
  }

  const headers = new Headers(init.headers ?? {});
  if (token) headers.set('Authorization', `Bearer ${token}`);

  return fetch(input, { ...init, headers });
}
