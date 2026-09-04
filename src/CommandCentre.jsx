import React, { useState, useEffect, useMemo } from "react";
import {
  Flame, AlertTriangle, Banknote, PhoneOff, Home, Phone, MessageCircle,
  Calendar, Clock, Target, ArrowRight, RefreshCw,
} from "lucide-react";
import { fetchAgentLeads, statusOf, fmtPrice } from "./propspace.js";
import { fetchLiveListings } from "./listings.js";
import { viewingEvidence, TIER_META } from "./brokers.js";
import {
  SUBJECT, buildBriefing, greeting, dubaiDateLabel, dialable, waNumber, wantedType, normaliseBeds,
} from "./commandCentre.js";

/**
 * Command Centre — one broker's day, off the live CRM.
 *
 * Beta, and deliberately one broker: Dennis Manalo. A briefing is only worth
 * judging against a book somebody recognises, and scoping it to one person
 * means the screen can be wrong in public without being wrong for everybody.
 *
 * Two things this screen does not do, both on purpose.
 *
 * It does not call itself AI. The panel the design marks "AI recommendation"
 * is a ranking with the reason printed next to it — see commandCentre.js for
 * why the CRM's own hot_lead and priority fields could not be used. Calling a
 * sort an intelligence would be the one dishonest thing on a page whose whole
 * point is that the numbers are real.
 *
 * And it invents no data. Where the CRM has nothing — no viewing on the
 * calendar, no budget on an enquiry — the panel says so rather than filling
 * the space. Empty is a finding: it is usually the most useful thing here.
 */

const Card = ({ children, className = "" }) => (
  <div className={`bg-white border border-slate-200 rounded-2xl ${className}`}>{children}</div>
);

