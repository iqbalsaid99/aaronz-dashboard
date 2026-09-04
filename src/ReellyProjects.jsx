import React, { useState, useEffect, useMemo, useCallback } from "react";
import {
  Loader2, AlertCircle, RefreshCw, Search, Building2, MapPin, Ruler,
  CalendarClock, ChevronLeft, ChevronRight, ArrowLeft, ShieldCheck, Layers,
  Wallet, FileText, ExternalLink, BedDouble, Info,
} from "lucide-react";
import {
  fetchProjects, fetchProject,
  ORDERINGS, SALE_STATUSES, CONSTRUCTION_STATUSES, UNIT_TYPES, PAGE_SIZE,
  quarterOptions, priceRange, sizeRange, fmtNum, fmtDate, fmtMoney, pageCount,
} from "./reelly.js";

/**
 * The off-plan project catalogue, from Reelly.
 *
 * This is the MARKET, not our stock — every off-plan project Reelly tracks in
 * the UAE, with the developer, handover date, payment plan and escrow number
 * an agent needs when a buyer asks about something we are not listing. The
 * other half of this tab is our own off-plan listings from PropSpace, and the
 * two are deliberately kept apart: confusing "projects being sold" with
 * "projects we are selling" is the one mistake this screen must not invite.
 *
 * EVERY FILTER HERE WAS MEASURED, NOT READ. Reelly's docs warn that some
 * declared filters do nothing and silently return the whole dataset. Three of
 * them do exactly that — see FILTERS in reellyParse.js — so they are not
 * offered: a control that appears to work and does not is worse than an absent
 * one. Notably the quarter picker is wired to completion_date_ranges, because
 * completion_quarters, the parameter named for the job, returns nothing at all.
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

const SALE_TINT = {
  on_sale: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  out_of_stock: "bg-slate-100 text-slate-600 ring-slate-200",
};

const Empty = ({ children }) => (
  <p className="text-xs text-slate-400 py-6 text-center">{children}</p>
);

/** Errors carry the upstream status, because 404 and 502 want different action. */
function ErrorCard({ error, onRetry }) {
  return (
    <Card className="p-5 border-amber-200 bg-amber-50 flex gap-3">
      <AlertCircle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-amber-900">
          {error.message}
          {error.status ? <span className="font-mono font-normal"> · HTTP {error.status}</span> : null}
        </p>
        {error.detail && <p className="text-xs text-amber-700 mt-1 break-words">{error.detail}</p>}
        <p className="text-xs text-amber-700 mt-1">
          {error.status === 503
            ? "REELLY_API_KEY is not set on this deployment — a settings change, not something fixable from this screen."
            : error.status >= 500
              ? "Reelly's own API. Usually transient, so try again before anything else."
              : "Check the filters above; the request was rejected rather than empty."}
        </p>
      </div>
      {onRetry && (
        <button onClick={onRetry}
          className="text-xs px-2.5 py-1.5 rounded-lg border border-amber-300 bg-white text-amber-800 h-fit flex-shrink-0
                     hover:bg-amber-100 hover:border-amber-400">
          Retry
        </button>
      )}
    </Card>
  );
}

/* -------------------------------- the card ------------------------------ */

