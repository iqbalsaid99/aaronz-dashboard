import React, { useState, useEffect, useMemo, useCallback } from "react";
import PublishedReport from "./PublishedReport.jsx";
import { readLedger } from "./publicationSync.js";
import { publishedByMonth } from "./publicationLedger.js";
import ListingPipeline from "./ListingPipeline.jsx";
import LeadsByAccount from "./LeadsByAccount.jsx";
import { Building2, RefreshCw, AlertTriangle, Home, Tag, FileEdit, Clock, Archive } from "lucide-react";
import {
  fetchListings, fetchLiveListings, listingAgentOf, isHouseAccount,
  classifyRelists, monthLabel, monthRange, fmtAed,
  WENT_LIVE, NOT_LIVE, DEFAULT_PRESET, clearListingCache,
  portalMeta, faviconUrl,
} from "./listings.js";
import DateRange, { resolveRange } from "./DateRange.jsx";
import { dubaiMonth } from "./time.js";

const Card = ({ children, className = "" }) => (
  <div className={`bg-white border border-slate-200 rounded-2xl ${className}`}>{children}</div>
);

const Stat = ({ icon: Icon, tint, label, value, sub }) => (
  <Card className="p-5">
    <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${tint}`}>
      <Icon className="w-5 h-5" strokeWidth={2} />
    </div>
    <p className="mt-4 text-sm font-medium text-slate-700">{label}</p>
    <p className="mt-2 text-4xl font-bold text-slate-900 tracking-tight">{value}</p>
    {sub && <p className="mt-2 text-xs text-slate-500">{sub}</p>}
  </Card>
);

/* Heat cell for the month × agent grid. */
function Cell({ fresh, relist, max, onClick }) {
  const total = fresh + relist;
  if (!total) return <td className="px-2 py-2 text-center text-slate-200 text-xs">·</td>;
  const intensity = max ? Math.min(1, total / max) : 0;
  return (
    <td className="px-1 py-1">
      <div
        onClick={onClick}
        className="rounded-md text-center text-xs font-medium py-1.5 cursor-pointer hover:ring-2 hover:ring-indigo-300"
        style={{
          backgroundColor: `rgba(79, 70, 229, ${0.08 + intensity * 0.55})`,
          color: intensity > 0.55 ? "white" : "#312e81",
        }}
        title={relist ? `${fresh} new + ${relist} relisted` : `${fresh} new`}
      >
        {fresh}
        {relist > 0 && <span className="text-[10px] opacity-80"> +{relist}r</span>}
      </div>
    </td>
  );
}

const LISTING_PRESETS = [
  ["30d", "Last 30 days"],
  ["3m", "Last 3 months"],
  ["ytd", "This year"],
  ["12m", "Last 12 months"],
  ["24m", "Last 24 months"],
];

const STATUS_TINT = {
  published: "bg-emerald-50 text-emerald-700",
  unpublished: "bg-slate-100 text-slate-600",
  draft: "bg-amber-50 text-amber-700",
  pending_approval: "bg-sky-50 text-sky-700",
};

/**
 * Everything listed in one month, with the brokers who listed it. Opened by
 * clicking a month column header (whole month) or a single cell (that broker's
 * listings that month).
 */
/**
 * First photo of a listing.
 *
 * `images` is populated on 100% of live listings, always six of them, always
 * already sorted with order_no 1 first — so images[0] is the cover shot.
 *
 * These come back at full size, 1400×1050 and ~520KB each, and the endpoint
 * ignores every resize parameter tried (w / width / size / thumb / h / resize
 * / quality). So a thumbnail here still downloads the full photo. `loading
 * ="lazy"` is doing real work: without it, opening one broker's 51 listings
 * would pull ~26MB up front.
 */
const coverOf = (l) => (l.images ?? [])[0]?.url ?? null;

function Thumb({ listing }) {
  const [failed, setFailed] = React.useState(false);
  const src = coverOf(listing);

  if (!src || failed) {
    return (
      <div className="w-16 h-12 rounded-lg bg-slate-100 flex items-center justify-center flex-shrink-0">
        <Building2 className="w-4 h-4 text-slate-300" />
      </div>
    );
  }
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className="w-16 h-12 rounded-lg object-cover bg-slate-100 flex-shrink-0"
    />
  );
}

/** One portal: real favicon where there is a domain, lettered badge otherwise
 *  or when the icon fails to load. */
function PortalIcon({ portalKey }) {
  const meta = portalMeta(portalKey);
  const [failed, setFailed] = React.useState(false);
  const src = faviconUrl(meta.domain);

  if (src && !failed) {
    return (
      <img src={src} alt={meta.label} title={meta.label} loading="lazy"
        onError={() => setFailed(true)}
        className="w-4 h-4 rounded-sm flex-shrink-0" />
    );
  }
  return (
    <span title={meta.label}
      className={`w-4 h-4 rounded-sm ${meta.tint} text-[9px] font-bold
                  flex items-center justify-center flex-shrink-0 uppercase`}>
      {meta.label[0]}
    </span>
  );
}

function PortalRow({ portals }) {
  if (!portals?.length) {
    return <span className="text-[11px] text-slate-300">not advertised</span>;
  }
  return (
    <span className="inline-flex items-center gap-1 flex-wrap"
      title={portals.map((p) => portalMeta(p).label).join(", ")}>
      {portals.map((p) => <PortalIcon key={p} portalKey={p} />)}
      <span className="text-[11px] text-slate-400 ml-0.5">{portals.length}</span>
    </span>
  );
}

function ListingsPanel({ title, subtitle, listings, tags, showBrokers, onClose }) {
  const [type, setType] = React.useState("all");   // all | rent | sale
  React.useEffect(() => { setType("all"); }, [title]);

  if (!title) return null;

  const rentN = listings.filter((l) => l.type === "rent").length;
  const saleN = listings.length - rentN;
  const inMonth = type === "all" ? listings : listings.filter((l) =>
    type === "sale" ? l.type === "sale" : l.type !== "sale");

  const byAgent = new Map();
  for (const l of inMonth) {
    const n = listingAgentOf(l);
    if (!byAgent.has(n)) byAgent.set(n, { name: n, house: isHouseAccount(n), rent: 0, sale: 0, relist: 0, value: 0, count: 0 });
    const r = byAgent.get(n);
    r.count++;
    r[l.type === "sale" ? "sale" : "rent"]++;
    r.value += l.price ?? 0;
    if (tags.get(l.id)?.kind === "relist") r.relist++;
  }
  const agents = [...byAgent.values()].sort((a, b) => b.count - a.count);
  const stillLive = inMonth.filter((l) => l.status === "published").length;

  // When the panel is scoped to one broker, their photo and job title are
  // already on the listing records — no extra lookup needed.
  const solo = !showBrokers
    ? (listings.find((l) => l.agent?.photo_url || l.agent?.job_title)?.agent
       ?? listings[0]?.agent ?? null)
    : null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-slate-900/30" onClick={onClose} />
      <div className="relative w-full max-w-3xl bg-slate-50 h-full overflow-y-auto shadow-2xl">
        <div className="sticky top-0 bg-white border-b border-slate-200 px-6 py-4 z-10">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-4 min-w-0">
              {solo && (solo.photo_url
                ? <img src={solo.photo_url} alt="" width="80" height="80"
                    className="w-20 h-20 rounded-full object-cover bg-slate-100 flex-shrink-0" />
                : <span className="w-20 h-20 rounded-full bg-slate-200 text-slate-600 text-xl font-semibold
                                   flex items-center justify-center flex-shrink-0">
                    {(solo.name ?? "?").split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase()}
                  </span>)}
              <div className="min-w-0">
              <p className="text-lg font-bold text-slate-900">{title}</p>
              {solo?.job_title && (
                <p className="text-xs text-slate-400">{solo.job_title}</p>
              )}
              <p className="text-xs text-slate-500 mt-0.5">
                {inMonth.length} listing{inMonth.length === 1 ? "" : "s"}
                {subtitle ? ` · ${subtitle}` : ""}
                {stillLive !== inMonth.length ? ` · ${stillLive} still live today` : ""}
              </p>
              </div>
            </div>
            <button onClick={onClose}
              className="text-slate-400 hover:text-slate-700 text-sm px-3 py-1 rounded-lg hover:bg-slate-100">
              Close
            </button>
          </div>

          <div className="flex gap-1 mt-3">
            {[["all", `All ${listings.length}`], ["rent", `Rent ${rentN}`], ["sale", `Sale ${saleN}`]]
              .map(([k, label]) => (
                <button key={k} onClick={() => setType(k)}
                  className={`px-3 py-1.5 text-xs rounded-lg border ${type === k
                    ? "bg-slate-900 text-white border-slate-900 font-medium"
                    : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"}`}>
                  {label}
                </button>
              ))}
          </div>
        </div>

        <div className="p-6 space-y-6">
          {showBrokers && agents.length > 1 && (
            <Card>
              <div className="px-5 py-4 border-b border-slate-200">
                <p className="text-sm font-semibold text-slate-900">Brokers</p>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500 border-b border-slate-200 bg-slate-50">
                    <th className="px-5 py-2 font-medium">Broker</th>
                    <th className="px-3 py-2 font-medium text-right">Listed</th>
                    <th className="px-3 py-2 font-medium text-right">Rent</th>
                    <th className="px-3 py-2 font-medium text-right">Sale</th>
                    <th className="px-5 py-2 font-medium text-right">Asking total</th>
                  </tr>
                </thead>
                <tbody>
                  {agents.map((r) => (
                    <tr key={r.name} className="border-b border-slate-100 last:border-0">
                      <td className="px-5 py-2.5 font-medium text-slate-900">
                        {r.name}
                        {r.house && (
                          <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">house</span>
                        )}
                        {r.relist > 0 && (
                          <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700">
                            {r.relist} relisted
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right font-semibold text-slate-900">{r.count}</td>
                      <td className="px-3 py-2.5 text-right text-slate-600">{r.rent}</td>
                      <td className="px-3 py-2.5 text-right text-slate-600">{r.sale}</td>
                      <td className="px-5 py-2.5 text-right text-slate-600">{fmtAed(r.value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}

          <Card>
            <div className="px-5 py-4 border-b border-slate-200">
              <p className="text-sm font-semibold text-slate-900">The listings</p>
              <p className="text-xs text-slate-400 mt-0.5">In the order they were created</p>
            </div>
            <div className="divide-y divide-slate-100">
              {inMonth.map((l) => {
                const t = tags.get(l.id);
                return (
                  <div key={l.id} className="px-5 py-3">
                    <div className="flex items-start gap-3">
                      <Thumb listing={l} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium text-slate-900">{l.ref}</span>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                            STATUS_TINT[l.status] ?? "bg-slate-100 text-slate-600"}`}>
                            {l.status}
                          </span>
                          <span className="text-[11px] text-slate-500">{l.type}</span>
                          {t?.kind === "relist" && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700">
                              relist of {t.priorRef}, {t.days}d later
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-slate-500 mt-1 truncate">
                          {[l.sub_area_location?.name, l.area_location?.name].filter(Boolean).join(", ")}
                          {l.unit_number ? ` · unit ${l.unit_number}` : ""}
                          {l.beds ? ` · ${l.beds} bed` : ""}
                          {l.size ? ` · ${Math.round(l.size)} sqft` : ""}
                        </p>
                        <p className="text-xs text-slate-400 mt-0.5 flex items-center gap-2 flex-wrap">
                          <span>{listingAgentOf(l)} · created {l.created_at.slice(0, 10)}</span>
                          <PortalRow portals={l.portals} />
                        </p>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <p className="text-sm font-semibold text-slate-900">{fmtAed(l.price)}</p>
                        {t?.kind === "relist" && t.priceDelta !== 0 && (
                          <p className={`text-[11px] font-medium ${
                            t.priceDelta < 0 ? "text-emerald-600" : "text-rose-600"}`}>
                            {t.priceDelta < 0 ? "−" : "+"}{fmtAed(Math.abs(t.priceDelta))}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
              {!inMonth.length && (
                <p className="px-5 py-8 text-center text-sm text-slate-400">Nothing listed this month.</p>
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function ListingActivity() {
  const [range, setRange] = useState({ preset: DEFAULT_PRESET, from: null, to: null });
  const [rows, setRows] = useState([]);
  const [liveRows, setLiveRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState(null);
  const [view, setView] = useState("new"); // "new" | "live"
  const [panel, setPanel] = useState(null);   // { title, subtitle, listings, showBrokers }
  const [ledger, setLedger] = useState(null);

  const { from: since, to: until } = useMemo(() => resolveRange(range), [range]);
  const ready = Boolean(since && until && new Date(since) <= new Date(until));
  const spanMonths = useMemo(() => Math.max(1, monthRange(since, until).length), [since, until]);

  async function load() {
    if (!ready) return;                       // half-typed custom range
    setLoading(true); setError(null); setProgress(0);
    try {
      // The listings pull still happens: the drill-through panels, the relist
      // analysis and the live-stock view all need the records themselves. What
      // changed is that the monthly COUNT no longer comes from them.
      const [hist, current, ledgerData] = await Promise.all([
        fetchListings({
          since, until, onProgress: setProgress,
          // Every state, always. Drafts and pending are no longer an optional
          // extra — they are reported beside the published figure.
          statuses: [...WENT_LIVE, ...NOT_LIVE],
        }),
        fetchLiveListings({}),
        // A missing ledger must not take the rest of the tab down with it.
        readLedger().catch((err) => ({ rows: [], syncs: [], trusted: null, error: err })),
      ]);
      setRows(hist);
      setLiveRows(current);
      setLedger(ledgerData);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [since, until]);

  /**
   * The month grid, counted on publication rather than record creation.
   *
   * PropSpace has no publish date — asked to sort by one, its own API answers
   * "sort_by must be one of the following values: ref, updated_at, price,
   * created_at, beds, size". So the date comes from the publication ledger,
   * which stamps when a listing was observed live and never rewrites it.
   * Deduplicated by reference, so a listing on two portals counts once and an
   * edit or a price change never adds a count.
   */
  const months = useMemo(() => monthRange(since, until), [since, until]);
  const grid = useMemo(
    () => publishedByMonth(ledger?.rows ?? [], months),
    [ledger, months]
  );

  /** Ledger rows for one month, and optionally one broker, for the drill-through. */
  const countedIn = useCallback((month, broker) =>
    grid.counted.filter((r) =>
      dubaiMonth(r.wentLiveAt) === month && (!broker || (r.brokerName || "Unassigned") === broker)),
    [grid]);

  /**
   * Open the drill-through for a month, optionally one broker's share of it.
   *
   * Resolves the ledger rows that were counted back to the listing records, so
   * the panel shows exactly the set behind the number — including listings that
   * have since been taken down or deleted, which is why the ledger row is kept
   * as a fallback when the record is gone.
   */
  const openMonth = useCallback((month, broker) => {
    const counted = countedIn(month, broker);
    const byRef = new Map(rows.map((l) => [String(l.ref ?? "").toUpperCase(), l]));
    const listings = counted
      .map((r) => byRef.get(String(r.listingRef).toUpperCase()))
      .filter(Boolean);

    const gone = counted.length - listings.length;
    setPanel({
      title: broker ? `${broker} — ${monthLabel(month)}` : monthLabel(month),
      subtitle: gone
        ? `went live this month · ${gone} no longer in the CRM but still counted`
        : "went live this month",
      showBrokers: !broker,
      listings,
    });
  }, [countedIn, rows]);


  /**
   * The states that never reached a portal, reported beside the published
   * figure rather than hidden behind a checkbox. Detail lives behind a click.
   */
  const otherStates = useMemo(() => {
    const of = (st) => rows.filter((l) => String(l.status ?? "").toLowerCase() === st);
    return {
      draft: of("draft"),
      pending_approval: of("pending_approval"),
      unpublished: of("unpublished"),
    };
  }, [rows]);
  const tags = useMemo(() => classifyRelists(rows), [rows]);
  const relistCount = useMemo(
    () => [...tags.values()].filter((t) => t.kind === "relist").length, [tags]
  );
  const maxCell = useMemo(() => {
    let m = 0;
    for (const r of grid.rows)
      for (const k of grid.months) m = Math.max(m, r.months[k].fresh + r.months[k].relist);
    return m;
  }, [grid]);

  const liveByAgent = useMemo(() => {
    const m = new Map();
    for (const l of liveRows) {
      const n = listingAgentOf(l);
      if (!m.has(n)) m.set(n, { name: n, house: isHouseAccount(n), count: 0, rent: 0, sale: 0, value: 0, portalSet: new Set() });
      const r = m.get(n);
      for (const p of (l.portals ?? [])) r.portalSet.add(p);
      r.count++;
      r[l.type === "sale" ? "sale" : "rent"]++;
      r.value += l.price ?? 0;
    }
    return [...m.values()]
      .map((r) => ({ ...r, portals: [...r.portalSet] }))
      .sort((a, b) => b.count - a.count);
  }, [liveRows]);

  const published = useMemo(
    () => Object.values(grid.totals).reduce((a, b) => a + b, 0), [grid]);

  const relisted = useMemo(
    () => rows.filter((l) => tags.get(l.id)?.kind === "relist")
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at)),
    [rows, tags]
  );

  if (error) {
    return (
      <Card className="p-6 border-amber-200 bg-amber-50">
        <p className="text-sm font-medium text-amber-900">Couldn't load listings</p>
        <p className="text-xs text-amber-700 mt-1 font-mono break-all">{error}</p>
      </Card>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        {/* The tab shell owns the page heading now; this section only labels
            itself, so the two do not stack. */}
        <p className="text-sm text-slate-500">
          Listings that went live each month, by broker. Counted on the date they were published, deduplicated
          by reference — so a listing counts once, in the month it went live, and stays there.
        </p>
        <div className="flex items-center gap-2">
          <div className="flex rounded-xl border border-slate-200 overflow-hidden">
            {[["new", "New per month"], ["live", "Live stock"]].map(([k, label]) => (
              <button key={k} onClick={() => setView(k)}
                className={`px-3 py-2 text-sm ${view === k
                  ? "bg-slate-900 text-white font-medium" : "bg-white text-slate-600 hover:bg-slate-50"}`}>
                {label}
              </button>
            ))}
          </div>
          {view === "new" && (
            <>
              <DateRange value={range} onChange={setRange} presets={LISTING_PRESETS} />

            </>
          )}
          <button onClick={() => { clearListingCache(); load(); }} disabled={loading}
            className={`p-2 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-50 ${
              loading ? "is-fetching" : ""}`}>
            <RefreshCw className={`w-4 h-4 text-slate-600 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {loading && (
        <Card className="p-5 mb-4">
          <p className="text-sm text-slate-600">
            Pulling listings… {progress} records so far.
          </p>
          <p className="text-xs text-slate-400 mt-1">
            Taken-down listings live behind a separate status query, so this walks
            several pages per status.
          </p>
        </Card>
      )}

      {/*
        Drafts and pending sit BESIDE the published figure rather than being
        folded into it or hidden behind a checkbox. They are current states, not
        history — a draft can become published tomorrow — so they carry no month
        and are deliberately not part of the grid below. Detail is one click in.
      */}
      {view === "new" && !loading && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
          <div className="bg-white border border-slate-200 rounded-2xl p-4">
            <p className="text-xs font-medium text-slate-600">Published in this window</p>
            <p className="mt-2 text-2xl font-bold text-slate-900 tabular-nums">
              {Object.values(grid.totals).reduce((a, b) => a + b, 0)}
            </p>
            <p className="text-[11px] text-slate-400 mt-1">
              Counted on publish date. Fixed — see the grid below.
            </p>
          </div>

          {[
            ["draft", "Draft", FileEdit, "Never sent to a portal."],
            ["pending_approval", "Awaiting approval", Clock, "Submitted, not yet accepted."],
            ["unpublished", "Taken down", Archive, "Was live; already counted in its month."],
          ].map(([key, label, Icon, note]) => {
            const list = otherStates[key] ?? [];
            return (
              <button key={key} type="button" disabled={!list.length}
                onClick={() => setPanel({
                  title: label,
                  subtitle: `${list.length} listing${list.length === 1 ? "" : "s"} — current state, not a monthly figure`,
                  showBrokers: true,
                  listings: list,
                })}
                className="text-left bg-white border border-slate-200 rounded-2xl p-4 disabled:opacity-60
                           enabled:hover:border-slate-300 enabled:cursor-pointer">
                <p className="text-xs font-medium text-slate-600 flex items-center gap-1.5">
                  <Icon className="w-3.5 h-3.5 text-slate-400" />{label}
                </p>
                <p className="mt-2 text-2xl font-bold text-slate-900 tabular-nums">{list.length}</p>
                <p className="text-[11px] text-slate-400 mt-1">{note}</p>
              </button>
            );
          })}
        </div>
      )}

      {view === "new" && !loading && !(ledger?.rows ?? []).length && (
        <Card className="p-4 mb-4 border-amber-200 bg-amber-50">
          <p className="text-sm font-medium text-amber-900">The publication ledger is empty.</p>
          <p className="text-xs text-amber-700 mt-1">
            {ledger?.error
              ? ledger.error.detail ?? ledger.error.message
              : "Open Published to portals and run a backfill, then a sync. Until then this grid has nothing to count — PropSpace records no publish date of its own, so the ledger is the only source for it."}
          </p>
        </Card>
      )}

      {view === "live" ? (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
            <Stat icon={Building2} tint="bg-indigo-50 text-indigo-600" label="Live listings"
              value={liveRows.length} sub="as of right now — not affected by the date range" />
            <Stat icon={Home} tint="bg-sky-50 text-sky-600" label="For rent"
              value={liveRows.filter((l) => l.type === "rent").length}
              sub={`${liveRows.filter((l) => l.type === "sale").length} for sale`} />
            <Stat icon={Tag} tint="bg-emerald-50 text-emerald-600" label="Portfolio value"
              value={fmtAed(liveRows.reduce((s, l) => s + (l.price ?? 0), 0))}
              sub="sum of asking prices, rent and sale mixed" />
          </div>

          <Card>
            <div className="px-5 py-4 border-b border-slate-200">
              <p className="text-sm font-semibold text-slate-900">Live stock by agent<span className="ml-2 text-xs font-normal text-slate-400">click a broker for their listings</span></p>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500 border-b border-slate-200 bg-slate-50">
                  <th className="px-5 py-2.5 font-medium">Agent</th>
                  <th className="px-3 py-2.5 font-medium text-right">Live</th>
                  <th className="px-3 py-2.5 font-medium text-right">Rent</th>
                  <th className="px-3 py-2.5 font-medium text-right">Sale</th>
                  <th className="px-3 py-2.5 font-medium">Advertised on</th>
                  <th className="px-5 py-2.5 font-medium text-right">Asking total</th>
                </tr>
              </thead>
              <tbody>
                {liveByAgent.map((r) => (
                  <tr key={r.name}
                    onClick={() => setPanel({
                      title: r.name,
                      subtitle: "live right now",
                      showBrokers: false,
                      listings: liveRows.filter((l) => listingAgentOf(l) === r.name),
                    })}
                    className="border-b border-slate-100 last:border-0 cursor-pointer hover:bg-slate-50">
                    <td className="px-5 py-3 font-medium text-slate-900">
                      {r.name}
                      {r.house && (
                        <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">
                          house account
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-right font-semibold text-slate-900">{r.count}</td>
                    <td className="px-3 py-3 text-right text-slate-600">{r.rent}</td>
                    <td className="px-3 py-3 text-right text-slate-600">{r.sale}</td>
                    <td className="px-3 py-3"><PortalRow portals={r.portals} /></td>
                    <td className="px-5 py-3 text-right text-slate-600">{fmtAed(r.value)}</td>
                  </tr>
                ))}
                {!liveByAgent.length && !loading && (
                  <tr><td colSpan={6} className="px-5 py-8 text-center text-slate-400">No live listings.</td></tr>
                )}
              </tbody>
            </table>
          </Card>
        </>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
            <Stat icon={Building2} tint="bg-indigo-50 text-indigo-600" label="Published"
              value={published}
              sub={range.preset === "custom" ? `${since} → ${until}` : `across ${spanMonths} months`} />
            <Stat icon={AlertTriangle} tint="bg-slate-100 text-slate-600" label="Avg / month"
              value={Math.round(published / spanMonths)} sub="listings going live per month" />
            {/* Relists are counted from CRM records, so this is a note about
                data entry rather than a publication figure. It is kept because
                the same unit remarketed is worth seeing, and labelled so it is
                not mistaken for part of the published count above. */}
            <Stat icon={RefreshCw} tint="bg-amber-50 text-amber-600" label="Relisted units"
              value={relistCount} sub="same unit re-entered in the CRM — not a publication count" />
          </div>

          <Card className="overflow-x-auto">
            <div className="px-5 py-4 border-b border-slate-200">
              <p className="text-sm font-semibold text-slate-900">
                New listings by agent, month by month
                <span className="ml-2 text-xs font-normal text-slate-400">
                  click a month or a cell for the listings behind it
                </span>
              </p>
              <p className="text-xs text-slate-400 mt-0.5">
                Counted on the date each listing was published, from the publication ledger, and
                deduplicated by reference — so a listing on two portals counts once, and an edit or a
                price change never adds a count. Drafts and listings still awaiting approval are not in
                here; they are reported separately above.
              </p>
              <p className="text-xs text-slate-500 mt-2 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                <span className="font-medium">This counts what went live that month</span>, whether or
                not it is still up today — and it stays counted after a listing is taken down, expires
                or is deleted from the CRM entirely. That is what makes a past month's figure stop
                moving. Current stock is a separate question; use the Live stock view for that.
                <br />
                <span className="text-slate-400">
                  A count read off the CRM listings screen will be lower for any past month, because
                  that screen only shows what is still up: July reads 84 there against 88 that went
                  live, and December 2025 reads 0 against 181.
                </span>
              </p>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500 border-b border-slate-200 bg-slate-50">
                  <th className="px-5 py-2.5 font-medium sticky left-0 bg-slate-50">Agent</th>
                  {grid.months.map((m) => (
                    <th key={m}
                      onClick={() => openMonth(m)}
                      className="px-1 py-2.5 font-medium text-center whitespace-nowrap cursor-pointer hover:text-indigo-600 hover:underline">
                      {monthLabel(m)}
                    </th>
                  ))}
                  <th className="px-4 py-2.5 font-medium text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {grid.rows.map((r) => (
                  <tr key={r.name} className="border-b border-slate-100 last:border-0">
                    <td className="px-5 py-2 font-medium text-slate-900 sticky left-0 bg-white whitespace-nowrap">
                      {r.name}
                      {r.house && (
                        <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">
                          house
                        </span>
                      )}
                    </td>
                    {grid.months.map((m) => (
                      <Cell key={m} fresh={r.months[m].fresh} relist={r.months[m].relist} max={maxCell}
                        onClick={() => openMonth(m, r.name)} />
                    ))}
                    <td className="px-4 py-2 text-right font-semibold text-slate-900">{r.total}</td>
                  </tr>
                ))}
                {!grid.rows.length && !loading && (
                  <tr><td colSpan={grid.months.length + 2} className="px-5 py-8 text-center text-slate-400">
                    No listings in this window.
                  </td></tr>
                )}
              </tbody>
              <tfoot>
                <tr className="bg-slate-50 border-t border-slate-200">
                  <td className="px-5 py-2.5 text-xs font-semibold text-slate-700 sticky left-0 bg-slate-50">All</td>
                  {grid.months.map((m) => (
                    <td key={m}
                      onClick={() => openMonth(m)}
                      className="px-1 py-2.5 text-center text-xs font-semibold text-slate-700 cursor-pointer hover:text-indigo-600">
                      {grid.totals[m]}
                    </td>
                  ))}
                  <td className="px-4 py-2.5 text-right text-xs font-semibold text-slate-700">{rows.length}</td>
                </tr>
              </tfoot>
            </table>
          </Card>

          {relisted.length > 0 && (
            <Card className="mt-4">
              <div className="px-5 py-4 border-b border-slate-200">
                <p className="text-sm font-semibold text-slate-900">Relisted units</p>
                <p className="text-xs text-slate-400 mt-0.5">
                  Same building, unit, beds and type as an earlier listing. The reference number
                  changes every time, so these are matched on the property itself.
                </p>
              </div>
              <div className="divide-y divide-slate-100">
                {relisted.slice(0, 15).map((l) => {
                  const t = tags.get(l.id);
                  return (
                    <div key={l.id} className="px-5 py-3 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-slate-900">
                          {l.ref}{" "}
                          <span className="text-xs font-normal text-slate-400">
                            was {t.priorRef}
                          </span>
                        </p>
                        <p className="text-xs text-slate-500 mt-0.5 truncate">
                          {l.sub_area_location?.name}, unit {l.unit_number} · {l.beds} bed · {l.type}
                          {" · "}{listingAgentOf(l)}
                        </p>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <p className="text-xs text-slate-500">{t.days} days later</p>
                        <p className={`text-xs font-semibold ${
                          t.priceDelta < 0 ? "text-emerald-600" : t.priceDelta > 0 ? "text-rose-600" : "text-slate-400"}`}>
                          {t.priceDelta === 0
                            ? "same price"
                            : `${t.priceDelta < 0 ? "−" : "+"}${fmtAed(Math.abs(t.priceDelta))}`}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}
        </>
      )}

      <ListingsPanel
        title={panel?.title}
        subtitle={panel?.subtitle}
        listings={panel?.listings ?? []}
        showBrokers={panel?.showBrokers}
        tags={tags}
        onClose={() => setPanel(null)}
      />

      <p className="text-xs text-slate-400 mt-6">
        New listings counted on <span className="font-mono">created_at</span> across published,
        unpublished, draft and pending statuses — the default published-only query would hide
        anything since rented or sold. There is no price-history endpoint on this API key, so
        price movement is only visible where a unit was relisted.
      </p>
    </div>
  );
}


/* --------------------------------- the tab -------------------------------- */

const SECTIONS = [
  ["published", "Published to portals",
   "How many listings went live each month. A past event — these figures do not change."],
  ["pipeline", "Live pipeline",
   "Where everything stands right now. This changes as listings move."],
  ["activity", "Listing activity",
   "New records created in the CRM over a window, and relists."],
  ["leads", "Leads",
   "How many leads sit under each CRM account, all time."],
];

/**
 * Listings, in three sections that must never be confused for one another.
 *
 * The first two are the important split. "How many listings went live in
 * August" is a past event and is read from the append-only publication ledger,
 * so it reads the same today and in a year. "What is live right now" is current
 * state and changes hourly. Deriving the first from the second is exactly what
 * was wrong: a listing taken down in October used to disappear from August.
 *
 * They are separate sections with separate data sources and share no figure.
 * The third is the original CRM-activity view, kept because it answers a
 * genuinely different question — how much work was entered — and is explicitly
 * about records rather than publications.
 *
 * The fourth counts leads rather than listings, which makes it the odd one out
 * on this tab. It lives here because it is the same shape of question — how
 * much is sitting under each name — and because the alternative was a fifth
 * top-level tab for a single table.
 */

export default function Listings() {
  const [section, setSection] = useState("published");
  const note = SECTIONS.find(([k]) => k === section)?.[2];

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Listings</h1>
        <p className="text-sm text-slate-500 mt-1">{note}</p>
      </div>

      <div className="flex flex-wrap gap-1 mb-5 border-b border-slate-200">
        {SECTIONS.map(([k, label]) => (
          <button key={k} onClick={() => setSection(k)}
            className={`px-3 py-2 text-sm -mb-px border-b-2 ${section === k
              ? "border-slate-900 text-slate-900 font-medium"
              : "border-transparent text-slate-500 hover:bg-slate-50 hover:text-slate-700 hover:border-slate-300"}`}>
            {label}
          </button>
        ))}
      </div>

      {section === "published" ? <PublishedReport />
        : section === "pipeline" ? <ListingPipeline />
        : section === "leads" ? <LeadsByAccount />
        : <ListingActivity />}
    </div>
  );
}
