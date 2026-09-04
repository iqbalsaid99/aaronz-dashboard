import React, { useState, useEffect, useMemo, useCallback } from "react";
import {
  Loader2, AlertCircle, RefreshCw, Building2, Home, Layers, Eye, Phone,
  ChevronDown, ChevronRight, ChevronUp, Info, Tag,
} from "lucide-react";
import DateRange, { resolveRange } from "./DateRange.jsx";
import { fetchLiveListings, clearListingCache } from "./listings.js";
import { fetchListingViews } from "./bayut.js";
import { fetchCrmAgents } from "./crmAgents.js";
import {
  buildRows, viewsByReference, applyFilters, summarise, leaderboard,
  sortRows, optionsFor, BLANK_FILTERS, fmtNum, fmtAed,
} from "./bayutListings.js";

/**
 * Bayut — listings analytics.
 *
 * WHERE THE NUMBERS COME FROM, because the two sources are not equal partners.
 * PropSpace is the inventory: Bayut publishes from that feed, and all 314 live
 * listings carry `bayut` in `portals`, so live PropSpace stock is our Bayut
 * stock exactly. Bayut's own API contributes engagement counts and nothing
 * else — it never decides what exists, only what has been looked at.
 *
 * ONE FILTERED ARRAY DRIVES EVERYTHING. The cards, the leaderboard and the
 * table all read the same `shown` array, so "the cards equal the table" holds
 * by construction rather than because three implementations agree today.
 *
 * NO CREDITS, TRUCHECK OR QUALITY SCORE. Those need Profolio endpoints this
 * key does not reach, and an empty card promising them later is a claim the
 * screen cannot keep.
 */

/* -------------------------------- atoms -------------------------------- */

const Card = ({ children, className = "" }) => (
  <div className={`bg-white border border-slate-200 rounded-2xl ${className}`}>{children}</div>
);

const ctrl =
  "text-sm border border-slate-200 rounded-xl px-3 py-2 bg-white outline-none focus:ring-2 focus:ring-indigo-200";

const Chip = ({ children, tint = "bg-slate-100 text-slate-600" }) => (
  <span className={`text-[11px] px-1.5 py-0.5 rounded whitespace-nowrap ${tint}`}>{children}</span>
);

const Empty = ({ children }) => (
  <p className="text-xs text-slate-400 py-6 text-center">{children}</p>
);

function Kpi({ icon: Icon, tint, label, value, sub, foot }) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2">
        <span className={`w-8 h-8 rounded-lg flex items-center justify-center ${tint}`}>
          <Icon className="w-4 h-4 text-white" strokeWidth={2} />
        </span>
        <p className="text-xs font-medium text-slate-600">{label}</p>
      </div>
      <p className="mt-3 text-3xl font-bold text-slate-900 tracking-tight">{value}</p>
      {sub && <p className="mt-1 text-xs text-slate-500">{sub}</p>}
      {foot && <p className="mt-2 text-[11px] text-slate-400 leading-relaxed">{foot}</p>}
    </Card>
  );
}

