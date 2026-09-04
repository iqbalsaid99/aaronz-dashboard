import React, { useState, useEffect, useMemo } from "react";
import {
  RefreshCw, Wallet, Eye, Building2, CheckCircle2, AlertTriangle,
  Clock, UserX, Mail, Phone, X, Pencil,
} from "lucide-react";
import {
  fetchLeads, statusOf, isCold, isStatusOnly, isUntouched,
  hoursToFirstTouch, fmtHours, humanNotes, firstTouchAt, listingOf, fmtPrice,
  prefetch, DEFAULT_DAYS, NOT_CONTACTED, fetchAgentLeads,
} from "./propspace.js";
import { fetchLiveListings, fmtAed, portalMeta, faviconUrl } from "./listings.js";
import { initialsOf, photoFocus } from "./agents.js";
import { fetchCrmAgents, isRankedLead, isRankedListing } from "./crmAgents.js";
import {
  buildRoster, matchBillings, sortRoster, BROKER_COLS, TIER_META, VIEWING_TIERS,
  fmtMoney, fmtMoneyExact, fmtDateTime, cleanNote, claimsViewing, summariseViewings,
  billedInRange, billedToDate,
  loadLocalBillings, saveLocalBillings,
} from "./brokers.js";
import DateRange, { resolveRange, rangeCaption, spanDays } from "./DateRange.jsx";
import { dubaiRange } from "./time.js";

/**
 * How far back to look for viewings, on top of the selected range.
 *
 * 120 days covers 102 of the 125 viewings on the live book — the widest preset
 * on this screen is 90 days, and a lead older than four months with a viewing
 * this week is rare enough not to justify the requests. Raising it costs one
 * request per extra 100 leads.
 */
const VIEWING_LOOKBACK_DAYS = 120;

const PRESETS = [
  ["today", "Today"],
  ["7", "Last 7 days"],
  ["30", "Last 30 days"],
  ["90", "Last 90 days"],
];

const Card = ({ children, className = "" }) => (
  <div className={`bg-white border border-slate-200 rounded-2xl ${className}`}>{children}</div>
);

function Avatar({ name, photo, size = "w-8 h-8", textClass = "text-[11px]" }) {
  const [failed, setFailed] = useState(false);
  if (photo && !failed) {
    return (
      <img src={photo} alt="" loading="lazy" onError={() => setFailed(true)}
        style={{ objectPosition: photoFocus(name) }}
        className={`${size} rounded-full object-cover bg-slate-100 flex-shrink-0`} />
    );
  }
  return (
    <span className={`${size} ${textClass} rounded-full bg-slate-200 text-slate-600 font-semibold
                      flex items-center justify-center flex-shrink-0`}>
      {initialsOf(name)}
    </span>
  );
}

