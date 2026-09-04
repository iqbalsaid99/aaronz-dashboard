import React, { useState, useEffect, useMemo } from "react";
import { Layers, RefreshCw, MapPin, BedDouble, Ruler, ShieldCheck, Building2 } from "lucide-react";
import { listingAgentOf, fmtAed } from "./listings.js";
import { apiFetch } from "./apiFetch.js";
import ReellyProjects from "./ReellyProjects.jsx";

const Card = ({ children, className = "" }) => (
  <div className={`bg-white border border-slate-200 rounded-2xl ${className}`}>{children}</div>
);

/**
 * Off-plan inventory.
 *
 * There is no reachable /projects endpoint on this API key — every variant
 * (/projects, /off-plan, /options/projects, /properties) returns the WAF's
 * 403 "Access to this resource is denied" page, and so does a deliberately
 * nonsense path, so 403 cannot distinguish "blocked" from "does not exist".
 *
 * Off-plan stock is reachable another way: /listings carries
 * `completion_status`, and the API accepts it as a filter. Live counts:
 *   off_plan_primary   3 published   (99 unpublished)
 *   off_plan_secondary 11 published  (671 unpublished)
 *
 * What this gives is off-plan LISTINGS. The project-level record a Projects
 * section would hold — developer payment plans, handover dates, unit
 * inventory — is not in this payload. `owner` is the closest thing: on
 * primary stock it is the developer ("New World Developments LLC").
 *
 * THAT GAP IS NOW FILLED FROM ELSEWHERE. The Projects view on this tab is
 * Reelly: the market-wide off-plan catalogue, with exactly the payment plans,
 * handover dates and unit inventory this endpoint cannot supply. The two are
 * kept as separate views rather than merged, because they answer different
 * questions — "what are we selling" versus "what is being sold" — and a single
 * list that silently mixes our stock with the market would be read as ours.
 */
const OFF_PLAN = ["off_plan_primary", "off_plan_secondary"];

