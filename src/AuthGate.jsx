import { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from './lib/supabase'
import loginBg from './assets/login_bg.jpg'
import { IMAGES } from './images.js'

const AuthContext = createContext(null)

export const useAuth = () => useContext(AuthContext)

export default function AuthGate({ children }) {
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!session) { setProfile(null); return }
    supabase
      .from('profiles')
      .select('*')
      .eq('id', session.user.id)
      .single()
      .then(({ data }) => setProfile(data))
  }, [session])

  if (loading) return <div className="p-8 text-sm text-gray-500">Loading…</div>
  if (!session) return <SignIn />
  if (!profile) return <div className="p-8 text-sm text-gray-500">Loading profile…</div>

  return (
    <AuthContext.Provider value={{ session, profile, user: session.user }}>
      {children}
    </AuthContext.Provider>
  )
}

/**
 * Sign-in.
 *
 * Split screen: the brand and the city on one side, the form on the other. The
 * form panel is deliberately plain — a login is a thirty-second interaction
 * and the only things that matter are the two fields, whether the password
 * manager recognises them, and a legible error when it goes wrong.
 *
 * The artwork is the one asset that carries the brand here, so it takes the
 * larger half on a wide screen and becomes a shallow banner on a narrow one
 * rather than disappearing.
 */
function SignIn() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) setError(error.message)
    setBusy(false)
  }

  return (
    <div className="min-h-screen flex flex-col md:flex-row bg-[#0C2036]">
      {/* Brand panel */}
      <div className="relative md:w-3/5 h-44 md:h-auto overflow-hidden">
        <img src={loginBg} alt="" className="absolute inset-0 w-full h-full object-cover" />
        {/* The artwork is already dark — the left 40% measures 37/255 — so this
            is a light scrim to hold the copy, not a blanket. A heavier one
            buries the marina, which is the whole point of the image. */}
        <div className="absolute inset-0 bg-gradient-to-r from-[#0C2036]/80 via-[#0C2036]/45 to-transparent" />
        {/* A touch at the foot so the small print does not sit on the water. */}
        <div className="absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-[#0C2036]/70 to-transparent" />

        <div className="relative h-full flex flex-col justify-between p-8 md:p-12">
          <img src={IMAGES.logoWhite} alt="Aaronz &amp; Co." width="268" height="132"
            className="w-32 md:w-40 h-auto" />

          <div className="hidden md:block max-w-md">
            <div className="w-16 h-px bg-[#C8A24B] mb-6" />
            <h1 className="text-[#EFEAE0] text-3xl lg:text-4xl font-semibold leading-tight tracking-tight">
              Marketing &amp; Operations
            </h1>
            <p className="text-[#A8A28B] mt-3 leading-relaxed">
              Lead performance, listings and advertising spend for Aaronz &amp; Co., Dubai.
            </p>
          </div>

          <p className="hidden md:block text-xs text-[#A8A28B]/70">
            Authorised users only
          </p>
        </div>
      </div>

      {/* Form panel */}
      <div className="flex-1 flex items-center justify-center bg-white px-6 py-12 md:py-0">
        <form onSubmit={submit} className="w-full max-w-sm">
          <h2 className="text-2xl font-semibold text-slate-900 tracking-tight">Sign in</h2>
          <p className="text-sm text-slate-500 mt-1.5">
            Use the account your administrator set up for you.
          </p>

          <label className="block mt-8">
            <span className="text-sm font-medium text-slate-700">Email</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              autoComplete="username" required autoFocus
              className="mt-1.5 w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm
                         outline-none focus:border-[#2F6475] focus:ring-2 focus:ring-[#2F6475]/15" />
          </label>

          <label className="block mt-4">
            <span className="text-sm font-medium text-slate-700">Password</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password" required
              className="mt-1.5 w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm
                         outline-none focus:border-[#2F6475] focus:ring-2 focus:ring-[#2F6475]/15" />
          </label>

          {error && (
            <p className="mt-4 text-sm text-rose-700 bg-rose-50 border border-rose-200
                          rounded-xl px-3 py-2.5">
              {error}
            </p>
          )}

          <button type="submit" disabled={busy}
            className="mt-6 w-full bg-[#0C2036] text-white rounded-xl py-2.5 text-sm font-medium
                       hover:bg-[#1B3A5B] disabled:opacity-50 transition-colors">
            {busy ? 'Signing in…' : 'Sign in'}
          </button>

          <p className="mt-6 text-xs text-slate-400 leading-relaxed">
            Trouble signing in? Ask an administrator to check your account — this
            dashboard has no self-service password reset.
          </p>
        </form>
      </div>
    </div>
  )
}

export function SignOutButton({ className = "" }) {
  return (
    <button onClick={() => supabase.auth.signOut()}
      className={`text-sm text-slate-400 hover:text-white ${className}`}>
      Sign out
    </button>
  )
}
