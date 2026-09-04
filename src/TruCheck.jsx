import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  Loader2, AlertCircle, RefreshCw, ShieldCheck, ShieldOff, HelpCircle,
  ExternalLink, Database, ChevronDown, ChevronUp, Info, CheckCircle2,
  LayoutGrid, Image, Video, Gauge,
} from "lucide-react";
import { fetchLiveListings } from "./listings.js";
import { fetchCrmAgents } from "./crmAgents.js";
import { buildRows as buildListingRows, optionsFor, fmtAed, fmtNum } from "./bayutListings.js";
import {
  readLatest, readConfig, startEnumerate, startDetails, pollRun, commitRun, TERMINAL,
} from "./truCheckSource.js";
import { scoreBand, PHOTO_TARGET } from "./truCheckScore.js";
import {
  buildRows, applyFilters, summarise, rateBy, rateByBroker, orphans, daysLive,
  BLANK_FILTERS, STATE_LABEL, ON_BAYUT, fmtPct, fmtDate, fmtDateTime,
} from "./truCheckModel.js";

/**
 * TruCheck — which of our Bayut listings carry the badge, and which do not.
 *
 * The not-TruChecked table is the point of the screen: it is the list someone
 * books appointments from. Everything else is there to let them narrow it.
 *
 * THREE STATES, NEVER TWO. A listing Bayut has never heard of is not a mild
 * case of "not TruChecked" — it is a publishing fault, and putting it in the
 * TruCheck queue wastes the appointment. They are separated everywhere,
 * including in the denominator: the TruCheck rate is measured against listings
 * live on Bayut, not against the whole inventory, or the rate improves whenever
 * publishing breaks.
 *
 * SNAPSHOT-FIRST. The tab renders the last crawl from Supabase and never waits
 * on Apify. Refresh starts a run alongside whatever is already on screen.
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
  <p className="text-xs text-slate-400 py-8 text-center">{children}</p>
);

const STATE_TINT = {
  truchecked: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  not: "bg-rose-50 text-rose-700 ring-rose-200",
  missing: "bg-slate-100 text-slate-600 ring-slate-200",
};

/**
 * A summary card, optionally a filter.
 *
 * When `onClick` is given the whole card becomes a button and filters the page
 * to exactly the rows it counted — anything else would mean clicking a number
 * and being shown a different set. Rendered as a real <button> so it is
 * reachable by keyboard and announced as interactive, which a div with a
 * handler is not.
 */
function Kpi({ icon: Icon, tint, label, value, sub, foot, onClick, active }) {
  const body = (
    <>
      <div className="flex items-center gap-2">
        <span className={`w-8 h-8 rounded-lg flex items-center justify-center ${tint}`}>
          <Icon className="w-4 h-4 text-white" strokeWidth={2} />
        </span>
        <p className="text-xs font-medium text-slate-600">{label}</p>
        {onClick && (
          <span className={`ml-auto text-[10px] ${active ? "text-slate-900 font-medium" : "text-slate-300"}`}>
            {active ? "filtered" : "filter"}
          </span>
        )}
      </div>
      <p className="mt-3 text-3xl font-bold text-slate-900 tracking-tight">{value}</p>
      {sub && <p className="mt-1 text-xs text-slate-500">{sub}</p>}
      {foot && <p className="mt-2 text-[11px] text-slate-400 leading-relaxed">{foot}</p>}
    </>
  );

  if (!onClick) return <Card className="p-4">{body}</Card>;

  return (
    <button type="button" onClick={onClick} aria-pressed={Boolean(active)}
      title={active ? "Clear this filter" : `Show only ${label}`}
      className={`text-left bg-white border rounded-2xl p-4 transition w-full
        focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300
        ${active ? "border-slate-900 ring-1 ring-slate-900" : "border-slate-200 hover:border-slate-300"}`}>
      {body}
    </button>
  );
}

const Problem = ({ title, detail, hint, tone = "amber", action }) => (
  <Card className={`p-5 mb-4 flex gap-3 border-${tone}-200 bg-${tone}-50`}>
    <AlertCircle className={`w-5 h-5 text-${tone}-600 flex-shrink-0 mt-0.5`} />
    <div className="min-w-0 flex-1">
      <p className={`text-sm font-medium text-${tone}-900`}>{title}</p>
      {detail && <p className={`text-xs text-${tone}-700 mt-1 break-words`}>{detail}</p>}
      {hint && <p className={`text-xs text-${tone}-700 mt-1`}>{hint}</p>}
    </div>
    {action}
  </Card>
);