async function fetchOffPlan({ statuses = ["published"] } = {}) {
  const out = [];
  for (const completion of OFF_PLAN) {
    for (const status of statuses) {
      for (let page = 1; page <= 10; page++) {
        const res = await apiFetch(
          `/ps/listings?per_page=100&page=${page}&status=${status}&completion_status=${completion}`
        );
        if (!res.ok) throw new Error(`listings ${res.status}`);
        const json = await res.json();
        const rows = json.data ?? [];
        if (!rows.length) break;
        out.push(...rows.map((r) => ({ ...r, completion, status })));
        if (rows.length < 100) break;
      }
    }
  }
  return out.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

const KIND = {
  off_plan_primary: { label: "Primary", hint: "direct from developer", tint: "bg-indigo-50 text-indigo-700 ring-indigo-200" },
  off_plan_secondary: { label: "Secondary", hint: "off-plan resale", tint: "bg-sky-50 text-sky-700 ring-sky-200" },
};

function Project({ l }) {
  const [imgFailed, setImgFailed] = useState(false);
  const cover = (l.images ?? [])[0]?.url;
  const kind = KIND[l.completion] ?? KIND.off_plan_secondary;
  // Descriptions come through as HTML; strip tags for the plain-text summary.
  const blurb = (l.description ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

  return (
    <Card className="overflow-hidden">
      <div className="sm:flex">
        {cover && !imgFailed ? (
          <img src={cover} alt="" loading="lazy" decoding="async"
            onError={() => setImgFailed(true)}
            className="sm:w-72 h-48 sm:h-auto object-cover bg-slate-100 flex-shrink-0" />
        ) : (
          <div className="sm:w-72 h-48 bg-slate-100 flex items-center justify-center flex-shrink-0">
            <Building2 className="w-8 h-8 text-slate-300" />
          </div>
        )}

        <div className="p-5 min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`text-[11px] font-medium px-2 py-0.5 rounded-lg ring-1 ${kind.tint}`}>
                  {kind.label}
                </span>
                <span className="text-[11px] text-slate-500">{kind.hint}</span>
                <span className="text-[11px] text-slate-400 font-mono">{l.ref}</span>
              </div>
              <p className="text-base font-semibold text-slate-900 mt-1.5">{l.name}</p>
              <p className="text-sm text-slate-500 flex items-center gap-1 mt-0.5">
                <MapPin className="w-3.5 h-3.5 flex-shrink-0" />
                {[l.sub_area_location?.name, l.area_location?.name, l.region?.name]
                  .filter(Boolean).join(", ")}
              </p>
            </div>
            <p className="text-xl font-bold text-slate-900 whitespace-nowrap">{fmtAed(l.price)}</p>
          </div>

          <div className="flex flex-wrap gap-x-5 gap-y-1.5 mt-3 text-xs text-slate-600">
            <span className="flex items-center gap-1.5">
              <Building2 className="w-3.5 h-3.5 text-slate-400" />{l.category}
            </span>
            <span className="flex items-center gap-1.5">
              <BedDouble className="w-3.5 h-3.5 text-slate-400" />{l.beds} bed · {l.baths} bath
            </span>
            <span className="flex items-center gap-1.5">
              <Ruler className="w-3.5 h-3.5 text-slate-400" />{Math.round(l.size).toLocaleString()} sqft
            </span>
            {l.permit_number && (
              <span className="flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5 text-slate-400" />Permit {l.permit_number}
              </span>
            )}
          </div>

          {blurb && <p className="text-xs text-slate-500 mt-3 line-clamp-2">{blurb.slice(0, 220)}…</p>}

          <div className="flex flex-wrap gap-x-6 gap-y-1 mt-4 pt-3 border-t border-slate-100 text-xs">
            <span className="text-slate-500">
              Developer / owner{" "}
              <span className="text-slate-900 font-medium">{l.owner?.name || "—"}</span>
            </span>
            <span className="text-slate-500">
              Agent <span className="text-slate-900 font-medium">{listingAgentOf(l)}</span>
            </span>
            <span className="text-slate-500">
              Unit <span className="text-slate-900 font-medium">{l.unit_number || "—"}</span>
            </span>
            <span className="text-slate-500">
              Listed <span className="text-slate-900 font-medium">{l.created_at.slice(0, 10)}</span>
            </span>
          </div>

          {(l.portals ?? []).length > 0 && (
            <p className="text-[11px] text-slate-400 mt-2">
              Advertised on {l.portals.join(", ")}
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}

function OurListings() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [kind, setKind] = useState("all");

  async function load() {
    setLoading(true); setError(null);
    try { setRows(await fetchOffPlan()); }
    catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const shown = useMemo(
    () => kind === "all" ? rows : rows.filter((r) => r.completion === kind),
    [rows, kind]
  );
  const primary = rows.filter((r) => r.completion === "off_plan_primary").length;

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4 mb-4">
        <p className="text-sm text-slate-500">
          {rows.length} live off-plan listing{rows.length === 1 ? "" : "s"} · {primary} primary ·{" "}
          {rows.length - primary} secondary
        </p>
        <div className="flex items-center gap-2">
          <div className="flex rounded-xl border border-slate-200 overflow-hidden">
            {[["all", "All"], ["off_plan_primary", "Primary"], ["off_plan_secondary", "Secondary"]]
              .map(([k, label]) => (
                <button key={k} onClick={() => setKind(k)}
                  className={`px-3 py-2 text-sm ${kind === k
                    ? "bg-slate-900 text-white font-medium" : "bg-white text-slate-600 hover:bg-slate-50"}`}>
                  {label}
                </button>
              ))}
          </div>
          <button onClick={load} disabled={loading}
            className={`p-2 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-50 ${
              loading ? "is-fetching" : ""}`}>
            <RefreshCw className={`w-4 h-4 text-slate-600 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {error && (
        <Card className="p-6 border-amber-200 bg-amber-50 mb-4">
          <p className="text-sm font-medium text-amber-900">Couldn't load off-plan listings</p>
          <p className="text-xs text-amber-700 mt-1 font-mono break-all">{error}</p>
        </Card>
      )}

      {loading && !rows.length && (
        <Card className="p-6"><p className="text-sm text-slate-500">Loading off-plan stock…</p></Card>
      )}

      <div className="space-y-4">
        {shown.map((l) => <Project key={l.id} l={l} />)}
        {!loading && !shown.length && !error && (
          <Card className="p-8 text-center">
            <Layers className="w-8 h-8 text-slate-300 mx-auto" />
            <p className="text-sm text-slate-500 mt-3">No live off-plan listings in this filter.</p>
          </Card>
        )}
      </div>

      <p className="text-xs text-slate-400 mt-6">
        Pulled from <span className="font-mono">/listings</span> filtered on{" "}
        <span className="font-mono">completion_status</span>, because this API key cannot reach a
        projects endpoint — every path tried returns the same 403 the WAF gives any unlisted route.
        These are off-plan <em>listings</em>; project-level detail such as payment plans, handover
        dates and unit inventory is not in this payload. Only published stock is shown — there are a
        further 770 off-plan records sitting unpublished.
      </p>
    </div>
  );
}


/* ------------------------------- the tab -------------------------------- */

const VIEWS = [
  ["projects", "Projects", "The market — every off-plan project Reelly tracks in the UAE"],
  ["listings", "Our listings", "Our own off-plan stock, from PropSpace"],
];

/** One icon per view, so the tab strip does not need a chain of ternaries. */
const VIEW_ICON = { projects: Building2, listings: Layers };

/**
 * Off-plan, in two halves.
 *
 * Projects leads because it is the one an agent reaches for with a buyer in
 * front of them: the whole market, searchable, with payment plans attached.
 * Our listings is the smaller, inward-facing half — fourteen published records
 * — and it was the entire tab until Reelly filled in the project-level data
 * PropSpace has never carried.
 */
export default function OffPlan() {
  const [view, setView] = useState("projects");
  const note = VIEWS.find(([k]) => k === view)?.[2];

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Off-plan</h1>
        <p className="text-sm text-slate-500 mt-1">{note}</p>
      </div>

      <div className="flex flex-wrap gap-1 mb-5 border-b border-slate-200">
        {VIEWS.map(([k, label]) => (
          <button key={k} onClick={() => setView(k)}
            className={`flex items-center gap-1.5 px-3 py-2 text-sm -mb-px border-b-2 ${view === k
              ? "border-slate-900 text-slate-900 font-medium"
              : "border-transparent text-slate-500 hover:bg-slate-50 hover:text-slate-700 hover:border-slate-300"}`}>
            {React.createElement(VIEW_ICON[k] ?? Layers, { className: "w-4 h-4" })}
            {label}
          </button>
        ))}
      </div>

      {view === "projects" ? <ReellyProjects /> : <OurListings />}
    </div>
  );
}
