import { useCallback, useEffect, useState } from 'react'
import { supabase } from './lib/supabase'
import { useAuth } from './AuthGate'
import assetsRegister from './assets-register.json'

/**
 * assets-register.json has NO id field — its keys are code, serial, name,
 * type, note. Identity is therefore derived, and it has to be code + name
 * together, because neither is unique on its own:
 *
 *   - ARZ-CE-62 covers three separate items: the MacBook Pro 16", its 140W
 *     charger, and the charger wire.
 *   - Two items carry no code at all: "Rollei pro flash" and
 *     "Weetontung connector". Hence the NOCODE fallback.
 *   - ARZ-OE-018 and ARZ-OE-029 share an identical name (the Godox XPROC
 *     bundle), so name alone collides too.
 *
 * code + name gives 27 unique keys for 27 records. This is the same
 * derivation as assetId() in equipment.js, kept here so this component does
 * not depend on that module — the rest of it is localStorage plumbing that
 * this screen has replaced.
 *
 * The value this produces is a string like "ARZ-CE-62|Charger Wire", so
 * equipment_bookings.asset_id must be a text column.
 */
const ASSET_NAME = 'name'
const ASSET_CODE = 'code'

const assetKey = (a) => `${a[ASSET_CODE] ?? 'NOCODE'}|${a[ASSET_NAME]}`

export default function Equipment() {
  const { profile } = useAuth()
  const [openBookings, setOpenBookings] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [pendingId, setPendingId] = useState(null)

  const load = useCallback(async () => {
    // Only unreturned rows. Returned bookings stay in the table as history.
    const { data, error } = await supabase
      .from('equipment_bookings')
      .select('id, asset_id, booked_at, due_back, notes, booked_by, profiles(full_name, email)')
      .is('returned_at', null)

    if (error) setError(error.message)
    else {
      setError(null)
      setOpenBookings(data ?? [])
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
    // Cheap way to stay current without websockets: refresh when the tab
    // regains focus. Swap for Supabase realtime later if you want live updates.
    const onFocus = () => load()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [load])

  const bookingFor = (assetId) => openBookings.find((b) => b.asset_id === assetId)

  async function bookOut(assetId) {
    setPendingId(assetId)
    setError(null)

    // booked_by is deliberately omitted. The column default is auth.uid(),
    // so the database stamps the author from the verified session.
    const { error } = await supabase
      .from('equipment_bookings')
      .insert({ asset_id: assetId })

    if (error) {
      // 23505 is the unique index: someone else booked it out first.
      setError(
        error.code === '23505'
          ? 'Someone else just booked this out. Refresh to see who.'
          : error.message
      )
    }
    await load()
    setPendingId(null)
  }

  async function bookIn(booking) {
    setPendingId(booking.asset_id)
    setError(null)

    const { error } = await supabase
      .from('equipment_bookings')
      .update({ returned_at: new Date().toISOString() })
      .eq('id', booking.id)

    // RLS allows this only for the person who booked it, or a super admin.
    if (error) setError(error.message)
    await load()
    setPendingId(null)
  }

  const canBookIn = (booking) =>
    booking.booked_by === profile.id || profile.role === 'super_admin'

  if (loading) {
    return <div className="p-8 text-sm text-gray-500">Loading equipment…</div>
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">Equipment</h2>
        <span className="text-sm text-gray-500">
          {openBookings.length} of {assetsRegister.length} out
        </span>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2">
          {error}
        </div>
      )}

      <div className="border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-gray-500">
            <tr>
              <th className="px-4 py-2 font-medium">Asset</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Since</th>
              <th className="px-4 py-2 font-medium text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {assetsRegister.map((asset) => {
              const id = assetKey(asset)
              const booking = bookingFor(id)
              const busy = pendingId === id

              return (
                <tr key={id} className="border-t">
                  <td className="px-4 py-3">{asset[ASSET_NAME]}</td>

                  <td className="px-4 py-3">
                    {booking ? (
                      <span className="text-amber-700">
                        With {booking.profiles?.full_name ?? booking.profiles?.email ?? 'unknown'}
                      </span>
                    ) : (
                      <span className="text-green-700">In office</span>
                    )}
                  </td>

                  <td className="px-4 py-3 text-gray-500">
                    {booking
                      ? new Date(booking.booked_at).toLocaleDateString('en-GB', {
                          day: 'numeric',
                          month: 'short',
                          timeZone: 'Asia/Dubai',
                        })
                      : '—'}
                  </td>

                  <td className="px-4 py-3 text-right">
                    {booking ? (
                      <button
                        onClick={() => bookIn(booking)}
                        disabled={busy || !canBookIn(booking)}
                        title={
                          canBookIn(booking)
                            ? undefined
                            : 'Only the person who booked it out can return it'
                        }
                        className="text-sm px-3 py-1 rounded-lg border disabled:opacity-40 enabled:hover:bg-slate-50 enabled:hover:border-slate-300 transition"
                      >
                        {busy ? '…' : 'Book in'}
                      </button>
                    ) : (
                      <button
                        onClick={() => bookOut(id)}
                        disabled={busy}
                        className="text-sm px-3 py-1 rounded-lg bg-gray-900 text-white disabled:opacity-40 enabled:hover:bg-gray-800 transition"
                      >
                        {busy ? '…' : 'Book out'}
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