/** Sortable header. */
function Th({ label, col, sort, onSort, align = "left", className = "" }) {
  const active = sort.key === col;
  const Arrow = active && sort.dir === "asc" ? ChevronUp : ChevronDown;
  return (
    <th className={`px-3 py-2.5 font-medium ${align === "right" ? "text-right" : "text-left"} ${className}`}>
      <button type="button" onClick={() => onSort(col)}
        className={`inline-flex items-center gap-1 hover:text-slate-900 ${active ? "text-slate-900" : ""}`}>
        {label}<Arrow className={`w-3 h-3 ${active ? "opacity-100" : "opacity-25"}`} />
      </button>
    </th>
  );
}

const sortRows = (rows, key, dir) => {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = a[key], y = b[key];
    const xn = x === null || x === undefined || x === "";
    const yn = y === null || y === undefined || y === "";
    if (xn && yn) return 0;
    if (xn) return 1;
    if (yn) return -1;
    if (typeof x === "number" && typeof y === "number") return (x - y) * sign;
    return String(x).localeCompare(String(y)) * sign;
  });
};

/* ------------------------------ breakdowns ------------------------------ */

function RateBars({ title, note, rows, remainder }) {
  const all = remainder ? [...rows, remainder] : rows;
  return (
    <Card className="p-5">
      <p className="text-sm font-semibold text-slate-900">{title}</p>
      {note && <p className="text-xs text-slate-400 mt-0.5 mb-3">{note}</p>}
      {all.length ? (
        <div className="space-y-2 mt-3">
          {all.map((e) => (
            <div key={e.key} className="flex items-center gap-3">
              <span className={`text-xs w-36 truncate flex-shrink-0 ${
                e.ranked === false ? "text-slate-500 italic" : "text-slate-600"}`} title={e.label}>
                {e.label}
              </span>
              <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden min-w-[40px] flex">
                <div className="h-full bg-emerald-600" style={{ width: `${(e.rate ?? 0) * 100}%` }} />
                <div className="h-full bg-rose-500"
                  style={{ width: `${e.liveOnBayut ? (e.not / e.liveOnBayut) * 100 : 0}%` }} />
              </div>
              <span className="text-xs w-40 text-right flex-shrink-0 tabular-nums text-slate-500">
                {/* null, not 0%, when nothing of theirs is on Bayut — they have
                    nothing to TruCheck, which is not the same as failing to. */}
                {e.rate === null ? <span className="text-slate-400">no Bayut stock</span>
                  : <>
                      {fmtPct(e.rate)} <span className="text-slate-400">{e.truchecked}/{e.liveOnBayut}</span>
                      {e.avgScore !== null && (
                        <span className="text-slate-400"> · score {e.avgScore}</span>
                      )}
                    </>}
              </span>
            </div>
          ))}
        </div>
      ) : <Empty>Nothing in this filter.</Empty>}
      <p className="text-[11px] text-slate-400 mt-3">
        Green is TruChecked, red is live on Bayut without the badge. Listings not found on Bayut are
        excluded from the rate and counted separately.
      </p>
    </Card>
  );
}

/* -------------------------------- tables -------------------------------- */

const BAND_TINT = {
  good: "bg-emerald-50 text-emerald-700",
  fair: "bg-amber-50 text-amber-700",
  poor: "bg-rose-50 text-rose-700",
  none: "bg-slate-100 text-slate-500",
};

/**
 * The score, and what it is made of.
 *
 * Expandable because a bare 65 tells an agent nothing actionable. The breakdown
 * is the point of the number: it names the two things to go and fix.
 */
