import React, { useState, useEffect, useMemo } from "react";
import {
  RefreshCw, Wallet, ChevronRight, ChevronDown, AlertTriangle, ImageOff, Pause,
  X, Play, Loader2,
} from "lucide-react";
import { useAuth } from "./AuthGate.jsx";
import { fetchLeads } from "./propspace.js";
import {
  leadsForCampaign, summariseCampaignLeads, BAND_META,
} from "./campaignLeads.js";
import { rangeSpelled as spelled } from "./DateRange.jsx";

import { DEFAULT_DAYS } from "./propspace.js";
import {
  fetchMetaInsights, fetchAccountSpend, fetchAdInsights, fetchAdObjects, fetchVideoSource,
  fetchCampaignObjects,
} from "./meta.js";
import {
  metaTotals, bySpend, reconcile, withVat, VAT_RATE, costOf, creativesFor,
  describeConversion, fmtMoney, fmtCost, fmtNum, CONVERSION_ACTIONS,
  createdIndex, fmtCreated,
} from "./metaParse.js";
import DateRange, { resolveRange, rangeSpelled } from "./DateRange.jsx";
import { IMAGES } from "./images.js";

/**
 * Campaigns — what the advertising costs, from the platform's own numbers.
 *
 * One table, not a split by objective. Campaigns were previously sorted into
 * Click-to-WhatsApp and Meta ads by their objective, which mislabelled the only
 * campaign running: it carries OUTCOME_LEADS and converts entirely through
 * WhatsApp. Objective describes what a campaign was set up to do; the actions
 * array describes what it did.
 *
 * Nothing here is typed in. public.ad_spend still exists in the database,
 * unread, and Property Finder, Bayut and Dubizzle publish no spend API, so they
 * are absent rather than estimated.
 */

const PRESETS = [
  ["today", "Today"],
  ["7", "Last 7 days"],
  ["30", "Last 30 days"],
  ["90", "Last 90 days"],
];

const Card = ({ children, className = "" }) => (
  <div className={`bg-white border border-slate-200 rounded-2xl ${className}`}>{children}</div>
);

const objectiveLabel = (o) =>
  !o ? "—" : String(o).replace(/^OUTCOME_/, "").replace(/_/g, " ").toLowerCase()
    .replace(/^./, (c) => c.toUpperCase());

/** Conversions stacked, each labelled for what it is, with its own cost. */
function Conversions({ conversions, spend, showCost = true }) {
  if (!conversions.length) {
    return (
      <span className="text-xs text-amber-700 bg-amber-50 px-2 py-0.5 rounded-lg whitespace-nowrap">
        no conversions recorded
      </span>
    );
  }
  return (
    <div className="space-y-1">
      {conversions.map((c) => (
        <div key={c.key}>
          <span className="font-semibold text-slate-900">{describeConversion(c)}</span>
          {showCost && (
            <span className="block text-[11px] text-slate-500">
              {fmtCost(costOf(spend, c.value))} each
            </span>
          )}
        </div>
      ))}
    </div>
  );
}


/**
 * One creative. The headline leads because every ad in this account is called
 * "New Leads ad" — the name distinguishes nothing, so it sits underneath.
 */