function ProjectCard({ p, onOpen }) {
  const [failed, setFailed] = useState(false);
  const price = priceRange(p.minPrice, p.maxPrice, p.currency);
  const size = sizeRange(p.minSize, p.maxSize, p.areaUnit);
  const where = [p.district, p.region].filter(Boolean).join(", ");

  return (
    <button type="button" onClick={() => onOpen(p)}
      className="text-left bg-white border border-slate-200 rounded-2xl overflow-hidden flex flex-col
                 hover:border-slate-300 hover:shadow-sm focus:outline-none focus-visible:ring-2
                 focus-visible:ring-indigo-300 transition">
      {p.cover && !failed ? (
        <img src={p.cover} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)}
          className="h-40 w-full object-cover bg-slate-100" />
      ) : (
        <div className="h-40 w-full bg-slate-100 flex items-center justify-center">
          <Building2 className="w-8 h-8 text-slate-300" />
        </div>
      )}

      <div className="p-4 flex-1 flex flex-col min-w-0">
        <div className="flex items-start gap-2 justify-between">
          <p className="text-sm font-semibold text-slate-900 leading-snug line-clamp-2">{p.name}</p>
          {p.saleStatusLabel && (
            <span className={`text-[11px] px-2 py-0.5 rounded-lg ring-1 flex-shrink-0 ${
              SALE_TINT[p.saleStatus] ?? "bg-slate-100 text-slate-600 ring-slate-200"}`}>
              {p.saleStatusLabel}
            </span>
          )}
        </div>

        <p className="text-xs text-slate-500 mt-1 truncate">{p.developer ?? "Developer unknown"}</p>

        {where && (
          <p className="text-xs text-slate-500 flex items-center gap-1 mt-1.5 truncate">
            <MapPin className="w-3.5 h-3.5 flex-shrink-0 text-slate-400" />{where}
          </p>
        )}

        <p className="text-base font-bold text-slate-900 mt-2.5">
          {/* Four of the 49 live projects carry min_price 0, which means "not
              published", not "free" — so no figure at all rather than AED 0. */}
          {price ?? <span className="text-sm font-medium text-slate-400">Price on application</span>}
        </p>

        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px] text-slate-500">
          {size && (
            <span className="flex items-center gap-1">
              <Ruler className="w-3 h-3 text-slate-400" />{size}
            </span>
          )}
          {p.completionLabel && (
            <span className="flex items-center gap-1">
              <CalendarClock className="w-3 h-3 text-slate-400" />{p.completionLabel}
            </span>
          )}
        </div>

        {p.unitTypes.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-3 pt-3 border-t border-slate-100">
            {p.unitTypes.slice(0, 4).map((t) => <Chip key={t}>{t}</Chip>)}
          </div>
        )}
      </div>
    </button>
  );
}

/* ------------------------------- the detail ----------------------------- */

const Stat = ({ label, value }) =>
  value === null || value === undefined || value === "" ? null : (
    <div>
      <p className="text-[11px] text-slate-400">{label}</p>
      <p className="text-sm text-slate-900 font-medium mt-0.5">{value}</p>
    </div>
  );

function PaymentPlan({ plan }) {
  const steps = plan.steps.filter((s) => s.name || s.percentage != null);
  const total = steps.reduce((sum, s) => sum + (s.percentage ?? 0), 0);

  return (
    <div className="border border-slate-200 rounded-xl p-4">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-medium text-slate-900">{plan.name}</p>
        {total > 0 && <span className="text-[11px] text-slate-400 tabular-nums">{total}% accounted</span>}
      </div>

      {steps.length ? (
        /* One tile per stage rather than one bar per stage: the three shares of
           a plan are read against each other, and side-by-side numbers compare
           faster than stacked bars — and the stage name gets room to wrap
           instead of truncating. */
        <div className="mt-3 grid grid-cols-3 gap-2">
          {steps.map((s, i) => (
            <div key={s.id ?? i}
              className="rounded-lg bg-slate-50 border border-slate-100 px-3 py-2.5">
              <p className="text-lg font-semibold text-indigo-600 tabular-nums leading-none">
                {s.percentage != null ? `${s.percentage}%` : "—"}
              </p>
              <p className="text-[11px] text-slate-600 mt-1.5 leading-snug">
                {s.name ?? "—"}
              </p>
            </div>
          ))}
        </div>
      ) : (
        <Empty>This plan has no steps recorded.</Empty>
      )}

      {plan.monthsAfterHandover ? (
        <p className="text-[11px] text-slate-400 mt-3">
          {plan.monthsAfterHandover} months post-handover.
        </p>
      ) : null}
    </div>
  );
}

