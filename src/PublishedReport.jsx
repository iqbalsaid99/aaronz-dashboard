import React, { useState, useEffect, useMemo, useCallback } from "react";
import {
  Loader2, AlertCircle, RefreshCw, Lock, Info, Database, CalendarClock,
  ChevronDown, ChevronUp,
} from "lucide-react";
import { readLedger, syncPublications } from "./publicationSync.js";
import {
  monthlyCounts, ledgerBreakdown, currentMonth, isPartial, isApproximate,
} from "./publicationLedger.js";
import { monthLabel, monthRange } from "./listings.js";
import { fmtNum } from "./bayutListings.js";

/**
 * Published to portals — the historical half of the Listings tab.
 *
 * Every figure here comes from the publication ledger and nothing else. The
 * ledger is append-only: a row records that a listing went live on a portal,
 * and stays true afterwards no matter what happens to the listing — taken
 * down, reassigned, expired, or deleted from PropSpace outright.
 *
 * That is the whole point. These numbers were previously derived from each
 * listing's current state, so a listing removed in October left August, and
 * August kept shrinking every time somebody looked. A month's figure must read
 * the same today and in a year.
 *
 * NOTHING ON THIS SCREEN MAY COME FROM CURRENT INVENTORY. The pipeline section
 * lives in its own component, reads its own data, and shares no number with
 * this one.
 */

const Card = ({ children, className = "" }) => (
  <div className={`bg-white border border-slate-200 rounded-2xl ${className}`}>{children}</div>
);

const Empty = ({ children }) => (
  <p className="text-xs text-slate-400 py-8 text-center">{children}</p>
);

/** Fixed hues per portal, so a portal is the same colour in every chart. */
const PORTAL_TINT = {
  bayut: "bg-emerald-600",
  propertyfinder: "bg-indigo-600",
  dubizzle: "bg-amber-600",
};
const tintFor = (p) => PORTAL_TINT[p] ?? "bg-slate-400";

/**
 * One month column, stacked by portal.
 *
 * The current month is drawn hatched rather than solid: it is still
 * accumulating, and a short bar next to eleven full ones reads as a collapse in
 * output rather than as a month that is four days old.
 */
function MonthColumn({ m, max, portals, partial, approximate }) {
  const height = (n) => `${max ? (n / max) * 100 : 0}%`;
  return (
    <div className="flex-1 h-full flex flex-col justify-end items-center gap-1 min-w-[28px] group relative">
      <div className="w-full flex flex-col-reverse justify-start items-stretch h-full">
        {portals.map((p) => {
          const n = m.byPortal[p] ?? 0;
          if (!n) return null;
          return (
            <div key={p} className={`${tintFor(p)} ${partial ? "opacity-50" : ""}`}
              style={{ height: height(n) }} title={`${p}: ${n}`} />
          );
        })}
      </div>
      <span className={`text-[10px] tabular-nums ${partial ? "text-slate-400" : "text-slate-600"}`}>
        {m.total || ""}
      </span>
      <span className="text-[10px] text-slate-400 whitespace-nowrap">
        {monthLabel(m.month)}
        {approximate && <span className="text-amber-600" title="Approximate — before the ledger began">*</span>}
      </span>

      <div className="absolute bottom-full mb-1 hidden group-hover:block z-10 pointer-events-none">
        <div className="bg-slate-900 text-white text-[11px] rounded-lg px-2 py-1 whitespace-nowrap">
          <p className="font-semibold">{monthLabel(m.month)} · {m.total}</p>
          {portals.map((p) => (m.byPortal[p] ? <p key={p} className="text-slate-300">{p} {m.byPortal[p]}</p> : null))}
          {partial && <p className="text-amber-300">in progress</p>}
          {approximate && <p className="text-amber-300">approximate</p>}
        </div>
      </div>
    </div>
  );
}

