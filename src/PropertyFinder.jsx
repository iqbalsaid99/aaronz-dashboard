import React, { useState, useEffect, useMemo, useCallback } from "react";
import {
  Loader2, AlertCircle, RefreshCw, Building2, Inbox, Users, Coins, Gauge,
  BadgeCheck, MessageCircle, Phone, Mail, ExternalLink, ChevronDown, Search,
  ShieldCheck, Trophy, Clock, TrendingDown, MapPin,
} from "lucide-react";
import {
  fetchListings, fetchLeads, fetchUsers, fetchSuperAgent, fetchProfileStats,
  fetchArena, fetchCreditBalance, fetchWallets, fetchCreditTransactions,
  fetchVerifications, fetchCreditsSpent, searchLocations, locationName,
  clearPfCache, tally, byDay, replyRate,
  fmtAed, fmtNum, fmtPct, fmtDuration, fmtDate, fmtDateTime, daysUntil,
  LEAD_DAYS, LISTING_STATES, CHANNELS, LEAD_STATUSES,
} from "./propertyfinder.js";

/**
 * Property Finder — the PF Expert account, rebuilt as one screen per question
 * rather than one screen per PF menu item.
 *
 * Everything here is our own data from the Enterprise API: the listings we
 * publish, the leads they generate, how the team is scored, and what it costs
 * in credits. It is not a market search — nothing about other agencies' stock
 * is available on this API.
 *
 * Colour carries meaning in exactly two ways and they never mix. Channels get a
 * fixed hue each (whatsapp emerald, call indigo, email amber) so a channel is
 * the same colour on every chart regardless of how it ranks. State — quality
 * bands, expiry, verification — uses the status tints, always beside a word,
 * never as the only signal.
 */

/* ------------------------------- atoms -------------------------------- */

const Card = ({ children, className = "" }) => (
  <div className={`bg-white border border-slate-200 rounded-2xl ${className}`}>{children}</div>
);

const ctrl =
  "text-sm border border-slate-200 rounded-xl px-3 py-2 bg-white outline-none focus:ring-2 focus:ring-indigo-200";

const CHANNEL_TINT = {
  whatsapp: "bg-emerald-600",
  call: "bg-indigo-600",
  email: "bg-amber-600",
};

const CHANNEL_ICON = { whatsapp: MessageCircle, call: Phone, email: Mail };

/** Quality bands, as PF grades them: 80+ green, 60+ amber, below that red. */
const qualityTint = (v) =>
  v >= 80 ? "bg-emerald-600" : v >= 60 ? "bg-amber-500" : "bg-rose-600";

const qualityText = (v) =>
  v >= 80 ? "text-emerald-700" : v >= 60 ? "text-amber-700" : "text-rose-700";

function Kpi({ icon: Icon, tint, label, value, sub, foot }) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2">
        <span className={`w-8 h-8 rounded-lg flex items-center justify-center ${tint}`}>
          <Icon className="w-4 h-4" strokeWidth={2} />
        </span>
        <p className="text-xs font-medium text-slate-600">{label}</p>
      </div>
      <p className="mt-3 text-3xl font-bold text-slate-900 tracking-tight">{value}</p>
      {sub && <p className="mt-1 text-xs text-slate-500">{sub}</p>}
      {foot && <p className="mt-2 text-[11px] text-slate-400 leading-relaxed">{foot}</p>}
    </Card>
  );
}

const Chip = ({ children, tint = "bg-slate-100 text-slate-600" }) => (
  <span className={`text-[11px] px-1.5 py-0.5 rounded whitespace-nowrap ${tint}`}>{children}</span>
);

/** Horizontal magnitude bar. The value is always written out beside it, which
 *  is what lets adjacent categorical hues sit within the CVD floor band.
 *
 *  `onClick` makes the whole row a button. It renders as a <button> rather than
 *  a clickable <div> so it is reachable by keyboard and reads as interactive to
 *  a screen reader, which a div with a handler does not. */
const BarRow = ({ label, value, max, tint = "bg-indigo-600", right, icon: Icon, onClick, active, title }) => {
  const inner = (
    <>
      <span className={`text-xs w-40 truncate flex items-center gap-1.5 flex-shrink-0 ${
          active ? "text-indigo-700 font-medium" : "text-slate-600"}`}
        title={title ?? label}>
        {Icon && <Icon className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />}
        {label}
      </span>
      <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden min-w-[40px]">
        <div className={`h-full rounded-full ${tint}`} style={{ width: `${max ? (value / max) * 100 : 0}%` }} />
      </div>
      <span className={`text-xs w-16 text-right flex-shrink-0 tabular-nums ${
          active ? "text-indigo-700 font-medium" : "text-slate-500"}`}>
        {right ?? fmtNum(value)}
      </span>
    </>
  );

  if (!onClick) return <div className="flex items-center gap-3">{inner}</div>;

  return (
    <button type="button" onClick={onClick} aria-pressed={active}
      className={`flex items-center gap-3 w-full text-left rounded-lg -mx-1.5 px-1.5 py-0.5
                  hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300
                  ${active ? "bg-indigo-50/70" : ""}`}>
      {inner}
    </button>
  );
};

