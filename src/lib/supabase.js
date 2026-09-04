import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !anonKey) {
  throw new Error(
    'Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. These are baked in at ' +
      'build time: locally, add them to .env.local and restart the dev server; on a ' +
      'deployed build, set them before `npm run build` and redeploy.'
  )
}

export const supabase = createClient(url, anonKey)