function Breakdown({ title, note, rows, limit = 10 }) {
  const [open, setOpen] = useState(false);
  const shown = open ? rows : rows.slice(0, limit);
  const max = Math.max(1, ...rows.map((r) => r.count));

  return (
    <Card className="p-5">
      <p className="text-sm font-semibold text-slate-900">{title}</p>
      {note && <p className="text-xs text-slate-400 mt-0.5">{note}</p>}
      {rows.length ? (
        <>
          <div className="space-y-2 mt-3">
            {shown.map((r) => (
              <div key={r.key} className="flex items-center gap-3">
                <span className="text-xs w-36 truncate flex-shrink-0 text-slate-600" title={String(r.label)}>
                  {r.label}
                </span>
                <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden min-w-[40px]">
                  <div className="h-full rounded-full bg-slate-700" style={{ width: `${(r.count / max) * 100}%` }} />
                </div>
                <span className="text-xs w-10 text-right tabular-nums text-slate-500">{fmtNum(r.count)}</span>
              </div>
            ))}
          </div>
          {rows.length > limit && (
            <button onClick={() => setOpen((v) => !v)}
              className="text-[11px] text-slate-500 hover:text-slate-800 mt-3 inline-flex items-center gap-1">
              {open ? <>Show fewer <ChevronUp className="w-3 h-3" /></>
                : <>Show all {rows.length} <ChevronDown className="w-3 h-3" /></>}
            </button>
          )}
        </>
      ) : <Empty>Nothing recorded yet.</Empty>}
    </Card>
  );
}