const Tile = ({ icon: Icon, tint, value, label, sub, alert }) => (
  <Card className="p-4">
    <div className="flex items-start gap-3">
      <span className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${tint}`}>
        <Icon className="w-5 h-5" />
      </span>
      <div className="min-w-0">
        <p className={`text-2xl font-bold tabular-nums leading-none ${alert ? "text-rose-600" : "text-slate-900"}`}>
          {value}
        </p>
        <p className="text-[11px] font-semibold tracking-wide text-slate-500 uppercase mt-1.5">{label}</p>
        {sub && <p className="text-[11px] text-slate-400 mt-0.5 leading-snug">{sub}</p>}
      </div>
    </div>
  </Card>
);

/** Score chip. The number is ours, so it is always shown next to the reason
 *  that produced it — never on its own. */
const Score = ({ score, band }) => {
  const tint = band === "high" ? "bg-emerald-50 text-emerald-700"
    : band === "medium" ? "bg-amber-50 text-amber-700" : "bg-slate-100 text-slate-500";
  return (
    <span className={`px-2 py-0.5 rounded-md text-xs font-semibold tabular-nums ${tint}`}>{score}</span>
  );
};

function CallButtons({ client, compact }) {
  const tel = dialable(client.mobile);
  const wa = waNumber(client.mobile);
  if (!tel) return <span className="text-[11px] text-slate-400 whitespace-nowrap">No number on file</span>;
  return (
    <div className="flex items-center gap-1.5 flex-shrink-0">
      <a href={`tel:${tel}`} title={`Call ${client.name}`}
        className="w-8 h-8 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white flex items-center justify-center transition">
        <Phone className="w-4 h-4" />
      </a>
      {wa && (
        <a href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer" title={`WhatsApp ${client.name}`}
          className="w-8 h-8 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 flex items-center justify-center transition">
          <MessageCircle className="w-4 h-4" />
        </a>
      )}
      {!compact && null}
    </div>
  );
}

/**
 * Pipeline ring.
 *
 * Three ORDERED bands, so the ramp is one hue light→dark rather than three
 * unrelated colours: probability is a magnitude, and painting it categorically
 * would say these are three kinds of thing instead of three degrees of one.
 * Steps are 0.24 / ~0.55 / 0.80 in OKLab lightness — monotonic, and the worst
 * adjacent pair separates by ΔE 21 under protanopia.
 *
 * The lightest step sits under 3:1 against white, which obliges a visible
 * label rather than colour alone — hence the value printed beside every key,
 * and the 2px surface gap so the segments never touch.
 */
function PipelineRing({ pipeline }) {
  const bands = [
    { key: "high", label: "High", hint: "70+", value: pipeline.high, fill: "#0C2036" },
    { key: "medium", label: "Medium", hint: "40–69", value: pipeline.medium, fill: "#4C7FA8" },
    { key: "low", label: "Low", hint: "under 40", value: pipeline.low, fill: "#A9C0D6" },
  ];
  const total = pipeline.total || 0;
  const R = 56, SW = 15, C = 2 * Math.PI * R, GAP = 2;

  let cursor = 0;
  const arcs = bands.filter((b) => b.value > 0).map((b) => {
    const frac = total ? b.value / total : 0;
    const len = Math.max(0, frac * C - GAP);
    const arc = { ...b, len, offset: -cursor };
    cursor += frac * C;
    return arc;
  });

  return (
    <div className="flex items-center gap-5">
      <svg viewBox="0 0 140 140" className="w-[132px] h-[132px] flex-shrink-0" role="img"
        aria-label={`Pipeline ${fmtPrice(total)} split by score band`}>
        <circle cx="70" cy="70" r={R} fill="none" stroke="#F1F5F9" strokeWidth={SW} />
        {arcs.map((a) => (
          <circle key={a.key} cx="70" cy="70" r={R} fill="none" stroke={a.fill} strokeWidth={SW}
            strokeDasharray={`${a.len} ${C - a.len}`} strokeDashoffset={a.offset}
            transform="rotate(-90 70 70)" strokeLinecap="butt" />
        ))}
        <text x="70" y="66" textAnchor="middle" className="fill-slate-900"
          style={{ font: "700 17px ui-sans-serif, system-ui" }}>
          {total >= 1_000_000 ? `${(total / 1_000_000).toFixed(1)}m` : `${Math.round(total / 1000)}k`}
        </text>
        <text x="70" y="82" textAnchor="middle" className="fill-slate-400"
          style={{ font: "600 9px ui-sans-serif, system-ui", letterSpacing: "0.08em" }}>
          AED
        </text>
      </svg>

      <div className="min-w-0 space-y-2">
        {bands.map((b) => (
          <div key={b.key} className="flex items-center gap-2 text-xs">
            <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: b.fill }} />
            <span className="text-slate-600 whitespace-nowrap">{b.label}</span>
            <span className="text-slate-400">({b.hint})</span>
            <span className="ml-auto pl-3 font-semibold text-slate-900 tabular-nums whitespace-nowrap">
              {fmtPrice(b.value)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

const Panel = ({ title, right, children, className = "" }) => (
  <Card className={`p-5 flex flex-col ${className}`}>
    <div className="flex items-center justify-between gap-3 mb-4">
      <h2 className="text-[11px] font-bold tracking-wider text-slate-500 uppercase">{title}</h2>
      {right}
    </div>
    {children}
  </Card>
);

const Empty = ({ children }) => (
  <p className="text-sm text-slate-400 py-6 text-center">{children}</p>
);

/**
 * Session cache. Held in the module, not in storage: a book of several hundred
 * leads with their notes is megabytes of JSON, which is a poor fit for the 5MB
 * sessionStorage budget and a worse one for the main thread. This survives tab
 * switches, which is the case that actually annoys, and dies with the page.
 */
const CACHE = { leads: null, listings: null, at: 0, id: null };
const FRESH_MS = 5 * 60 * 1000;

export default function CommandCentre() {
  const cached = CACHE.id === SUBJECT.id && Date.now() - CACHE.at < FRESH_MS;
  const [leads, setLeads] = useState(cached ? CACHE.leads : null);
  const [listings, setListings] = useState(cached ? CACHE.listings ?? [] : []);
  const [count, setCount] = useState(0);
  const [progress, setProgress] = useState(null);
  const [state, setState] = useState(cached ? "ready" : "loading");
  const [error, setError] = useState(null);
  const [now, setNow] = useState(() => new Date());

  async function load({ force = false } = {}) {
    if (!force && CACHE.id === SUBJECT.id && Date.now() - CACHE.at < FRESH_MS) {
      setLeads(CACHE.leads); setListings(CACHE.listings ?? []); setState("ready");
      return;
    }
    setState("loading"); setError(null); setCount(0); setProgress(null);

    // Inventory is fetched ALONGSIDE the book, not after it. Matching is the
    // only panel that needs it, and it is a different endpoint, so waiting for
    // the leads before starting it was pure dead time.
    const listingsPromise = fetchLiveListings()
      .then((rows) => { CACHE.listings = rows; setListings(rows); return rows; })
      .catch((e) => {
        console.error("[command centre] listings unavailable, matching disabled", e);
        return [];
      });

    try {
      const rows = await fetchAgentLeads(SUBJECT.id, {
        fresh: force,
        onProgress: setCount,
        // Paint each batch as it lands. The briefing over the first 400 leads
        // is the same shape as the briefing over all of them, so the screen
        // fills in instead of holding a spinner to the last page.
        onPartial: (partial, at) => {
          setLeads(partial);
          setProgress(at);
          setState("ready");
        },
      });
      CACHE.leads = rows; CACHE.id = SUBJECT.id; CACHE.at = Date.now();
      setLeads(rows);
      setProgress(null);
      setNow(new Date());
      setState("ready");
      await listingsPromise;
    } catch (e) {
      console.error("[command centre]", e);
      setError(String(e.message ?? e));
      setState("failed");
    }
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const brief = useMemo(
    () => (leads ? buildBriefing({ leads, listings, now }) : null),
    [leads, listings, now]
  );

  /**
   * Today's viewings, read the only way this CRM allows: out of the notes and
   * sub-statuses. There is no viewings endpoint on this key — /viewings and
   * every neighbour of it 403 — so an empty schedule here means nothing was
   * written down, which is worth seeing.
   */
  const schedule = useMemo(() => {
    if (!leads) return [];
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(now);
    const out = [];
    for (const lead of leads) {
      const { tier, at } = viewingEvidence(lead);
      if (!tier || !at) continue;
      const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(at);
      if (day >= today) out.push({ lead, tier, at, day });
    }
    return out.sort((a, b) => a.at - b.at).slice(0, 6);
  }, [leads, now]);

  if (state === "loading") {
    return (
      <Shell>
        <Card className="p-10 text-center">
          <RefreshCw className="w-5 h-5 text-slate-300 mx-auto animate-spin" />
          <p className="text-sm text-slate-500 mt-3">
            Reading {SUBJECT.first}’s book from the CRM…
          </p>
          <p className="text-xs text-slate-400 mt-1 tabular-nums">{count} leads</p>
        </Card>
      </Shell>
    );
  }

  if (state === "failed") {
    return (
      <Shell>
        <Card className="p-8">
          <p className="text-sm font-medium text-slate-900">The CRM did not answer.</p>
          <p className="text-sm text-slate-500 mt-1">{error}</p>
          <button onClick={() => load({ force: true })}
            className="mt-4 px-3 py-2 text-sm rounded-lg border border-slate-200 hover:bg-slate-50">
            Try again
          </button>
        </Card>
      </Shell>
    );
  }

  // A broker-scoped session asking for another agent gets its own rows back,
  // which fetchAgentLeads discards. That is the edge scoping working, not a
  // fault, and it needs saying rather than showing an empty dashboard.
  if (!brief || !brief.totals.book) {
    return (
      <Shell>
        <Card className="p-8">
          <p className="text-sm font-medium text-slate-900">
            No leads visible for {SUBJECT.name} under your access.
          </p>
          <p className="text-sm text-slate-500 mt-1 max-w-xl">
            This beta reads one specific broker’s book. If you are signed in as a broker,
            the edge scopes every lead request to your own rows, so another agent’s book
            correctly comes back empty rather than as an error.
          </p>
        </Card>
      </Shell>
    );
  }

  const { hot, atRisk, neverContacted, pipeline, rent, matches, byScore, totals } = brief;
  const top = byScore.slice(0, 3);
  const first = top[0];
  const matchCount = matches.reduce((s, m) => s + m.listings.length, 0);

  return (
    <Shell onRefresh={() => load({ force: true })} count={atRisk.length + neverContacted.length}>
      {/* ---------------------------- tiles ---------------------------- */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-5">
        <Tile icon={Flame} tint="bg-orange-50 text-orange-500" value={hot.length}
          label="Hot leads" sub="Scoring 70 or more" />
        <Tile icon={AlertTriangle} tint="bg-amber-50 text-amber-500" value={atRisk.length}
          label="At risk" sub="Committed, then went quiet" alert={atRisk.length > 0} />
        <Tile icon={Banknote} tint="bg-emerald-50 text-emerald-600" value={fmtPrice(pipeline.total)}
          label="Sale pipeline" sub={`Asking price · ${pipeline.priced} buyer enquiries`} />
        <Tile icon={PhoneOff} tint="bg-rose-50 text-rose-500" value={neverContacted.length}
          label="Never contacted" sub="No note, status untouched" alert={neverContacted.length > 0} />
        <Tile icon={Home} tint="bg-sky-50 text-sky-600" value={listings.length ? matchCount : "—"}
          label="New matches" sub={listings.length ? `Across ${matches.length} clients` : "Loading the book…"} />
      </div>

      {/* --------------------- three-column middle --------------------- */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 mb-4">
        <Panel title="Top leads to contact today">
          {top.length === 0 ? <Empty>Nothing open in this book.</Empty> : (
            <ul className="space-y-3 flex-1">
              {top.map((r) => (
                <li key={r.lead.id} className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold text-slate-900 truncate">{r.client.name}</p>
                      <Score score={r.score} band={r.band} />
                    </div>
                    <p className="text-xs text-slate-500 mt-0.5 truncate">
                      {[r.want.subLocation || r.want.location, r.want.beds ? `${r.want.beds} BR` : null,
                        r.want.unitType || r.want.category].filter(Boolean).join(" · ") || "No requirement recorded"}
                      {r.value ? ` · ${fmtPrice(r.value)}` : ""}
                    </p>
                    <p className="text-[11px] text-slate-400 mt-0.5 truncate" title={r.reasons.join(", ")}>
                      {r.reasons.join(" · ")}
                    </p>
                  </div>
                  <CallButtons client={r.client} compact />
                </li>
              ))}
            </ul>
          )}
          <p className="text-[11px] text-slate-400 mt-3 pt-3 border-t border-slate-100">
            Ranked by sub-status, enquiry age and time since the last note.
          </p>
        </Panel>

        <Panel title="Needs attention"
          right={<span className="text-[11px] text-slate-400">{atRisk.length} open</span>}>
          {atRisk.length === 0 ? (
            <Empty>Nothing committed has gone quiet. That is the good outcome.</Empty>
          ) : (
            <ul className="space-y-3 flex-1">
              {atRisk.slice(0, 3).map((r) => (
                <li key={r.lead.id}>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-slate-900 truncate">{r.client.name}</p>
                    <span className={`text-[10px] font-bold tracking-wide uppercase px-1.5 py-0.5 rounded ${
                      r.risk.level === "high" ? "bg-rose-50 text-rose-600" : "bg-amber-50 text-amber-600"}`}>
                      {r.risk.level} risk
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 mt-0.5">{r.risk.reason}</p>
                  <div className="flex items-center justify-between gap-2 mt-1.5">
                    <p className="text-[11px] text-slate-400 truncate">
                      {r.want.subLocation || r.want.location || "—"}
                      {r.value ? ` · ${fmtPrice(r.value)}` : ""}
                    </p>
                    <CallButtons client={r.client} compact />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Pipeline snapshot">
          {pipeline.total ? <PipelineRing pipeline={pipeline} /> : <Empty>No budgets recorded.</Empty>}
          <p className="text-[11px] text-slate-400 mt-4 pt-3 border-t border-slate-100 leading-snug">
            Asking price of the property each <strong className="font-semibold text-slate-500">buyer</strong> enquired
            against, banded by the same score the queue is ordered by. Not a weighted forecast.
            {pipeline.unpriced > 0 && ` ${pipeline.unpriced} carry no price.`}
            {rent.leads > 0 && ` Rent is excluded — ${rent.leads} tenant enquiries worth ${fmtPrice(rent.total)} a year sit outside this ring.`}
          </p>
        </Panel>
      </div>

      {/* ------------------- recommendation + schedule ------------------- */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 mb-4">
        <Card className="p-5 xl:col-span-2">
          <div className="flex items-center gap-2 mb-3">
            <Target className="w-4 h-4 text-slate-400" />
            <h2 className="text-[11px] font-bold tracking-wider text-slate-500 uppercase">
              Start here
            </h2>
          </div>
          {first ? (
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm text-slate-900 leading-relaxed max-w-2xl">
                  Call <span className="font-semibold">{first.client.name}</span> — {first.reasons.join(", ")}
                  {first.want.subLocation || first.want.location
                    ? <> , looking in <span className="font-medium">{first.want.subLocation || first.want.location}</span></>
                    : null}
                  {first.value ? <> at {fmtPrice(first.value)}</> : null}.
                  {" "}This is the highest-scoring open lead in the book at {first.score}.
                </p>
              </div>
              <CallButtons client={first.client} />
            </div>
          ) : <Empty>Nothing open to act on.</Empty>}
        </Card>

        <Panel title="Viewings on the calendar"
          right={<Calendar className="w-4 h-4 text-slate-300" />}>
          {schedule.length === 0 ? (
            <Empty>
              Nothing scheduled from today. This CRM has no viewings endpoint — the date is
              read out of notes and sub-statuses, so an empty list means none were written down.
            </Empty>
          ) : (
            <ul className="space-y-2.5">
              {schedule.map(({ lead, tier, at }) => (
                <li key={lead.id} className="flex items-start gap-3">
                  <span className="text-xs font-semibold text-slate-900 tabular-nums whitespace-nowrap pt-0.5">
                    {new Intl.DateTimeFormat("en-GB", {
                      timeZone: "Asia/Dubai", day: "numeric", month: "short",
                    }).format(at)}
                  </span>
                  <div className="min-w-0">
                    <p className="text-xs text-slate-700 truncate">{lead.contact?.first_name ?? "Client"} — {statusOf(lead)}</p>
                    <span className={`inline-block mt-1 text-[10px] px-1.5 py-0.5 rounded ${TIER_META[tier]?.tint ?? ""}`}>
                      {TIER_META[tier]?.label ?? tier}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {/* ---------------------------- matches ---------------------------- */}
      <Panel title="New matches for your clients"
        right={<span className="text-[11px] text-slate-400">
          {listings.length ? `${listings.length} live listings searched` : "Loading inventory…"}
        </span>}>
        {!listings.length ? (
          <Empty>Fetching the live book…</Empty>
        ) : matches.length === 0 ? (
          <Empty>Nothing in the live book fits an open requirement in this queue.</Empty>
        ) : (
          <ul className="divide-y divide-slate-100">
            {matches.slice(0, 5).map((m) => (
              <li key={m.lead.id} className="py-3 first:pt-0 last:pb-0">
                <div className="flex items-center gap-2 mb-1.5">
                  <p className="text-sm font-semibold text-slate-900 truncate">{m.client.name}</p>
                  <Score score={m.score} band={m.band} />
                  <span className="text-[11px] text-slate-400 truncate">
                    wants {wantedType(m.lead) === "sale" ? "to buy" : "to rent"} in{" "}
                    {m.want.subLocation || m.want.location}
                    {m.want.beds ? ` · ${m.want.beds} BR` : ""}
                    {m.value ? ` · up to ${fmtPrice(m.value)}` : ""}
                  </span>
                  <span className="ml-auto flex-shrink-0"><CallButtons client={m.client} compact /></span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {m.listings.map(({ listing: l, sameBuilding }) => (
                    <span key={l.id}
                      className={`text-[11px] rounded-lg px-2 py-1 border ${sameBuilding
                        ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                        : "bg-slate-50 border-slate-200 text-slate-600"}`}>
                      <span className="font-medium">{l.ref}</span>
                      {" · "}{l.sub_area_location?.name || l.area_location?.name}
                      {normaliseBeds(l.beds) != null
                        ? ` · ${normaliseBeds(l.beds) === 0 ? "Studio" : `${normaliseBeds(l.beds)} BR`}` : ""}
                      {l.price ? ` · ${fmtPrice(l.price)}` : ""}
                      {sameBuilding && <span className="ml-1 font-semibold">· same building</span>}
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="text-[11px] text-slate-400 mt-3 pt-3 border-t border-slate-100">
          Matched on what the client actually asked for: sale or rent, the area they named,
          their size or one bigger — never smaller — and inside their stated budget plus 10%.
          Their own building sorts to the front.
        </p>
      </Panel>

      {progress && (
        <p className="text-[11px] text-slate-500 mt-4 flex items-center gap-2">
          <RefreshCw className="w-3 h-3 animate-spin text-slate-400" />
          Still reading — page {progress.page}{progress.pages ? ` of ${progress.pages}` : ""}.
          The figures below rise as the rest of the book lands.
        </p>
      )}
      <p className="text-[11px] text-slate-400 mt-4">
        {totals.book} leads in {SUBJECT.first}’s book · {totals.live} open · {totals.closed} closed ·
        read live from the CRM at {new Intl.DateTimeFormat("en-GB", {
          timeZone: "Asia/Dubai", hour: "2-digit", minute: "2-digit",
        }).format(now)} Dubai time.
      </p>
    </Shell>
  );
}

function Shell({ children, onRefresh, count = 0 }) {
  const now = new Date();
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-slate-900 tracking-tight">
              {greeting(now)}, {SUBJECT.first}
            </h1>
            <span className="text-[10px] font-bold tracking-wider uppercase bg-slate-900 text-white
                             px-1.5 py-0.5 rounded">Beta</span>
          </div>
          <p className="text-sm text-slate-500 mt-1">
            Your briefing for today — {SUBJECT.role}.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {count > 0 && (
            <span className="flex items-center gap-1.5 text-xs text-slate-600 bg-white border
                             border-slate-200 rounded-lg px-3 py-2">
              <Clock className="w-3.5 h-3.5 text-slate-400" />
              {count} need action
            </span>
          )}
          <span className="flex items-center gap-2 text-xs text-slate-600 bg-white border
                           border-slate-200 rounded-lg px-3 py-2">
            <Calendar className="w-3.5 h-3.5 text-slate-400" />
            {dubaiDateLabel(now)}
          </span>
          {onRefresh && (
            <button onClick={onRefresh} title="Re-read the CRM"
              className="w-9 h-9 rounded-lg bg-white border border-slate-200 text-slate-500
                         hover:bg-slate-50 flex items-center justify-center transition">
              <RefreshCw className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
      {children}
    </>
  );
}