function Creative({ ad, onOpen }) {
  const [imgFailed, setImgFailed] = React.useState(false);
  const paused = ad.delivery && !ad.delivery.live;

  return (
    <div className="flex gap-3 py-3 border-b border-slate-100 last:border-0">
      {/* A creative that will not load must never remove the row: the spend is
          real whether or not the picture resolves. */}
      <button onClick={onOpen}
        className="relative w-20 h-20 rounded-lg overflow-hidden bg-slate-100 flex-shrink-0
                   group transition hover:ring-2 hover:ring-slate-300
                   focus:outline-none focus:ring-2 focus:ring-indigo-300">
        {ad.image && !imgFailed ? (
          <img src={ad.image} alt="" loading="lazy" onError={() => setImgFailed(true)}
            className="w-full h-full object-cover" />
        ) : (
          <span className="w-full h-full flex flex-col items-center justify-center text-slate-400 gap-1">
            <ImageOff className="w-4 h-4" />
            <span className="text-[9px]">no image</span>
          </span>
        )}
        {ad.videoId && (
          <span className="absolute inset-0 flex items-center justify-center bg-slate-900/30
                           group-hover:bg-slate-900/45">
            <Play className="w-5 h-5 text-white" fill="currentColor" />
          </span>
        )}
      </button>

      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <p className="text-sm font-medium text-slate-900 leading-snug">
              {ad.headline ?? <span className="text-slate-400">Untitled creative</span>}
            </p>
            <p className="text-[11px] text-slate-400 mt-0.5">
              {ad.name}
              {ad.cta && <> · {String(ad.cta).replace(/_/g, " ").toLowerCase()}</>}
            </p>
            {paused && (
              <span className="inline-flex items-center gap-1 mt-1.5 text-[10px] font-medium
                               px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">
                <Pause className="w-2.5 h-2.5" />{ad.delivery.label} · not delivering
              </span>
            )}
          </div>

          <div className="text-right flex-shrink-0">
            <p className="text-sm font-semibold text-slate-900">{fmtMoney(ad.spend)}</p>
            {ad.share != null && (
              <p className="text-[11px] text-slate-400">
                {Math.round(ad.share * 100)}% of campaign
              </p>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-1 mt-2">
          <p className="text-[11px] text-slate-500">
            {fmtNum(ad.impressions)} impressions · {fmtNum(ad.linkClicks)} link clicks
          </p>
          <div className="text-right text-xs">
            {ad.conversions.length ? ad.conversions.map((c) => (
              <p key={c.key}>
                <span className="font-semibold text-slate-900">{describeConversion(c)}</span>
                <span className="text-slate-400"> · {fmtCost(costOf(ad.spend, c.value))} each</span>
              </p>
            )) : (
              <span className="text-[11px] text-amber-700">no conversions recorded</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}


/**
 * The creative at full size, with its copy alongside.
 *
 * Video is fetched HERE, on open, and never at page load. The source Meta
 * returns is a signed CDN URL that expires within hours, so anything fetched
 * with the table would be dead by the time somebody clicked it — a play button
 * that does nothing is worse than no play button.
 */
function CreativeLightbox({ ad, onClose }) {
  const [video, setVideo] = React.useState(ad.videoId ? { loading: true } : null);

  React.useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  React.useEffect(() => {
    if (!ad.videoId) return;
    let alive = true;
    fetchVideoSource(ad.videoId)
      .then((v) => { if (alive) setVideo({ loading: false, ...v }); })
      .catch((e) => { if (alive) setVideo({ loading: false, error: e.message }); });
    return () => { alive = false; };
  }, [ad.videoId]);

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/70" onClick={onClose} />

      <div className="relative w-full max-w-5xl max-h-[90vh] bg-white rounded-2xl shadow-2xl
                      overflow-hidden flex flex-col md:flex-row">
        <button onClick={onClose}
          className="absolute top-3 right-3 z-10 p-2 rounded-xl bg-white/90 text-slate-500
                     hover:text-slate-900 hover:bg-white shadow">
          <X className="w-4 h-4" />
        </button>

        <div className="bg-slate-900 flex items-center justify-center md:w-3/5 min-h-[240px]">
          {ad.videoId ? (
            video?.loading ? (
              <span className="flex items-center gap-2 text-sm text-slate-300">
                <Loader2 className="w-4 h-4 animate-spin" />Loading video…
              </span>
            ) : video?.source ? (
              <video src={video.source} poster={video.picture ?? ad.image ?? undefined}
                controls autoPlay playsInline
                className="max-h-[80vh] w-full object-contain bg-black" />
            ) : (
              /* The still is a fair fallback, but say why it is not playing —
                 a silent poster looks like a broken player. */
              <div className="p-6 text-center">
                {(ad.image || ad.thumb) && (
                  <img src={ad.image ?? ad.thumb} alt="" className="max-h-[60vh] mx-auto rounded" />
                )}
                <p className="text-xs text-amber-300 mt-3">
                  Couldn't load the video{video?.error ? ` — ${video.error}` : ""}. Showing the
                  creative still instead.
                </p>
              </div>
            )
          ) : ad.image || ad.thumb ? (
            /* thumb is Meta's downscaled crop and is only reached when the
               creative exposes no full-size image. Showing it labelled beats
               showing nothing — a running ad with 1,439 impressions plainly
               HAS a creative, and an empty panel reads as the ad being broken
               rather than as this dashboard not having asked for the right
               field. Which is what it was. */
            <div className="w-full">
              <img src={ad.image ?? ad.thumb} alt=""
                className="max-h-[80vh] w-full object-contain" />
              {!ad.image && (
                <p className="text-[11px] text-slate-400 text-center py-2">
                  Meta exposes only a thumbnail for this creative, so this is a downscaled crop.
                </p>
              )}
            </div>
          ) : (
            <div className="text-slate-400 text-sm flex flex-col items-center gap-2 p-10 text-center">
              <ImageOff className="w-6 h-6" />
              <span>No image on this creative</span>
              {/* Named so the next one of these is traceable rather than a
                  shrug. Meta puts the image in one of five places depending on
                  how the ad was built; if a creative reaches here, it is using
                  a sixth. */}
              {ad.id && <span className="text-[11px] text-slate-500 font-mono">creative {ad.id}</span>}
            </div>
          )}
        </div>

        <div className="md:w-2/5 p-6 overflow-y-auto">
          <p className="text-lg font-semibold text-slate-900 leading-snug">
            {ad.headline ?? <span className="text-slate-400">Untitled creative</span>}
          </p>
          <p className="text-xs text-slate-400 mt-1">
            {ad.name}
            {ad.cta && <> · {String(ad.cta).replace(/_/g, " ").toLowerCase()}</>}
          </p>
          {ad.delivery && !ad.delivery.live && (
            <span className="inline-flex items-center gap-1 mt-2 text-[10px] font-medium
                             px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">
              <Pause className="w-2.5 h-2.5" />{ad.delivery.label} · not delivering
            </span>
          )}

          {ad.body && (
            <p className="text-sm text-slate-600 mt-4 whitespace-pre-line leading-relaxed">
              {ad.body}
            </p>
          )}

          <div className="mt-5 pt-4 border-t border-slate-100 space-y-1.5 text-sm">
            <div className="flex justify-between">
              <span className="text-slate-500">Spend</span>
              <span className="font-semibold text-slate-900">{fmtMoney(ad.spend)}</span>
            </div>
            {ad.share != null && (
              <div className="flex justify-between">
                <span className="text-slate-500">Share of campaign</span>
                <span className="text-slate-900">{Math.round(ad.share * 100)}%</span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-slate-500">Impressions</span>
              <span className="text-slate-900">{fmtNum(ad.impressions)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Link clicks</span>
              <span className="text-slate-900">{fmtNum(ad.linkClicks)}</span>
            </div>
            {ad.conversions.length ? ad.conversions.map((c) => (
              <div key={c.key} className="flex justify-between">
                <span className="text-slate-500">{c.label}</span>
                <span className="font-semibold text-slate-900">{c.value}</span>
              </div>
            )) : (
              <p className="text-xs text-amber-700 pt-1">no conversions recorded</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Everything Meta reported for a campaign, so a figure can be traced. */
function ActionBreakdown({ actions }) {
  if (!actions.length) return <p className="text-xs text-slate-500">No actions reported.</p>;
  const sorted = [...actions].sort((a, b) => Number(b.value) - Number(a.value));
  return (
    <div className="grid sm:grid-cols-2 gap-x-8 gap-y-1">
      {sorted.map((a) => {
        const counted = CONVERSION_ACTIONS.has(a.action_type);
        return (
          <div key={a.action_type} className="flex justify-between gap-4 text-[11px] py-0.5
                                              border-b border-slate-100 last:border-0">
            <span className={counted ? "text-slate-900 font-medium" : "text-slate-500"}>
              {a.action_type}
              {counted && <span className="text-emerald-600"> · counted</span>}
            </span>
            <span className={counted ? "text-slate-900 font-semibold" : "text-slate-500"}>
              {fmtNum(Number(a.value))}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * `initialRange` is the window Insights was showing when somebody clicked
 * through from the Meta card. Arriving on a different range to the figure that
 * was just clicked makes the two screens look like they disagree, when all that
 * happened is the tab defaulted to its own thirty days.
 *
 * Only the starting value — the picker here still owns the range afterwards, so
 * changing it on this tab does not reach back into Insights.
 */

/**
 * What the CRM did with a campaign's leads.
 *
 * The point of this table is the two middle columns. Meta will happily report
 * 17 leads and a cost per lead; whether anybody rang them is a different
 * question, and until now the two numbers lived on different screens. Status
 * and owner sit next to each other so "nobody has touched eleven of these"
 * is one glance rather than an export and a pivot table.
 *
 * The score is ours and it scores the RECORD, not the person — see
 * campaignLeads.js. It sits beside the name with its reasons on hover rather
 * than replacing anything, because it is evidence for a human decision, not
 * the decision.
 */
function CampaignLeads({ rows, loading, error }) {
  const [only, setOnly] = useState("all");

  if (loading) {
    return <p className="text-xs text-slate-500 py-3">Reading the CRM for this window…</p>;
  }
  if (error) {
    return (
      <p className="text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5">
        <span className="font-semibold">The CRM did not answer.</span> {error}
      </p>
    );
  }
  if (!rows.length) {
    return (
      <p className="text-xs text-slate-500 py-3">
        No CRM leads carry this campaign's ad name in this window. Meta leads are matched on the
        ad name the portal writes into the import note — a campaign whose ads have been renamed
        or deleted since it ran will show nothing here even though it has spend.
      </p>
    );
  }

  const s = summariseCampaignLeads(rows);
  const shown = only === "all" ? rows : rows.filter((r) => r.auth.band === only);

  const chip = (k, label, n, tint) => (
    <button key={k} onClick={() => setOnly(only === k ? "all" : k)}
      className={`px-2 py-1 rounded-md text-[11px] font-medium border transition ${
        only === k ? "ring-1 ring-slate-400 " : ""}${tint}`}>
      {label} {n}
    </button>
  );

  return (
    <div>
      <div className="flex flex-wrap items-center gap-4 mb-3">
        <p className="text-xs text-slate-700">
          <span className="font-semibold text-slate-900">{s.total}</span> leads in the CRM ·{" "}
          <span className={s.untouched ? "font-semibold text-rose-600" : "text-slate-500"}>
            {s.untouched} never touched
          </span>{" "}
          <span className="text-slate-400">
            ({s.worked} worked — a note by a person, not the import)
          </span>
          <span className="text-slate-400">
            {" · "}{rows.filter((r) => r.notes.length).length} carry a broker note
          </span>
        </p>
        <div className="flex items-center gap-1.5 ml-auto">
          {chip("real", "Looks real", s.real, BAND_META.real.tint)}
          {chip("check", "Worth checking", s.check, BAND_META.check.tint)}
          {chip("junk", "Likely junk", s.junk, BAND_META.junk.tint)}
        </div>
      </div>

      <p className="text-[11px] text-slate-500 mb-3">
        Sitting under:{" "}
        {s.agents.map((a) => `${a.key} (${a.count})`).join(", ")}
        {" · "}
        {s.statuses.map((x) => `${x.key} (${x.count})`).join(", ")}
      </p>

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-slate-500">
            <tr className="border-b border-slate-200">
              <th className="text-left font-medium px-3 py-2">Contact</th>
              <th className="text-left font-medium px-3 py-2">Status in the CRM</th>
              <th className="text-left font-medium px-3 py-2">Sitting under</th>
              <th className="text-left font-medium px-3 py-2">Last touched</th>
              <th className="text-right font-medium px-3 py-2">Authenticity</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const band = BAND_META[r.auth.band];
              return (
                <tr key={r.id} className="border-b border-slate-100 last:border-0 align-top">
                  <td className="px-3 py-2">
                    <p className="font-medium text-slate-900">{r.name}</p>
                    <p className="text-[11px] text-slate-500">
                      {[r.email, r.phone].filter(Boolean).join(" · ") || "no contact details"}
                    </p>
                    {r.answers.length > 0 && (
                      <p className="text-[11px] text-slate-400 mt-0.5">
                        {r.answers.map((a) => `${a.q}: ${a.a}`).join(" · ")}
                      </p>
                    )}
                    {/* Above is what the client told the ad form. This is what
                        the broker wrote back — a different voice, so it does
                        not share the styling. */}
                    {r.notes.length > 0 && (
                      <ul className="mt-1.5 pl-2 border-l-2 border-slate-200 space-y-1">
                        {r.notes.map((n, i) => (
                          <li key={i} className="text-[11px] leading-snug">
                            <span className="text-slate-700">“{n.text}”</span>
                            <span className="text-slate-400">
                              {" — "}{n.author}
                              {n.at && ` · ${n.at.toLocaleDateString("en-GB",
                                { day: "numeric", month: "short" })}`}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`inline-block px-1.5 py-0.5 rounded text-[11px] ${
                      /not yet contacted|not specified/i.test(r.status)
                        ? "bg-rose-50 text-rose-700" : "bg-slate-100 text-slate-700"}`}>
                      {r.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-slate-700">{r.agent}</td>
                  <td className="px-3 py-2 text-slate-500">
                    {r.lastTouch
                      ? r.lastTouch.toLocaleDateString("en-GB", { day: "numeric", month: "short" })
                      : <span className="text-rose-600">never</span>}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <span title={[...r.auth.bad, ...r.auth.good].join(" · ")}
                      className={`inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded border text-[11px] font-medium ${band.tint}`}>
                      <span className="tabular-nums">{r.auth.score}</span>
                      {band.label}
                    </span>
                    {r.auth.bad.length > 0 && (
                      <p className="text-[11px] text-slate-400 mt-0.5 max-w-[220px] ml-auto">
                        {r.auth.bad.join(" · ")}
                      </p>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-slate-400 mt-2">
        The score reads the record, not the person: name shape, whether the email agrees with the
        name, the mailbox domain, and whether the number is dialable. It cannot catch a false name
        spelled like a real one, which is why it sits beside the contact rather than filtering it away.
      </p>
    </div>
  );
}

export default function Campaigns({ initialRange }) {
  const [range, setRange] = useState(
    initialRange ?? { preset: String(DEFAULT_DAYS), from: null, to: null }
  );
  const [rows, setRows] = useState([]);
  const [ads, setAds] = useState([]);
  const [adObjects, setAdObjects] = useState([]);
  const [campaignObjects, setCampaignObjects] = useState([]);
  const [accountSpend, setAccountSpend] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  // Creatives arrive after the table. Tracked separately so an empty list
  // mid-flight is not mistaken for an ad-less campaign.
  const [creativesLoading, setCreativesLoading] = useState(true);
  const [open, setOpen] = useState(null);
  const [tieOpen, setTieOpen] = useState(false);
  const [lightbox, setLightbox] = useState(null);
  // CRM leads for the same window, so a campaign can be asked what the sales
  // floor actually did with what it bought. Loaded alongside Meta and allowed
  // to fail on its own: the spend figures are this page's job, and a CRM
  // outage should cost the Leads tab, not the tab it lives in.
  const [crmLeads, setCrmLeads] = useState(null);
  const [leadsError, setLeadsError] = useState(null);
  const [drill, setDrill] = useState("creatives");
  const { profile, user } = useAuth();

  const { from, to } = useMemo(() => resolveRange(range), [range]);
  const ready = Boolean(from && to && new Date(from) <= new Date(to));

  /** Never cached: Meta revises attribution for weeks, so anything held from an
   *  earlier load would quietly disagree with Ads Manager. */
  function load() {
    if (!ready) return;
    setLoading(true); setError(null); setOpen(null); setCreativesLoading(true);

    // ONLY THE TABLE'S OWN FIGURES ARE AWAITED.
    //
    // The tab used to wait on all five calls before painting anything, so the
    // spend table — which needs two of them — was gated behind the slowest.
    // That is fetchAdObjects: the creative fields are too large for one
    // response, so it pages three times SEQUENTIALLY, each request waiting on
    // the previous one's cursor. Nothing above the drill-down needs it.
    Promise.all([
      fetchMetaInsights({ from, to }),
      fetchAccountSpend({ from, to }),
      fetchAdInsights({ from, to }),
    ])
      .then(([campaigns, account, adRows]) => {
        setRows(campaigns); setAccountSpend(account); setAds(adRows);
      })
      .catch((e) => {
        setError(e.message); setRows([]); setAds([]); setAccountSpend(null);
      })
      .finally(() => setLoading(false));

    // Creative metadata is not range-bound — an ad's headline and image are
    // the same whatever window is being looked at — but it is refetched with
    // the rest so a newly created ad appears without a reload. It now lands in
    // its own time, behind a table that is already readable.
    fetchAdObjects()
      .then(setAdObjects)
      .catch((e) => { console.error("[campaigns] creatives unavailable", e); setAdObjects([]); })
      .finally(() => setCreativesLoading(false));

    // Created dates are decoration on rows that stand up without them, so a
    // failure here drops to no dates rather than taking the tab down with it.
    // The spend figures are the point of this page; a date is not worth an
    // error card over.
    fetchCampaignObjects().then(setCampaignObjects).catch(() => setCampaignObjects([]));

    setCrmLeads(null); setLeadsError(null);
    fetchLeads({ from, to })
      .then(setCrmLeads)
      .catch((e) => { setLeadsError(String(e.message ?? e)); setCrmLeads([]); });
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [from, to, ready]);

  const ordered = useMemo(() => bySpend(rows), [rows]);
  const createdOn = useMemo(() => createdIndex(campaignObjects), [campaignObjects]);
  const totals = useMemo(() => metaTotals(rows), [rows]);
  const split = useMemo(() => reconcile(rows, accountSpend), [rows, accountSpend]);

  const creativesOf = (campaign) =>
    creativesFor(campaign.campaignId, ads, adObjects, campaign.spend);

  return (
    <>
      <div className="flex items-start justify-between mb-6 flex-wrap gap-3">
        <div>
          <p className="text-sm text-slate-500">Campaigns</p>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight mt-1">
            What the advertising costs
          </h1>
          <p className="text-sm text-slate-500 mt-1">{rangeSpelled(from, to)}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <DateRange value={range} onChange={setRange} presets={PRESETS} />
          <button onClick={load}
            className={`flex items-center gap-2 bg-white border border-slate-200 rounded-xl px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 ${
              loading ? "is-fetching" : ""}`}>
            <RefreshCw className={`w-4 h-4 text-slate-400 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>
      </div>

      {error ? (
        <Card className="p-5 bg-rose-50 border-rose-200">
          {/* Meta's messages arrive without terminal punctuation, so the
              sentence after ran straight on from it: "...retry your request
              Nothing is shown rather than". Separated into its own paragraph
              rather than patched with a full stop, because the two are
              different voices — theirs and ours. */}
          <p className="text-sm text-rose-800">
            <span className="font-medium">Couldn't load Meta figures.</span> {error}
          </p>
          <p className="text-sm text-rose-800 mt-2">
            Nothing is shown rather than a partial picture — a missing campaign would make the
            reconciliation below tie to the wrong number.
          </p>
        </Card>
      ) : loading ? (
        <Card className="p-10 text-center text-sm text-slate-500">Loading Meta insights…</Card>
      ) : (
        <>
          <Card className="p-5 mb-4">
            <div className="flex items-start justify-between flex-wrap gap-4">
              <div className="flex items-start gap-3">
                <span className="w-10 h-10 rounded-xl bg-slate-900 text-white flex items-center justify-center flex-shrink-0">
                  <Wallet className="w-5 h-5" strokeWidth={2} />
                </span>
                <div>
                  <p className="text-sm font-medium text-slate-700">Account spend</p>
                  <p className="text-xs text-slate-500">{rangeSpelled(from, to)} · pulled at account level</p>
                  <p className="mt-2 text-4xl font-bold text-slate-900 tracking-tight">
                    {fmtMoney(split.account)}
                  </p>
                  <p className="mt-1.5 text-xs text-slate-500">
                    Excludes {Math.round(VAT_RATE * 100)}% VAT. Invoiced amount will be higher.
                  </p>
                </div>
              </div>
              <div className="text-right">
                <p className="text-xs text-slate-500">With VAT, as invoiced</p>
                <p className="text-2xl font-bold text-slate-900 tracking-tight mt-1">
                  {fmtMoney(withVat(split.account))}
                </p>
              </div>
            </div>
          </Card>

          <Card className="mb-4 overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 flex items-start gap-3">
              <span className="w-10 h-10 rounded-xl bg-slate-50 flex items-center justify-center flex-shrink-0">
                <img src={IMAGES.meta} alt="" width="20" height="20" className="w-5 h-5" />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-900">Campaigns</p>
                <p className="text-xs text-slate-500 mt-0.5">
                  {ordered.length} campaign{ordered.length === 1 ? "" : "s"} ·{" "}
                  {fmtMoney(totals.spend)} · click a row for creatives and the full action list
                </p>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-500 text-xs">
                  <tr>
                    <th className="text-left font-medium px-5 py-2.5">Campaign</th>
                    <th className="text-left font-medium px-3 py-2.5">Objective</th>
                    <th className="text-right font-medium px-3 py-2.5">Spend</th>
                    <th className="text-right font-medium px-3 py-2.5">Impressions</th>
                    <th className="text-right font-medium px-3 py-2.5">Link clicks</th>
                    <th className="text-right font-medium px-5 py-2.5">Conversions</th>
                  </tr>
                </thead>
                <tbody>
                  {ordered.map((c) => {
                    const isOpen = open === c.id;
                    const creatives = creativesOf(c);
                    // Absent for a campaign Meta no longer returns an object
                    // for — a deleted one still carries spend. The line is
                    // dropped rather than shown as a dash: an empty date reads
                    // as missing data, when the row itself is perfectly sound.
                    const created = fmtCreated(createdOn.get(String(c.campaignId)));
                    // Only for the row actually open — this walks every lead in
                    // the window and there is no reason to do it 40 times.
                    const campaignLeadRows = isOpen
                      ? leadsForCampaign(crmLeads ?? [], c.campaignId, ads)
                      : [];
                    return (
                      <React.Fragment key={c.id}>
                        <tr onClick={() => { setOpen(isOpen ? null : c.id); setDrill("creatives"); }}
                          className="border-b border-slate-100 cursor-pointer hover:bg-slate-50 align-top">
                          <td className="px-5 py-3 font-medium text-slate-900">
                            <span className="flex items-center gap-1.5">
                              {isOpen
                                ? <ChevronDown className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                                : <ChevronRight className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />}
                              {c.name}
                            </span>
                            {created && (
                              <span className="block pl-5 mt-0.5 text-[11px] font-normal text-slate-400">
                                Created {created}
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-3 text-slate-500 text-xs">{objectiveLabel(c.objective)}</td>
                          <td className="px-3 py-3 text-right text-slate-500">{fmtMoney(c.spend)}</td>
                          <td className="px-3 py-3 text-right text-slate-500">{fmtNum(c.impressions)}</td>
                          <td className="px-3 py-3 text-right text-slate-500">{fmtNum(c.linkClicks)}</td>
                          <td className="px-5 py-3 text-right">
                            <Conversions conversions={c.conversions} spend={c.spend} />
                          </td>
                        </tr>

                        {isOpen && (
                          <tr className="border-b border-slate-200">
                            <td colSpan={6} className="px-5 py-4 bg-slate-50/60">
                              {/* Two questions about one campaign: what it showed,
                                  and what the CRM did with what came back. */}
                              <div className="flex items-center gap-1.5 mb-4">
                                {[["creatives", creativesLoading ? "Creatives…" : `Creatives (${creatives.length})`],
                                  ["leads", crmLeads === null && !leadsError
                                    ? "Leads…"
                                    : `Leads (${campaignLeadRows.length})`]].map(([k, label]) => (
                                  <button key={k} onClick={() => setDrill(k)}
                                    className={`px-2.5 py-1 text-xs rounded-md border transition ${drill === k
                                      ? "bg-slate-900 text-white border-slate-900 font-medium"
                                      : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"}`}>
                                    {label}
                                  </button>
                                ))}
                              </div>

                              {drill === "leads" ? (
                                <CampaignLeads rows={campaignLeadRows}
                                  loading={crmLeads === null && !leadsError}
                                  error={leadsError} />
                              ) : (<>
                              <p className="text-xs font-semibold text-slate-700 mb-1">
                                Creatives
                                <span className="font-normal text-slate-400">
                                  {" "}— {creatives.length} ad{creatives.length === 1 ? "" : "s"}, biggest spend first
                                </span>
                              </p>
                              {creatives.length ? (
                                <div className="mb-4">
                                  {creatives.map((a) => (
                                    <Creative key={a.id} ad={a} onOpen={() => setLightbox(a)} />
                                  ))}
                                </div>
                              ) : creativesLoading ? (
                                <p className="mb-4 text-xs text-slate-500 flex items-center gap-2">
                                  <RefreshCw className="w-3 h-3 animate-spin text-slate-300" />
                                  Loading creatives…
                                </p>
                              ) : (
                                /* Spend with no ad rows is not an empty drill-down. The
                                   money is real and has to stay visible, so the campaign
                                   total is restated with the reason it stands alone. */
                                <div className="mb-4 px-3 py-2.5 rounded-lg bg-amber-50 border border-amber-200">
                                  <p className="text-xs text-amber-900">
                                    <span className="font-semibold">{fmtMoney(c.spend)} on this campaign,
                                    but Meta returned no ad-level rows for it.</span>{" "}
                                    Usually the ads were deleted — spend survives on the campaign,
                                    the ads that produced it do not.
                                  </p>
                                </div>
                              )}

                              <p className="text-xs font-semibold text-slate-700 mb-2">
                                Everything Meta reported
                                <span className="font-normal text-slate-500">
                                  {" "}— for checking against Ads Manager
                                </span>
                              </p>
                              <ActionBreakdown actions={c.actions} />
                              </>)}
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}

                  {!ordered.length && (
                    <tr><td colSpan={6} className="px-5 py-8 text-center text-sm text-slate-500">
                      No Meta campaigns ran in this range.
                    </td></tr>
                  )}
                </tbody>

                {ordered.length > 0 && (
                  <tfoot>
                    <tr className="border-t-2 border-slate-200 bg-slate-50">
                      <td className="px-5 py-3 font-semibold text-slate-900">All campaigns</td>
                      <td />
                      <td className="px-3 py-3 text-right font-semibold">{fmtMoney(totals.spend)}</td>
                      <td className="px-3 py-3 text-right font-semibold">{fmtNum(totals.impressions)}</td>
                      <td className="px-3 py-3 text-right font-semibold">{fmtNum(totals.linkClicks)}</td>
                      <td className="px-5 py-3 text-right">
                        <Conversions conversions={totals.conversions} spend={totals.spend} />
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>

            <div className="px-5 py-3 bg-amber-50 border-t border-amber-200 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
              <p className="text-[11px] text-amber-900 leading-relaxed">
                <span className="font-semibold">WhatsApp conversations are not PropSpace leads.</span>{" "}
                A conversation started is somebody opening a chat from an ad; it creates no CRM
                record, so these figures will never reconcile with Insights. Conversions are read
                from what each campaign actually recorded, never inferred from its objective.
              </p>
            </div>
          </Card>

          {/* Collapsed to its headline. The breakdown is for the moment
              somebody is reconciling against an invoice, not for every visit —
              but the figure that gets compared to the bill stays visible. */}
          <Card className="overflow-hidden">
            <button onClick={() => setTieOpen((o) => !o)}
              className="w-full px-5 py-4 flex items-center justify-between gap-4 text-left hover:bg-slate-50">
              <span className="flex items-center gap-2 min-w-0">
                {tieOpen
                  ? <ChevronDown className="w-4 h-4 text-slate-400 flex-shrink-0" />
                  : <ChevronRight className="w-4 h-4 text-slate-400 flex-shrink-0" />}
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-slate-900">Invoice total</span>
                  <span className="block text-xs text-slate-400">
                    Including {Math.round(VAT_RATE * 100)}% VAT
                    {split.ties === false && " · does not tie"}
                  </span>
                </span>
              </span>
              <span className="text-right flex-shrink-0">
                <span className="block text-2xl font-bold text-slate-900 tracking-tight">
                  {fmtMoney(withVat(split.account))}
                </span>
                {split.ties === false && (
                  <span className="block text-[11px] text-rose-700">
                    {fmtMoney(Math.abs(split.difference))} unaccounted
                  </span>
                )}
              </span>
            </button>

            {tieOpen && (
              <div className="px-5 pb-5 pt-1 border-t border-slate-100">
                <div className="space-y-1.5 text-sm mt-3">
                  <div className="flex justify-between">
                    <span className="text-slate-600">Campaign rows</span>
                    <span className="font-medium">{fmtMoney(split.parts)}</span>
                  </div>
                  <div className="flex justify-between border-t border-slate-200 pt-1.5">
                    <span className="text-slate-700 font-medium">Account total, excluding VAT</span>
                    <span className="font-semibold">{fmtMoney(split.account)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-700 font-medium">
                      Plus {Math.round(VAT_RATE * 100)}% VAT
                    </span>
                    <span className="font-semibold">
                      {fmtMoney(split.account == null ? null : split.account * VAT_RATE)}
                    </span>
                  </div>
                  <div className="flex justify-between border-t-2 border-slate-200 pt-1.5">
                    <span className="text-slate-900 font-semibold">Invoice total</span>
                    <span className="font-bold">{fmtMoney(withVat(split.account))}</span>
                  </div>
                </div>

                {split.ties === true && (
                  <p className="mt-3 text-xs text-emerald-700">
                    Campaign rows tie exactly to the account total. Every dirham the account
                    spent is in the table above.
                  </p>
                )}
                {split.ties === false && (
                  <p className="mt-3 text-xs text-rose-800">
                    <span className="font-semibold">
                      Difference of {fmtMoney(Math.abs(split.difference))}
                    </span>{" "}
                    {split.difference > 0
                      ? "is on the account but in no campaign row. Meta leaves deleted campaigns out of campaign-level reports, so this is usually spend on one that no longer exists."
                      : "more is in the campaign rows than the account reports, which should not happen — treat both figures with suspicion until it is explained."}
                  </p>
                )}
                {split.ties === null && (
                  <p className="mt-3 text-xs text-slate-500">
                    The account total could not be read, so this cannot be checked.
                  </p>
                )}
              </div>
            )}
          </Card>
        </>
      )}

      {lightbox && <CreativeLightbox ad={lightbox} onClose={() => setLightbox(null)} />}

    </>
  );
}