export default function PublishedReport({ months = 12 }) {
  const [ledger, setLedger] = useState(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState(null);
  const [sync, setSync] = useState(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    (async () => {
      setBusy(true); setError(null);
      try {
        const data = await readLedger();
        if (alive) setLedger(data);
      } catch (err) {
        if (alive) setError({ message: err.message, detail: err.detail, code: err.code });
      } finally {
        if (alive) setBusy(false);
      }
    })();
    return () => { alive = false; };
  }, [nonce]);

  const run = useCallback(async (mode) => {
    setSync({ mode, running: true });
    try {
      const out = await syncPublications({ mode });
      setSync({ ...out, running: false });
      setNonce((n) => n + 1);
    } catch (err) {
      setSync({ mode, running: false, error: `${err.message}${err.detail ? ` — ${err.detail}` : ""}` });
    }
  }, []);

  const axis = useMemo(() => {
    const now = new Date();
    const start = new Date(now);
    start.setMonth(start.getMonth() - (months - 1));
    return monthRange(start.toISOString().slice(0, 10), now.toISOString().slice(0, 10));
  }, [months]);

  const report = useMemo(
    () => monthlyCounts(ledger?.rows ?? [], { months: axis }),
    [ledger, axis]
  );

  const trusted = ledger?.trusted ?? null;
  const thisMonth = currentMonth();
  const max = Math.max(1, ...report.months.map((m) => m.total));

  const breakdowns = useMemo(() => {
    const rows = ledger?.rows ?? [];
    return {
      broker: ledgerBreakdown(rows, (r) => r.brokerId ?? `name:${r.brokerName}`,
        (k) => rows.find((r) => (r.brokerId ?? `name:${r.brokerName}`) === k)?.brokerName ?? k),
      offering: ledgerBreakdown(rows, (r) => r.offering),
      category: ledgerBreakdown(rows, (r) => r.categoryClass),
      community: ledgerBreakdown(rows, (r) => r.community),
    };
  }, [ledger]);

  if (error?.code === "NO_TABLE") {
    return (
      <Card className="p-5 border-amber-200 bg-amber-50 flex gap-3">
        <AlertCircle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-amber-900">{error.message}</p>
          <p className="text-xs text-amber-700 mt-1">{error.detail}</p>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card className="p-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex gap-2.5 min-w-0">
          <Lock className="w-4 h-4 text-slate-400 flex-shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="text-xs font-medium text-slate-700">
              Recorded when it happened. These figures do not change.
            </p>
            <p className="text-[11px] text-slate-500 mt-0.5 leading-relaxed">
              A listing counts in the month it went live on a portal, once per portal, and stays counted after
              it is taken down, reassigned, expires or is deleted from the CRM. Broker is whoever published it
              at the time, not whoever owns the listing now.
            </p>
            {trusted ? (
              <p className="text-[11px] text-slate-500 mt-1">
                Fully observed from <span className="font-medium text-slate-700">{monthLabel(trusted.month)}</span>.
                Earlier months are marked <span className="text-amber-600">*</span> — they were reconstructed
                from listing creation dates and undercount anything already deleted.
              </p>
            ) : (
              <p className="text-[11px] text-amber-700 mt-1">
                No sync has run yet, so every month here is reconstructed and approximate.
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button onClick={() => run("sync")} disabled={sync?.running || busy}
            title="Record any listing now live on a portal that is not already in the ledger."
            className={`flex items-center gap-2 px-3 py-2 text-sm rounded-xl border border-slate-200 bg-white
                        disabled:opacity-40 enabled:hover:bg-slate-50 enabled:hover:border-slate-300 ${sync?.running ? "is-fetching" : ""}`}>
            <RefreshCw className={`w-4 h-4 ${sync?.running && sync.mode === "sync" ? "animate-spin" : ""}`} />
            Sync publications
          </button>
          {!trusted && (
            <button onClick={() => run("backfill")} disabled={sync?.running || busy}
              title="One-time seed from historical listings. Dates are approximate."
              className="flex items-center gap-2 px-3 py-2 text-sm rounded-xl border border-slate-900
                         bg-slate-900 text-white disabled:opacity-40 enabled:hover:bg-slate-800">
              <Database className="w-4 h-4" />Backfill history
            </button>
          )}
        </div>
      </Card>

      {sync && (
        <Card className={`p-4 flex gap-3 ${sync.error ? "border-rose-200 bg-rose-50" : "bg-slate-50"}`}>
          {sync.running
            ? <Loader2 className="w-4 h-4 text-slate-400 animate-spin flex-shrink-0 mt-0.5" />
            : sync.error
              ? <AlertCircle className="w-4 h-4 text-rose-600 flex-shrink-0 mt-0.5" />
              : <Info className="w-4 h-4 text-slate-400 flex-shrink-0 mt-0.5" />}
          <p className="text-xs text-slate-700 min-w-0">
            {sync.running
              ? `Reading PropSpace and recording new publications…`
              : sync.error
                ? <span className="text-rose-900">{sync.error}</span>
                : <>Recorded {fmtNum(sync.written)} new publication{sync.written === 1 ? "" : "s"} from{" "}
                  {fmtNum(sync.listingsSeen)} listings. {fmtNum(sync.alreadyRecorded)} were already in the
                  ledger and were left untouched.</>}
          </p>
        </Card>
      )}

      <Card className="p-5">
        <div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
          <div>
            <p className="text-sm font-semibold text-slate-900">Published per month</p>
            <p className="text-xs text-slate-400 mt-0.5">
              One count per listing per portal, on the month it first went live.
            </p>
          </div>
          <div className="flex items-center gap-3 text-[11px] text-slate-500">
            {report.portals.map((p) => (
              <span key={p} className="flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-sm ${tintFor(p)}`} />{p}
              </span>
            ))}
          </div>
        </div>

        {busy && !ledger ? (
          <div className="py-16 text-center">
            <Loader2 className="w-5 h-5 text-slate-300 mx-auto animate-spin" />
          </div>
        ) : report.months.some((m) => m.total) ? (
          <>
            <div className="h-48 flex items-end gap-1.5">
              {report.months.map((m) => (
                <MonthColumn key={m.month} m={m} max={max} portals={report.portals}
                  partial={isPartial(m.month)} approximate={isApproximate(m.month, trusted)} />
              ))}
            </div>
            <p className="text-[11px] text-slate-400 mt-4 flex items-center gap-1.5">
              <CalendarClock className="w-3.5 h-3.5" />
              {monthLabel(thisMonth)} is still in progress — drawn faded, and not comparable with a
              complete month.
            </p>
          </>
        ) : (
          <Empty>
            The ledger is empty. Run a backfill to reconstruct history, then sync to keep it current.
          </Empty>
        )}
      </Card>

      <div className="grid lg:grid-cols-2 gap-4">
        <Breakdown title="By broker at publication"
          note="Who published it, frozen at the time — not the listing's current owner."
          rows={breakdowns.broker} />
        <Breakdown title="By community" rows={breakdowns.community} />
        <Breakdown title="By offering" rows={breakdowns.offering} limit={4} />
        <Breakdown title="By category" rows={breakdowns.category} limit={4} />
      </div>

      {error && error.code !== "NO_TABLE" && (
        <Card className="p-4 border-amber-200 bg-amber-50">
          <p className="text-xs text-amber-900">{error.message}</p>
        </Card>
      )}
    </div>
  );
}