function ScoreCell({ row, open, onToggle }) {
  if (row.score === null || row.score === undefined) {
    // Three different reasons for no score, and they are not the same fact.
    // Saying "not yet detailed" out loud is what stops a blank column being
    // read as a zero — which is the failure this whole two-speed design exists
    // to avoid.
    if (row.state === "missing") {
      return <span className="text-xs text-slate-300" title="Not on Bayut, so there is nothing to score">—</span>;
    }
    return (
      <span className="text-[11px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 whitespace-nowrap"
        title="This listing has not been read by a full refresh yet. Its quality columns are unmeasured, not zero.">
        not yet detailed
      </span>
    );
  }
  return (
    <button type="button" onClick={onToggle}
      className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded tabular-nums
                  transition hover:brightness-95 hover:ring-1 hover:ring-slate-300
                  ${BAND_TINT[scoreBand(row.score)]}`}>
      {row.score}
      {open ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
    </button>
  );
}

/** A dash that says WHY it is a dash. Never rendered where a zero would fit. */
const NotMeasured = () => (
  <span className="text-slate-300 text-xs"
    title="Not yet detailed — unmeasured, not zero">—</span>
);

const YesNo = ({ v, yes, no }) =>
  v === null || v === undefined
    ? <NotMeasured />
    : v
      ? <Chip tint="bg-emerald-50 text-emerald-700">{yes}</Chip>
      : <Chip tint="bg-slate-100 text-slate-500">{no}</Chip>;

function Table({ rows, segment }) {
  const [sort, setSort] = useState(
    segment === "truchecked" ? { key: "truCheckedAt", dir: "desc" } : { key: "broker", dir: "asc" }
  );
  const [limit, setLimit] = useState(100);
  const [open, setOpen] = useState(null);

  const sorted = useMemo(() => sortRows(rows, sort.key, sort.dir), [rows, sort]);
  const onSort = useCallback((key) => {
    setSort((s) => (s.key === key ? { key, dir: s.dir === "desc" ? "asc" : "desc" } : { key, dir: "asc" }));
  }, []);
  useEffect(() => { setLimit(100); setOpen(null); }, [rows, sort, segment]);

  if (!rows.length) return <Empty>No listings in this filter.</Empty>;

  const onBayut = segment !== "missing";

  return (
    <>
      <div className="overflow-x-auto -mx-5 px-5">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b border-slate-200 bg-slate-50">
              <Th label="Ref" col="ref" sort={sort} onSort={onSort} className="pl-0" />
              <Th label="Community" col="community" sort={sort} onSort={onSort} />
              <Th label="Broker" col="broker" sort={sort} onSort={onSort} />
              <Th label="Offering" col="offering" sort={sort} onSort={onSort} />
              <Th label="Price" col="price" sort={sort} onSort={onSort} align="right" />
              {segment === "truchecked" && <Th label="TruChecked" col="truCheckedAt" sort={sort} onSort={onSort} />}
              {onBayut && <Th label="Plan" col="hasFloorPlan" sort={sort} onSort={onSort} />}
              {onBayut && <Th label="Photos" col="photoCount" sort={sort} onSort={onSort} align="right" />}
              {onBayut && <Th label="Video/360" col="videoCount" sort={sort} onSort={onSort} />}
              {onBayut && <Th label="Score" col="score" sort={sort} onSort={onSort} align="right" />}
              <th className="px-3 py-2.5 text-right font-medium">Bayut</th>
            </tr>
          </thead>
          <tbody>
            {sorted.slice(0, limit).map((r) => {
              const isOpen = open === r.id;
              const media = (r.videoCount ?? 0) + (r.panoramaCount ?? 0);
              return (
                <React.Fragment key={r.id}>
                  <tr className="border-b border-slate-100 hover:bg-slate-50/60">
                    <td className="pl-0 pr-3 py-2.5 font-mono text-xs text-slate-600 whitespace-nowrap">{r.ref ?? "—"}</td>
                    <td className="px-3 py-2.5 text-xs text-slate-900 truncate max-w-[10rem]" title={r.community ?? undefined}>
                      {r.community ?? "—"}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-slate-600 truncate max-w-[9rem]" title={r.broker}>
                      {r.broker}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-slate-600">{r.offering ?? "—"}</td>
                    <td className="px-3 py-2.5 text-right text-xs text-slate-900 tabular-nums whitespace-nowrap">
                      {fmtAed(r.price)}
                    </td>
                    {segment === "truchecked" && (
                      <td className="px-3 py-2.5 text-xs text-slate-600 whitespace-nowrap">
                        {r.truCheckedAt ? fmtDate(r.truCheckedAt)
                          : <span className="text-slate-400 text-xs"
                              title="The badge is current; the date comes from a full refresh, which has not covered this listing yet">
                              not yet detailed
                            </span>}
                      </td>
                    )}
                    {onBayut && <td className="px-3 py-2.5"><YesNo v={r.hasFloorPlan} yes="plan" no="none" /></td>}
                    {onBayut && (
                      <td className="px-3 py-2.5 text-right text-xs tabular-nums">
                        {r.photoCount === null ? <NotMeasured />
                          : <span className={r.photoCount >= PHOTO_TARGET ? "text-slate-900" : "text-amber-700"}>
                              {fmtNum(r.photoCount)}
                            </span>}
                      </td>
                    )}
                    {onBayut && (
                      <td className="px-3 py-2.5">
                        {r.videoCount === null ? <NotMeasured />
                          : media > 0 ? <Chip tint="bg-emerald-50 text-emerald-700">{fmtNum(media)}</Chip>
                          : <Chip tint="bg-slate-100 text-slate-500">none</Chip>}
                      </td>
                    )}
                    {onBayut && (
                      <td className="px-3 py-2.5 text-right">
                        <ScoreCell row={r} open={isOpen} onToggle={() => setOpen(isOpen ? null : r.id)} />
                      </td>
                    )}
                    <td className="px-3 py-2.5 text-right">
                      {r.bayutUrl
                        ? <a href={r.bayutUrl} target="_blank" rel="noreferrer"
                            className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-800">
                            Open<ExternalLink className="w-3 h-3" />
                          </a>
                        : <span className="text-slate-300 text-xs">—</span>}
                    </td>
                  </tr>

                  {isOpen && (
                    <tr className="bg-slate-50/70 border-b border-slate-100">
                      <td colSpan={11} className="px-3 py-3">
                        <div className="flex flex-wrap gap-x-6 gap-y-2">
                          {(r.factors ?? []).map((f) => (
                            <div key={f.key} className="text-xs">
                              <p className={f.full ? "text-emerald-700" : "text-slate-500"}>
                                {f.label}{" "}
                                <span className="tabular-nums font-medium">{f.got}/{f.weight}</span>
                              </p>
                              <p className="text-[11px] text-slate-400">{f.say}</p>
                            </div>
                          ))}
                        </div>
                        {/* Bayut's own numbers, side by side with ours and
                            never blended into them — nobody outside Bayut
                            knows what they weigh. */}
                        {r.nativeScores && (
                          <p className="text-[11px] text-slate-400 mt-3 pt-2 border-t border-slate-200">
                            Bayut's internal numbers:{" "}
                            {Object.entries(r.nativeScores)
                              .filter(([, v]) => v !== null)
                              .map(([k, v]) => `${k} ${v}`)
                              .join(" · ") || "none reported"}
                          </p>
                        )}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
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
  );
}

/* ---------------------------------- tab --------------------------------- */

export default function TruCheck() {
  const [listings, setListings] = useState([]);
  const [crmAgents, setCrmAgents] = useState(null);
  const [snapshot, setSnapshot] = useState(null);
  const [config, setConfig] = useState(null);

  const [busy, setBusy] = useState(true);
  const [listingsError, setListingsError] = useState(null);
  const [snapshotError, setSnapshotError] = useState(null);

  const [run, setRun] = useState(null);          // { id, status, error }
  const [filters, setFilters] = useState(BLANK_FILTERS);
  const [tab, setTab] = useState("not");
  const [nonce, setNonce] = useState(0);
  const poller = useRef(null);

  /* ---- load: inventory, identity, snapshot. None depends on a crawl. ---- */
  useEffect(() => {
    let alive = true;
    (async () => {
      setBusy(true); setListingsError(null); setSnapshotError(null);
      const [L, C, S, K] = await Promise.allSettled([
        fetchLiveListings({ maxPages: 20 }),
        fetchCrmAgents(),
        readLatest(),
        readConfig(),
      ]);
      if (!alive) return;

      if (L.status === "rejected") setListingsError({ message: String(L.reason?.message ?? L.reason) });
      else setListings(L.value ?? []);

      setCrmAgents(C.status === "fulfilled" ? C.value ?? null : null);

      if (S.status === "rejected") {
        setSnapshotError({
          message: S.reason?.message ?? String(S.reason),
          detail: S.reason?.detail ?? null,
          code: S.reason?.code ?? null,
        });
      } else setSnapshot(S.value);

      setConfig(K.status === "fulfilled" ? K.value : null);
      setBusy(false);
    })();
    return () => { alive = false; };
  }, [nonce]);

  /* ---- refresh: enumerate, then detail, then commit. ------------------- */

  /**
   * Poll one Apify run to completion.
   *
   * Resolves with the finished run rather than throwing on a bad terminal
   * state, because "the detail pass failed" is a reportable outcome the crawl
   * survives, not an exception that should lose the listing pass with it.
   */
  const waitFor = useCallback((runId, onTick) => new Promise((resolve, reject) => {
    poller.current = setInterval(async () => {
      try {
        const s = await pollRun(runId);
        onTick?.(s);
        if (!TERMINAL.includes(s.status)) return;
        clearInterval(poller.current);
        resolve(s);
      } catch (err) {
        clearInterval(poller.current);
        reject(err);
      }
    }, 5000);
  }), []);

  /**
   * Refresh, in one of two speeds.
   *
   *   enumerate  every listing and its badge. Cheap; safe to run daily.
   *   full       the above plus a read of every listing page, for the quality
   *              signals and the score. Costs per listing.
   *
   * Both write a complete snapshot of what exists. Only a full run writes
   * quality data, and readLatest keeps serving the last full run's quality
   * alongside the newest badges — so a cheap refresh never blanks the columns
   * an expensive one filled.
   */
  const refresh = useCallback(async (mode) => {
    const fail = (msg) => setRun((r) => ({ ...r, stage: "failed", error: msg }));
    setRun({ mode, stage: "listing", error: null });

    try {
      const list = await startEnumerate();
      setRun((r) => ({ ...r, listRunId: list.runId }));

      const listDone = await waitFor(list.runId, (s) =>
        setRun((r) => ({ ...r, listCount: s.itemCount, usageUsd: s.usageUsd })));

      if (listDone.status !== "SUCCEEDED") {
        return fail(`The listing pass ended as ${listDone.status}. Nothing was saved.`);
      }

      let detailRunId = null;
      let requested = null;
      let detailUsage = 0;

      if (mode === "full") {
        setRun((r) => ({ ...r, stage: "details" }));
        try {
          const det = await startDetails(list.runId);
          detailRunId = det.runId;
          requested = det.requested;
          setRun((r) => ({ ...r, detailRunId, requested }));

          const detDone = await waitFor(det.runId, (s) =>
            setRun((r) => ({ ...r, detailCount: s.itemCount, usageUsd: (r.usageUsd ?? 0) + (s.usageUsd ?? 0) })));
          detailUsage = detDone.usageUsd ?? 0;
        } catch (err) {
          // A detail pass that will not start is survivable: the badges are
          // already in hand, and the previous full run's quality data stays on
          // screen rather than being replaced with blanks.
          setRun((r) => ({ ...r, detailWarning: err.message }));
        }
      }

      setRun((r) => ({ ...r, stage: "saving" }));
      const done = await commitRun({
        runId: list.runId,
        detailRunId,
        mode,
        expected: requested,
        usageUsd: (listDone.usageUsd ?? 0) + detailUsage,
      });

      setRun({ stage: "done", mode, ...done, error: null });
      setNonce((n) => n + 1);
    } catch (err) {
      fail(`${err.message}${err.detail ? ` — ${err.detail}` : ""}`);
    }
  }, [waitFor]);

  useEffect(() => () => clearInterval(poller.current), []);

  /* ------------------------------- the model --------------------------- */

  // PropSpace rows first (offering, category, broker, community, price all come
  // from the Bayut tab's derivations), then the TruCheck state layered on.
  const base = useMemo(
    () => buildListingRows(listings, new Map(), crmAgents),
    [listings, crmAgents]
  );

  const rows = useMemo(() => {
    const withState = buildRows(base, snapshot?.rows ?? []);
    return withState.map((r) => ({ ...r, daysLive: daysLive(r.createdAt) }));
  }, [base, snapshot]);

  /**
   * How old the quality half is.
   *
   * Ten days is the threshold asked for. It is generous on purpose: photo
   * counts and floor plans change when someone edits a listing, not daily, so
   * flagging sooner would keep an amber warning on screen permanently and
   * teach everyone to ignore it.
   */
  const quality = useMemo(() => {
    const at = snapshot?.qualityScrapedAt;
    if (!at) return { stale: false, ageDays: null, never: true };
    const days = Math.floor((Date.now() - new Date(at).getTime()) / 86_400_000);
    return { stale: days > 10, ageDays: days, never: false };
  }, [snapshot]);

  const shown = useMemo(() => applyFilters(rows, filters), [rows, filters]);
  const s = useMemo(() => summarise(shown), [shown]);
  const extra = useMemo(() => orphans(base, snapshot?.rows ?? []), [base, snapshot]);

  const byBroker = useMemo(() => rateByBroker(shown), [shown]);
  const byOffering = useMemo(() => rateBy(shown, (r) => r.offering), [shown]);
  const byCategory = useMemo(() => rateBy(shown, (r) => r.categoryClass), [shown]);
  const byCommunity = useMemo(
    () => rateBy(shown, (r) => r.community).slice(0, 12), [shown]
  );

  // Listings the newest run found but the newest full crawl never saw — new
  // stock, or added since the last full refresh.
  const awaiting = useMemo(
    () => shown.filter((r) => r.onBayut && r.awaitingDetail).length, [shown]);

  const communities = useMemo(() => optionsFor(rows, (r) => r.community), [rows]);
  const brokers = useMemo(() => {
    const m = new Map();
    for (const r of rows) if (r.brokerId) m.set(r.brokerId, r.broker);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows]);

  const set = useCallback((k, v) => setFilters((f) => ({ ...f, [k]: v })), []);

  /**
   * Card click = filter to exactly the rows that card counted; click again to
   * clear. The table segment follows, because filtering to TruChecked and
   * leaving the table on the not-TruChecked tab would show an empty table
   * under a card reading 16.
   */
  const toggleState = useCallback((state) => {
    setFilters((f) => ({ ...f, state: f.state === state ? "" : state }));
    if (state === "truchecked" || state === "not" || state === "missing") setTab(state);
  }, []);
  const dirty = useMemo(
    () => Object.entries(filters).some(([k, v]) => v !== BLANK_FILTERS[k]), [filters]);

  const tableRows = shown.filter((r) => r.state === tab);
  // Keyed on `stage`, which is what the refresh flow sets. This read `run.status`
  // for a while, which is never populated — so every value was "not terminal"
  // and both buttons stayed disabled for the rest of the session after a single
  // refresh.
  const running = Boolean(run) && !["done", "failed"].includes(run.stage);

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">TruCheck</h1>
          <p className="text-sm text-slate-500 mt-1">
            Which of our Bayut listings carry the badge, and how complete they are.
          </p>

          {/* Two stamps, because the two halves of this screen are refreshed at
              different speeds and presenting one date for both would be a lie
              about whichever half is older. */}
          {snapshot && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-xs">
              <span className="text-slate-500">
                TruCheck as of <span className="text-slate-900 font-medium">{fmtDateTime(snapshot.scrapedAt)}</span>
              </span>
              <span className={quality.stale ? "text-amber-700" : "text-slate-500"}>
                Quality data as of{" "}
                <span className={`font-medium ${quality.stale ? "text-amber-800" : "text-slate-900"}`}>
                  {snapshot.qualityScrapedAt ? fmtDateTime(snapshot.qualityScrapedAt) : "never"}
                </span>
                {quality.stale && (
                  <span className="ml-1.5 px-1.5 py-0.5 rounded bg-amber-50 text-amber-800">
                    {quality.ageDays} days old — run a full refresh
                  </span>
                )}
                {!snapshot.qualityScrapedAt && (
                  <span className="ml-1.5 px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">
                    no full crawl yet
                  </span>
                )}
              </span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Two buttons rather than a mode dropdown: the cost difference is
              about fiftyfold, and a setting you have to check first is a setting
              somebody eventually does not check. */}
          <button onClick={() => refresh("enumerate")} disabled={running || busy}
            title="Re-reads every listing and its TruCheck badge. Quality columns keep their existing values."
            className={`flex items-center gap-2 px-3 py-2 text-sm rounded-xl border border-slate-200 bg-white
                        disabled:opacity-40 enabled:hover:bg-slate-50 enabled:hover:border-slate-300 ${running && run?.mode === "enumerate" ? "is-fetching" : ""}`}>
            <ShieldCheck className={`w-4 h-4 ${running && run?.mode === "enumerate" ? "animate-pulse" : ""}`} />
            Refresh TruCheck
          </button>
          <button onClick={() => refresh("full")} disabled={running || busy}
            title="Re-reads every listing page as well. Slower and costs more; updates photos, floor plans, video and scores."
            className={`flex items-center gap-2 px-3 py-2 text-sm rounded-xl border border-slate-900 bg-slate-900
                        text-white disabled:opacity-40 enabled:hover:bg-slate-800 ${running && run?.mode === "full" ? "is-fetching" : ""}`}>
            <RefreshCw className={`w-4 h-4 ${running && run?.mode === "full" ? "animate-spin" : ""}`} />
            Full refresh
          </button>
        </div>
      </div>

      {run && (
        <Card className={`p-4 mb-4 flex gap-3 ${run.error ? "border-rose-200 bg-rose-50" : "border-slate-200 bg-slate-50"}`}>
          {run.error ? <AlertCircle className="w-4 h-4 text-rose-600 flex-shrink-0 mt-0.5" />
            : run.stage === "done" ? <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0 mt-0.5" />
            : <Loader2 className="w-4 h-4 text-slate-400 animate-spin flex-shrink-0 mt-0.5" />}
          <div className="min-w-0 text-xs flex-1">
            {run.error ? (
              <p className="text-rose-900 font-medium">{run.error}</p>
            ) : run.stage === "done" ? (
              <p className="text-slate-700">
                {run.mode === "enumerate" ? (
                  <>Refreshed TruCheck for {fmtNum(run.enumerated)} listings. Quality data is unchanged —
                    run a full refresh to update photos, floor plans and scores.</>
                ) : (
                  <>Saved a full snapshot — {fmtNum(run.enumerated)} listings,
                    {" "}{fmtNum(run.detailed)} with quality detail
                    {run.failed > 0 && <span className="text-amber-700">, {fmtNum(run.failed)} listing pages did not return</span>}.</>
                )}
              </p>
            ) : (
              <p className="text-slate-700">
                {run.stage === "listing" && <>{run.mode === "enumerate" ? "Refreshing TruCheck" : "Listing every property"} on the Bayut account{run.listCount ? ` · ${fmtNum(run.listCount)} found` : ""}…</>}
                {run.stage === "details" && <>Reading each listing page{run.detailCount != null && run.requested ? ` · ${fmtNum(run.detailCount)} of ${fmtNum(run.requested)}` : ""}…</>}
                {run.stage === "saving" && <>Saving the snapshot…</>}
              </p>
            )}
            {run.detailWarning && (
              <p className="text-amber-700 mt-0.5">
                The detail pass could not start — {run.detailWarning}. Badges were still saved; quality columns are blank.
              </p>
            )}
            <p className="text-slate-400 mt-0.5 font-mono">
              {run.listRunId ? `list ${run.listRunId}` : ""}
              {run.detailRunId ? ` · detail ${run.detailRunId}` : ""}
              {run.usageUsd ? ` · $${Number(run.usageUsd).toFixed(3)}` : ""}
            </p>
          </div>
        </Card>
      )}

      {/*
        The count assertion, surfaced rather than swallowed.

        `expected` is how many listing URLs the detail pass was handed;
        `detailed` is how many came back. A shortfall means some pages were not
        read, which shows up downstream as blank quality columns and a lower
        average score — indistinguishable from genuinely poor listings unless
        it is said out loud here.
      */}
      {snapshot?.run && snapshot.run.expected_count != null &&
        snapshot.run.detailed_count < snapshot.run.expected_count && (
        <Problem
          title={`${fmtNum(snapshot.run.expected_count - snapshot.run.detailed_count)} listing pages were not read on the last crawl.`}
          detail={`${fmtNum(snapshot.run.detailed_count)} of ${fmtNum(snapshot.run.expected_count)} came back. Those rows show blank quality columns and no score rather than zeros.`}
          hint="Refresh to retry them. The badge status for every listing is still accurate — only the quality signals are affected." />
      )}

      {listingsError && (
        <Problem title="Couldn't load listings from PropSpace — every figure below is missing, not zero."
          detail={listingsError.message} />
      )}

      {snapshotError?.code === "NO_TABLE" ? (
        <Problem title="The TruCheck snapshot table does not exist yet."
          detail={snapshotError.detail}
          hint="Until then every listing shows as Not found on Bayut, because there is no crawl to compare against." />
      ) : snapshotError ? (
        <Problem title="Couldn't read the last TruCheck snapshot." detail={snapshotError.message} />
      ) : null}

      {!snapshot && !snapshotError && !busy && (
        <Problem title="No crawl has run yet." tone="slate"
          detail="Press Full refresh to crawl Bayut for the first time — that pass fills both the badges and the quality columns. Until then nothing can be compared, so every listing reads as Not found on Bayut."
          hint={config ? `The crawl is scoped to ${config.agency}.` : null} />
      )}

      {busy && !listings.length ? (
        <Card className="p-16 text-center">
          <Loader2 className="w-6 h-6 text-slate-300 mx-auto animate-spin" />
          <p className="text-sm text-slate-500 mt-3">Loading listings and the last snapshot…</p>
        </Card>
      ) : (
        <div className="space-y-4">
          <div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-4">
            <Kpi icon={Database} tint="bg-slate-900" label="Live on Bayut"
              value={fmtNum(s.liveOnBayut)}
              sub={`of ${fmtNum(s.total)} live in PropSpace`}
              foot="The denominator for every rate on this screen."
              onClick={() => toggleState(ON_BAYUT)} active={filters.state === ON_BAYUT} />
            <Kpi icon={ShieldCheck} tint="bg-emerald-600" label={STATE_LABEL.truchecked}
              value={fmtNum(s.truchecked)} sub={fmtPct(s.truCheckedPct)}
              onClick={() => toggleState("truchecked")} active={filters.state === "truchecked"} />
            <Kpi icon={ShieldOff} tint="bg-rose-600" label={STATE_LABEL.not}
              value={fmtNum(s.not)} sub={fmtPct(s.notPct)} foot="The action list."
              onClick={() => toggleState("not")} active={filters.state === "not"} />
            <Kpi icon={HelpCircle} tint="bg-slate-500" label={STATE_LABEL.missing}
              value={fmtNum(s.missing)}
              sub="in PropSpace, absent from the crawl"
              foot="A publishing fault, not a TruCheck one — kept out of every rate above."
              onClick={() => toggleState("missing")} active={filters.state === "missing"} />

            <Kpi icon={LayoutGrid} tint="bg-indigo-600" label="Floor plan coverage"
              value={s.floorPlanCoverage === null ? "—" : fmtPct(s.floorPlanCoverage)}
              sub={`${fmtNum(shown.filter((r) => r.hasFloorPlan).length)} of ${fmtNum(s.liveOnBayut)} on Bayut`} />
            {/* The average is over scored listings only. A listing never
                detailed has no score to average, and counting it as zero would
                drag the figure down with a number nobody measured. */}
            <Kpi icon={Gauge} tint="bg-sky-600" label="Average listing score"
              value={s.avgScore === null ? "—" : `${s.avgScore}`}
              sub={s.detailed ? `across ${fmtNum(s.detailed)} scored listings` : "no full crawl yet"}
              foot={awaiting > 0
                ? `${fmtNum(awaiting)} listing${awaiting === 1 ? "" : "s"} not yet detailed and excluded from this average.`
                : "Our completeness score, not Bayut's. Bayut's own numbers are shown per listing, separately."} />
            <Kpi icon={RefreshCw} tint="bg-slate-600" label="Last refreshed"
              value={snapshot ? fmtDate(snapshot.scrapedAt) : "never"}
              sub={snapshot ? fmtDateTime(snapshot.scrapedAt) : "press Full refresh"}
              foot={extra.length ? `${fmtNum(extra.length)} on Bayut with no PropSpace listing.` : null} />
            <Kpi icon={Image} tint="bg-slate-700" label="Detail coverage"
              value={s.liveOnBayut ? fmtPct(s.detailed / s.liveOnBayut) : "—"}
              sub={`${fmtNum(s.detailed)} of ${fmtNum(s.liveOnBayut)} pages read`}
              foot={quality.never
                ? "No full crawl has run. Every quality column is blank."
                : "Quality columns are blank on the rest — unmeasured, not zero."} />
          </div>

          <Card className="p-4">
            <div className="flex flex-wrap gap-2 items-center">
              {/* Carries the same values the cards set, so the two controls
                  never disagree about what is filtered. */}
              <select value={filters.state} onChange={(e) => toggleState(e.target.value)} className={ctrl}>
                <option value="">Every state</option>
                <option value={ON_BAYUT}>Live on Bayut (any)</option>
                <option value="truchecked">{STATE_LABEL.truchecked}</option>
                <option value="not">{STATE_LABEL.not}</option>
                <option value="missing">{STATE_LABEL.missing}</option>
              </select>
              <select value={filters.broker} onChange={(e) => set("broker", e.target.value)} className={ctrl}>
                <option value="">Every broker</option>
                {brokers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select>
              <select value={filters.offering} onChange={(e) => set("offering", e.target.value)} className={ctrl}>
                <option value="">Sale and rent</option>
                <option value="sale">Sale</option>
                <option value="rent">Rent</option>
              </select>
              <select value={filters.categoryClass} onChange={(e) => set("categoryClass", e.target.value)} className={ctrl}>
                <option value="">Every category</option>
                <option value="residential">Residential</option>
                <option value="commercial">Commercial</option>
              </select>
              <select value={filters.community} onChange={(e) => set("community", e.target.value)} className={ctrl}>
                <option value="">Every community</option>
                {communities.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              {/* A score bound excludes unscored listings entirely — they are
                  unmeasured, not zero, so they are neither above nor below it. */}
              <input type="number" min="0" max="100" value={filters.scoreFrom}
                onChange={(e) => set("scoreFrom", e.target.value)}
                placeholder="Score ≥" className={`${ctrl} w-28`} />
              <input type="number" min="0" max="100" value={filters.scoreTo}
                onChange={(e) => set("scoreTo", e.target.value)}
                placeholder="Score ≤" className={`${ctrl} w-28`} />

              <span className="text-xs text-slate-400">
                {fmtNum(shown.length)} of {fmtNum(rows.length)} listings
              </span>
              {dirty && (
                <button onClick={() => setFilters(BLANK_FILTERS)}
                  className="text-xs text-slate-500 hover:text-slate-800 px-2 py-2">Clear</button>
              )}
            </div>
          </Card>

          <div className="grid lg:grid-cols-2 gap-4">
            <RateBars title="TruCheck rate by broker"
              note="Excluded agents never rank; their listings are totalled on the last line."
              rows={byBroker.ranked} remainder={byBroker.remainder} />
            <RateBars title="By community" note="The twelve with the most listings." rows={byCommunity} />
            <RateBars title="By offering" rows={byOffering} />
            <RateBars title="By category" rows={byCategory} />
          </div>

          <Card className="p-5">
            <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
              <div className="flex rounded-xl border border-slate-200 overflow-hidden">
                {[["not", STATE_LABEL.not, s.not],
                  ["truchecked", STATE_LABEL.truchecked, s.truchecked],
                  ["missing", STATE_LABEL.missing, s.missing]].map(([k, label, n]) => (
                    <button key={k} onClick={() => setTab(k)}
                      className={`px-3 py-2 text-sm ${tab === k
                        ? "bg-slate-900 text-white font-medium" : "bg-white text-slate-600 hover:bg-slate-50"}`}>
                      {label} <span className={tab === k ? "text-slate-300" : "text-slate-400"}>{fmtNum(n)}</span>
                    </button>
                  ))}
              </div>
              <span className="text-xs text-slate-400">{fmtNum(tableRows.length)} rows</span>
            </div>
            <Table rows={tableRows} segment={tab} />
          </Card>

          {s.missing > 0 && (
            <Card className="p-4 flex gap-2.5">
              <Info className="w-4 h-4 text-slate-400 flex-shrink-0 mt-0.5" />
              <p className="text-[11px] text-slate-500 leading-relaxed">
                <span className="font-medium text-slate-700">{fmtNum(s.missing)} listings are live in PropSpace but
                absent from the Bayut crawl.</span>{" "}
                They have their own tab above rather than sitting in the TruCheck lists, because nobody can
                TruCheck a listing Bayut cannot see. That is a publishing job, not a TruCheck one — and it is
                why they are kept out of every rate on this screen.
              </p>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
