/**
 * Normalise Supabase environment variables across local Vite builds and
 * Cloudflare Pages deployments.
 *
 * The app is configured with NEXT_PUBLIC_* names in the current deployment, but
 * the server-side Pages functions still expect SUPABASE_URL and
 * SUPABASE_ANON_KEY. This helper resolves either naming scheme so the guard can
 * satisfy both without changing the frontend runtime contract.
 */
export function getSupabaseConfig(env = {}) {
  const url = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || env.VITE_SUPABASE_URL || '';
  const anonKey = env.SUPABASE_ANON_KEY || env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_ANON_KEY || '';

  return { url: url.replace(/\/$/, ''), anonKey };
}