/** A section that failed, named with its upstream status. */
const SectionError = ({ title, errors }) =>
  !errors.length ? null : (
    <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3 flex gap-2.5">
      <AlertCircle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
      <div className="min-w-0">
        <p className="text-xs font-medium text-amber-900">{title}</p>
        <ul className="mt-1 space-y-0.5">
          {errors.map((e, i) => (
            <li key={i} className="text-[11px] text-amber-700 break-words">
              {e.label ? <span className="font-mono">{e.label}</span> : null}
              {e.status ? ` · HTTP ${e.status}` : ""} · {e.message}
              {e.detail ? ` — ${e.detail}` : ""}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );

/** A sortable column header. */
function Th({ label, col, sort, onSort, align = "left", className = "" }) {
  const active = sort.key === col;
  const Arrow = active && sort.dir === "asc" ? ChevronUp : ChevronDown;
  return (
    <th className={`px-3 py-2.5 font-medium ${align === "right" ? "text-right" : "text-left"} ${className}`}>
      <button type="button" onClick={() => onSort(col)}
        className={`inline-flex items-center gap-1 hover:text-slate-900 ${active ? "text-slate-900" : ""}`}>
        {label}
        <Arrow className={`w-3 h-3 ${active ? "opacity-100" : "opacity-25"}`} />
      </button>
    </th>
  );
}

/* ------------------------------ leaderboard ----------------------------- */

const LB_COLS = [
  ["total", "Listings"], ["sale", "Sale"], ["rent", "Rent"],
  ["residential", "Resi"], ["commercial", "Comm"], ["views", "Views"],
];

function BrokerRow({ b, max, expanded, onToggle }) {
  return (
    <>
      <tr className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60">
        <td className="px-3 py-2.5">
          <button type="button" onClick={onToggle}
            className="flex items-center gap-1.5 text-left min-w-0 w-full rounded hover:text-slate-900 group">
            {expanded
              ? <ChevronDown className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
              : <ChevronRight className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />}
            <span className={`text-sm truncate ${b.ranked ? "text-slate-900" : "text-slate-500 italic"}`}>
              {b.name}
            </span>
            {!b.ranked && (
              <Chip>{b.people ? `${b.people} people` : "not ranked"}</Chip>
            )}
          </button>
        </td>
        <td className="px-3 py-2.5 w-40">
          <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
            <div className="h-full rounded-full bg-indigo-600"
              style={{ width: `${max ? (b.total / max) * 100 : 0}%` }} />
          </div>
        </td>
        <td className="px-3 py-2.5 text-right text-sm text-slate-900 tabular-nums font-medium">{fmtNum(b.total)}</td>
        <td className="px-3 py-2.5 text-right text-xs text-slate-600 tabular-nums">{fmtNum(b.views)}</td>
      </tr>

      {expanded && (
        <tr className="bg-slate-50/60 border-b border-slate-100">
          <td colSpan={4} className="px-3 py-3">
            <div className="flex flex-wrap gap-x-8 gap-y-2 pl-5 text-xs">
              <span className="text-slate-500">Sale <span className="text-slate-900 font-medium">{fmtNum(b.sale)}</span></span>
              <span className="text-slate-500">Rent <span className="text-slate-900 font-medium">{fmtNum(b.rent)}</span></span>
              <span className="text-slate-500">Residential <span className="text-slate-900 font-medium">{fmtNum(b.residential)}</span></span>
              <span className="text-slate-500">Commercial <span className="text-slate-900 font-medium">{fmtNum(b.commercial)}</span></span>
              <span className="text-slate-500">Off-plan <span className="text-slate-900 font-medium">{fmtNum(b.offPlan)}</span></span>
              <span className="text-slate-500">WhatsApp <span className="text-slate-900 font-medium">{fmtNum(b.whatsapp)}</span></span>
              <span className="text-slate-500">SMS <span className="text-slate-900 font-medium">{fmtNum(b.sms)}</span></span>
              <span className="text-slate-500">Phone <span className="text-slate-900 font-medium">{fmtNum(b.phone)}</span></span>
            </div>
            {b.types?.length ? (
              <p className="text-[11px] text-slate-400 mt-2 pl-5">Held back from the ranking: {b.types.join(" · ")}.</p>
            ) : null}
          </td>
        </tr>
      )}
    </>
  );
}

function Leaderboard({ rows }) {
  const [open, setOpen] = useState(null);
  const [sort, setSort] = useState({ key: "total", dir: "desc" });

  const { ranked, remainder } = useMemo(() => leaderboard(rows), [rows]);
  const sorted = useMemo(() => sortRows(ranked, sort.key, sort.dir), [ranked, sort]);
  const max = Math.max(1, ...ranked.map((b) => b.total));

  const onSort = useCallback((key) => {
    setSort((s) => (s.key === key ? { key, dir: s.dir === "desc" ? "asc" : "desc" } : { key, dir: "desc" }));
  }, []);

  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
        <div>
          <p className="text-sm font-semibold text-slate-900">Broker leaderboard</p>
          <p className="text-xs text-slate-400 mt-0.5">
            Listings per broker. Click a row for the sale/rent and residential/commercial split.
          </p>
        </div>
        <select value={`${sort.key}:${sort.dir}`}
          onChange={(e) => { const [k, d] = e.target.value.split(":"); setSort({ key: k, dir: d }); }}
          className={ctrl}>
          {LB_COLS.map(([k, l]) => (
            <React.Fragment key={k}>
              <option value={`${k}:desc`}>{l}, high to low</option>
              <option value={`${k}:asc`}>{l}, low to high</option>
            </React.Fragment>
          ))}
          <option value="name:asc">Name, A–Z</option>
        </select>
      </div>

      {sorted.length || remainder ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b border-slate-200 bg-slate-50">
                <Th label="Broker" col="name" sort={sort} onSort={onSort} />
                <th className="px-3 py-2.5" />
                <Th label="Listings" col="total" sort={sort} onSort={onSort} align="right" />
                <Th label="Views" col="views" sort={sort} onSort={onSort} align="right" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((b) => (
                <BrokerRow key={b.id ?? b.name} b={b} max={max}
                  expanded={open === (b.id ?? b.name)}
                  onToggle={() => setOpen(open === (b.id ?? b.name) ? null : (b.id ?? b.name))} />
              ))}
              {/* Held back from the ranking but still counted, so this column
                  sums to the card above it. crm_agents decides who is here. */}
              {remainder && (
                <BrokerRow b={remainder} max={max}
                  expanded={open === "__remainder"}
                  onToggle={() => setOpen(open === "__remainder" ? null : "__remainder")} />
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>No listings match these filters.</Empty>
      )}

      <p className="text-[11px] text-slate-400 mt-3">
        Attribution is on the listing's assigned agent id, joined through crm_agents. Coordinators, marketing
        and house accounts are held out of the ranking and totalled on the last row instead of dropped, so this
        column always adds up to the listings card.
      </p>
    </Card>
  );
}

/* -------------------------------- table --------------------------------- */

const OFFERING_TINT = { sale: "bg-indigo-50 text-indigo-700", rent: "bg-sky-50 text-sky-700" };

function ListingsTable({ rows }) {
  const [sort, setSort] = useState({ key: "views", dir: "desc" });
  const [limit, setLimit] = useState(100);

  const sorted = useMemo(() => sortRows(rows, sort.key, sort.dir), [rows, sort]);
  const onSort = useCallback((key) => {
    setSort((s) => (s.key === key ? { key, dir: s.dir === "desc" ? "asc" : "desc" } : { key, dir: "desc" }));
  }, []);

  useEffect(() => { setLimit(100); }, [rows, sort]);

  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <p className="text-sm font-semibold text-slate-900">Listings</p>
          <p className="text-xs text-slate-400 mt-0.5">
            Every live listing in the current filter. View counts are Bayut's, left-joined on reference.
          </p>
        </div>
        <span className="text-xs text-slate-400">{fmtNum(rows.length)} listings</span>
      </div>

      {sorted.length ? (
        <>
          <div className="overflow-x-auto -mx-5 px-5">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500 border-b border-slate-200 bg-slate-50">
                  <Th label="Ref" col="ref" sort={sort} onSort={onSort} className="pl-0" />
                  <Th label="Community" col="community" sort={sort} onSort={onSort} />
                  <Th label="Offering" col="offering" sort={sort} onSort={onSort} />
                  <Th label="Category" col="categoryClass" sort={sort} onSort={onSort} />
                  <Th label="Price" col="price" sort={sort} onSort={onSort} align="right" />
                  <Th label="Broker" col="broker" sort={sort} onSort={onSort} />
                  <Th label="Off-plan" col="offPlan" sort={sort} onSort={onSort} />
                  <Th label="Permit" col="permit" sort={sort} onSort={onSort} />
                  <Th label="WA" col="whatsapp" sort={sort} onSort={onSort} align="right" />
                  <Th label="SMS" col="sms" sort={sort} onSort={onSort} align="right" />
                  <Th label="Phone" col="phone" sort={sort} onSort={onSort} align="right" />
                </tr>
              </thead>
              <tbody>
                {sorted.slice(0, limit).map((r) => (
                  <tr key={r.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60">
                    <td className="pl-0 pr-3 py-2.5 font-mono text-xs text-slate-600 whitespace-nowrap">
                      {r.ref ?? "—"}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-slate-900 truncate max-w-[11rem]"
                      title={r.community ?? undefined}>
                      {r.community ?? "—"}
                    </td>
                    <td className="px-3 py-2.5">
                      {r.offering
                        ? <Chip tint={OFFERING_TINT[r.offering]}>{r.offering}</Chip>
                        : <span className="text-slate-300 text-xs">—</span>}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-slate-600">
                      {r.categoryClass === "unclassified"
                        ? <span title={r.category ?? undefined} className="text-amber-700">unclassified</span>
                        : r.categoryClass}
                    </td>
                    <td className="px-3 py-2.5 text-right text-xs text-slate-900 tabular-nums whitespace-nowrap">
                      {fmtAed(r.price)}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-slate-600 truncate max-w-[9rem]" title={r.broker}>
                      {r.broker}
                    </td>
                    <td className="px-3 py-2.5">
                      {r.offPlan
                        ? <Chip tint="bg-amber-50 text-amber-700">{r.completionStatus?.replace(/_/g, " ") ?? "off-plan"}</Chip>
                        : <span className="text-slate-300 text-xs">—</span>}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-[11px] text-slate-500 truncate max-w-[9rem]"
                      title={r.permit ?? undefined}>
                      {r.permit ?? "—"}
                    </td>
                    <td className="px-3 py-2.5 text-right text-xs tabular-nums">
                      <span className={r.whatsapp ? "text-slate-900" : "text-slate-300"}>{fmtNum(r.whatsapp)}</span>
                    </td>
                    <td className="px-3 py-2.5 text-right text-xs tabular-nums">
                      <span className={r.sms ? "text-slate-900" : "text-slate-300"}>{fmtNum(r.sms)}</span>
                    </td>
                    <td className="px-3 py-2.5 text-right text-xs tabular-nums">
                      <span className={r.phone ? "text-slate-900" : "text-slate-300"}>{fmtNum(r.phone)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {sorted.length > limit && (
            <div className="text-center mt-4">
              <button onClick={() => setLimit((n) => n + 200)}
                className="text-xs px-3 py-2 rounded-xl border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:border-slate-300">
                Show more · {fmtNum(sorted.length - limit)} remaining
              </button>
            </div>
          )}
        </>
      ) : (
        <Empty>No listings match these filters.</Empty>
      )}
    </Card>
  );
}

/* ---------------------------------- tab --------------------------------- */

const PRESETS = [
  ["today", "Today"],
  ["7", "Last 7 days"],
  ["30", "Last 30 days"],
  ["90", "Last 90 days"],
];

export default function Bayut() {
  const [range, setRange] = useState({ preset: "30", from: "", to: "" });
  const [filters, setFilters] = useState(BLANK_FILTERS);
  const [nonce, setNonce] = useState(0);

  const [listings, setListings] = useState([]);
  const [viewPulls, setViewPulls] = useState([]);
  const [crmAgents, setCrmAgents] = useState(null);

  const [busy, setBusy] = useState(true);
  const [listingsError, setListingsError] = useState(null);
  const [crmError, setCrmError] = useState(null);

  const { from } = resolveRange(range);

  // Inventory and identity. Neither depends on the date range — the range only
  // ever reached the engagement pull, and (see below) not even that.
  useEffect(() => {
    let alive = true;
    (async () => {
      setBusy(true); setListingsError(null); setCrmError(null);
      const [L, C] = await Promise.allSettled([
        fetchLiveListings({ maxPages: 20 }),
        fetchCrmAgents(),
      ]);
      if (!alive) return;

      if (L.status === "rejected") {
        setListingsError({ message: String(L.reason?.message ?? L.reason) });
        setListings([]);
      } else {
        setListings(L.value ?? []);
      }

      // A failed crm_agents lookup must not silently promote coordinators and
      // house accounts into the ranking, so it is named rather than absorbed.
      if (C.status === "rejected") {
        setCrmError({ message: String(C.reason?.message ?? C.reason) });
        setCrmAgents(null);
      } else {
        setCrmAgents(C.value ?? null);
      }
      setBusy(false);
    })();
    return () => { alive = false; };
  }, [nonce]);

  // Engagement. Separate from inventory so a Bayut outage costs the view
  // columns and nothing else — the listing count stays right.
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!from) return;
      const pulls = await fetchListingViews({ from });
      if (alive) setViewPulls(pulls);
    })();
    return () => { alive = false; };
  }, [from, nonce]);

  const views = useMemo(
    () => viewsByReference(viewPulls.flatMap((p) => p.rows)),
    [viewPulls]
  );

  const rows = useMemo(
    () => buildRows(listings, views, crmAgents),
    [listings, views, crmAgents]
  );

  // THE one filtered array. Cards, leaderboard and table all read this.
  const shown = useMemo(() => applyFilters(rows, filters), [rows, filters]);
  const s = useMemo(() => summarise(shown), [shown]);

  const communities = useMemo(() => optionsFor(rows, (r) => r.community), [rows]);
  const brokers = useMemo(() => {
    const m = new Map();
    for (const r of rows) if (r.brokerId) m.set(r.brokerId, r.broker);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows]);

  const set = useCallback((k, v) => setFilters((f) => ({ ...f, [k]: v })), []);
  const dirty = useMemo(
    () => Object.entries(filters).some(([k, v]) => v !== BLANK_FILTERS[k]),
    [filters]
  );

  const viewErrors = viewPulls
    .filter((p) => p.error)
    .map((p) => ({ label: p.id, ...p.error }));

  const refresh = () => { clearListingCache(); setNonce((n) => n + 1); };

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Bayut</h1>
          <p className="text-sm text-slate-500 mt-1">
            Listings analytics — {fmtNum(s.total)} live listing{s.total === 1 ? "" : "s"} on Bayut,
            {" "}{fmtNum(s.views)} contact reveals against {fmtNum(s.withViews)} of them.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <DateRange value={range} onChange={setRange} presets={PRESETS} />
          <button onClick={refresh} disabled={busy}
            className={`flex items-center gap-2 px-3 py-2 text-sm rounded-xl border border-slate-200 bg-white
                        disabled:opacity-40 enabled:hover:bg-slate-50 enabled:hover:border-slate-300 ${busy ? "is-fetching" : ""}`}>
            <RefreshCw className={`w-4 h-4 ${busy ? "animate-spin" : ""}`} />Refresh
          </button>
        </div>
      </div>

      {/*
        The date picker is wired to the engagement pull's `timestamp`, as
        designed — and Bayut ignores it. Measured: the same pull at three
        different start dates returned an identical 51 rows and 5,019 views,
        while a lead pull over the same dates swung 62 -> 900. View rows are
        lifetime counters per listing. Saying so here, next to the control, is
        the only honest option short of removing the control.
      */}
      <div className="mb-4 rounded-xl border border-slate-200 bg-slate-50 p-3 flex gap-2.5">
        <Info className="w-4 h-4 text-slate-400 flex-shrink-0 mt-0.5" />
        <p className="text-[11px] text-slate-500 leading-relaxed">
          <span className="font-medium text-slate-700">View counts are lifetime totals, not this range.</span>{" "}
          The date picker sends its start date to Bayut as the engagement filter, but Bayut does not apply it to
          view pulls — the same request at three different start dates returns identical figures. Listing counts
          are current inventory and were never range-bound. Nothing on this screen changes when you move the picker.
        </p>
      </div>

      {listingsError && (
        <SectionError title="Couldn't load listings from PropSpace — every figure below is missing, not zero."
          errors={[listingsError]} />
      )}
      {crmError && (
        <SectionError title="Couldn't load crm_agents — the leaderboard is ranking everyone, including coordinators and house accounts."
          errors={[crmError]} />
      )}

      {busy && !listings.length ? (
        <Card className="p-16 text-center">
          <Loader2 className="w-6 h-6 text-slate-300 mx-auto animate-spin" />
          <p className="text-sm text-slate-500 mt-3">Pulling live listings and Bayut engagement…</p>
        </Card>
      ) : (
        <div className="space-y-4">
          <div className="grid sm:grid-cols-2 xl:grid-cols-5 gap-4">
            <Kpi icon={Building2} tint="bg-slate-900" label="Live listings"
              value={fmtNum(s.total)}
              sub={dirty ? "in the current filter" : "published to Bayut"}
              foot="PropSpace is the inventory. All live stock carries bayut in its portals." />
            <Kpi icon={Tag} tint="bg-indigo-600" label="Sale vs rent"
              value={`${fmtNum(s.sale)} / ${fmtNum(s.rent)}`}
              sub={s.noOffering ? `${fmtNum(s.noOffering)} with neither` : "sale / rent"} />
            <Kpi icon={Home} tint="bg-emerald-600" label="Resi vs comm"
              value={`${fmtNum(s.residential)} / ${fmtNum(s.commercial)}`}
              sub={s.unclassified
                ? `${fmtNum(s.unclassified)} unclassified category`
                : "residential / commercial"} />
            <Kpi icon={Layers} tint="bg-amber-600" label="Off-plan"
              value={fmtNum(s.offPlan)}
              sub="by completion_status" />
            <Kpi icon={Eye} tint="bg-sky-600" label="Bayut reveals · lifetime"
              value={fmtNum(s.views)}
              sub={`${fmtNum(s.whatsapp)} WhatsApp · ${fmtNum(s.sms)} SMS · ${fmtNum(s.phone)} phone`}
              foot="Not bounded by the date range — see the note above." />
          </div>

          <Card className="p-4">
            <div className="flex flex-wrap gap-2 items-center">
              <select value={filters.offering} onChange={(e) => set("offering", e.target.value)} className={ctrl}>
                <option value="">Sale and rent</option>
                <option value="sale">Sale</option>
                <option value="rent">Rent</option>
              </select>

              <select value={filters.categoryClass} onChange={(e) => set("categoryClass", e.target.value)} className={ctrl}>
                <option value="">Every category</option>
                <option value="residential">Residential</option>
                <option value="commercial">Commercial</option>
                {s.unclassified > 0 && <option value="unclassified">Unclassified</option>}
              </select>

              <select value={filters.broker} onChange={(e) => set("broker", e.target.value)} className={ctrl}>
                <option value="">Every broker</option>
                {brokers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select>

              <select value={filters.community} onChange={(e) => set("community", e.target.value)} className={ctrl}>
                <option value="">Every community</option>
                {communities.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>

              <select value={filters.offPlan} onChange={(e) => set("offPlan", e.target.value)} className={ctrl}>
                <option value="">Off-plan and ready</option>
                <option value="yes">Off-plan only</option>
                <option value="no">Ready only</option>
              </select>

              <input type="number" min="0" step="50000" value={filters.priceFrom}
                onChange={(e) => set("priceFrom", e.target.value)}
                placeholder="Min AED" className={`${ctrl} w-32`} />
              <input type="number" min="0" step="50000" value={filters.priceTo}
                onChange={(e) => set("priceTo", e.target.value)}
                placeholder="Max AED" className={`${ctrl} w-32`} />

              <span className="text-xs text-slate-400">
                {fmtNum(shown.length)} of {fmtNum(rows.length)} listings
              </span>

              {dirty && (
                <button onClick={() => setFilters(BLANK_FILTERS)}
                  className="text-xs text-slate-500 hover:text-slate-800 px-2 py-2">
                  Clear
                </button>
              )}
            </div>
          </Card>

          <SectionError
            title={viewErrors.length === 1
              ? "One Bayut engagement pull failed — those view columns are incomplete, not zero."
              : "Bayut engagement pulls failed — those view columns are incomplete, not zero."}
            errors={viewErrors} />

          <Leaderboard rows={shown} />
          <ListingsTable rows={shown} />
        </div>
      )}

      <p className="text-xs text-slate-400 mt-6">
        Inventory from PropSpace <span className="font-mono">/listings?status=published</span>, paged to
        exhaustion. Engagement from Bayut's website-client-leads API, <span className="font-mono">is_trulead=0,
        target=listing</span>, summed per reference and left-joined — a listing with no Bayut row shows zero
        rather than being dropped. Broker identity is the listing's agent id joined through crm_agents, never
        the agent email, which gets stripped when records are reassigned. Credits, TruCheck and quality score
        need Profolio endpoints this key does not reach and are deliberately absent rather than stubbed.
      </p>
    </div>
  );
}
