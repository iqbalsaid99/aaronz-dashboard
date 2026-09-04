import React, { useState, useEffect, useMemo, useCallback } from "react";
import {
  Loader2, RefreshCw, Activity, FileEdit, Clock, Globe, Archive, Info,
} from "lucide-react";
import { fetchPipeline, TAKEN_DOWN_SINCE } from "./publicationSync.js";
import { clearListingCache, listingAgentOf, fmtAed } from "./listings.js";
import { fmtNum } from "./bayutListings.js";


/**
 * The live pipeline — the current-state half of the Listings tab.
 *
 * This section is ALLOWED to change. It answers "what is on the portals right
 * now, what is waiting, what never went out" — a question whose answer moves
 * hourly, and should.
 *
 * It shares no number with the published report above it. That separation is
 * the entire fix: mixing "went live in August" with "is live today" is what
 * made historical months move in the first place. Different questions, and a
 * figure that answers one must never be shown as answering the other.
 *
 * ONE THING PROPSPACE DOES NOT EXPOSE: rejections. Checked against the live
 * account — the API accepts exactly four statuses (published, unpublished,
 * draft, pending_approval), every record carries the identical 31 fields
 * regardless of status, and there is no rejection reason anywhere. So "what was
 * rejected and why" cannot be built from this source and is deliberately absent
 * rather than faked from pending_approval, which means waiting, not refused.
 */

const Card = ({ children, className = "" }) => (
  <div className={`bg-white border border-slate-200 rounded-2xl ${className}`}>{children}</div>
);

/** "2026-01-01" as "January 2026", for the labels that have to state it. */
const SINCE_LABEL = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric" })
  .format(new Date(`${TAKEN_DOWN_SINCE}T00:00:00Z`));

const STATES = [
  { key: "published", label: "Live on portals", icon: Globe, tint: "bg-emerald-600",
    note: "Currently published and visible." },
  { key: "pending_approval", label: "Submitted, awaiting approval", icon: Clock, tint: "bg-amber-600",
    note: "Sent to the portals and not yet accepted." },
  { key: "draft", label: "Draft", icon: FileEdit, tint: "bg-slate-500",
    note: "Never sent to a portal." },
  { key: "unpublished", label: "Taken down", icon: Archive, tint: "bg-slate-400",
    // The window is part of the label, not a footnote. Without it this reads as
    // the whole archive, which is what it used to be and no longer is. Spelled
    // from the constant so the sentence cannot drift from the query.
    note: `Was live and is no longer. Records created since ${SINCE_LABEL} only.` },
];