function Detail({ id, onBack }) {
  const [p, setP] = useState(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    (async () => {
      setBusy(true); setError(null);
      try {
        const d = await fetchProject(id);
        if (alive) setP(d);
      } catch (err) {
        if (alive) setError({ message: err.message, status: err.status, detail: err.detail });
      } finally {
        if (alive) setBusy(false);
      }
    })();
    return () => { alive = false; };
  }, [id, nonce]);

  const back = (
    <button onClick={onBack}
      className="flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900 mb-4">
      <ArrowLeft className="w-4 h-4" />Back to catalogue
    </button>
  );

  if (busy) {
    return (
      <div>{back}
        <Card className="p-16 text-center">
          <Loader2 className="w-6 h-6 text-slate-300 mx-auto animate-spin" />
          <p className="text-sm text-slate-500 mt-3">Loading project…</p>
        </Card>
      </div>
    );
  }

  if (error) {
    return <div>{back}<ErrorCard error={error} onRetry={() => setNonce((n) => n + 1)} /></div>;
  }

  const price = priceRange(p.minPrice, p.maxPrice, p.currency);
  const size = sizeRange(p.minSize, p.maxSize, p.areaUnit);
  const where = [p.district, p.sector, p.region].filter(Boolean).join(", ");

  return (
    <div>
      {back}

      <Card className="overflow-hidden mb-4">
        {p.cover && (
          <img src={p.cover} alt="" className="w-full h-56 object-cover bg-slate-100" />
        )}
        <div className="p-5">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                {p.saleStatusLabel && (
                  <span className={`text-[11px] px-2 py-0.5 rounded-lg ring-1 ${
                    SALE_TINT[p.saleStatus] ?? "bg-slate-100 text-slate-600 ring-slate-200"}`}>
                    {p.saleStatusLabel}
                  </span>
                )}
                {p.constructionStatusLabel && <Chip>{p.constructionStatusLabel}</Chip>}
              </div>
              <h2 className="text-xl font-bold text-slate-900 mt-2">{p.name}</h2>
              <p className="text-sm text-slate-500 mt-0.5">{p.developer ?? "Developer unknown"}</p>
              {where && (
                <p className="text-sm text-slate-500 flex items-center gap-1 mt-1">
                  <MapPin className="w-3.5 h-3.5 text-slate-400" />{where}
                </p>
              )}
            </div>
            <p className="text-2xl font-bold text-slate-900 whitespace-nowrap">
              {price ?? <span className="text-base font-medium text-slate-400">Price on application</span>}
            </p>
          </div>

          {p.blurb && <p className="text-sm text-slate-600 mt-4">{p.blurb}</p>}

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-5 pt-4 border-t border-slate-100">
            <Stat label="Handover" value={p.completionLabel} />
            <Stat label="Sizes" value={size} />
            <Stat label="Units" value={p.unitsCount ? fmtNum(p.unitsCount) : null} />
            <Stat label="Buildings" value={p.buildingCount ? fmtNum(p.buildingCount) : null} />
            <Stat label="Service charge" value={p.serviceCharge} />
            <Stat label="Furnishing" value={p.furnishing} />
            <Stat label="Construction" value={p.readiness != null ? `${p.readiness}% complete` : null} />
            <Stat label="Updated" value={p.updatedAt ? fmtDate(p.updatedAt) : null} />
          </div>

          {/* Escrow and post-handover exist ONLY on this endpoint — the card in
              the grid cannot know them, which is why they are not shown there. */}
          <div className="flex flex-wrap gap-2 mt-4">
            {p.escrowNumber && (
              <Chip tint="bg-emerald-50 text-emerald-700">
                <ShieldCheck className="w-3 h-3 inline mr-1 -mt-0.5" />Escrow {p.escrowNumber}
              </Chip>
            )}
            {p.postHandover === true && <Chip tint="bg-indigo-50 text-indigo-700">Post-handover plan</Chip>}
            {p.brochure && (
              <a href={p.brochure} target="_blank" rel="noreferrer"
                className="text-[11px] px-1.5 py-0.5 rounded bg-slate-100 text-indigo-700 hover:bg-slate-200
                           inline-flex items-center gap-1">
                <FileText className="w-3 h-3" />Brochure<ExternalLink className="w-3 h-3" />
              </a>
            )}
          </div>
        </div>
      </Card>

      <div className="grid lg:grid-cols-2 gap-4">
        <Card className="p-5">
          <p className="text-sm font-semibold text-slate-900 mb-4 flex items-center gap-2">
            <Wallet className="w-4 h-4 text-slate-400" />Payment plans
          </p>
          {p.paymentPlans.length ? (
            <div className="space-y-3">
              {p.paymentPlans.map((plan, i) => <PaymentPlan key={plan.id ?? i} plan={plan} />)}
            </div>
          ) : (
            <Empty>No payment plan recorded for this project.</Empty>
          )}
        </Card>

        <Card className="p-5">
          <p className="text-sm font-semibold text-slate-900 mb-4 flex items-center gap-2">
            <BedDouble className="w-4 h-4 text-slate-400" />Typical units
          </p>
          {p.typicalUnits.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                    <th className="py-2 font-medium">Beds</th>
                    <th className="py-2 font-medium">From</th>
                    <th className="py-2 font-medium">To</th>
                    <th className="py-2 font-medium">Size</th>
                  </tr>
                </thead>
                <tbody>
                  {p.typicalUnits.map((u, i) => (
                    <tr key={i} className="border-b border-slate-100 last:border-0">
                      <td className="py-2 text-slate-900">{u.bedrooms ?? "—"}</td>
                      <td className="py-2 text-slate-600">{fmtMoney(u.fromPrice, p.currency) ?? "—"}</td>
                      <td className="py-2 text-slate-600">{fmtMoney(u.toPrice, p.currency) ?? "—"}</td>
                      <td className="py-2 text-slate-600">{sizeRange(u.fromSize, u.toSize, p.areaUnit) ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>No unit breakdown recorded.</Empty>
          )}
        </Card>
      </div>

      {(p.amenities.length > 0 || p.buildings.length > 0) && (
        <div className="grid lg:grid-cols-2 gap-4 mt-4">
          {p.amenities.length > 0 && (
            <Card className="p-5">
              <p className="text-sm font-semibold text-slate-900 mb-3">Amenities</p>
              <div className="flex flex-wrap gap-1.5">
                {p.amenities.map((a, i) => <Chip key={`${a}-${i}`}>{a}</Chip>)}
              </div>
            </Card>
          )}
          {p.buildings.length > 0 && (
            <Card className="p-5">
              <p className="text-sm font-semibold text-slate-900 mb-3 flex items-center gap-2">
                <Layers className="w-4 h-4 text-slate-400" />Buildings
              </p>
              <div className="space-y-2">
                {p.buildings.map((b, i) => (
                  <div key={b.id ?? i} className="text-xs">
                    <p className="text-slate-900 font-medium">
                      {b.name ?? "Building"}
                      {b.floors ? <span className="text-slate-400 font-normal"> · {b.floors} floors</span> : null}
                      {b.type ? <span className="text-slate-400 font-normal"> · {b.type}</span> : null}
                    </p>
                    {b.description && <p className="text-slate-500 mt-0.5">{b.description}</p>}
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      )}

      {p.overview && (
        <Card className="p-5 mt-4">
          <p className="text-sm font-semibold text-slate-900 mb-2">Overview</p>
          <p className="text-sm text-slate-600 whitespace-pre-line">{p.overview}</p>
        </Card>
      )}
    </div>
  );
}

/* ------------------------------- the catalogue -------------------------- */

const BLANK = {
  search_query: "", sale_status: "", status: "", unit_bedrooms: "",
  unit_types: "", unit_price_from: "", unit_price_to: "",
  completion_date_ranges: "", has_escrow: "", post_handover: "",
};

export default function ReellyProjects() {
  const [openId, setOpenId] = useState(null);

  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState(BLANK);
  const [ordering, setOrdering] = useState(ORDERINGS[0][0]);
  const [page, setPage] = useState(1);
  const [nonce, setNonce] = useState(0);

  const [data, setData] = useState({ count: 0, projects: [], hasNext: false, hasPrevious: false });
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState(null);

  const quarters = useMemo(() => quarterOptions(), []);

  // Debounced, so typing "Emaar" is one request rather than five.
  useEffect(() => {
    const t = setTimeout(() => {
      setFilters((f) => (f.search_query === search ? f : { ...f, search_query: search }));
    }, 350);
    return () => clearTimeout(t);
  }, [search]);

  // Any change to what is being asked for returns to the first page. Staying
  // on page 3 of a narrower result set is how you land on an empty grid that
  // looks like "no matches".
  useEffect(() => { setPage(1); }, [filters, ordering]);

  useEffect(() => {
    let alive = true;
    (async () => {
      setBusy(true); setError(null);
      try {
        const res = await fetchProjects({ page, ordering, filters });
        if (alive) setData(res);
      } catch (err) {
        if (alive) {
          setError({ message: err.message, status: err.status, detail: err.detail });
          setData({ count: 0, projects: [], hasNext: false, hasPrevious: false });
        }
      } finally {
        if (alive) setBusy(false);
      }
    })();
    return () => { alive = false; };
  }, [page, ordering, filters, nonce]);

  const set = useCallback((k, v) => setFilters((f) => ({ ...f, [k]: v })), []);

  const dirty = useMemo(
    () => Object.entries(filters).some(([k, v]) => v !== BLANK[k]),
    [filters]
  );

  const reset = () => { setSearch(""); setFilters(BLANK); setOrdering(ORDERINGS[0][0]); };

  if (openId != null) return <Detail id={openId} onBack={() => setOpenId(null)} />;

  const pages = pageCount(data.count);

  return (
    <div>
      <Card className="p-4 mb-4">
        <div className="flex flex-wrap gap-2 items-center">
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Project, developer or area"
              className={`${ctrl} pl-9 w-64`} />
          </div>

          <select value={filters.sale_status} onChange={(e) => set("sale_status", e.target.value)} className={ctrl}>
            <option value="">Any sale status</option>
            {SALE_STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>

          <select value={filters.status} onChange={(e) => set("status", e.target.value)} className={ctrl}>
            <option value="">Any construction status</option>
            {CONSTRUCTION_STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>

          <select value={filters.unit_bedrooms} onChange={(e) => set("unit_bedrooms", e.target.value)} className={ctrl}>
            <option value="">Any beds</option>
            {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n} bed</option>)}
          </select>

          <select value={filters.unit_types} onChange={(e) => set("unit_types", e.target.value)} className={ctrl}>
            <option value="">Any unit type</option>
            {UNIT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>

          <select value={filters.completion_date_ranges}
            onChange={(e) => set("completion_date_ranges", e.target.value)} className={ctrl}>
            <option value="">Any handover</option>
            {quarters.map((q) => <option key={q.value} value={q.value}>{q.label}</option>)}
          </select>

          <input type="number" min="0" step="100000" value={filters.unit_price_from}
            onChange={(e) => set("unit_price_from", e.target.value)}
            placeholder="Min AED" className={`${ctrl} w-32`} />
          <input type="number" min="0" step="100000" value={filters.unit_price_to}
            onChange={(e) => set("unit_price_to", e.target.value)}
            placeholder="Max AED" className={`${ctrl} w-32`} />

          <select value={filters.has_escrow} onChange={(e) => set("has_escrow", e.target.value)} className={ctrl}>
            <option value="">Escrow, any</option>
            <option value="true">Has escrow</option>
            <option value="false">No escrow</option>
          </select>

          <select value={filters.post_handover} onChange={(e) => set("post_handover", e.target.value)} className={ctrl}>
            <option value="">Post-handover, any</option>
            <option value="true">Post-handover plan</option>
            <option value="false">No post-handover</option>
          </select>

          <span className="flex-1" />

          <select value={ordering} onChange={(e) => setOrdering(e.target.value)} className={ctrl}>
            {ORDERINGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>

          {dirty && (
            <button onClick={reset} className="text-xs text-slate-500 hover:text-slate-800 px-2 py-2">
              Clear
            </button>
          )}

          <button onClick={() => setNonce((n) => n + 1)} disabled={busy}
            className={`flex items-center gap-2 px-3 py-2 text-sm rounded-xl border border-slate-200 bg-white
                        disabled:opacity-40 enabled:hover:bg-slate-50 enabled:hover:border-slate-300 ${busy ? "is-fetching" : ""}`}>
            <RefreshCw className={`w-4 h-4 ${busy ? "animate-spin" : ""}`} />Refresh
          </button>
        </div>

        <p className="text-[11px] text-slate-400 mt-3 flex items-start gap-1.5">
          <Info className="w-3.5 h-3.5 flex-shrink-0 mt-px" />
          Only filters verified to work against the live API are shown. Reelly declares several more —
          bedrooms, completion_quarters and districts among them — that silently return the full
          dataset or nothing at all, so they are deliberately absent rather than present and wrong.
        </p>
      </Card>

      {error && <div className="mb-4"><ErrorCard error={error} onRetry={() => setNonce((n) => n + 1)} /></div>}

      {busy && !data.projects.length ? (
        <Card className="p-16 text-center">
          <Loader2 className="w-6 h-6 text-slate-300 mx-auto animate-spin" />
          <p className="text-sm text-slate-500 mt-3">Loading projects…</p>
        </Card>
      ) : !data.projects.length && !error ? (
        <Card className="p-12 text-center">
          <Building2 className="w-8 h-8 text-slate-300 mx-auto" />
          <p className="text-sm text-slate-500 mt-3">No projects match those filters.</p>
          {dirty && (
            <button onClick={reset} className="text-xs text-indigo-600 hover:text-indigo-800 mt-2">
              Clear filters
            </button>
          )}
        </Card>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3 mb-3">
            <p className="text-xs text-slate-500">
              {fmtNum(data.count)} project{data.count === 1 ? "" : "s"}
              {data.count > PAGE_SIZE && <> · page {page} of {pages}</>}
            </p>
          </div>

          <div className={`grid sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4 ${
            busy ? "opacity-60" : ""}`}>
            {data.projects.map((p) => (
              <ProjectCard key={p.id} p={p} onOpen={(x) => setOpenId(x.id)} />
            ))}
          </div>

          {pages > 1 && (
            <div className="flex items-center justify-center gap-2 mt-6">
              <button onClick={() => setPage((n) => Math.max(1, n - 1))}
                disabled={!data.hasPrevious || busy}
                className="flex items-center gap-1 px-3 py-2 text-sm rounded-xl border border-slate-200
                           bg-white disabled:opacity-40 enabled:hover:bg-slate-50 enabled:hover:border-slate-300">
                <ChevronLeft className="w-4 h-4" />Previous
              </button>
              <span className="text-xs text-slate-500 px-2 tabular-nums">{page} / {pages}</span>
              <button onClick={() => setPage((n) => n + 1)}
                disabled={!data.hasNext || busy}
                className="flex items-center gap-1 px-3 py-2 text-sm rounded-xl border border-slate-200
                           bg-white disabled:opacity-40 enabled:hover:bg-slate-50 enabled:hover:border-slate-300">
                Next<ChevronRight className="w-4 h-4" />
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