/** Daily column chart with a hover read-out. One series, so no legend. */
function Trend({ series, tint = "bg-indigo-600", unit = "" }) {
  const [hover, setHover] = useState(null);
  const max = Math.max(1, ...series.map((d) => d.value));
  const h = hover != null ? series[hover] : null;

  return (
    <div>
      <div className="relative">
        {h && (
          <div className="absolute -top-1 z-10 pointer-events-none"
            style={{ left: `${((hover + 0.5) / series.length) * 100}%`, transform: "translateX(-50%)" }}>
            <div className="bg-slate-900 text-white text-[11px] rounded-lg px-2 py-1 whitespace-nowrap">
              <span className="font-semibold">{fmtNum(h.value)}{unit}</span>
              <span className="text-slate-300 ml-1.5">
                {h.date.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
              </span>
            </div>
          </div>
        )}
        <div className="h-24 flex items-end gap-[2px] pt-6">
          {series.map((d, i) => (
            <div key={d.day} className="flex-1 h-full flex items-end cursor-default"
              onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <div
                className={`w-full rounded-t-[4px] ${tint} ${hover === i ? "" : "opacity-80"}`}
                style={{ height: `${Math.max(d.value ? 6 : 2, (d.value / max) * 100)}%` }}
              />
            </div>
          ))}
        </div>
      </div>
      <div className="flex justify-between text-[10px] text-slate-400 mt-1.5">
        <span>{series[0]?.date.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span>
        <span>{series[series.length - 1]?.date.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span>
      </div>
    </div>
  );
}

function Avatar({ name, photo, size = "w-8 h-8" }) {
  const [failed, setFailed] = useState(false);
  const initials = String(name ?? "")
    .split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
  if (photo && !failed) {
    return <img src={photo} alt="" loading="lazy" onError={() => setFailed(true)}
      className={`${size} rounded-full object-cover bg-slate-100 flex-shrink-0`} style={{ objectPosition: "50% 25%" }} />;
  }
  return (
    <span className={`${size} rounded-full bg-slate-200 text-slate-600 text-[10px] font-semibold
                      flex items-center justify-center flex-shrink-0`}>{initials}</span>
  );
}

const Section = ({ title, note, children, right, className = "" }) => (
  <Card className={`p-5 ${className}`}>
    <div className="flex items-start justify-between gap-3 mb-4">
      <div>
        <p className="text-sm font-semibold text-slate-900">{title}</p>
        {note && <p className="text-xs text-slate-400 mt-0.5">{note}</p>}
      </div>
      {right}
    </div>
    {children}
  </Card>
);

const Empty = ({ children }) => (
  <p className="text-xs text-slate-400 py-6 text-center">{children}</p>
);

/* ------------------------------ overview ------------------------------ */

function Overview({ d, days, onView }) {
  const live = d.listings.filter((l) => l.live);
  const withQuality = d.listings.filter((l) => l.quality != null);
  const avgQuality = withQuality.length
    ? withQuality.reduce((s, l) => s + l.quality, 0) / withQuality.length : null;
  const verifiedLive = live.filter((l) => l.verification === "approved").length;
  const rate = replyRate(d.leads);

  const leadSeries = byDay(d.leads, days);
  const byChannel = tally(d.leads, (l) => l.channel);
  const maxChannel = Math.max(1, ...byChannel.map((r) => r.count));

  // The funnel is cumulative: a replied lead was also delivered and read.
  const rank = { sent: 0, delivered: 1, read: 2, replied: 3 };
  const funnel = LEAD_STATUSES.map((s, i) => ({
    key: s,
    count: d.leads.filter((l) => (rank[l.status] ?? -1) >= i).length,
  }));

  const cycleUsed = d.balance ? d.balance.used / Math.max(1, d.balance.total) : null;
  const cycleEnd = d.balance?.cycle?.endDate ? new Date(d.balance.cycle.endDate) : null;
  const daysLeftInCycle = daysUntil(cycleEnd);

  // What will bite next. Everything here is a date or a threshold, not a mood.
  const attention = [
    {
      label: "Live but not verified",
      n: live.filter((l) => l.verification !== "approved").length,
      hint: "Verification is worth 20 points of quality score on its own.",
      view: "quality",
    },
    {
      label: "Live with quality under 60",
      n: live.filter((l) => l.quality != null && l.quality < 60).length,
      hint: "Red-band listings are pushed down search results.",
      view: "quality",
    },
    {
      label: "Featured/premium expiring in 14 days",
      n: d.listings.filter((l) => l.level && l.level !== "standard" &&
        daysUntil(l.levelExpiresAt) !== null && daysUntil(l.levelExpiresAt) <= 14 && daysUntil(l.levelExpiresAt) >= 0).length,
      hint: "They drop to standard placement silently when they lapse.",
      view: "listings",
    },
    {
      label: "Verifications expiring in 30 days",
      n: d.verifications.filter((v) => v.status === "approved" &&
        daysUntil(new Date(v.expiresAt)) !== null && daysUntil(new Date(v.expiresAt)) <= 30 && daysUntil(new Date(v.expiresAt)) >= 0).length,
      hint: "Re-submit before expiry or the listing loses its badge.",
      view: "quality",
    },
    {
      // Counted over the agents the Agents tab actually lists — the ones with
      // listings, leads or scoring. The account carries 130-odd logins, most of
      // them dormant, and flagging their paperwork sends you to an empty table.
      label: "BRN expired or expiring in 30 days",
      n: d.agents.filter((a) => a.brnExpiry && daysUntil(a.brnExpiry) <= 30).length,
      hint: "An agent cannot legally advertise on a lapsed broker number.",
      view: "agents",
    },
    {
      label: "Unanswered leads",
      n: d.leads.filter((l) => l.status !== "replied").length,
      hint: `Out of ${fmtNum(d.leads.length)} in the last ${days} days.`,
      view: "leads",
    },
  ].filter((r) => r.n > 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
        <Kpi icon={Building2} tint="bg-indigo-50 text-indigo-600" label="Live listings"
          value={fmtNum(live.length)}
          sub={`${fmtNum(d.listings.length)} published all-time`} />
        <Kpi icon={Inbox} tint="bg-emerald-50 text-emerald-600" label={`Leads · ${days}d`}
          value={fmtNum(d.leads.length)}
          sub={`${fmtNum(byChannel[0]?.count ?? 0)} on ${byChannel[0]?.key ?? "—"}`} />
        <Kpi icon={MessageCircle} tint="bg-slate-100 text-slate-600" label="Replied"
          value={fmtPct(rate)}
          sub={`${fmtNum(d.leads.filter((l) => l.status === "replied").length)} of ${fmtNum(d.leads.length)}`} />
        <Kpi icon={Gauge} tint="bg-amber-50 text-amber-600" label="Avg quality score"
          value={avgQuality == null ? "—" : Math.round(avgQuality)}
          sub={`${withQuality.filter((l) => l.quality >= 80).length} of ${withQuality.length} in the green`} />
        <Kpi icon={BadgeCheck} tint="bg-emerald-50 text-emerald-600" label="Verified · live"
          value={live.length ? fmtPct(verifiedLive / live.length) : "—"}
          sub={`${fmtNum(verifiedLive)} of ${fmtNum(live.length)} live listings`} />
        <Kpi icon={Coins} tint="bg-slate-100 text-slate-600" label="Credits left"
          value={d.balance ? fmtNum(d.balance.remaining) : "—"}
          sub={d.balance ? `${fmtPct(cycleUsed)} of ${fmtNum(d.balance.total)} used` : null}
          foot={daysLeftInCycle != null ? `Cycle ends ${fmtDate(cycleEnd)} · ${daysLeftInCycle} days` : null} />
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        <Section className="lg:col-span-2" title={`Leads per day · last ${days} days`}
          note="Every enquiry PF attributes to us, whatever it landed on.">
          {d.leads.length ? <Trend series={leadSeries} /> : <Empty>No leads in this window.</Empty>}
        </Section>

        <Section title="How they arrive" note="Channel is fixed-coloured across this tab.">
          <div className="space-y-2">
            {byChannel.map((r) => (
              <BarRow key={r.key} label={r.key} value={r.count} max={maxChannel}
                tint={CHANNEL_TINT[r.key] ?? "bg-slate-400"} icon={CHANNEL_ICON[r.key]}
                right={`${r.count} · ${fmtPct(r.count / Math.max(1, d.leads.length))}`} />
            ))}
            {!byChannel.length && <Empty>Nothing yet.</Empty>}
          </div>
        </Section>
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        <Section title="Where leads stop"
          note="Cumulative — a replied lead was also delivered and read.">
          <div className="space-y-2">
            {funnel.map((f, i) => (
              <BarRow key={f.key} label={f.key} value={f.count} max={Math.max(1, funnel[0].count)}
                tint={["bg-indigo-200", "bg-indigo-400", "bg-indigo-500", "bg-indigo-700"][i]}
                right={`${f.count} · ${fmtPct(f.count / Math.max(1, funnel[0].count))}`} />
            ))}
          </div>
        </Section>

        <Section title="Inventory" note="Published listings by state and placement.">
          <div className="space-y-2">
            {tally(d.listings, (l) => l.state).map((r) => (
              <BarRow key={r.key} label={r.key === "takendown" ? "taken down" : r.key} value={r.count}
                max={d.listings.length} tint="bg-slate-400" />
            ))}
            <div className="pt-2 mt-2 border-t border-slate-100 space-y-2">
              {tally(d.listings.filter((l) => l.live), (l) => l.level ?? "standard").map((r) => (
                <BarRow key={r.key} label={`${r.key} · live`} value={r.count}
                  max={Math.max(1, d.listings.filter((l) => l.live).length)}
                  tint={r.key === "premium" ? "bg-indigo-600" : r.key === "featured" ? "bg-indigo-400" : "bg-slate-300"} />
              ))}
            </div>
          </div>
        </Section>

        <Section title="Needs attention" note="Counted now, from live data.">
          {attention.length ? (
            <div className="space-y-2">
              {attention.map((a) => (
                <button key={a.label} onClick={() => onView(a.view)}
                  className="w-full text-left flex items-start gap-3 p-2 -mx-2 rounded-lg hover:bg-slate-50">
                  <span className="text-sm font-semibold text-slate-900 w-9 text-right tabular-nums flex-shrink-0">
                    {fmtNum(a.n)}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-xs font-medium text-slate-700">{a.label}</span>
                    <span className="block text-[11px] text-slate-400 leading-snug">{a.hint}</span>
                  </span>
                </button>
              ))}
            </div>
          ) : <Empty>Nothing outstanding.</Empty>}
        </Section>
      </div>
    </div>
  );
}

/* ------------------------------ listings ------------------------------ */

const LEVEL_TINT = {
  premium: "bg-indigo-50 text-indigo-700",
  featured: "bg-sky-50 text-sky-700",
  standard: "bg-slate-100 text-slate-500",
};

const VERIFY_TINT = {
  approved: "bg-emerald-50 text-emerald-700",
  pending: "bg-amber-50 text-amber-700",
  rejected: "bg-rose-50 text-rose-700",
  expired: "bg-rose-50 text-rose-700",
};

const FACTOR_LABEL = {
  imagesDimensions: "Photo sizes",
  imageDuplicates: "Duplicate photos",
  imageDiversity: "Photo variety",
  image: "Photo count",
  listingCompletion: "Fields filled in",
  location: "Location detail",
  description: "Description",
  title: "Title",
  verified: "Verification",
};

function ListingRow({ l, expanded, onToggle, spent }) {
  const area = locationName(l.locationId);
  return (
    <>
      <tr className="border-b border-slate-100 hover:bg-slate-50/60 cursor-pointer" onClick={onToggle}>
        <td className="px-3 py-2.5">
          <div className="flex items-center gap-3 min-w-0">
            {l.photo
              ? <img src={l.photo} alt="" loading="lazy" className="w-12 h-9 rounded object-cover bg-slate-100 flex-shrink-0" />
              : <span className="w-12 h-9 rounded bg-slate-100 flex-shrink-0" />}
            <div className="min-w-0">
              <p className="text-sm text-slate-900 truncate max-w-[22rem]">{l.title ?? "—"}</p>
              <p className="text-[11px] text-slate-400 truncate">
                <span className="font-mono">{l.ref}</span>
                {area ? <> · <MapPin className="w-3 h-3 inline -mt-0.5" /> {area}</> : null}
                {" · "}{l.type}{l.beds ? ` · ${l.beds} bed` : ""}{l.size ? ` · ${Math.round(l.size).toLocaleString()} sqft` : ""}
              </p>
            </div>
          </div>
        </td>
        <td className="px-3 py-2.5 whitespace-nowrap">
          <p className="text-sm font-semibold text-slate-900">{fmtAed(l.price)}</p>
          <p className="text-[11px] text-slate-400">
            {l.offering === "sale" ? "sale" : `${l.priceType}${l.cheques ? ` · ${l.cheques} chq` : ""}`}
          </p>
        </td>
        <td className="px-3 py-2.5">
          <div className="flex items-center gap-2 min-w-0">
            <Avatar name={l.agentName} photo={l.agentPhoto} size="w-6 h-6" />
            <span className="text-xs text-slate-600 truncate max-w-[8rem]">{l.agentName ?? "—"}</span>
          </div>
        </td>
        <td className="px-3 py-2.5">
          {l.quality == null ? <span className="text-xs text-slate-400">—</span> : (
            <div className="flex items-center gap-2">
              <div className="w-16 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                <div className={`h-full rounded-full ${qualityTint(l.quality)}`} style={{ width: `${l.quality}%` }} />
              </div>
              <span className={`text-xs font-medium tabular-nums ${qualityText(l.quality)}`}>{l.quality}</span>
            </div>
          )}
        </td>
        <td className="px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-1">
            {l.live
              ? <Chip tint="bg-emerald-50 text-emerald-700">live</Chip>
              : <Chip>{l.state === "takendown" ? "taken down" : l.state}</Chip>}
            {l.level && l.level !== "standard" && <Chip tint={LEVEL_TINT[l.level]}>{l.level}</Chip>}
            {l.verification && l.verification !== "approved" && (
              <Chip tint={VERIFY_TINT[l.verification] ?? "bg-slate-100 text-slate-600"}>{l.verification}</Chip>
            )}
            {l.verification === "approved" && (
              <span className="inline-flex items-center gap-0.5 text-[11px] text-emerald-700">
                <BadgeCheck className="w-3.5 h-3.5" />verified
              </span>
            )}
          </div>
        </td>
        <td className="px-3 py-2.5 text-right">
          <ChevronDown className={`w-4 h-4 text-slate-300 inline transition-transform ${expanded ? "rotate-180" : ""}`} />
        </td>
      </tr>

      {expanded && (
        <tr className="border-b border-slate-100 bg-slate-50/60">
          <td colSpan={6} className="px-3 py-4">
            <div className="grid md:grid-cols-3 gap-6">
              <div>
                <p className="text-xs font-semibold text-slate-700 mb-2">
                  Quality — {l.quality ?? "—"}/100
                </p>
                {l.qualityIssues.length ? (
                  <div className="space-y-1.5">
                    {l.qualityIssues.map((f) => (
                      <div key={f.key} className="flex items-center justify-between gap-3 text-xs">
                        <span className="text-slate-600">
                          {FACTOR_LABEL[f.key] ?? f.key}
                          {f.tag && f.tag !== "Ok" && <span className="text-slate-400"> · {f.tag}</span>}
                        </span>
                        <span className="text-rose-700 font-medium tabular-nums flex-shrink-0">−{f.lost}</span>
                      </div>
                    ))}
                    <p className="text-[11px] text-slate-400 pt-1">
                      {l.qualityIssues[0].help ?? "Points recoverable by fixing the items above."}
                    </p>
                  </div>
                ) : <p className="text-xs text-slate-400">Full marks — nothing to fix.</p>}
              </div>

              <div className="text-xs space-y-1.5">
                <p className="text-xs font-semibold text-slate-700 mb-2">Listing</p>
                <Detail k="Permit" v={l.permit ? `${l.permit}${l.permitType ? ` (${l.permitType.toUpperCase()})` : ""}` : "—"} />
                <Detail k="Photos" v={fmtNum(l.images)} />
                <Detail k="Furnishing" v={l.furnishing ?? "—"} />
                <Detail k="Created" v={fmtDate(l.createdAt)} />
                <Detail k="Published" v={fmtDate(l.publishedAt)} />
                <Detail k="Last updated" v={fmtDate(l.updatedAt)} />
                {l.level && l.level !== "standard" && (
                  <Detail k={`${l.level} until`} v={fmtDate(l.levelExpiresAt)} />
                )}
              </div>

              <div className="text-xs space-y-1.5">
                <p className="text-xs font-semibold text-slate-700 mb-2">Cost &amp; state</p>
                <Detail k="Credits spent" v={spent === undefined ? "…" : fmtNum(spent ?? 0)} />
                <Detail k="State" v={l.stateDetail ?? l.state} />
                {l.stateReason && <p className="text-[11px] text-slate-500 leading-relaxed pt-1">{l.stateReason}</p>}
                {l.locationId && !locationName(l.locationId) && (
                  <p className="text-[11px] text-slate-400 pt-1">
                    Area id {l.locationId} — search an area below to learn its name.
                  </p>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

const Detail = ({ k, v }) => (
  <div className="flex justify-between gap-3">
    <span className="text-slate-400">{k}</span>
    <span className="text-slate-700 text-right">{v}</span>
  </div>
);

function ListingsView({ d }) {
  const [state, setState] = useState("live");
  const [category, setCategory] = useState("");
  const [offering, setOffering] = useState("");
  const [level, setLevel] = useState("");
  const [verification, setVerification] = useState("");
  const [agent, setAgent] = useState("");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("quality");
  const [open, setOpen] = useState(null);
  const [spent, setSpent] = useState({});

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    const out = d.listings.filter((l) =>
      (!state || l.state === state) &&
      (!category || l.category === category) &&
      (!offering || l.offering === offering) &&
      (!level || (l.level ?? "standard") === level) &&
      (!verification || (l.verification ?? "none") === verification) &&
      (!agent || String(l.agentId) === agent) &&
      (!term || [l.title, l.ref, l.permit, l.agentName].some((v) => String(v ?? "").toLowerCase().includes(term)))
    );
    const by = {
      quality: (a, b) => (a.quality ?? 999) - (b.quality ?? 999),
      price: (a, b) => (b.price ?? 0) - (a.price ?? 0),
      created: (a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0),
      updated: (a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0),
    };
    return out.sort(by[sort] ?? by.quality);
  }, [d.listings, state, category, offering, level, verification, agent, q, sort]);

  // Credits spent is a separate call capped at 20 ids, so it is fetched for the
  // rows actually on screen rather than the whole book.
  useEffect(() => {
    const ids = rows.slice(0, 20).map((l) => l.id).filter((id) => !(id in spent));
    if (!ids.length) return;
    let alive = true;
    fetchCreditsSpent(ids).then((m) => {
      if (!alive) return;
      setSpent((prev) => {
        const next = { ...prev };
        for (const id of ids) next[id] = m.get(id) ?? 0;
        return next;
      });
    }).catch(() => { /* cost is a nicety, not a blocker */ });
    return () => { alive = false; };
  }, [rows, spent]);

  const agents = useMemo(() => {
    const m = new Map();
    for (const l of d.listings) if (l.agentId) m.set(String(l.agentId), l.agentName);
    return [...m.entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1])));
  }, [d.listings]);

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex flex-wrap gap-2 items-center">
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Title, ref, permit, agent"
              className={`${ctrl} pl-9 w-56`} />
          </div>
          <select value={state} onChange={(e) => setState(e.target.value)} className={ctrl}>
            {LISTING_STATES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <select value={category} onChange={(e) => setCategory(e.target.value)} className={ctrl}>
            <option value="">Any category</option>
            <option value="residential">Residential</option>
            <option value="commercial">Commercial</option>
          </select>
          <select value={offering} onChange={(e) => setOffering(e.target.value)} className={ctrl}>
            <option value="">Sale &amp; rent</option>
            <option value="sale">For sale</option>
            <option value="rent">For rent</option>
          </select>
          <select value={level} onChange={(e) => setLevel(e.target.value)} className={ctrl}>
            <option value="">Any placement</option>
            <option value="premium">Premium</option>
            <option value="featured">Featured</option>
            <option value="standard">Standard</option>
          </select>
          <select value={verification} onChange={(e) => setVerification(e.target.value)} className={ctrl}>
            <option value="">Any verification</option>
            <option value="approved">Verified</option>
            <option value="pending">Pending</option>
            <option value="rejected">Rejected</option>
            <option value="none">Never submitted</option>
          </select>
          <select value={agent} onChange={(e) => setAgent(e.target.value)} className={ctrl}>
            <option value="">Every agent</option>
            {agents.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
          <select value={sort} onChange={(e) => setSort(e.target.value)} className={ctrl}>
            <option value="quality">Worst quality first</option>
            <option value="price">Highest price</option>
            <option value="created">Newest</option>
            <option value="updated">Recently updated</option>
          </select>
        </div>
        <p className="text-xs text-slate-400 mt-3">
          {fmtNum(rows.length)} of {fmtNum(d.listings.length)} published listings. Click a row for its quality
          breakdown and lifetime credit cost.
        </p>
      </Card>

      <Card className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b border-slate-200 bg-slate-50">
              <th className="px-3 py-2.5 font-medium">Listing</th>
              <th className="px-3 py-2.5 font-medium">Price</th>
              <th className="px-3 py-2.5 font-medium">Agent</th>
              <th className="px-3 py-2.5 font-medium">Quality</th>
              <th className="px-3 py-2.5 font-medium">State</th>
              <th className="px-3 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 200).map((l) => (
              <ListingRow key={l.id} l={l} spent={spent[l.id]}
                expanded={open === l.id} onToggle={() => setOpen(open === l.id ? null : l.id)} />
            ))}
          </tbody>
        </table>
        {!rows.length && <Empty>Nothing matches those filters.</Empty>}
        {rows.length > 200 && (
          <p className="text-xs text-slate-400 px-3 py-3 border-t border-slate-100">
            Showing the first 200 of {fmtNum(rows.length)}. Narrow the filters to see the rest.
          </p>
        )}
      </Card>
    </div>
  );
}

/* -------------------------------- leads ------------------------------- */

/**
 * One listing, opened from the "Busiest listings" bars, with the leads table
 * below filtered to it.
 *
 * The ref on its own says nothing, which is the whole reason this exists: a
 * listing pulling a quarter of the month's enquiries is either the best ad on
 * the account or an underpriced one drawing the wrong people, and price against
 * reply rate is what separates the two.
 *
 * `focus.listing` is null when the ref no longer sits in the published set —
 * the leads survive a takedown, so the lead half is still shown rather than the
 * whole card disappearing.
 */
function FocusedListing({ focus, onClear }) {
  const { listing: l, leads, replied, byChannel, agents, share, ref } = focus;
  const area = l ? locationName(l.locationId) : null;
  const times = leads.map((x) => x.at).filter(Boolean).sort((a, b) => new Date(a) - new Date(b));

  return (
    <Card className="p-4 border-indigo-200 bg-indigo-50/30">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          {l?.photo
            ? <img src={l.photo} alt="" loading="lazy"
                className="w-28 h-20 rounded-lg object-cover bg-slate-100 flex-shrink-0" />
            : <span className="w-28 h-20 rounded-lg bg-slate-100 flex-shrink-0 flex items-center justify-center">
                <Building2 className="w-5 h-5 text-slate-300" />
              </span>}
          <div className="min-w-0">
            <p className="text-sm font-semibold text-slate-900">
              {l?.title ?? "No longer published"}
            </p>
            <p className="text-[11px] text-slate-500 mt-0.5 truncate">
              <span className="font-mono">{ref}</span>
              {area ? <> · <MapPin className="w-3 h-3 inline -mt-0.5" /> {area}</> : null}
              {l?.type ? ` · ${l.type}` : ""}
              {l?.beds ? ` · ${l.beds} bed` : ""}
              {l?.size ? ` · ${Math.round(l.size).toLocaleString()} sqft` : ""}
            </p>
            {l && (
              <div className="flex flex-wrap items-center gap-1.5 mt-2">
                <span className="text-sm font-semibold text-slate-900">{fmtAed(l.price)}</span>
                <span className="text-[11px] text-slate-400">
                  {l.offering === "sale" ? "sale" : `${l.priceType}${l.cheques ? ` · ${l.cheques} chq` : ""}`}
                </span>
                {l.quality != null && (
                  <span className={`text-[11px] font-medium ${qualityText(l.quality)}`}>
                    · quality {l.quality}
                  </span>
                )}
                {l.live
                  ? <Chip tint="bg-emerald-50 text-emerald-700">live</Chip>
                  : <Chip>{l.state === "takendown" ? "taken down" : l.state}</Chip>}
                {l.level && l.level !== "standard" && <Chip tint={LEVEL_TINT[l.level]}>{l.level}</Chip>}
              </div>
            )}
            {l?.agentName && (
              <div className="flex items-center gap-2 mt-2">
                <Avatar name={l.agentName} photo={l.agentPhoto} size="w-5 h-5" />
                <span className="text-[11px] text-slate-500">{l.agentName}</span>
              </div>
            )}
          </div>
        </div>
        <button onClick={onClear}
          className="text-xs text-slate-500 hover:text-slate-900 px-2.5 py-1 rounded-lg
                     hover:bg-white flex-shrink-0">
          Clear
        </button>
      </div>

      <div className="mt-4 pt-3 border-t border-indigo-100 grid sm:grid-cols-3 gap-4">
        <div>
          <p className="text-[11px] text-slate-500">Leads</p>
          <p className="text-2xl font-bold text-slate-900 tracking-tight">{fmtNum(leads.length)}</p>
          <p className="text-[11px] text-slate-400 mt-0.5">
            {fmtPct(share)} of every lead in this window
          </p>
        </div>
        <div>
          <p className="text-[11px] text-slate-500">Replied</p>
          <p className={`text-2xl font-bold tracking-tight ${
              leads.length && replied / leads.length < 0.5 ? "text-rose-700" : "text-slate-900"}`}>
            {fmtPct(leads.length ? replied / leads.length : 0)}
          </p>
          <p className="text-[11px] text-slate-400 mt-0.5">
            {replied} of {leads.length} marked replied
          </p>
        </div>
        <div>
          <p className="text-[11px] text-slate-500">First to last enquiry</p>
          <p className="text-xs text-slate-700 mt-1.5">
            {times.length
              ? <>{fmtDateTime(times[0])}<br />{fmtDateTime(times[times.length - 1])}</>
              : "—"}
          </p>
        </div>
      </div>

      <div className="mt-3 pt-3 border-t border-indigo-100 grid sm:grid-cols-2 gap-x-6 gap-y-2">
        <div>
          <p className="text-[11px] font-medium text-slate-500 mb-1.5">By channel</p>
          <div className="space-y-1.5">
            {byChannel.map((c) => (
              <BarRow key={c.key} label={c.key} value={c.count}
                max={Math.max(1, byChannel[0].count)}
                tint={CHANNEL_TINT[c.key] ?? "bg-slate-400"}
                icon={CHANNEL_ICON[c.key] ?? MessageCircle} />
            ))}
          </div>
        </div>
        <div>
          <p className="text-[11px] font-medium text-slate-500 mb-1.5">Who took them</p>
          <div className="space-y-1.5">
            {agents.slice(0, 5).map((a) => (
              <BarRow key={a.key} label={a.key} value={a.count} max={Math.max(1, agents[0].count)}
                tint="bg-slate-400" />
            ))}
            {!agents.length && <p className="text-[11px] text-slate-400">Unassigned.</p>}
          </div>
        </div>
      </div>
    </Card>
  );
}

function LeadsView({ d, days }) {
  const [channel, setChannel] = useState("");
  const [status, setStatus] = useState("");
  const [agent, setAgent] = useState("");
  const [q, setQ] = useState("");
  // Set by clicking a bar under "Busiest listings". Kept separate from `q` so
  // typing in the search box does not silently drop the listing you picked.
  const [focusRef, setFocusRef] = useState(null);

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    return d.leads.filter((l) =>
      (!focusRef || l.listingRef === focusRef) &&
      (!channel || l.channel === channel) &&
      (!status || l.status === status) &&
      (!agent || String(l.agentId) === agent) &&
      (!term || [l.senderName, l.phone, l.email, l.listingRef].some((v) => String(v ?? "").toLowerCase().includes(term)))
    );
  }, [d.leads, channel, status, agent, q, focusRef]);

  const agentName = useCallback((id) => d.agentsById.get(id)?.name ?? null, [d.agentsById]);

  const perAgent = useMemo(() => {
    const m = new Map();
    for (const l of d.leads) {
      if (!l.agentId) continue;
      const e = m.get(l.agentId) ?? { id: l.agentId, total: 0, replied: 0 };
      e.total++;
      if (l.status === "replied") e.replied++;
      m.set(l.agentId, e);
    }
    return [...m.values()].sort((a, b) => b.total - a.total);
  }, [d.leads]);

  const byEntity = tally(d.leads, (l) => l.entityType);
  const topListings = tally(d.leads.filter((l) => l.listingRef), (l) => l.listingRef).slice(0, 8);

  // Leads reference a listing by ref, so the join is on ref rather than id.
  const listingByRef = useMemo(() => {
    const m = new Map();
    for (const l of d.listings) if (l.ref) m.set(l.ref, l);
    return m;
  }, [d.listings]);

  // Everything about the listing being focused on, or null. A lead can point at
  // a ref that has since left the published set, so the listing half may be
  // missing while the lead half is not.
  const focus = useMemo(() => {
    if (!focusRef) return null;
    const leads = d.leads.filter((l) => l.listingRef === focusRef);
    return {
      ref: focusRef,
      listing: listingByRef.get(focusRef) ?? null,
      leads,
      replied: leads.filter((l) => l.status === "replied").length,
      byChannel: tally(leads, (l) => l.channel),
      agents: tally(leads.filter((l) => l.agentId), (l) => agentName(l.agentId) ?? `#${l.agentId}`),
      share: d.leads.length ? leads.length / d.leads.length : 0,
    };
  }, [focusRef, d.leads, listingByRef, agentName]);

  return (
    <div className="space-y-4">
      <div className="grid lg:grid-cols-3 gap-4">
        <Section className="lg:col-span-2" title={`Leads per day · last ${days} days`}
          note={`${fmtNum(d.leads.length)} in total · ${fmtPct(replyRate(d.leads))} replied`}>
          {d.leads.length ? <Trend series={byDay(d.leads, days)} /> : <Empty>No leads in this window.</Empty>}
        </Section>
        <Section title="What they came from" note="Listing, agent profile, or the agency page.">
          <div className="space-y-2">
            {byEntity.map((r) => (
              <BarRow key={r.key} label={r.key} value={r.count} max={Math.max(1, byEntity[0].count)} tint="bg-slate-400" />
            ))}
            <div className="pt-3 mt-1 border-t border-slate-100">
              <p className="text-[11px] font-medium text-slate-500 mb-2">
                Busiest listings
                <span className="text-slate-400 font-normal"> · click one to see its leads</span>
              </p>
              <div className="space-y-1.5">
                {topListings.map((r) => (
                  <BarRow key={r.key} label={r.key} value={r.count}
                    max={Math.max(1, topListings[0].count)} tint="bg-indigo-500"
                    active={focusRef === r.key}
                    title={listingByRef.get(r.key)?.title ?? `${r.key} — no longer published`}
                    onClick={() => setFocusRef(focusRef === r.key ? null : r.key)} />
                ))}
                {!topListings.length && <Empty>None.</Empty>}
              </div>
            </div>
          </div>
        </Section>
      </div>

      <Section title="Who is answering" note="Reply rate is the share of that agent's leads marked replied.">
        <div className="space-y-2">
          {perAgent.slice(0, 12).map((a) => (
            <div key={a.id} className="flex items-center gap-3">
              <span className="w-40 flex items-center gap-2 flex-shrink-0 min-w-0">
                <Avatar name={agentName(a.id)} photo={d.agentsById.get(a.id)?.photo} size="w-6 h-6" />
                <span className="text-xs text-slate-600 truncate">{agentName(a.id) ?? `#${a.id}`}</span>
              </span>
              <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden flex gap-[2px] min-w-[60px]">
                <div className="h-full rounded-full bg-emerald-600"
                  style={{ width: `${(a.replied / Math.max(1, perAgent[0].total)) * 100}%` }} />
                <div className="h-full rounded-full bg-slate-300"
                  style={{ width: `${((a.total - a.replied) / Math.max(1, perAgent[0].total)) * 100}%` }} />
              </div>
              <span className="text-xs text-slate-500 w-28 text-right flex-shrink-0 tabular-nums">
                {a.replied}/{a.total} · {fmtPct(a.replied / a.total)}
              </span>
            </div>
          ))}
          {!perAgent.length && <Empty>No leads to attribute.</Empty>}
        </div>
        <p className="text-[11px] text-slate-400 mt-3">
          Green is replied, grey is not. Bars are scaled against the busiest agent, so length is volume and
          the split is responsiveness.
        </p>
      </Section>

      {focus && <FocusedListing focus={focus} onClear={() => setFocusRef(null)} />}

      <Card className="p-4">
        <div className="flex flex-wrap gap-2 items-center">
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, phone, email, ref"
              className={`${ctrl} pl-9 w-56`} />
          </div>
          <select value={channel} onChange={(e) => setChannel(e.target.value)} className={ctrl}>
            <option value="">Every channel</option>
            {CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className={ctrl}>
            <option value="">Any status</option>
            {LEAD_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={agent} onChange={(e) => setAgent(e.target.value)} className={ctrl}>
            <option value="">Every agent</option>
            {perAgent.map((a) => (
              <option key={a.id} value={String(a.id)}>{agentName(a.id) ?? `#${a.id}`}</option>
            ))}
          </select>
          <span className="text-xs text-slate-400">{fmtNum(rows.length)} leads</span>
        </div>
      </Card>

      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b border-slate-200 bg-slate-50">
              <th className="px-4 py-2.5 font-medium">When</th>
              <th className="px-3 py-2.5 font-medium">From</th>
              <th className="px-3 py-2.5 font-medium">Channel</th>
              <th className="px-3 py-2.5 font-medium">On</th>
              <th className="px-3 py-2.5 font-medium">Agent</th>
              <th className="px-3 py-2.5 font-medium">Status</th>
              <th className="px-3 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 300).map((l) => {
              const Icon = CHANNEL_ICON[l.channel] ?? MessageCircle;
              return (
                <tr key={l.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60">
                  <td className="px-4 py-2.5 text-slate-500 whitespace-nowrap text-xs">{fmtDateTime(l.at)}</td>
                  <td className="px-3 py-2.5 min-w-0">
                    <p className="text-slate-900 truncate max-w-[12rem]">{l.senderName ?? "—"}</p>
                    <p className="text-[11px] text-slate-400 truncate">{l.phone ?? l.email ?? "—"}</p>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="inline-flex items-center gap-1.5 text-xs text-slate-600">
                      <span className={`w-1.5 h-1.5 rounded-full ${CHANNEL_TINT[l.channel] ?? "bg-slate-400"}`} />
                      <Icon className="w-3.5 h-3.5 text-slate-400" />{l.channel}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-xs">
                    {l.listingRef
                      ? <span className="font-mono text-slate-600">{l.listingRef}</span>
                      : <span className="text-slate-400">{l.entityType}</span>}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-slate-600 truncate max-w-[9rem]">
                    {agentName(l.agentId) ?? "—"}
                  </td>
                  <td className="px-3 py-2.5">
                    <Chip tint={l.status === "replied"
                      ? "bg-emerald-50 text-emerald-700"
                      : l.status === "read" ? "bg-amber-50 text-amber-700" : "bg-slate-100 text-slate-600"}>
                      {l.status}
                    </Chip>
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    {l.responseLink && (
                      <a href={l.responseLink} target="_blank" rel="noreferrer"
                        className="p-1.5 rounded-lg hover:bg-slate-100 inline-block" title="Open in Property Finder">
                        <ExternalLink className="w-3.5 h-3.5 text-slate-400" />
                      </a>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!rows.length && <Empty>No leads match those filters.</Empty>}
      </Card>
    </div>
  );
}

/* -------------------------------- agents ------------------------------ */

function AgentsView({ d, days }) {
  const [open, setOpen] = useState(null);
  const [sort, setSort] = useState("leads");

  const rows = useMemo(() => {
    const by = {
      leads: (a, b) => b.leads - a.leads,
      listings: (a, b) => b.liveListings - a.liveListings,
      quality: (a, b) => (b.quality ?? -1) - (a.quality ?? -1),
      response: (a, b) => (a.responseTime ?? Infinity) - (b.responseTime ?? Infinity),
      value: (a, b) => b.liveValue - a.liveValue,
    };
    return [...d.agents].sort(by[sort] ?? by.leads);
  }, [d.agents, sort]);

  return (
    <div className="space-y-4">
      <Card className="p-4 flex flex-wrap items-center gap-2">
        <span className="text-xs text-slate-500">Sort by</span>
        <select value={sort} onChange={(e) => setSort(e.target.value)} className={ctrl}>
          <option value="leads">Leads received</option>
          <option value="listings">Live listings</option>
          <option value="quality">Quality score</option>
          <option value="response">Fastest response</option>
          <option value="value">Live stock value</option>
        </select>
        <p className="text-xs text-slate-400 ml-auto">
          Response rate, quality and SuperAgent points come from PF's own scoring and only exist for the
          {" "}{fmtNum(d.agents.filter((a) => a.superAgent).length)} profiles enrolled in SuperAgent.
        </p>
      </Card>

      <Card className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b border-slate-200 bg-slate-50">
              <th className="px-4 py-2.5 font-medium">Agent</th>
              <th className="px-3 py-2.5 font-medium text-right">Live</th>
              <th className="px-3 py-2.5 font-medium text-right">Stock value</th>
              <th className="px-3 py-2.5 font-medium text-right">Leads · {days}d</th>
              <th className="px-3 py-2.5 font-medium text-right">Replied</th>
              <th className="px-3 py-2.5 font-medium text-right">Response</th>
              <th className="px-3 py-2.5 font-medium">Quality</th>
              <th className="px-3 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <React.Fragment key={a.id}>
                <tr className="border-b border-slate-100 hover:bg-slate-50/60 cursor-pointer"
                  onClick={() => setOpen(open === a.id ? null : a.id)}>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-3 min-w-0">
                      <Avatar name={a.name} photo={a.photo} />
                      <div className="min-w-0">
                        <p className="text-sm text-slate-900 truncate flex items-center gap-1.5">
                          {a.name}
                          {a.superAgent && <Trophy className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />}
                        </p>
                        <p className="text-[11px] text-slate-400 truncate">
                          {a.role ?? "—"}
                          {a.brnExpiry && daysUntil(a.brnExpiry) <= 30 && (
                            <span className="text-rose-600 ml-1.5">
                              BRN {daysUntil(a.brnExpiry) < 0 ? "expired" : `expires in ${daysUntil(a.brnExpiry)}d`}
                            </span>
                          )}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-right text-sm text-slate-700 tabular-nums">{fmtNum(a.liveListings)}</td>
                  <td className="px-3 py-2.5 text-right text-sm text-slate-700 tabular-nums whitespace-nowrap">
                    {a.liveValue ? fmtAed(a.liveValue) : "—"}
                  </td>
                  <td className="px-3 py-2.5 text-right text-sm text-slate-700 tabular-nums">{fmtNum(a.leads)}</td>
                  <td className="px-3 py-2.5 text-right text-sm text-slate-700 tabular-nums">
                    {a.leads ? fmtPct(a.replied / a.leads) : "—"}
                  </td>
                  <td className="px-3 py-2.5 text-right text-sm text-slate-700 tabular-nums whitespace-nowrap">
                    {a.responseTime != null ? fmtDuration(a.responseTime) : "—"}
                  </td>
                  <td className="px-3 py-2.5">
                    {a.quality == null ? <span className="text-xs text-slate-400">—</span> : (
                      <div className="flex items-center gap-2">
                        <div className="w-14 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                          <div className={`h-full rounded-full ${qualityTint(a.quality)}`} style={{ width: `${a.quality}%` }} />
                        </div>
                        <span className={`text-xs font-medium tabular-nums ${qualityText(a.quality)}`}>
                          {Math.round(a.quality)}
                        </span>
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <ChevronDown className={`w-4 h-4 text-slate-300 inline transition-transform ${open === a.id ? "rotate-180" : ""}`} />
                  </td>
                </tr>

                {open === a.id && (
                  <tr className="border-b border-slate-100 bg-slate-50/60">
                    <td colSpan={8} className="px-4 py-4">
                      <div className="grid md:grid-cols-3 gap-6">
                        <div className="text-xs space-y-1.5">
                          <p className="font-semibold text-slate-700 mb-2">Contact &amp; compliance</p>
                          <Detail k="Email" v={a.email ?? "—"} />
                          <Detail k="Mobile" v={a.mobile ?? "—"} />
                          <Detail k="Status" v={a.status ?? "—"} />
                          <Detail k="BRN" v={a.brn ?? "—"} />
                          <Detail k="BRN expiry" v={a.brnExpiry ? fmtDate(a.brnExpiry) : "—"} />
                          <Detail k="Profile id" v={a.id} />
                        </div>

                        <div className="text-xs space-y-1.5">
                          <p className="font-semibold text-slate-700 mb-2">SuperAgent scoring</p>
                          {a.superAgent ? (
                            <>
                              <Detail k="Live listings points" v={`${a.superAgent.liveListingsPointsCombined ?? 0}`} />
                              <Detail k="Claimed transactions" v={`${a.superAgent.claimedTransactionsPointsCombined ?? 0} pts · ${(a.superAgent.claimedTransactionsSalesCountActual ?? 0) + (a.superAgent.claimedTransactionsRentalCountActual ?? 0)} deals`} />
                              <Detail k="Listing quality" v={`${a.superAgent.listingQualityPoints ?? 0} pts · ${fmtPct(a.superAgent.listingQualityActual)}`} />
                              <Detail k="Response rate" v={`${a.superAgent.responseRatePoints ?? 0} pts · ${fmtPct(a.superAgent.responseRateActual)}`} />
                              <Detail k="Response time" v={`${a.superAgent.responseTimePoints ?? 0} pts · ${fmtDuration(a.superAgent.responseTimeActual)}`} />
                              <Detail k="Streak" v={`${a.superAgent.superagentStreakWeeks ?? 0} weeks · ${a.superAgent.superagentStreakPoints ?? 0} pts`} />
                            </>
                          ) : <p className="text-slate-400">Not enrolled in SuperAgent.</p>}
                        </div>

                        <div className="text-xs">
                          <p className="font-semibold text-slate-700 mb-2">
                            Arena rankings {a.ranks.length ? `· top is #${a.ranks[0].rank}` : ""}
                          </p>
                          {a.ranks.length ? (
                            <div className="space-y-1">
                              {a.ranks.slice(0, 8).map((r, i) => (
                                <div key={i} className="flex justify-between gap-3">
                                  <span className="text-slate-500 truncate">
                                    {r.location} · {r.propertyType}
                                    <span className="text-slate-400"> · {r.category}</span>
                                  </span>
                                  <span className="text-slate-700 font-medium flex-shrink-0">#{r.rank}</span>
                                </div>
                              ))}
                              {a.ranks.length > 8 && (
                                <p className="text-slate-400 pt-1">+{a.ranks.length - 8} more areas</p>
                              )}
                            </div>
                          ) : <p className="text-slate-400">Not ranked in any arena.</p>}
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
        {!rows.length && <Empty>No agents returned.</Empty>}
      </Card>
    </div>
  );
}

/* ------------------------------- quality ------------------------------ */

function QualityView({ d }) {
  const live = d.listings.filter((l) => l.live);

  // Where the points actually go. Summing lost points per factor across live
  // listings ranks the fixes by what they would return, not by how often they
  // trip — a 20-point verification miss beats ten 2-point ones.
  const factors = useMemo(() => {
    const m = new Map();
    for (const l of live) {
      for (const f of l.qualityIssues) {
        const e = m.get(f.key) ?? { key: f.key, lost: 0, listings: 0 };
        e.lost += f.lost;
        e.listings++;
        m.set(f.key, e);
      }
    }
    return [...m.values()].sort((a, b) => b.lost - a.lost);
  }, [live]);

  const bands = [
    { key: "80–100 · green", n: live.filter((l) => l.quality >= 80).length, tint: "bg-emerald-600" },
    { key: "60–79 · amber", n: live.filter((l) => l.quality >= 60 && l.quality < 80).length, tint: "bg-amber-500" },
    { key: "under 60 · red", n: live.filter((l) => l.quality != null && l.quality < 60).length, tint: "bg-rose-600" },
  ];

  const vStatus = tally(d.verifications, (v) => v.status);
  const expiring = d.verifications
    .filter((v) => v.status === "approved" && v.expiresAt)
    .map((v) => ({ ...v, days: daysUntil(new Date(v.expiresAt)) }))
    .filter((v) => v.days !== null && v.days <= 60)
    .sort((a, b) => a.days - b.days);

  const worst = [...live].filter((l) => l.quality != null).sort((a, b) => a.quality - b.quality).slice(0, 10);

  return (
    <div className="space-y-4">
      <div className="grid lg:grid-cols-2 gap-4">
        <Section title="What the quality score is costing us"
          note={`Points lost across ${fmtNum(live.length)} live listings, biggest recoverable first.`}>
          <div className="space-y-2">
            {factors.map((f) => (
              <BarRow key={f.key} label={FACTOR_LABEL[f.key] ?? f.key} value={f.lost}
                max={Math.max(1, factors[0].lost)} tint="bg-rose-600"
                right={`${fmtNum(f.lost)} pts · ${f.listings}`} />
            ))}
            {!factors.length && <Empty>Every live listing is scoring full marks.</Empty>}
          </div>
          <p className="text-[11px] text-slate-400 mt-3">
            Right-hand figures are points lost, then how many listings lose them.
          </p>
        </Section>

        <Section title="Quality bands" note="PF pushes red-band listings down its search results.">
          <div className="space-y-2">
            {bands.map((b) => (
              <BarRow key={b.key} label={b.key} value={b.n} max={Math.max(1, live.length)} tint={b.tint}
                right={`${b.n} · ${fmtPct(b.n / Math.max(1, live.length))}`} />
            ))}
          </div>
          <div className="mt-5 pt-4 border-t border-slate-100">
            <p className="text-xs font-semibold text-slate-700 mb-2">Lowest scoring live listings</p>
            <div className="space-y-1.5">
              {worst.map((l) => (
                <div key={l.id} className="flex items-center justify-between gap-3 text-xs">
                  <span className="truncate text-slate-600">
                    <span className="font-mono text-slate-400">{l.ref}</span> {l.title}
                  </span>
                  <span className={`font-medium tabular-nums flex-shrink-0 ${qualityText(l.quality)}`}>{l.quality}</span>
                </div>
              ))}
              {!worst.length && <Empty>None.</Empty>}
            </div>
          </div>
        </Section>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <Section title="Verification pipeline" note={`${fmtNum(d.verifications.length)} submissions on record.`}>
          <div className="space-y-2">
            {vStatus.map((r) => (
              <BarRow key={r.key} label={r.key} value={r.count} max={Math.max(1, vStatus[0].count)}
                tint={r.key === "approved" ? "bg-emerald-600" : r.key === "rejected" ? "bg-rose-600" : "bg-amber-500"} />
            ))}
          </div>
          <p className="text-[11px] text-slate-400 mt-3">
            {fmtNum(live.filter((l) => l.verification !== "approved").length)} live listings carry no approved
            verification — that is 20 quality points each, left on the table.
          </p>
        </Section>

        <Section title="Verifications expiring" note="Next 60 days, soonest first.">
          {expiring.length ? (
            <div className="space-y-1.5 max-h-64 overflow-y-auto">
              {expiring.map((v) => (
                <div key={v.id} className="flex items-center justify-between gap-3 text-xs">
                  <span className="font-mono text-slate-600 truncate">{v.listingReference}</span>
                  <span className={`flex-shrink-0 tabular-nums ${v.days <= 14 ? "text-rose-700 font-medium" : "text-slate-500"}`}>
                    {v.days < 0 ? "expired" : `${v.days} days`} · {fmtDate(new Date(v.expiresAt))}
                  </span>
                </div>
              ))}
            </div>
          ) : <Empty>Nothing expiring in the next 60 days.</Empty>}
        </Section>
      </div>
    </div>
  );
}

/* ------------------------------- credits ------------------------------ */

function CreditsView({ d, days }) {
  const b = d.balance;
  const spendRows = d.transactions.filter((t) => t.amount < 0);
  const spent = spendRows.reduce((s, t) => s + Math.abs(t.amount), 0);
  const perDay = spent / Math.max(1, days);
  const runway = perDay > 0 && b ? Math.floor(b.remaining / perDay) : null;
  const cycleEnd = b?.cycle?.endDate ? new Date(b.cycle.endDate) : null;
  const cycleDaysLeft = daysUntil(cycleEnd);

  const series = byDay(spendRows, days, (t) => Math.abs(t.amount));
  const byType = tally(spendRows, (t) => t.description ?? t.type);

  const byListing = useMemo(() => {
    const m = new Map();
    for (const t of spendRows) {
      if (!t.listingRef) continue;
      m.set(t.listingRef, (m.get(t.listingRef) ?? 0) + Math.abs(t.amount));
    }
    return [...m.entries()].map(([key, v]) => ({ key, v })).sort((a, b2) => b2.v - a.v).slice(0, 10);
  }, [spendRows]);

  const byAgent = useMemo(() => {
    const m = new Map();
    for (const t of spendRows) {
      if (!t.agentId) continue;
      m.set(t.agentId, (m.get(t.agentId) ?? 0) + Math.abs(t.amount));
    }
    return [...m.entries()].map(([id, v]) => ({ id, v })).sort((a, b2) => b2.v - a.v).slice(0, 10);
  }, [spendRows]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi icon={Coins} tint="bg-indigo-50 text-indigo-600" label="Credits remaining"
          value={b ? fmtNum(b.remaining) : "—"}
          sub={b ? `${fmtNum(b.used)} of ${fmtNum(b.total)} used` : null} />
        <Kpi icon={TrendingDown} tint="bg-amber-50 text-amber-600" label={`Spent · ${days}d`}
          value={fmtNum(spent)} sub={`${perDay.toFixed(1)} per day`} />
        <Kpi icon={Clock} tint="bg-slate-100 text-slate-600" label="At this rate"
          value={runway == null ? "—" : `${fmtNum(runway)}d`}
          sub={cycleDaysLeft != null ? `${cycleDaysLeft} days left in cycle` : null}
          foot={runway != null && cycleDaysLeft != null
            ? (runway < cycleDaysLeft
              ? `Short by roughly ${cycleDaysLeft - runway} days.`
              : "Comfortably covers the rest of the cycle.")
            : null} />
        <Kpi icon={Building2} tint="bg-slate-100 text-slate-600" label="Listings charged"
          value={fmtNum(new Set(spendRows.map((t) => t.listingId).filter(Boolean)).size)}
          sub={`${fmtNum(spendRows.length)} charges`} />
      </div>

      {b && (
        <Card className="p-5">
          <div className="flex items-center justify-between text-xs text-slate-500 mb-2">
            <span>Cycle {fmtDate(b.cycle?.startDate ? new Date(b.cycle.startDate) : null)} → {fmtDate(cycleEnd)}</span>
            <span className="tabular-nums">{fmtPct(b.used / Math.max(1, b.total))} used</span>
          </div>
          <div className="h-3 bg-slate-100 rounded-full overflow-hidden">
            <div className="h-full rounded-full bg-indigo-600" style={{ width: `${(b.used / Math.max(1, b.total)) * 100}%` }} />
          </div>
        </Card>
      )}

      <div className="grid lg:grid-cols-3 gap-4">
        <Section className="lg:col-span-2" title={`Credits spent per day · last ${days} days`}
          note="Charges only — refunds and top-ups are excluded.">
          {spendRows.length ? <Trend series={series} tint="bg-amber-600" /> : <Empty>No charges in this window.</Empty>}
        </Section>
        <Section title="What it went on" note="Charge description as PF records it.">
          <div className="space-y-2">
            {byType.map((r) => (
              <BarRow key={r.key} label={r.key} value={r.count} max={Math.max(1, byType[0].count)} tint="bg-slate-400" />
            ))}
            {!byType.length && <Empty>Nothing.</Empty>}
          </div>
        </Section>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <Section title="Most expensive listings" note={`Credits charged in the last ${days} days.`}>
          <div className="space-y-2">
            {byListing.map((r) => (
              <BarRow key={r.key} label={r.key} value={r.v} max={Math.max(1, byListing[0].v)} tint="bg-amber-600" />
            ))}
            {!byListing.length && <Empty>Nothing charged.</Empty>}
          </div>
        </Section>
        <Section title="Spend by agent" note="Charged against listings assigned to them.">
          <div className="space-y-2">
            {byAgent.map((r) => (
              <BarRow key={r.id} label={d.agentsById.get(r.id)?.name ?? `#${r.id}`} value={r.v}
                max={Math.max(1, byAgent[0].v)} tint="bg-amber-600" />
            ))}
            {!byAgent.length && <Empty>Nothing charged.</Empty>}
          </div>
        </Section>
      </div>
    </div>
  );
}

/* --------------------------------- tab -------------------------------- */

const VIEWS = [
  ["overview", "Overview", Gauge],
  ["listings", "Listings", Building2],
  ["leads", "Leads", Inbox],
  ["agents", "Agents", Users],
  ["quality", "Quality", ShieldCheck],
  ["credits", "Credits", Coins],
];

const EMPTY = {
  listings: [], leads: [], users: [], profileStats: [], superAgent: [], arena: [],
  verifications: [], transactions: [], balance: null, wallets: null,
};

export default function PropertyFinder() {
  const [view, setView] = useState("overview");
  const [days, setDays] = useState(30);
  const [nonce, setNonce] = useState(0);
  const [raw, setRaw] = useState(EMPTY);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState(null);
  const [loc, setLoc] = useState("");
  const [locHits, setLocHits] = useState([]);

  // The account-wide sets are small and unrelated to the date range, so they
  // load once. Partial failure is normal — a down stats service should not cost
  // you the listings — so each result is taken on its own.
  useEffect(() => {
    let alive = true;
    (async () => {
      setBusy(true); setError(null);
      const settled = await Promise.allSettled([
        fetchListings(), fetchUsers(), fetchProfileStats(), fetchSuperAgent(),
        fetchArena(), fetchCreditBalance(), fetchWallets(), fetchVerifications(),
      ]);
      if (!alive) return;
      const [L, U, PS, SA, AR, B, W, V] = settled;

      // Tolerating partial failure is deliberate — a down stats service should
      // not cost you the listings. Reporting only the listings failure was not:
      // every other rejection collapsed to [] or null, so a failed users or
      // verifications pull rendered as a confident zero. Name whatever broke,
      // so a zero on screen is never mistaken for a zero in the account.
      const NAMES = ["listings", "users", "profile stats", "super agent",
                     "arena", "credit balance", "wallets", "verifications"];
      const failed = settled
        .map((r, i) => (r.status === "rejected" ? { name: NAMES[i], reason: r.reason } : null))
        .filter(Boolean);

      if (failed.length) {
        const first = failed[0].reason;
        setError({
          msg: failed.length === 1
            ? `Couldn't load ${failed[0].name}: ${first?.message ?? String(first)}`
            : `Couldn't load ${failed.map((f) => f.name).join(", ")}. Figures for those are missing, not zero.`,
          detail: first?.detail,
        });
      }
      setRaw((r) => ({
        ...r,
        listings: L.value?.listings ?? [],
        users: U.value ?? [],
        profileStats: PS.value ?? [],
        superAgent: SA.value ?? [],
        arena: AR.value ?? [],
        balance: B.value ?? null,
        wallets: W.value ?? null,
        verifications: V.value?.submissions ?? [],
      }));
      setBusy(false);
    })();
    return () => { alive = false; };
  }, [nonce]);

  // Leads and credit charges are both range-bound, so they reload together.
  useEffect(() => {
    let alive = true;
    (async () => {
      const [LE, TX] = await Promise.allSettled([fetchLeads({ days }), fetchCreditTransactions({ days })]);
      if (!alive) return;

      // Neither rejection was reported before, which was the worst of the three
      // cases: a failed lead pull drew an empty chart and a headline of 0 leads,
      // indistinguishable from an account that genuinely had none for the range.
      const failed = [
        LE.status === "rejected" ? { name: "leads", reason: LE.reason } : null,
        TX.status === "rejected" ? { name: "credit charges", reason: TX.reason } : null,
      ].filter(Boolean);

      if (failed.length) {
        const first = failed[0].reason;
        setError({
          msg: `Couldn't load ${failed.map((f) => f.name).join(" or ")} for this range. ` +
               `The figures below are missing, not zero. ${first?.message ?? String(first)}`,
          detail: first?.detail,
        });
      }

      setRaw((r) => ({
        ...r,
        leads: LE.value?.leads ?? [],
        transactions: TX.value?.transactions ?? [],
      }));
    })();
    return () => { alive = false; };
  }, [days, nonce]);

  /**
   * One row per public profile, joined across five sources.
   *
   * Public profile id is the join key everywhere — listings assign to it, leads
   * arrive on it, and both stats endpoints are keyed by it. The user record is
   * the only place a role, BRN or mobile number lives, and the only source that
   * covers everyone: stats cover the SuperAgent enrolment alone, so an agent
   * with listings and no stats must still appear.
   */
  const agents = useMemo(() => {
    const m = new Map();
    const touch = (id, seed = {}) => {
      if (id == null) return null;
      if (!m.has(id)) {
        m.set(id, {
          id, name: null, photo: null, role: null, status: null, email: null, mobile: null,
          brn: null, brnExpiry: null, liveListings: 0, liveValue: 0, listings: 0,
          leads: 0, replied: 0, quality: null, responseTime: null, responseRate: null,
          superAgent: null, ranks: [], ...seed,
        });
      }
      return m.get(id);
    };

    for (const u of raw.users) {
      if (!u.profileId) continue;
      Object.assign(touch(u.profileId), {
        name: u.name, photo: u.photo, role: u.role, status: u.status,
        email: u.email, mobile: u.mobile, brn: u.brn, brnExpiry: u.brnExpiry,
      });
    }
    for (const s of raw.profileStats) {
      const a = touch(s.id);
      a.name = a.name ?? s.name;
      a.photo = a.photo ?? s.photo;
      a.quality = s.quality;
      a.responseRate = s.responseRate;
      a.responseTime = s.responseTime;
    }
    for (const s of raw.superAgent) {
      const a = touch(s.id);
      a.name = a.name ?? s.name;
      a.superAgent = s;
      // Both endpoints report seconds — checked against the ten enrolled
      // profiles, where the two figures agree to the decimal.
      if (a.responseTime == null && s.responseTimeActual != null) a.responseTime = s.responseTimeActual;
    }
    for (const r of raw.arena) {
      const a = touch(r.id);
      a.name = a.name ?? r.name;
      a.ranks.push(r);
    }
    for (const l of raw.listings) {
      const a = touch(l.agentId);
      if (!a) continue;
      a.name = a.name ?? l.agentName;
      a.photo = a.photo ?? l.agentPhoto;
      a.listings++;
      if (l.live) { a.liveListings++; a.liveValue += l.price ?? 0; }
    }
    for (const l of raw.leads) {
      const a = touch(l.agentId);
      if (!a) continue;
      a.leads++;
      if (l.status === "replied") a.replied++;
    }

    for (const a of m.values()) a.ranks.sort((x, y) => x.rank - y.rank);
    // Anyone with no listings, no leads and no scoring is a dormant login.
    return [...m.values()]
      .filter((a) => a.listings || a.leads || a.superAgent || a.quality != null)
      .sort((a, b) => (b.leads - a.leads) || (b.liveListings - a.liveListings));
  }, [raw]);

  const d = useMemo(() => ({
    ...raw,
    agents,
    agentsById: new Map(agents.map((a) => [a.id, a])),
  }), [raw, agents]);

  useEffect(() => {
    if (loc.trim().length < 2) { setLocHits([]); return; }
    const t = setTimeout(() => { searchLocations(loc).then(setLocHits); }, 300);
    return () => clearTimeout(t);
  }, [loc]);

  const refresh = () => { clearPfCache(); setNonce((n) => n + 1); };

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Property Finder</h1>
          <p className="text-sm text-slate-500 mt-1">
            Our PF Expert account — {fmtNum(raw.listings.filter((l) => l.live).length)} live listings,
            {" "}{fmtNum(raw.leads.length)} leads in {days} days, {fmtNum(d.balance?.remaining ?? 0)} credits left.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} className={ctrl}>
            {LEAD_DAYS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <button onClick={refresh} disabled={busy}
            className={`flex items-center gap-2 px-3 py-2 text-sm rounded-xl border border-slate-200 bg-white disabled:opacity-40 enabled:hover:bg-slate-50 enabled:hover:border-slate-300 ${
              busy ? "is-fetching" : ""}`}>
            <RefreshCw className={`w-4 h-4 ${busy ? "animate-spin" : ""}`} />Refresh
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1 mb-5 border-b border-slate-200">
        {VIEWS.map(([k, label, Icon]) => (
          <button key={k} onClick={() => setView(k)}
            className={`flex items-center gap-1.5 px-3 py-2 text-sm -mb-px border-b-2 ${view === k
              ? "border-slate-900 text-slate-900 font-medium"
              : "border-transparent text-slate-500 hover:bg-slate-50 hover:text-slate-700 hover:border-slate-300"}`}>
            <Icon className="w-4 h-4" />{label}
          </button>
        ))}
      </div>

      {error && (
        <Card className="p-5 border-amber-200 bg-amber-50 mb-4 flex gap-3">
          <AlertCircle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-amber-900">{error.msg}</p>
            {error.detail && <p className="text-xs text-amber-700 mt-1 break-words">{error.detail}</p>}
            {/* This used to end with "add the keys to .env and restart the dev
                server" on every error, deployed or not. There is no .env and no
                dev server in production, and the advice sent people chasing
                credentials twice for problems that were nothing to do with
                them. The message above already says what failed; this only adds
                what to do about the two cases where the answer is not obvious. */}
            <p className="text-xs text-amber-700 mt-1">
              Property Finder's own API is the usual cause — a 500 from their side is
              typically transient, so try Refresh before anything else. A firewall block
              or missing credentials is a deployment setting, not something you can fix
              from this screen.
            </p>
          </div>
        </Card>
      )}

      {busy && !raw.listings.length ? (
        <Card className="p-16 text-center">
          <Loader2 className="w-6 h-6 text-slate-300 mx-auto animate-spin" />
          <p className="text-sm text-slate-500 mt-3">Pulling listings, leads, scoring and credits…</p>
        </Card>
      ) : (
        <>
          {view === "overview" && <Overview d={d} days={days} onView={setView} />}
          {view === "listings" && <ListingsView d={d} />}
          {view === "leads" && <LeadsView d={d} days={days} />}
          {view === "agents" && <AgentsView d={d} days={days} />}
          {view === "quality" && <QualityView d={d} />}
          {view === "credits" && <CreditsView d={d} days={days} />}
        </>
      )}

      {/* Area names are not resolvable from a listing's location id — PF has no
          id lookup — so this is the one way to attach a name to one. Anything
          looked up here is remembered and shows up on listings from then on. */}
      <Card className="p-4 mt-6">
        <div className="flex flex-wrap items-center gap-3">
          <MapPin className="w-4 h-4 text-slate-400" />
          <input value={loc} onChange={(e) => setLoc(e.target.value)}
            placeholder="Look up an area to learn its name and id" className={`${ctrl} w-72`} />
          <span className="text-xs text-slate-400">
            Listings only carry a numeric area id and PF exposes no way to resolve one, so areas fill in as
            you search. Their location service is also frequently down, in which case this returns nothing.
          </span>
        </div>
        {locHits.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {locHits.map((h) => (
              <span key={h.id} className="text-xs px-2 py-1 rounded-lg bg-slate-100 text-slate-600">
                {h.name} <span className="text-slate-400">· {h.type.toLowerCase()} · #{h.id}</span>
              </span>
            ))}
          </div>
        )}
      </Card>

      <p className="text-xs text-slate-400 mt-6">
        Property Finder Enterprise API (atlas.propertyfinder.com), separate from PropSpace. Leads are capped at
        three months by the API. Response rate, response time and agent quality scores are PF's own figures and
        exist only for profiles enrolled in SuperAgent.
      </p>
    </div>
  );
}