const Stat = ({ icon: Icon, tint, label, value, sub, alert, valueClass = "text-3xl" }) => (
  <Card className="p-4">
    <div className="flex items-start justify-between">
      <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${tint}`}>
        <Icon className="w-4 h-4" strokeWidth={2} />
      </div>
      {alert && (
        <span className="text-[11px] font-medium px-2 py-0.5 rounded-lg bg-rose-50 text-rose-700">{alert}</span>
      )}
    </div>
    <p className="mt-3 text-xs font-medium text-slate-600">{label}</p>
    <p className={`mt-1.5 ${valueClass} font-bold text-slate-900 tracking-tight tabular-nums`}>{value}</p>
    {sub && <p className="mt-1.5 text-[11px] text-slate-500 leading-relaxed">{sub}</p>}
  </Card>
);

/** Target vs billed vs actual, as one bar. Empty until the sheet arrives. */
function BillingBar({ billing, currency }) {
  if (!billing) return <span className="text-slate-300 text-xs">—</span>;
  const { target, billed, actual } = billing;
  if (!target) {
    return (
      <span className="text-xs text-slate-600">
        {fmtMoney(actual ?? billed, currency)}
        {actual != null && billed != null && actual !== billed && (
          <span className="text-slate-400"> of {fmtMoney(billed, currency)}</span>
        )}
      </span>
    );
  }
  const pctBilled = Math.min(1, (billed ?? 0) / target);
  const pctActual = Math.min(1, (actual ?? 0) / target);
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden relative min-w-[60px]">
        <div className="h-full rounded-full bg-indigo-200 absolute inset-y-0 left-0"
          style={{ width: `${pctBilled * 100}%` }} title={`Billed ${fmtMoney(billed, currency)}`} />
        <div className={`h-full rounded-full absolute inset-y-0 left-0 ${
            pctActual >= 1 ? "bg-emerald-500" : pctActual > 0.6 ? "bg-indigo-500" : "bg-amber-500"}`}
          style={{ width: `${pctActual * 100}%` }} title={`Actual ${fmtMoney(actual, currency)}`} />
      </div>
      <span className="text-xs text-slate-500 w-9 text-right flex-shrink-0">
        {Math.round(pctActual * 100)}%
      </span>
    </div>
  );
}

/**
 * The label is the thing being measured, so it is never cut off: these read
 * "propertyfinder.ae · whatsapp" and at a fixed 10rem truncated to
 * "propertyfinder.ae.Wha…". Wider column, wrapping instead of truncating, and
 * the bar keeps the whole remaining width out to the right edge.
 */
const Bar = ({ label, count, total, tint = "bg-slate-300", danger }) => (
  <div className="flex items-start gap-3">
    <span className={`text-xs w-52 flex-shrink-0 break-words leading-snug ${
      danger ? "text-rose-700 font-medium" : "text-slate-600"}`}>{label}</span>
    <div className="flex-1 h-2 mt-1 bg-slate-100 rounded-full overflow-hidden">
      <div className={`h-full rounded-full ${danger ? "bg-rose-400" : tint}`}
        style={{ width: `${total ? (count / total) * 100 : 0}%` }} />
    </div>
    <span className="text-xs text-slate-500 w-8 text-right flex-shrink-0 mt-0.5">{count}</span>
  </div>
);

/* --------------------------- billings editor --------------------------- */

/**
 * Lets the numbers be keyed in before the sheet exists. Saved to localStorage,
 * which is per-browser — the same limitation as the Equipment register, and
 * called out here rather than left to be discovered.
 */
function BillingsEditor({ broker, currency, value, onSave, onClose }) {
  const [form, setForm] = useState({
    target: value?.target ?? "", billed: value?.billed ?? "",
    actual: value?.actual ?? "", deals: value?.deals ?? "", notes: value?.notes ?? "",
  });

  const field = (k, label, hint) => (
    <label className="block">
      <span className="text-xs font-medium text-slate-700">{label}</span>
      {hint && <span className="block text-[11px] text-slate-400 mb-1">{hint}</span>}
      <input type="number" inputMode="decimal" value={form[k]}
        onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))}
        className="mt-1 w-full text-sm border border-slate-200 rounded-xl px-3 py-2 outline-none
                   focus:border-indigo-300" placeholder="—" />
    </label>
  );

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/40" onClick={onClose} />
      <Card className="relative w-full max-w-md p-6">
        <div className="flex items-start justify-between mb-4">
          <div>
            <p className="text-sm font-semibold text-slate-900">Billings — {broker.name}</p>
            <p className="text-xs text-slate-400 mt-0.5">All figures in {currency}</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="space-y-3">
          {field("target", "Target", "What they are expected to bill this period")}
          {field("billed", "Billings to date", "Invoiced, whether or not it has landed")}
          {field("actual", "Actual billings", "Collected — the figure that counts")}
          {field("deals", "Deals closed")}
          <label className="block">
            <span className="text-xs font-medium text-slate-700">Note</span>
            <input value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              className="mt-1 w-full text-sm border border-slate-200 rounded-xl px-3 py-2 outline-none
                         focus:border-indigo-300" placeholder="e.g. two rentals pending collection" />
          </label>
        </div>

        <p className="mt-4 text-[11px] text-slate-500 leading-relaxed bg-amber-50 border border-amber-200
                      rounded-xl px-3 py-2">
          Saved in this browser only — nobody else sees it and it does not survive a
          different device. Move the numbers into <code className="text-slate-700">src/billings.json</code>
          {" "}to share them.
        </p>

        <div className="mt-4 flex items-center justify-end gap-2">
          <button onClick={onClose}
            className="text-sm px-4 py-2 rounded-xl text-slate-600 hover:bg-slate-100">Cancel</button>
          <button
            onClick={() => {
              const num = (v) => (v === "" || v == null ? null : Number(v));
              onSave({
                target: num(form.target), billed: num(form.billed), actual: num(form.actual),
                deals: num(form.deals), notes: form.notes.trim() || null, local: true,
              });
              onClose();
            }}
            className="text-sm px-4 py-2 rounded-xl bg-slate-900 text-white font-medium hover:bg-slate-800">
            Save
          </button>
        </div>
      </Card>
    </div>
  );
}

/* ---------------------------- profile panel ---------------------------- */

const SECTIONS = [
  ["overview", "Overview"],
  ["viewings", "Viewings"],
  ["listings", "Listings"],
  ["leads", "Leads"],
];

function Thumb({ listing }) {
  const [failed, setFailed] = useState(false);
  const src = (listing.images ?? [])[0]?.url ?? null;
  if (!src || failed) {
    return (
      <div className="w-16 h-12 rounded-lg bg-slate-100 flex items-center justify-center flex-shrink-0">
        <Building2 className="w-4 h-4 text-slate-300" />
      </div>
    );
  }
  return (
    <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)}
      className="w-16 h-12 rounded-lg object-cover bg-slate-100 flex-shrink-0" />
  );
}

function PortalIcon({ portalKey }) {
  const meta = portalMeta(portalKey);
  const [failed, setFailed] = useState(false);
  const src = faviconUrl(meta.domain);
  if (src && !failed) {
    return <img src={src} alt={meta.label} title={meta.label} loading="lazy"
      onError={() => setFailed(true)} className="w-4 h-4 rounded-sm flex-shrink-0" />;
  }
  return (
    <span title={meta.label}
      className={`w-4 h-4 rounded-sm ${meta.tint} text-[9px] font-bold
                  flex items-center justify-center flex-shrink-0 uppercase`}>
      {meta.label[0]}
    </span>
  );
}

function BrokerProfile({ broker, currency, period, asOf, onEditBillings, onClose }) {
  const [section, setSection] = useState("overview");
  useEffect(() => { setSection("overview"); }, [broker?.key]);

  /**
   * This broker's entire history, fetched on open, for the exact viewing count.
   *
   * The windowed figure leans on last_updated for any viewing recorded only as
   * a sub-status, and last_updated is the last edit to the record rather than
   * the appointment — so a June viewing can surface in an August window if
   * somebody touched the lead since. That cannot be fixed, only disclosed. The
   * defence is a second figure with no date filter at all, which the
   * approximation cannot distort, answering "is this broker doing viewings?"
   * even when "how many in August?" is soft.
   *
   * Only affordable because `assigned_to` is honoured server-side — see
   * fetchAgentLeads. One broker, opened deliberately, not 26 roster rows.
   */
  const [allTime, setAllTime] = useState(null);
  const [allTimeState, setAllTimeState] = useState("idle");

  const agentId = broker?.id ?? null;
  useEffect(() => {
    if (!agentId) { setAllTime(null); setAllTimeState("unavailable"); return; }
    let cancelled = false;
    setAllTime(null);
    setAllTimeState("loading");
    fetchAgentLeads(agentId)
      .then((rows) => { if (!cancelled) { setAllTime(rows); setAllTimeState("ready"); } })
      .catch((e) => {
        if (cancelled) return;
        console.error("[brokers] all-time viewing pull failed", e);
        setAllTimeState("failed");
      });
    return () => { cancelled = true; };
  }, [agentId]);

  // No date filter — this is the exact one.
  const allTimeViewings = useMemo(
    () => (allTime ? summariseViewings(allTime) : null), [allTime]
  );

  if (!broker) return null;

  const b = broker;
  const billing = b.billing;

  const cold = b.leads.filter(isCold);
  const statusOnly = b.leads.filter(isStatusOnly);
  const noted = b.leads.filter((l) => !isUntouched(l));

  const viewingsByTier = VIEWING_TIERS
    .map((t) => ({ tier: t, rows: b.viewings.filter((v) => v.tier === t) }))
    .filter((g) => g.rows.length);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-slate-900/30" onClick={onClose} />
      <div className="relative w-full max-w-3xl bg-slate-50 h-full overflow-y-auto shadow-2xl">
        <div className="sticky top-0 bg-white border-b border-slate-200 z-10">
          <div className="px-6 py-6 flex items-start justify-between">
            <div className="flex items-center gap-5 min-w-0">
              <Avatar name={b.name} photo={b.photo} size="w-28 h-28" textClass="text-3xl" />
              <div className="min-w-0">
                <p className="text-2xl font-bold text-slate-900 leading-tight">{b.name}</p>
                {b.jobTitle && <p className="text-sm text-slate-400 mt-0.5">{b.jobTitle}</p>}
                <div className="flex items-center gap-4 mt-2 flex-wrap">
                  {b.email && (
                    <a href={`mailto:${b.email}`}
                      className="text-xs text-slate-500 hover:text-indigo-600 flex items-center gap-1.5">
                      <Mail className="w-3.5 h-3.5" />{b.email}
                    </a>
                  )}
                  {b.mobile && (
                    <span className="text-xs text-slate-500 flex items-center gap-1.5">
                      <Phone className="w-3.5 h-3.5" />{b.mobile}
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-400 mt-2">{period}</p>
              </div>
            </div>
            <button onClick={onClose}
              className="text-slate-400 hover:text-slate-700 text-sm px-3 py-1 rounded-lg hover:bg-slate-100">
              Close
            </button>
          </div>
          <div className="px-6 flex items-center gap-1 border-t border-slate-100">
            {SECTIONS.map(([k, label]) => (
              <button key={k} onClick={() => setSection(k)}
                className={`px-3 py-2.5 text-sm border-b-2 -mb-px ${
                  section === k
                    ? "border-slate-900 text-slate-900 font-medium"
                    : "border-transparent text-slate-500 hover:bg-slate-50 hover:text-slate-800 hover:border-slate-300"}`}>
                {label}
                {k === "viewings" && ` (${b.viewingsReal})`}
                {k === "listings" && ` (${b.listingCount})`}
                {k === "leads" && ` (${b.total})`}
              </button>
            ))}
          </div>
        </div>

        <div className="p-6 space-y-4">
          {section === "overview" && (
            <>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                {/* The selected window, not the year — this sits beside
                    viewings and leads, which both follow the range, and three
                    numbers on one row answering three different questions is
                    how a card gets misread. Exact and a size down: this is the
                    figure that gets checked against the invoice sheet it came
                    from, and "AED 228k" cannot be checked against anything.
                    The year-to-date total is in the Billings panel below. */}
                <Stat icon={Wallet} tint="bg-emerald-50 text-emerald-600" label="Billings"
                  valueClass="text-2xl"
                  value={billing?.period
                    ? fmtMoneyExact(billing.period.amount, currency)
                    : billing?.actual != null ? fmtMoneyExact(billing.actual, currency) : "—"}
                  sub={!billing ? "Not entered yet"
                    : billing.period
                      ? `${billing.period.deals} deal${billing.period.deals === 1 ? "" : "s"} · ${period}`
                      : period} />
                <Stat icon={Eye} tint="bg-sky-50 text-sky-600" label="Viewings"
                  value={b.viewingsReal}
                  sub={`${b.tierCounts.confirmed} logged in the CRM · ${b.tierCounts.done} happened · `
                    + `${b.tierCounts.booked} booked`
                    + (b.viewingsApprox > 0 ? ` · ${b.viewingsApprox} dated by last record update` : "")} />
                <Stat icon={Building2} tint="bg-violet-50 text-violet-600" label="Live listings"
                  value={b.listingCount}
                  sub={`${b.listingSale} sale · ${b.listingRent} rent · ${fmtAed(b.listingValue)} on the book`} />
                <Stat icon={CheckCircle2} tint="bg-indigo-50 text-indigo-600" label="Leads worked"
                  value={`${Math.round(b.rate * 100)}%`}
                  alert={b.cold ? `${b.cold} cold` : null}
                  sub={`${b.worked} of ${b.total} moved on or noted · ${b.statusOnly} without a note` +
                       ` · median first touch ${fmtHours(b.median)}`} />
              </div>

              <Card className="p-5">
                <div className="flex items-start justify-between mb-1">
                  <div>
                    <p className="text-sm font-semibold text-slate-900">Billings</p>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Entered by hand — PropSpace has no deals or commissions endpoint on this key
                    </p>
                  </div>
                  <button onClick={() => onEditBillings(b)}
                    className="text-xs flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200
                               text-slate-600 hover:bg-slate-50">
                    <Pencil className="w-3 h-3" />{billing ? "Edit" : "Enter"}
                  </button>
                </div>
                {billing ? (
                  <div className="mt-4 space-y-3">
                    {/* To date, whatever window is selected — the counterpart
                        to the windowed figure in the capsule above, and the
                        reason both can sit on one screen without contradicting
                        each other. Exact underneath, because this is the number
                        that gets tied back to the invoice sheet. */}
                    <div className="grid grid-cols-3 gap-4">
                      {[["Target", billing.target],
                        ["Billings to date", billing.toDate?.amount ?? billing.billed ?? null],
                        ["Deals to date", billing.toDate?.deals ?? billing.deals ?? null]]
                        .map(([label, v]) => (
                        <div key={label}>
                          <p className="text-[11px] text-slate-500">{label}</p>
                          <p className="text-lg font-bold text-slate-900 mt-0.5 tabular-nums">
                            {label === "Deals to date"
                              ? (v ?? "—")
                              : fmtMoney(v, currency)}
                          </p>
                          {label !== "Deals to date" && v != null && (
                            <p className="text-[11px] text-slate-400 tabular-nums">
                              {fmtMoneyExact(v, currency)}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                    {billing.target != null && (
                      <BillingBar
                        billing={{ ...billing, billed: billing.toDate?.amount ?? billing.billed,
                                   actual: billing.toDate?.amount ?? billing.actual }}
                        currency={currency} />
                    )}
                    {asOf && (
                      <p className="text-[11px] text-slate-400">Invoice sheet as of {asOf}.</p>
                    )}
                    {billing.notes && <p className="text-xs text-slate-500">{billing.notes}</p>}
                    {billing.local && (
                      <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200
                                    rounded-lg px-2.5 py-1.5">
                        Typed into this browser, not shared. Move it into src/billings.json when the
                        real sheet lands.
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="mt-4 text-sm text-slate-500 leading-relaxed">
                    No figures for {b.name} yet. Add them to{" "}
                    <code className="text-slate-700 bg-slate-100 px-1 rounded">src/billings.json</code>{" "}
                    once the sheet arrives, or press Enter above to key them in now.
                  </p>
                )}
              </Card>

              <Card className="p-5">
                <p className="text-sm font-semibold text-slate-900">Lead status</p>
                <p className="text-xs text-slate-400 mt-0.5">
                  Sub-status as the CRM has it, same taxonomy as Insights. Self-reported.
                </p>
                <div className="mt-4 space-y-1.5">
                  {b.statuses.map((s) => (
                    <Bar key={s.key} label={s.key} count={s.count} total={b.total}
                      tint="bg-violet-400" danger={NOT_CONTACTED.has(s.key)} />
                  ))}
                  {!b.statuses.length && <p className="text-xs text-slate-400">No leads in this range.</p>}
                </div>
                <div className="mt-4 pt-4 border-t border-slate-100 grid grid-cols-3 gap-3">
                  {[[UserX, "Cold", b.cold, "text-rose-600",
                     "Arrived and nothing happened — default status, no note. The only bucket that counts against them."],
                    [AlertTriangle, "Worked, but no note", b.statusOnly, "text-amber-600",
                     "Status was moved on without a note. Counts as worked; the detail is just missing."],
                    [Clock, "Median first touch", fmtHours(b.median), "text-sky-600",
                     `Lead arriving to the first note logged against it. Measurable on the ${b.noted} with a note.`]].map(
                    ([Icon, label, value, tint, note]) => (
                      <div key={label}>
                        <Icon className={`w-4 h-4 ${tint}`} />
                        <p className="text-xl font-bold text-slate-900 mt-1.5">{value}</p>
                        <p className="text-[11px] font-medium text-slate-600 mt-0.5">{label}</p>
                        <p className="text-[10px] text-slate-400 mt-0.5 leading-snug">{note}</p>
                      </div>
                    ))}
                </div>
              </Card>
            </>
          )}

          {section === "viewings" && (
            <>
              {/* The exact figure first, deliberately. It is the one that is not
                  approximated, and it is the one that answers whether this
                  broker is doing viewings at all. */}
              <div className="grid grid-cols-2 gap-3">
                <Card className="p-5">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                    All time
                  </p>
                  <p className="text-3xl font-bold text-slate-900 mt-1.5">
                    {allTimeState === "ready" ? allTimeViewings.real
                      : allTimeState === "loading" ? "…" : "—"}
                  </p>
                  <p className="text-[11px] text-slate-500 mt-1 leading-snug">
                    {allTimeState === "ready"
                      ? `Every viewing on ${b.name}'s ${allTime.length} leads, no date filter. ` +
                        "Exact — no date approximation applies."
                      : allTimeState === "loading"
                        ? "Reading this broker's full history…"
                        : allTimeState === "failed"
                          ? "That pull failed, so this is unknown — not zero."
                          : "No agent id on this row, so their history cannot be read."}
                  </p>
                </Card>
                <Card className="p-5">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                    {period}
                  </p>
                  <p className="text-3xl font-bold text-slate-900 mt-1.5">{b.viewingsReal}</p>
                  <p className="text-[11px] text-slate-500 mt-1 leading-snug">
                    {b.viewingsApprox > 0
                      ? `${b.viewingsApprox} of these dated by last record update, not an ` +
                        "appointment time — so this window is approximate."
                      : "All dated by an appointment time or the note recording them."}
                  </p>
                </Card>
              </div>

              <Card className="p-5">
                <p className="text-sm font-semibold text-slate-900">How this is counted</p>
                <p className="text-xs text-slate-500 mt-1.5 leading-relaxed">
                  PropSpace has no viewings endpoint on this key — <code>/viewings</code>,{" "}
                  <code>/appointments</code>, <code>/activities</code> and <code>/calendar</code> all 403.
                  So a viewing is inferred from two things instead: what the broker wrote in the
                  notes, and where the broker put the lead. Either is enough on its own. The result
                  is graded in five tiers by how strong the evidence is, and the first three count
                  towards the headline figure of {b.viewingsReal}.
                </p>
                <p className="text-xs text-slate-500 mt-2 leading-relaxed">
                  These are dated on the viewing, not on the lead — a viewing booked this week
                  against a lead from two months ago belongs to this week. Leads going back{" "}
                  {VIEWING_LOOKBACK_DAYS} days are searched to find them.
                  {viewingLoading && " Still loading — the list below may grow."}
                  {!viewingLoading && !viewingLeads &&
                    " That wider search did not load, so this shows only viewings on leads that " +
                    "arrived in the range — it is a floor, not the full picture."}
                </p>
                <div className="mt-4 space-y-2">
                  {VIEWING_TIERS.map((t) => (
                    <div key={t} className="flex items-start gap-3">
                      <span className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${TIER_META[t].dot}`} />
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium text-slate-800">
                          {TIER_META[t].label}
                          <span className="text-slate-400 font-normal"> · {b.tierCounts[t]}</span>
                        </p>
                        <p className="text-[11px] text-slate-500 leading-snug">{TIER_META[t].note}</p>
                      </div>
                    </div>
                  ))}
                </div>
                <p className="mt-4 pt-3 border-t border-slate-100 text-[11px] text-slate-500 leading-relaxed">
                  {b.viewingsClaimed} of these leads currently sit at a &ldquo;Viewing&rdquo;
                  sub-status, and all {b.viewingsClaimed} are counted — a broker who moved a lead
                  there recorded a viewing as deliberately as one who typed it into a note. The
                  status is a snapshot with no history, so it only ever misses viewings: a lead that
                  was viewed and has since moved to Offer Made no longer says so. That is why the
                  notes are read as well, and why the headline is the union of the two rather than
                  either one.
                </p>
              </Card>

              {viewingsByTier.map(({ tier, rows }) => (
                <Card key={tier}>
                  <div className="px-5 py-3 border-b border-slate-200 flex items-center justify-between">
                    <p className="text-sm font-semibold text-slate-900">{TIER_META[tier].label}</p>
                    <span className={`text-[11px] font-semibold px-2 py-1 rounded-lg ${TIER_META[tier].tint}`}>
                      {rows.length}
                    </span>
                  </div>
                  <div className="divide-y divide-slate-100">
                    {rows.map(({ lead, evidence, at, dateFrom }) => (
                      <div key={lead.id} className="px-5 py-3">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium text-slate-900">
                            {lead.reference ?? lead.id}
                          </span>
                          <span className="text-[11px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">
                            {statusOf(lead)}
                          </span>
                          {at && (
                            <span
                              className="text-[11px] text-slate-500"
                              /* An appointment time is exact; a note is when it was written
                                 down; last_updated is only the last edit to the record. Saying
                                 which is the difference between a date and a guess. */
                              title={dateFrom === "appointment" ? "Scheduled time from the CRM viewing record"
                                : dateFrom === "note" ? "When the note evidencing it was written"
                                : "Last change to the lead — approximate"}
                            >
                              {fmtDateTime(at)}{dateFrom === "last-updated" ? " (approx.)" : ""}
                            </span>
                          )}
                          {evidence[0]?.kind === "system" && evidence[0].at && (
                            <span className="text-[11px] text-sky-700 font-medium">
                              {fmtDateTime(evidence[0].at)}
                            </span>
                          )}
                          {evidence[0]?.kind === "system" && evidence[0].client && (
                            <span className="text-[11px] text-slate-500">{evidence[0].client}</span>
                          )}
                        </div>
                        {evidence.map((e, i) => (
                          <p key={i} className="text-xs text-slate-500 mt-1 leading-relaxed">
                            {/* A status carries no author and no timestamp, so it
                                gets its own byline rather than a bare "null — ". */}
                            <span className="text-slate-400">
                              {e.kind === "status" ? "CRM status" : e.author}
                              {e.loggedAt ? ` · ${fmtDateTime(e.loggedAt)}` : ""} —{" "}
                            </span>
                            {e.kind === "system"
                              ? `viewing ${e.state?.toLowerCase()}${e.listingRef ? ` on ${e.listingRef}` : ""}` +
                                (e.feedback ? `, feedback: ${e.feedback}` : ", no feedback recorded")
                              : e.text}
                          </p>
                        ))}
                      </div>
                    ))}
                  </div>
                </Card>
              ))}

              {!b.viewings.length && (
                <Card className="p-8">
                  <p className="text-sm text-slate-400 text-center">
                    None of {b.name}&rsquo;s {b.total} leads in this range mentions a viewing in its
                    notes or sits at a viewing sub-status.
                  </p>
                </Card>
              )}
            </>
          )}

          {section === "listings" && (
            <Card>
              <div className="px-5 py-4 border-b border-slate-200">
                <p className="text-sm font-semibold text-slate-900">Current listings</p>
                <p className="text-xs text-slate-400 mt-0.5">
                  Published in the CRM right now — {b.listingSale} sale, {b.listingRent} rent,{" "}
                  {fmtAed(b.listingValue)} in total. Not affected by the date range.
                </p>
              </div>
              <div className="divide-y divide-slate-100">
                {[...b.listings].sort((a, c) => (c.price ?? 0) - (a.price ?? 0)).map((l) => (
                  <div key={l.id} className="px-5 py-3 flex items-start gap-3 hover:bg-slate-50">
                    <Thumb listing={l} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-slate-900">{l.ref}</span>
                        <span className={`text-[11px] px-1.5 py-0.5 rounded ${
                          l.type === "sale" ? "bg-violet-50 text-violet-700" : "bg-sky-50 text-sky-700"}`}>
                          {l.type}
                        </span>
                        <span className="text-[11px] text-slate-500">
                          {l.beds ? `${l.beds} bed` : ""}{l.category ? ` · ${l.category}` : ""}
                        </span>
                      </div>
                      <p className="text-xs text-slate-500 mt-0.5 truncate">
                        {[l.sub_area_location?.name, l.area_location?.name].filter(Boolean).join(", ")
                          || l.name}
                      </p>
                      <div className="mt-1 flex items-center gap-1 flex-wrap">
                        {(l.portals ?? []).map((p) => <PortalIcon key={p} portalKey={p} />)}
                        {!l.portals?.length && (
                          <span className="text-[11px] text-slate-300">not advertised</span>
                        )}
                      </div>
                    </div>
                    <span className="text-sm font-semibold text-slate-900 flex-shrink-0">
                      {fmtAed(l.price)}
                    </span>
                  </div>
                ))}
                {!b.listings.length && (
                  <p className="px-5 py-8 text-center text-sm text-slate-400">
                    Nothing published under {b.name} right now.
                  </p>
                )}
              </div>
            </Card>
          )}

          {section === "leads" && (
            <Card>
              <div className="px-5 py-4 border-b border-slate-200">
                <p className="text-sm font-semibold text-slate-900">Leads</p>
                <p className="text-xs text-slate-400 mt-0.5">Cold first, then oldest</p>
              </div>
              <div className="divide-y divide-slate-100">
                {[...cold.sort((a, c) => new Date(a.created_at) - new Date(c.created_at)),
                  ...statusOnly.sort((a, c) => new Date(a.created_at) - new Date(c.created_at)),
                  ...noted.sort((a, c) => new Date(a.created_at) - new Date(c.created_at))]
                  .map((l) => {
                    const g = listingOf(l);
                    const dead = isCold(l);
                    const notes = humanNotes(l);
                    return (
                      <div key={l.id} className="px-5 py-3 hover:bg-slate-50">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-sm font-medium text-slate-900">
                                {l.reference ?? l.id}
                              </span>
                              <span className="text-[11px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">
                                {l.source}
                              </span>
                              <span className="text-[11px] text-slate-500">{l.lead_type}</span>
                              {claimsViewing(l) && (
                                <span className="text-[11px] px-1.5 py-0.5 rounded bg-sky-50 text-sky-700">
                                  {statusOf(l)}
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-slate-500 mt-1 truncate">
                              {g.ref ? `${g.ref} · ` : ""}
                              {[g.subLocation, g.location].filter(Boolean).join(", ")
                                || "no listing recorded"}
                              {g.price ? ` · ${fmtPrice(g.price)}` : ""}
                            </p>
                            <p className="text-xs text-slate-400 mt-0.5">
                              {statusOf(l)}
                              {dead
                                ? " · status never moved, nothing logged"
                                : isUntouched(l)
                                  ? " · status moved, but no note logged"
                                  : ` · first touch ${fmtHours(hoursToFirstTouch(l))} after arrival · ` +
                                    `${notes.length} note${notes.length === 1 ? "" : "s"}`}
                            </p>
                          </div>
                          <span className={`text-[11px] font-semibold px-2 py-1 rounded-lg flex-shrink-0 ${
                            dead ? "bg-rose-50 text-rose-700"
                              : isUntouched(l) ? "bg-amber-50 text-amber-700"
                              : "bg-emerald-50 text-emerald-700"}`}>
                            {dead
                              ? `${fmtHours((Date.now() - new Date(l.created_at)) / 3_600_000)} cold`
                              : isUntouched(l) ? "worked, no note" : "worked"}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                {!b.leads.length && (
                  <p className="px-5 py-8 text-center text-sm text-slate-400">
                    No leads in this range.
                  </p>
                )}
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------- tab ------------------------------- */

export default function Brokers() {
  const [range, setRange] = useState({ preset: String(DEFAULT_DAYS), from: null, to: null });
  const [raw, setRaw] = useState([]);
  const [listings, setListings] = useState([]);
  const [crmAgents, setCrmAgents] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null);          // broker key
  const [editing, setEditing] = useState(null);    // broker row
  const [local, setLocal] = useState(loadLocalBillings);
  const [sort, setSort] = useState({ key: "actual", dir: "desc" });
  const [showHouse, setShowHouse] = useState(false);
  // A separate, wider pull that only feeds viewings — see VIEWING_LOOKBACK_DAYS.
  const [viewingRaw, setViewingRaw] = useState(null);
  const [viewingLoading, setViewingLoading] = useState(false);
  const [viewingError, setViewingError] = useState(null);

  const { from, to } = useMemo(() => resolveRange(range), [range]);
  const ready = Boolean(from && to && new Date(from) <= new Date(to));

  const firstLoad = React.useRef(true);

  async function load() {
    if (!ready) return;
    setLoading(true); setError(null);
    try {
      // The default 30-day pull is already in flight from module load, so the
      // first render adopts it instead of firing an identical second request.
      const canReuse = firstLoad.current && from === prefetch.from && to === prefetch.to;
      // fetchLiveListings used to be wrapped in .catch(() => []). A listings
      // pull that died halfway then became an empty array, and every broker
      // silently showed 0 live listings — a wrong number presented as a real
      // one, with no error anywhere. Let it throw into the catch below instead:
      // an error banner is honest, a confident zero is not.
      let [leadResult, live] = await Promise.all([
        canReuse ? prefetch.promise
                 : fetchLeads({ from, to }).then((rows) => ({ rows, error: null })),
        fetchLiveListings({}),
      ]);
      firstLoad.current = false;

      // The prefetch is fired at module load, which on a deployed build is
      // before anyone has signed in, so the edge answers it with a 401 every
      // time. Retry for real rather than treating that as this range's answer.
      // Insights has had this since the guard went in; this screen had not,
      // which is why it opened on zero leads every single time.
      if (canReuse && leadResult.error) {
        leadResult = { rows: await fetchLeads({ from, to }), error: null };
      }

      // Listings succeeding does not make a failed lead pull presentable. The
      // roster is the union of both, so rendering it here drew every broker
      // with their real listing count against zero leads — a table that looks
      // authoritative and is wrong. Show the error and nothing else.
      if (leadResult.error) {
        setRaw([]);
        setListings([]);
        setError(leadResult.error);
        return;
      }

      setRaw(leadResult.rows);
      setListings(live);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [from, to]);

  /**
   * Viewings need a wider pull than everything else on this screen.
   *
   * Every other figure here is a property of leads that ARRIVED in the range.
   * A viewing is not: brokers book viewings against leads they have been
   * working for weeks, so filtering them by the lead's arrival date answers a
   * question nobody asked. Measured on the live book, "Last 7 days" surfaced 6
   * of the 125 leads sitting at a viewing sub-status.
   *
   * So this fetches back VIEWING_LOOKBACK_DAYS and keeps only the viewings whose
   * OWN date lands in the range. It runs after the main load rather than
   * alongside it — it is roughly four times the requests, and the roster should
   * not wait on it. Until it lands the screen falls back to the narrow pull,
   * which is the old behaviour rather than a blank.
   */
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const wideFrom = new Date(new Date(from).getTime() - VIEWING_LOOKBACK_DAYS * 864e5)
      .toISOString().slice(0, 10);

    setViewingLoading(true);
    setViewingRaw(null);
    setViewingError(null);
    // maxPages is a backstop, not a budget: the pull already stops as soon as it
    // pages past wideFrom. At 60 it stopped SHORT of that on the 90-day preset —
    // 210 days is ~68 pages at current volume — so the lookback silently covered
    // less ground the wider the window got, which is the opposite of its job.
    fetchLeads({ from: wideFrom, to, maxPages: 200 })
      .then((rows) => { if (!cancelled) setViewingRaw(rows); })
      // Not a page-level error — the rest of the roster is fine — but it must
      // reach the viewings figures, which otherwise print a number measured a
      // different way and look merely low rather than wrong.
      .catch((e) => {
        if (cancelled) return;
        console.error("[brokers] viewing pull failed", e);
        setViewingError(e.message);
      })
      .finally(() => { if (!cancelled) setViewingLoading(false); });

    return () => { cancelled = true; };
    /* eslint-disable-next-line */
  }, [from, to, ready]);

  // Same classification Insights ranks on. Two screens ranking the same people
  // differently is how you end up being asked which one is right.
  useEffect(() => {
    fetchCrmAgents()
      .then(setCrmAgents)
      .catch((e) => setError(
        `Couldn't load the agent classifications, so the roster below may include ` +
        `people who are not brokers. ${e.message}`
      ));
  }, []);

  // Dubai days, same as Insights — an enquiry at 01:00 local carries the
  // previous UTC date.
  const leads = useMemo(() => {
    const { start, end } = dubaiRange(from, to);
    return raw.filter((l) => {
      const t = new Date(l.created_at).getTime();
      return t >= start && t <= end && isRankedLead(l, crmAgents);
    });
  }, [raw, from, to, crmAgents]);

  // Listings are filtered on the same rule, and have to be: buildRoster takes
  // the UNION of both sources, so an unranked agent holding a live listing
  // would still appear as a row once their leads had gone.
  const rankedListings = useMemo(
    () => listings.filter((l) => isRankedListing(l, crmAgents)), [listings, crmAgents]
  );

  const viewingLeads = useMemo(
    () => (viewingRaw ? viewingRaw.filter((l) => isRankedLead(l, crmAgents)) : null),
    [viewingRaw, crmAgents]
  );

  // The viewing's own date, in the same Dubai days as everything else.
  const viewingInRange = useMemo(() => {
    const { start, end } = dubaiRange(from, to);
    return (at) => {
      if (!at) return false;
      const t = at.getTime();
      return t >= start && t <= end;
    };
  }, [from, to]);

  /**
   * Whether the viewing figures mean anything yet.
   *
   * They are the ONLY column on this screen that needs the wide pull, and until
   * it lands there is no honest number to print. This used to fall back to the
   * narrow pull with no date filter — every viewing on leads that ARRIVED in the
   * window — which is a different measurement in the same slot, and the reason
   * ninety days could show fewer viewings than thirty: the wider window is the
   * slower pull, so it was the one still showing the fallback.
   */
  const viewingsReady = viewingLeads != null;

  const roster = useMemo(
    () => buildRoster({
      leads, listings: rankedListings,
      // [] rather than null: null asks buildRoster for its own fallback, which
      // is the substitution this is here to stop. Not-yet-counted renders as
      // "—" below, never as a figure.
      viewingLeads: viewingLeads ?? [],
      viewingInRange,
    }),
    [leads, rankedListings, viewingLeads, viewingInRange]
  );

  const { byKey, unmatched, ambiguous, currency, asOf } = useMemo(
    () => matchBillings(roster), [roster]
  );

  // File billings first, then anything typed into this browser on top.
  const withBillings = useMemo(
    () => roster.map((r) => {
      const billing = local[r.key] ?? byKey.get(r.key) ?? null;
      return {
        ...r,
        billing: billing && {
          ...billing,
          // Null when the entry carries no invoice list — a hand-keyed figure
          // has no dates to filter on, and inventing a window for it would be
          // worse than showing the total it actually is.
          period: billedInRange(billing, from, to),
          toDate: billedToDate(billing),
        },
      };
    }),
    [roster, byKey, local, from, to]
  );

  const visible = useMemo(() => {
    const rows = showHouse ? withBillings : withBillings.filter((r) => !r.house);
    return sortRoster(rows, sort);
  }, [withBillings, sort, showHouse]);

  const houseCount = withBillings.filter((r) => r.house).length;
  const openBroker = visible.find((r) => r.key === open)
    ?? withBillings.find((r) => r.key === open) ?? null;

  const toggleSort = (col) =>
    setSort((s) => s.key === col.key
      ? { key: col.key, dir: s.dir === "asc" ? "desc" : "asc" }
      : { key: col.key, dir: col.firstDir ?? "desc" });

  const saveBilling = (broker, value) => {
    const next = { ...local, [broker.key]: value };
    setLocal(next);
    saveLocalBillings(next);
  };

  // "Last 7 days · 1–7 Aug" — day windows end yesterday, so show the dates.
  const period = range.preset === "custom"
    ? `${from} → ${to} (${spanDays(from, to)} days)`
    : rangeCaption(range, PRESETS);
  const ctrl = "flex items-center gap-2 bg-white border border-slate-200 rounded-xl px-3 py-2 text-sm text-slate-700";

  const totals = visible.reduce((s, r) => ({
    leads: s.leads + r.total,
    viewings: s.viewings + r.viewingsReal,
    viewingsApprox: s.viewingsApprox + r.viewingsApprox,
    listings: s.listings + r.listingCount,
    actual: s.actual + (r.billing?.period?.amount ?? r.billing?.actual ?? 0),
    billed: s.billed + (r.billing?.toDate?.amount ?? r.billing?.billed ?? 0),
    withBillings: s.withBillings + (r.billing ? 1 : 0),
  }), { leads: 0, viewings: 0, viewingsApprox: 0, listings: 0, actual: 0, billed: 0, withBillings: 0 });

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div>
          <p className="text-sm text-slate-500">Brokers</p>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight mt-1">
            One profile per broker
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Click any broker for their billings, viewings, listings and lead statuses
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <DateRange value={range} onChange={setRange} presets={PRESETS} />
          <button onClick={load}
            className={`${ctrl} hover:bg-slate-50 ${loading || viewingLoading ? "is-fetching" : ""}`}>
            <RefreshCw className={`w-4 h-4 text-slate-400 ${loading || viewingLoading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 px-4 py-3 rounded-xl bg-rose-50 border border-rose-200 text-sm text-rose-800">
          <span className="font-medium">Couldn&rsquo;t load from PropSpace.</span> {error}
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        {/* The selected window, like the viewings and leads cards beside it.
            Each broker's year to date is on their own profile. */}
        <Stat icon={Wallet} tint="bg-emerald-50 text-emerald-600" label="Billings"
          value={totals.withBillings ? fmtMoney(totals.actual, currency) : "—"}
          sub={totals.withBillings
            ? `${period} · ${totals.withBillings} of ${visible.length} brokers have figures` +
              (asOf ? ` · sheet as of ${asOf}` : "")
            : "No billings entered — PropSpace has no deals endpoint on this key"} />
        <Stat icon={Eye} tint="bg-sky-50 text-sky-600" label="Viewings"
          value={viewingsReady ? totals.viewings : "—"}
          sub={!viewingsReady
            ? (viewingError
                ? `Couldn't load the wider pull viewings need — ${viewingError}. No number is shown rather than one measured a different way.`
                : "Counting… viewings need a wider pull than the rest of this screen, so they land a moment later.")
            : "From note text and the CRM viewing sub-status."
              + (totals.viewingsApprox > 0
                ? ` ${totals.viewingsApprox} dated by last record update, so this window is approximate — open a profile for that broker's exact all-time count.`
                : " All dated by an appointment or the note recording them.")} />
        <Stat icon={Building2} tint="bg-violet-50 text-violet-600" label="Live listings"
          value={totals.listings}
          sub={`Published in the CRM now, across ${visible.length} brokers`} />
        <Stat icon={CheckCircle2} tint="bg-indigo-50 text-indigo-600" label="Leads"
          value={totals.leads} sub={period} />
      </div>

      {(unmatched.length > 0 || ambiguous.length > 0) && (
        <div className="mb-4 px-4 py-3 rounded-xl bg-amber-50 border border-amber-200 text-sm text-amber-900">
          <p className="font-medium">Some billings rows did not land on a broker.</p>
          {unmatched.length > 0 && (
            <p className="text-xs mt-1">
              No match for {unmatched.map((u) => `"${u.name}"`).join(", ")} — check the spelling in
              billings.json, or add an <code>agentId</code>.
            </p>
          )}
          {ambiguous.map((a, i) => (
            <p key={i} className="text-xs mt-1">
              &ldquo;{a.entry.name}&rdquo; matches {a.candidates.join(" and ")} — add an{" "}
              <code>agentId</code> to say which.
            </p>
          ))}
        </div>
      )}

      <Card className="overflow-hidden">
        <div className="p-5 pb-4 flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-slate-900">Roster</p>
            <p className="text-xs text-slate-400 mt-0.5">
              Click a heading to rank by it · listings are all-time, everything else follows
              the date range
            </p>
          </div>
          {houseCount > 0 && (
            <button onClick={() => setShowHouse((v) => !v)}
              className="text-xs px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600
                         hover:bg-slate-50 flex-shrink-0">
              {showHouse ? "Hide" : "Show"} {houseCount} house account{houseCount === 1 ? "" : "s"}
            </button>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-y border-slate-200 bg-slate-50">
                {BROKER_COLS.map((c, i) => {
                  const active = sort.key === c.key;
                  return (
                    <th key={c.key} onClick={() => toggleSort(c)} title={`Sort by ${c.label}`}
                      className={`py-2.5 font-medium cursor-pointer select-none hover:text-slate-900
                        ${i === 0 ? "px-5" : i === BROKER_COLS.length - 1 ? "px-5 w-32" : "px-3"}
                        ${c.align === "right" ? "text-right" : "text-left"}
                        ${active ? "text-slate-900" : ""}`}>
                      <span className="inline-flex items-center gap-1">
                        {c.align === "right" && active && (
                          <span className="text-indigo-500">{sort.dir === "asc" ? "▲" : "▼"}</span>
                        )}
                        {c.label}
                        {c.align !== "right" && active && (
                          <span className="text-indigo-500">{sort.dir === "asc" ? "▲" : "▼"}</span>
                        )}
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.key} onClick={() => setOpen(r.key)}
                  className="border-b border-slate-100 last:border-0 cursor-pointer hover:bg-slate-50">
                  <td className="px-5 py-3 font-medium text-slate-900">
                    <span className="flex items-center gap-2.5">
                      <Avatar name={r.name} photo={r.photo} />
                      <span className="min-w-0">
                        <span className="block hover:underline truncate">
                          {r.name}
                          {/* Carries leads but is not on the active user list —
                              they have left. The leads are real and stay
                              counted; the row just should not read as an active
                              broker doing nothing. */}
                          {!r.onCrm && (
                            <span className="ml-2 text-[10px] font-medium px-1.5 py-0.5 rounded
                                             bg-slate-100 text-slate-500 align-middle">
                              not on the CRM
                            </span>
                          )}
                        </span>
                        {r.jobTitle && (
                          <span className="block text-[11px] text-slate-400 truncate font-normal">
                            {r.jobTitle}
                          </span>
                        )}
                      </span>
                    </span>
                  </td>
                  <td className="px-3 py-3 text-right text-slate-600">
                    {(r.billing?.toDate?.amount ?? r.billing?.billed) != null
                      ? fmtMoney(r.billing.toDate?.amount ?? r.billing.billed, currency)
                      : <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-3 py-3 text-right font-medium text-slate-900">
                    {(r.billing?.period?.amount ?? r.billing?.actual) != null
                      ? fmtMoney(r.billing.period?.amount ?? r.billing.actual, currency)
                      : <span className="text-slate-300 font-normal">—</span>}
                  </td>
                  <td className="px-3 py-3 text-right">
                    {!viewingsReady
                      ? <span className="text-slate-300" title="Still counting">—</span>
                      : r.viewingsReal > 0
                        ? <span className="inline-block px-2 py-0.5 rounded-lg bg-sky-50 text-sky-700 font-semibold">
                            {r.viewingsReal}
                          </span>
                        : <span className="text-slate-300">0</span>}
                  </td>
                  <td className="px-3 py-3 text-right text-slate-600">
                    {r.listingCount || <span className="text-slate-300">0</span>}
                  </td>
                  <td className="px-3 py-3 text-right text-slate-600">{r.total}</td>
                  <td className="px-3 py-3 text-right text-slate-600">{fmtHours(r.median)}</td>
                  <td className="px-5 py-3">
                    {r.total ? (
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden min-w-[50px]">
                          <div className={`h-full rounded-full ${
                              r.rate > 0.75 ? "bg-emerald-400" : r.rate > 0.5 ? "bg-amber-400" : "bg-rose-400"}`}
                            style={{ width: `${r.rate * 100}%` }} />
                        </div>
                        <span className="text-xs text-slate-500 w-9 text-right">
                          {Math.round(r.rate * 100)}%
                        </span>
                      </div>
                    ) : (
                      <span className="text-xs text-slate-300">no leads</span>
                    )}
                  </td>
                </tr>
              ))}
              {!visible.length && (
                <tr><td colSpan={BROKER_COLS.length}
                  className="px-5 py-8 text-center text-sm text-slate-400">
                  {loading ? "Loading…" : "No brokers in this range."}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <p className="text-xs text-slate-400 mt-6 leading-relaxed max-w-3xl">
        Leads, statuses and listings are live from PropSpace. Viewings are derived from note text
        and the lead&rsquo;s viewing sub-status because the API has no viewings endpoint, and are
        counted against leads that arrived in the selected range — a viewing logged this week
        against an older lead is not in the
        figure. Billings are entered by hand: there is no deals, commissions or invoices endpoint
        on this key.
      </p>

      <BrokerProfile broker={openBroker} currency={currency} period={period} asOf={asOf}
        onEditBillings={setEditing} onClose={() => setOpen(null)} />

      {editing && (
        <BillingsEditor broker={editing} currency={currency}
          value={local[editing.key] ?? byKey.get(editing.key)}
          onSave={(v) => saveBilling(editing, v)}
          onClose={() => setEditing(null)} />
      )}
    </>
  );
}