export default function ListingPipeline() {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState(null);
  const [nonce, setNonce] = useState(0);
  const [open, setOpen] = useState("pending_approval");

  useEffect(() => {
    let alive = true;
    (async () => {
      setBusy(true); setError(null);
      try {
        const d = await fetchPipeline();
        if (alive) setData(d);
      } catch (err) {
        if (alive) setError(err.message);
      } finally {
        if (alive) setBusy(false);
      }
    })();
    return () => { alive = false; };
  }, [nonce]);

  const refresh = () => { clearListingCache(); setNonce((n) => n + 1); };

  const counts = useMemo(() => {
    const b = data?.byStatus ?? {};
    return Object.fromEntries(STATES.map((s) => [s.key, (b[s.key] ?? []).length]));
  }, [data]);

  const shown = (data?.byStatus?.[open] ?? [])
    .slice()
    .sort((a, b) => new Date(b.updated_at ?? 0) - new Date(a.updated_at ?? 0))
    .slice(0, 60);

  return (
    <div className="space-y-4">

      <Card className="p-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex gap-2.5 min-w-0">
          <Activity className="w-4 h-4 text-slate-400 flex-shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="text-xs font-medium text-slate-700">Where everything stands right now.</p>
            <p className="text-[11px] text-slate-500 mt-0.5 leading-relaxed">
              This section changes as listings move. It is deliberately separate from the published history
              above, which does not — the two answer different questions and share no figure.
              Live, awaiting and draft are read whole, however old; taken-down covers records created
              since {SINCE_LABEL}, because the CRM keeps every withdrawal ever made and reading all of
              them took minutes to produce a number nobody acts on.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={refresh} disabled={busy}
            className={`flex items-center gap-2 px-3 py-2 text-sm rounded-xl border border-slate-200 bg-white
                        disabled:opacity-40 enabled:hover:bg-slate-50 enabled:hover:border-slate-300 ${busy ? "is-fetching" : ""}`}>
            <RefreshCw className={`w-4 h-4 ${busy ? "animate-spin" : ""}`} />Refresh
          </button>
        </div>
      </Card>

      {error && (
        <Card className="p-4 border-amber-200 bg-amber-50">
          <p className="text-sm font-medium text-amber-900">Couldn't load the pipeline</p>
          <p className="text-xs text-amber-700 mt-1 font-mono break-all">{error}</p>
        </Card>
      )}

      {busy && !data ? (
        <Card className="p-16 text-center">
          <Loader2 className="w-6 h-6 text-slate-300 mx-auto animate-spin" />
          <p className="text-sm text-slate-500 mt-3">Reading the CRM…</p>
        </Card>
      ) : (
        <>
          <div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-4">
            {STATES.map((s) => {
              const Icon = s.icon;
              const active = open === s.key;
              return (
                <button key={s.key} onClick={() => setOpen(s.key)}
                  className={`text-left bg-white border rounded-2xl p-4 transition
                    ${active ? "border-slate-900 ring-1 ring-slate-900" : "border-slate-200 hover:border-slate-300"}`}>
                  <div className="flex items-center gap-2">
                    <span className={`w-8 h-8 rounded-lg flex items-center justify-center ${s.tint}`}>
                      <Icon className="w-4 h-4 text-white" strokeWidth={2} />
                    </span>
                    <p className="text-xs font-medium text-slate-600">{s.label}</p>
                  </div>
                  <p className="mt-3 text-3xl font-bold text-slate-900 tracking-tight">
                    {fmtNum(counts[s.key] ?? 0)}
                  </p>
                  <p className="mt-1 text-[11px] text-slate-400 leading-relaxed">{s.note}</p>
                </button>
              );
            })}
          </div>

          <Card className="p-4 flex gap-2.5">
            <Info className="w-4 h-4 text-slate-400 flex-shrink-0 mt-0.5" />
            <p className="text-[11px] text-slate-500 leading-relaxed">
              <span className="font-medium text-slate-700">Rejections are not shown because PropSpace does not
              record them.</span>{" "}
              The API exposes four statuses and no rejection reason on any of them, so a listing refused by a
              portal is indistinguishable here from one still waiting. "Submitted, awaiting approval" means
              exactly that and must not be read as rejected.
            </p>
          </Card>

          <Card className="p-5">
            <div className="flex items-center justify-between gap-3 mb-4">
              <p className="text-sm font-semibold text-slate-900">
                {STATES.find((s) => s.key === open)?.label}
              </p>
              <span className="text-xs text-slate-400">
                {shown.length < (counts[open] ?? 0)
                  ? `newest ${shown.length} of ${fmtNum(counts[open])}`
                  : `${fmtNum(shown.length)} listings`}
              </span>
            </div>

            {shown.length ? (
              <div className="overflow-x-auto -mx-5 px-5">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-slate-500 border-b border-slate-200 bg-slate-50">
                      <th className="pl-0 pr-3 py-2.5 font-medium">Ref</th>
                      <th className="px-3 py-2.5 font-medium">Community</th>
                      <th className="px-3 py-2.5 font-medium">Broker</th>
                      <th className="px-3 py-2.5 font-medium">Offering</th>
                      <th className="px-3 py-2.5 font-medium text-right">Price</th>
                      <th className="px-3 py-2.5 font-medium">Portals</th>
                      <th className="px-3 py-2.5 font-medium">Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((l) => (
                      <tr key={l.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60">
                        <td className="pl-0 pr-3 py-2.5 font-mono text-xs text-slate-600 whitespace-nowrap">{l.ref}</td>
                        <td className="px-3 py-2.5 text-xs text-slate-900 truncate max-w-[11rem]">
                          {l.area_location?.name ?? "—"}
                        </td>
                        <td className="px-3 py-2.5 text-xs text-slate-600 truncate max-w-[9rem]">
                          {listingAgentOf(l)}
                        </td>
                        <td className="px-3 py-2.5 text-xs text-slate-600">{l.type ?? "—"}</td>
                        <td className="px-3 py-2.5 text-xs text-slate-900 text-right tabular-nums whitespace-nowrap">
                          {fmtAed(l.price)}
                        </td>
                        <td className="px-3 py-2.5 text-[11px] text-slate-500 truncate max-w-[12rem]">
                          {(l.portals ?? []).length ? l.portals.join(", ") : "—"}
                        </td>
                        <td className="px-3 py-2.5 text-xs text-slate-500 whitespace-nowrap">
                          {String(l.updated_at ?? "").slice(0, 10) || "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-xs text-slate-400 py-8 text-center">Nothing in this state.</p>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
