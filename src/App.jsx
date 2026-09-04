import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  BarChart3, Calendar, Users, Database, Building2, Briefcase, Layers,
  Megaphone, Settings, Clock, AlertTriangle, UserX, Inbox, Download, Camera, Search, Globe,
  RefreshCw, Contact, Info, Sparkles, ChevronRight, ChevronDown, Home, ShieldCheck,
  GraduationCap, LayoutDashboard, Crosshair,
} from "lucide-react";
import {
  fetchLeads, agentOf, statusOf, isUntouched, hoursToFirstTouch,
  median, summarise, fmtHours,
  channelOf, listingOf, fmtPrice, tally, humanNotes,
  prefetch, DEFAULT_DAYS, isCold, isStatusOnly, parseNoteDate,
} from "./propspace.js";
import Listings from "./Listings.jsx";
import Brokers from "./Brokers.jsx";
import Equipment from "./Equipment.jsx";
import OffPlan from "./OffPlan.jsx";
import OwnerSearch from "./OwnerSearch.jsx";
import PropertyFinder from "./PropertyFinder.jsx";
import Bayut from "./Bayut.jsx";
import TruCheck from "./TruCheck.jsx";
import DatabaseTab from "./Database.jsx";
import Campaigns from "./Campaigns.jsx";
import PersonalBranding from "./PersonalBranding.jsx";
import Training from "./Training.jsx";
import CommandCentre from "./CommandCentre.jsx";
import Prospecting from "./Prospecting.jsx";
import ColdTrend from "./ColdTrend.jsx";
import DateRange, { resolveRange, rangeCaption, rangeSpelled, spanDays } from "./DateRange.jsx";
import { IMAGES } from "./images.js";
import { dubaiRange } from "./time.js";
import { fetchAgentDirectory, agentLookupFromLeads, initialsOf, photoFocus } from "./agents.js";
import { fetchCrmAgents, isRankedLead, reconciliationRow } from "./crmAgents.js";
import { isPropertyManagement, PM_LABEL } from "./propertyManagement.js";
// The CRM escapes apostrophes as #sqoute#; cleanNote is where that is undone.
import { cleanNote } from "./brokers.js";
import { fetchMetaInsights } from "./meta.js";
import { metaTotals, fmtMoney, fmtCost, costOf } from "./metaParse.js";
// lucide dropped brand marks, so the platform logos come from simple-icons via
// react-icons. A generic chat bubble would say "messaging"; SiWhatsapp says
// which platform the money went to, which is the point of the card.
import { SiMeta, SiWhatsapp } from "react-icons/si";
import { useAuth, SignOutButton } from "./AuthGate.jsx";


const LEAD_PRESETS = [
  ["today", "Today"],
  ["7", "Last 7 days"],
  ["30", "Last 30 days"],
  ["90", "Last 90 days"],
];


/* ------------------------------ atoms ------------------------------ */

const Card = ({ children, className = "", ...rest }) => (
  <div className={`bg-white border border-slate-200 rounded-2xl ${className}`} {...rest}>{children}</div>
);

/**
 * The card-wide click target used by the two cards that lead somewhere.
 *
 * A whole card is a large thing to make clickable, so it has to look clickable
 * before it is clicked — hence the cursor, the border lift and the standing
 * "see them" line rather than a hover-only hint. Keyboard gets the same route:
 * a div with an onClick is invisible to a tab key, and these are the only way
 * to reach the cold list at all.
 */
const OPENABLE = "cursor-pointer hover:border-slate-300 hover:shadow-sm transition " +
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400";

const openable = (onClick) => ({
  onClick,
  role: "button",
  tabIndex: 0,
  onKeyDown: (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); }
  },
});

/** The standing affordance on a card that opens something. */
const OpenHint = ({ children }) => (
  <span className="mt-3 inline-flex items-center gap-0.5 text-[11px] font-medium text-slate-500">
    {children}<ChevronRight className="w-3 h-3" />
  </span>
);

/**
 * `sub` is the one-line explanation, always visible. `more` is the fuller
 * definition behind a "What counts?" toggle — enough for someone who has never
 * seen the dashboard to work out what the number means without asking.
 */
/**
 * A hint that floats.
 *
 * The card previously carried a description AND a "What counts?" expander —
 * the same explanation twice — and the expander pushed every card below it
 * down when opened, so reading one definition rearranged the page. This is
 * absolutely positioned instead: it cannot change the height of anything.
 *
 * Hover on a pointer, tap on touch. The outside-tap listener is bound only
 * while a tooltip is open, so four cards do not mean four idle listeners.
 */
function InfoHint({ text }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const away = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  return (
    <span ref={ref} className="relative inline-flex align-middle"
      onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" aria-label="What counts?"
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        className="text-slate-400 hover:text-slate-700">
        <Info className="w-3.5 h-3.5" strokeWidth={2} />
      </button>
      {open && (
        <span role="tooltip"
          className="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 z-50 w-64
                     rounded-xl bg-slate-900 text-white text-[11px] leading-relaxed
                     px-3 py-2.5 shadow-xl pointer-events-none">
          {text}
        </span>
      )}
    </span>
  );
}

function Metric({ icon: Icon, tint, label, period, value, alert, hint, scope, onOpen, openLabel }) {
  const open = Boolean(onOpen);
  return (
    <Card className={`p-5 ${open ? OPENABLE : ""}`} {...(open ? openable(onOpen) : {})}>
      <div className="flex items-start justify-between">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${tint}`}>
          <Icon className="w-5 h-5" strokeWidth={2} />
        </div>
        {alert && (
          <span className="text-xs font-medium px-2 py-1 rounded-lg bg-rose-50 text-rose-700">{alert}</span>
        )}
      </div>
      <p className="mt-4 text-sm font-medium text-slate-700 flex items-center gap-1.5">
        {label}
        {hint && <InfoHint text={hint} />}
      </p>
      <p className="text-xs text-slate-400 mt-0.5">{period}</p>
      <p className="mt-3 text-4xl font-bold text-slate-900 tracking-tight">{value}</p>
      {/* A figure computed on fewer leads than the headline says so here,
          rather than quietly disagreeing with the total above it. */}
      {scope && <p className="mt-2 text-[11px] text-slate-500">{scope}</p>}
      {open && <OpenHint>{openLabel}</OpenHint>}
    </Card>
  );
}

/** Agent photo, or their initials when the CRM has no picture for them. */
function Avatar({ name, photo, size = "w-7 h-7", textClass = "text-[10px]" }) {
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

/**
 * A collapsible run of related tabs.
 *
 * The rail had grown to fourteen flat entries, which is a list rather than a
 * structure — Bayut and TruCheck sit next to each other and read as unrelated,
 * and Campaigns and Personal Branding are the same job filed apart.
 *
 * Two shapes, and the difference matters. A group with its own `tab` (Bayut)
 * is a real destination that happens to have something nested under it, so its
 * header both opens the group and goes there. A group without one (Prospecting,
 * Marketing) is only a heading; clicking it opens the group and navigates
 * nowhere, because there is nothing to navigate to and a header that looked
 * clickable but did nothing would be worse than one that only expands.
 */
function NavGroup({ icon: Icon, label, badge, open, onToggle, activeInside, children }) {
  return (
    <div>
      <div onClick={onToggle}
        className={`flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm cursor-pointer transition-colors ${
          activeInside && !open
            ? "bg-white/10 text-white font-medium"
            : "text-slate-400 hover:bg-white/5 hover:text-slate-200"}`}>
        <Icon className="w-4 h-4 flex-shrink-0" strokeWidth={2} />
        <span className="min-w-0 truncate">{label}</span>
        {badge && (
          <span className="flex-shrink-0 text-[9px] font-semibold uppercase tracking-wide
                           px-1.5 py-0.5 rounded bg-amber-400/20 text-amber-300">
            {badge}
          </span>
        )}
        <ChevronDown className={`w-3.5 h-3.5 ml-auto flex-shrink-0 transition-transform
                                 ${open ? "" : "-rotate-90"}`} />
      </div>
      {/* Indented against a hairline, so a child reads as belonging to the
          header above it rather than as another top-level row. */}
      {open && (
        <div className="ml-6 pl-2 border-l border-white/10 space-y-1 mt-1">{children}</div>
      )}
    </div>
  );
}

const NavItem = ({ icon: Icon, label, active, onClick, badge }) => (
  <div onClick={onClick}
    className={`flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm cursor-pointer transition-colors ${
      active
        ? "bg-white/10 text-white font-medium"
        // Half the active tint on hover, so the rail shows you where you would
        // land using the same colour it uses to show where you are. Text alone
        // was too faint to read as an affordance on a dark rail.
        : "text-slate-400 hover:bg-white/5 hover:text-slate-200"}`}>
    <Icon className="w-4 h-4 flex-shrink-0" strokeWidth={2} />
    <span className="min-w-0 truncate">{label}</span>
    {/* Sits after the label and pushed right, so it marks the item without
        shifting the label out of line with every other row in the rail. */}
    {badge && (
      <span className="ml-auto flex-shrink-0 text-[9px] font-semibold uppercase tracking-wide
                       px-1.5 py-0.5 rounded bg-amber-400/20 text-amber-300">
        {badge}
      </span>
    )}
  </div>
);

/* --------------------------- drill-down --------------------------- */

/** Labels wrap rather than truncate — a cut-off source name hides the thing
 *  being measured. The bar keeps the full remaining width. */
const Bar = ({ label, count, total, tint = "bg-slate-300" }) => (
  <div className="flex items-start gap-3">
    <span className="text-xs text-slate-600 w-52 flex-shrink-0 break-words leading-snug">{label}</span>
    <div className="flex-1 h-2 mt-1 bg-slate-100 rounded-full overflow-hidden">
      <div className={`h-full rounded-full ${tint}`} style={{ width: `${(count / total) * 100}%` }} />
    </div>
    <span className="text-xs text-slate-500 w-10 text-right flex-shrink-0 mt-0.5">{count}</span>
  </div>
);

const Breakdown = ({ title, rows, total, tint, limit = 6, note }) => (
  <div>
    <p className="text-xs font-semibold text-slate-700 mb-2">{title}</p>
    {note && <p className="text-[11px] text-slate-400 mb-2">{note}</p>}
    <div className="space-y-1.5">
      {rows.slice(0, limit).map((r) => (
        <Bar key={r.key} label={r.key} count={r.count} total={total} tint={tint} />
      ))}
      {!rows.length && <p className="text-xs text-slate-400">No data.</p>}
    </div>
  </div>
);

/**
 * One lead, as it reads in a drill-down.
 *
 * Extracted from the agent panel so the cold list shows a lead exactly as the
 * agent panel does. Two renderings of the same record that drift apart is how
 * the same lead ends up looking like two different leads depending on which
 * card you clicked to get to it.
 */
/**
 * One note, as the broker wrote it.
 *
 * Dates arrive in four formats, none of which new Date() parses — see
 * parseNoteDate. An unparseable one keeps its raw string rather than being
 * dropped or shown as "Invalid Date": the text is the point, and the timestamp
 * is context for it.
 */
function Note({ note }) {
  const at = parseNoteDate(note.date ?? note.created_at);
  return (
    <li className="py-2 first:pt-0 last:pb-0">
      <p className="text-xs text-slate-700 leading-relaxed">{cleanNote(note.notes)}</p>
      <p className="text-[11px] text-slate-400 mt-0.5">
        {note.user_name || "Unknown"}
        {" · "}
        {at
          ? at.toLocaleString("en-GB", {
              day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
            })
          : String(note.date ?? "")}
      </p>
    </li>
  );
}

function LeadRow({ lead: l }) {
  const g = listingOf(l);
  const dead = isCold(l);
  // What the broker actually wrote. humanNotes drops the portal's own import
  // note, which is the lead arriving rather than anybody working it.
  const notes = humanNotes(l);
  const [openNotes, setOpenNotes] = useState(false);

  return (
    <div className="px-5 py-3 hover:bg-slate-50">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-slate-900">{l.reference ?? l.id}</span>
            <span className="text-[11px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">
              {l.source} · {channelOf(l)}
            </span>
            <span className="text-[11px] text-slate-500">{l.lead_type}</span>
          </div>
          <p className="text-xs text-slate-500 mt-1 truncate">
            {g.ref ? `${g.ref} · ` : ""}
            {[g.subLocation, g.location].filter(Boolean).join(", ") || "no listing recorded"}
            {g.price ? ` · ${fmtPrice(g.price)}` : ""}
            {g.beds && g.beds !== "0" ? ` · ${g.beds} bed` : ""}
          </p>
          <p className="text-xs text-slate-400 mt-0.5">
            {statusOf(l)}
            {dead
              ? " · status never moved, nothing logged"
              : isUntouched(l)
                ? " · status moved, but no note logged"
                : ` · first touch ${fmtHours(hoursToFirstTouch(l))} after arrival`}
            {notes.length > 0 && (
              <>
                {" · "}
                <button onClick={() => setOpenNotes((v) => !v)}
                  className="text-slate-500 underline decoration-dotted underline-offset-2
                             hover:text-slate-800">
                  {notes.length} note{notes.length === 1 ? "" : "s"}
                  {openNotes ? " — hide" : " — read"}
                </button>
              </>
            )}
          </p>

          {/* The agent's own words. Oldest first: the notes are a history, and
              read in order they say what happened; newest first only ever
              answers what happened last. */}
          {openNotes && notes.length > 0 && (
            <ul className="mt-2 pl-3 border-l-2 border-slate-200 divide-y divide-slate-100">
              {[...notes]
                .sort((a, b) => {
                  const da = parseNoteDate(a.date ?? a.created_at);
                  const db = parseNoteDate(b.date ?? b.created_at);
                  if (!da || !db) return 0;
                  return da - db;
                })
                .map((n, i) => <Note key={i} note={n} />)}
            </ul>
          )}
        </div>
        <span className={`text-[11px] font-semibold px-2 py-1 rounded-lg flex-shrink-0 ${
          dead ? "bg-rose-50 text-rose-700"
            : isUntouched(l) ? "bg-amber-50 text-amber-700"
            : "bg-emerald-50 text-emerald-700"}`}>
          {dead
            ? fmtHours((Date.now() - new Date(l.created_at)) / 3_600_000) + " cold"
            : isUntouched(l) ? "worked, no note" : "worked"}
        </span>
      </div>
    </div>
  );
}

const oldestFirst = (rows) =>
  [...rows].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

/**
 * The cold leads themselves, behind the Cold card.
 *
 * The card has always been able to say how many; this is the list of which,
 * which is the only form the number can actually be acted on in. Oldest first:
 * a lead that has sat untouched for three weeks is a worse problem than one
 * that arrived this morning, and the order is the triage.
 *
 * It carries the same window and agent filter as the card, and says so in the
 * header — a panel that quietly showed all cold leads ever would not match the
 * number that was clicked to open it.
 */
function ColdPanel({ open, leads, period, scope, info, onClose }) {
  const [openBroker, setOpenBroker] = useState(null);
  if (!open) return null;

  /**
   * Brokers first, most cold at the top, and the leads themselves one click
   * further in.
   *
   * A flat list of seventy leads answers "which leads are cold"; the question
   * actually being asked of this panel is "whose". Ranking by count puts the
   * person to speak to first without anybody having to tally names down a list.
   */
  const byBroker = [...leads.reduce((m, l) => {
    const name = agentOf(l);
    if (!m.has(name)) m.set(name, []);
    m.get(name).push(l);
    return m;
  }, new Map())]
    .map(([name, rows]) => ({ name, rows, oldest: oldestFirst(rows)[0] }))
    .sort((a, b) => b.rows.length - a.rows.length || a.name.localeCompare(b.name));

  const worst = byBroker[0]?.rows.length ?? 0;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-slate-900/30" onClick={onClose} />
      <div className="relative w-full max-w-2xl bg-slate-50 h-full overflow-y-auto shadow-2xl">
        <div className="sticky top-0 bg-white border-b border-slate-200 px-6 py-5 flex items-start
                        justify-between gap-4 z-10">
          <div className="min-w-0">
            <p className="text-xl font-bold text-slate-900">
              {leads.length} cold lead{leads.length === 1 ? "" : "s"}
            </p>
            <p className="text-sm text-slate-500 mt-1">{period}{scope ? ` · ${scope}` : ""}</p>
            <p className="text-xs text-slate-400 mt-1">
              No status change and no note. Most cold first — click a broker for the leads.
            </p>
          </div>
          <button onClick={onClose}
            className="text-slate-400 hover:text-slate-700 text-sm px-3 py-1 rounded-lg hover:bg-slate-100 flex-shrink-0">
            Close
          </button>
        </div>

        {/* The count answers "how bad is it now". This answers "is it getting
            better", which is the question the number always provokes and which
            no single window can answer. */}
        <ColdTrend />

        <div className="p-6">
          <Card>
            <div className="divide-y divide-slate-100">
              {byBroker.map(({ name, rows, oldest }) => {
                const isOpen = openBroker === name;
                const days = oldest
                  ? Math.floor((Date.now() - new Date(oldest.created_at)) / 864e5)
                  : null;
                return (
                  <div key={name}>
                    <div onClick={() => setOpenBroker(isOpen ? null : name)}
                      className="px-5 py-3 flex items-center gap-3 cursor-pointer hover:bg-slate-50">
                      {isOpen
                        ? <ChevronDown className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                        : <ChevronRight className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />}
                      <Avatar name={name} photo={info?.get(name)?.photo} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium text-slate-900 truncate">
                          {info?.get(name)?.fullName ?? name}
                        </span>
                        {days != null && (
                          <span className="block text-[11px] text-slate-400">
                            oldest sitting {days} day{days === 1 ? "" : "s"}
                          </span>
                        )}
                      </span>
                      {/* Bar against the worst offender, not against their own
                          lead count — the panel ranks people against each other,
                          so the comparison has to be the same one. */}
                      <span className="w-24 h-1.5 bg-slate-100 rounded-full overflow-hidden hidden sm:block">
                        <span className="block h-full bg-rose-400 rounded-full"
                          style={{ width: `${worst ? (rows.length / worst) * 100 : 0}%` }} />
                      </span>
                      <span className="text-lg font-bold text-slate-900 w-10 text-right flex-shrink-0">
                        {rows.length}
                      </span>
                    </div>

                    {isOpen && (
                      <div className="bg-slate-50/60 border-t border-slate-100 divide-y divide-slate-100">
                        {oldestFirst(rows).map((l) => <LeadRow key={l.id} lead={l} />)}
                      </div>
                    )}
                  </div>
                );
              })}
              {!leads.length && (
                /* Worth saying plainly. Zero cold leads in a window is a good
                   result, and an empty panel on its own looks like a failure
                   to load. */
                <p className="px-5 py-8 text-center text-sm text-slate-400">
                  Nothing is cold in this range.
                </p>
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function AgentPanel({ name, leads, info, onClose }) {
  if (!name) return null;

  const cold = leads.filter(isCold);
  const statusOnly = leads.filter(isStatusOnly);
  const noted = leads.filter((l) => !isUntouched(l));
  // Already one agent's leads, so there is no ranked/unranked split to make.
  const med = median(leads.map(hoursToFirstTouch));

  // Portal × channel, e.g. "Bayut.com · whatsapp" — the actual source detail.
  const bySource = tally(leads, (l) => `${l.source ?? "Unknown"} · ${channelOf(l)}`);
  const byType = tally(leads, (l) => l.lead_type);
  const byBuilding = tally(leads, (l) => {
    const b = listingOf(l).subLocation;
    return b ? b.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : null;
  });
  const byStatus = tally(leads, statusOf);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-slate-900/30" onClick={onClose} />
      <div className="relative w-full max-w-2xl bg-slate-50 h-full overflow-y-auto shadow-2xl">
        <div className="sticky top-0 bg-white border-b border-slate-200 px-6 py-6 flex items-start justify-between z-10">
          <div className="flex items-center gap-5 min-w-0">
            {/* 3x the 44px used elsewhere. Initials scale with it so the
                fallback does not sit tiny in a large circle. */}
            <Avatar name={info?.fullName ?? name} photo={info?.photo}
              size="w-[132px] h-[132px]" textClass="text-3xl" />
            <div className="min-w-0">
              <p className="text-2xl font-bold text-slate-900 leading-tight">
                {info?.fullName ?? name}
              </p>
              {info?.jobTitle && <p className="text-sm text-slate-400 mt-0.5">{info.jobTitle}</p>}
              <p className="text-sm text-slate-500 mt-2">
                {leads.length} leads · {cold.length} cold · {statusOnly.length} worked without a note
                · median first touch {fmtHours(med)}
              </p>
            </div>
          </div>
          <button onClick={onClose}
            className="text-slate-400 hover:text-slate-700 text-sm px-3 py-1 rounded-lg hover:bg-slate-100">
            Close
          </button>
        </div>

        <div className="p-6 space-y-6">
          <Card className="p-5 space-y-5">
            <Breakdown title="Where the leads came from" rows={bySource} total={leads.length}
              tint="bg-indigo-400" limit={8}
              note="Portal · channel. Channel is missing on ~12% of leads even after recovering it from the import note." />
            <Breakdown title="Lead type" rows={byType} total={leads.length} tint="bg-sky-400" limit={5} />
            <Breakdown title="Building enquired about" rows={byBuilding} total={leads.length}
              tint="bg-violet-400" limit={6}
              note="Free-text in the CRM and inconsistently spelled — grouped case-insensitively." />
            <Breakdown title="Current status" rows={byStatus} total={leads.length} tint="bg-slate-400" limit={8} />
          </Card>

          <Card>
            <div className="px-5 py-4 border-b border-slate-200">
              <p className="text-sm font-semibold text-slate-900">Leads</p>
              <p className="text-xs text-slate-400 mt-0.5">Cold first, then oldest</p>
            </div>
            <div className="divide-y divide-slate-100">
              {[...oldestFirst(cold), ...oldestFirst(statusOnly), ...oldestFirst(noted)]
                .map((l) => <LeadRow key={l.id} lead={l} />)}
              {!leads.length && (
                <p className="px-5 py-8 text-center text-sm text-slate-400">No leads in this range.</p>
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ app ------------------------------ */

export default function App() {
  const [range, setRange] = useState({ preset: String(DEFAULT_DAYS), from: null, to: null });
  const [agentFilter, setAgentFilter] = useState("All agents");
  const [openAgent, setOpenAgent] = useState(null);
  const [coldOpen, setColdOpen] = useState(false);
  const [tab, setTab] = useState("leads");
  // Which nav groups are expanded. A group holding the open tab starts open,
  // or the rail would show no sign of where you are.
  const GROUP_OF = { bayut: "bayut", trucheck: "bayut",
                     owner: "prospecting", prospecting: "prospecting", database: "prospecting",
                     campaigns: "marketing", branding: "marketing" };
  const [openGroups, setOpenGroups] = useState(() => ({ [GROUP_OF[tab]]: true }));
  const toggleGroup = (k) => setOpenGroups((g) => ({ ...g, [k]: !g[k] }));
  const goTo = (t) => { setTab(t); const g = GROUP_OF[t]; if (g) setOpenGroups((o) => ({ ...o, [g]: true })); };
  const [agentDir, setAgentDir] = useState(() => new Map());
  const [raw, setRaw] = useState([]);
  const [crmAgents, setCrmAgents] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);   // the prefetch is already running
  const [error, setError] = useState(null);

  // Presets and custom dates both collapse to concrete { from, to } here, so
  // the fetch and the filtering below never care which the user chose.
  const { from, to } = useMemo(() => resolveRange(range), [range]);
  const ready = Boolean(from && to && new Date(from) <= new Date(to));

  async function load({ usePrefetch = false } = {}) {
    if (!ready) return;                       // half-typed custom range
    setLoading(true); setError(null);
    try {
      // The default range is already being fetched at module load, so the
      // first render adopts that result instead of firing a second identical
      // request.
      const canReuse = usePrefetch && from === prefetch.from && to === prefetch.to;
      let { rows, error: err } = canReuse
        ? await prefetch.promise
        : { rows: await fetchLeads({ from, to }), error: null };

      // The prefetch is kicked off at module load, which on a deployed build
      // happens before anyone has signed in — the edge proxy answers it with a
      // 401. Without this, the first render after a successful sign-in would
      // adopt that signed-out failure and show "Not signed in" to someone who
      // plainly is. Locally there is no guard and the prefetch just succeeds.
      if (canReuse && err) {
        rows = await fetchLeads({ from, to });
        err = null;
      }

      setRaw(rows);
      if (err) setError(err);
      else if (!rows.length) setError("Connected, but the API returned no leads for this range.");
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  // Photos live on listing agent records, joined to leads by agent id.
  useEffect(() => { fetchAgentDirectory().then(setAgentDir); }, []);

  // Who counts as a broker for ranking purposes. Loaded once — the
  // classification changes when someone edits the table, not mid-session.
  //
  // The failure is surfaced rather than swallowed: falling back to an empty map
  // means "everybody is a broker", which puts admin and house accounts back
  // into the ranking while the page looks entirely normal.
  useEffect(() => {
    fetchCrmAgents()
      .then(setCrmAgents)
      .catch((e) => setError(
        `Couldn't load the agent classifications, so the ranking below may include ` +
        `people who are not brokers. ${e.message}`
      ));
  }, []);

  /**
   * Meta for the overview strip, loaded separately from the leads.
   *
   * The result carries its own ok/error rather than defaulting to zero: a
   * failed fetch and a quiet month must never look the same, on screen or in
   * the export.
   */
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    setMeta(null);
    fetchMetaInsights({ from, to })
      .then((r) => { if (alive) setMeta({ ok: true, totals: metaTotals(r), campaigns: r }); })
      .catch((e) => { if (alive) setMeta({ ok: false, error: e.message }); });
    return () => { alive = false; };
  }, [from, to, ready]);

  const first = useRef(true);
  useEffect(() => {
    load({ usePrefetch: first.current });
    first.current = false;
    /* eslint-disable-next-line */
  }, [from, to]);

  const leads = useMemo(() => {
    // Dubai days: an enquiry at 01:00 local carries the previous UTC date.
    const { start, end } = dubaiRange(from, to);
    return raw.filter((l) => {
      const t = new Date(l.created_at).getTime();
      return t >= start && t <= end &&
        (agentFilter === "All agents" || agentOf(l) === agentFilter);
    });
  }, [raw, from, to, agentFilter]);

  /**
   * The headline set: every lead in range EXCEPT Property Management.
   *
   * PM handle tenancy and landlord work, not sales enquiries. Their leads
   * arrive in the same pipeline, so counting them in "Leads received" — and in
   * every ratio built on it — described two different jobs as one, and judged
   * PM work by a sales yardstick it was never doing.
   *
   * `leads` stays whole and is what the by-agent table reads, so their figures
   * are still on screen in full. Only the numbers at the top narrow.
   */
  const [headlineLeads, pmLeads] = useMemo(() => {
    const headline = [];
    const pm = [];
    for (const l of leads) (isPropertyManagement(agentOf(l)) ? pm : headline).push(l);
    return [headline, pm];
  }, [leads]);

  const agentNames = useMemo(
    () => [...new Set(raw.map(agentOf))].sort(), [raw]
  );

  const statusList = useMemo(() => [...new Set(raw.map(statusOf))], [raw]);

  /** Where the leads actually arrived from, biggest first. Raw PropSpace
   *  source values, so the PDF and the screen reconcile. */
  const sources = useMemo(() => tally(headlineLeads, (l) => l.source ?? "Unknown"), [headlineLeads]);

  // Lead agent name -> photo / full name, joined via agent id.
  const agentInfo = useMemo(() => agentLookupFromLeads(raw, agentDir), [raw, agentDir]);

  // Mutually exclusive. Cold is the only bucket that counts against anyone:
  // status never moved AND no note. Status-only means the lead was worked but
  // nothing was written down, which is a record-keeping gap, not a cold lead.
  /**
   * Ranked brokers and everyone else. Needed above the KPI block because the
   * median is computed on brokers only.
   */
  const [rankedLeads, unrankedLeads] = useMemo(() => {
    const ranked = [];
    const rest = [];
    for (const l of leads) (isRankedLead(l, crmAgents) ? ranked : rest).push(l);
    return [ranked, rest];
  }, [leads, crmAgents]);

  // All computed on the headline set, so the cards, the cold panel and the
  // percentages beneath them agree with one another. A PM lead that is cold is
  // still cold — it is just not counted against the sales pipeline.
  const cold = headlineLeads.filter(isCold);
  const statusOnly = headlineLeads.filter(isStatusOnly);
  const noted = headlineLeads.filter((l) => !isUntouched(l));
  // API returns the string "Yes"/"No", not a boolean — "No" is truthy, so a
  // bare check counted all 620 leads as pooled. All 620 are actually "No".
  const pool = headlineLeads.filter((l) => l.in_lead_pool === "Yes" || l.in_lead_pool === true);
  /**
   * Brokers only, unlike the counts above.
   *
   * This measures how quickly a broker responds. A lead sitting on a company
   * inbox or a management account never reached one, so including it measures
   * routing rather than responsiveness. Leads received and Cold stay
   * all-inclusive so both still tie to the CRM total — and an unrouted lead
   * has to stay visible in Cold, because that gap is worth seeing.
   */
  const med = median(
    rankedLeads.filter((l) => !isPropertyManagement(agentOf(l))).map(hoursToFirstTouch)
  );

  // Biggest bucket first. Statuses present in the wider pull but absent from
  // the current range or agent filter drop out rather than sitting at zero.
  const statusCounts = statusList
    .map((s) => ({ status: s, count: headlineLeads.filter((l) => statusOf(l) === s).length }))
    .filter((s) => s.count > 0)
    .sort((a, b) => b.count - a.count || a.status.localeCompare(b.status));
  const maxStatus = Math.max(...statusCounts.map((s) => s.count), 1);

  /**
   * Columns of the By-agent table, each with the value to rank on.
   * `desc` is the direction a first click should apply — names read better
   * A-Z, counts read better highest-first.
   */
  const AGENT_COLS = [
    { key: "name",       label: "Agent",        align: "left",  value: (r) => r.name.toLowerCase(), firstDir: "asc" },
    { key: "total",      label: "Leads",        align: "right", value: (r) => r.total },
    { key: "cold",       label: "Cold",         align: "right", value: (r) => r.cold },
    { key: "median",     label: "Median first note", align: "right", value: (r) => r.median },
    { key: "statusOnly", label: "No note",      align: "right", value: (r) => r.statusOnly },
    { key: "rate",       label: "Worked",       align: "left",  value: (r) => r.rate },
  ];

  const [sort, setSort] = useState({ key: "rate", dir: "desc" });

  const toggleSort = (col) =>
    setSort((s) => s.key === col.key
      ? { key: col.key, dir: s.dir === "asc" ? "desc" : "asc" }
      : { key: col.key, dir: col.firstDir ?? "desc" });

  /**
   * The ranking narrows to brokers; nothing above it does.
   *
   * `leads` stays whole, so every KPI card, the status breakdown and the
   * headline count are computed over all of it regardless of who the lead sat
   * with. Only the table below splits, and the remainder is rendered as one
   * reconciliation line so the Leads column still sums to "Leads received".
   */
  const reconciliation = useMemo(
    () => reconciliationRow(unrankedLeads, crmAgents), [unrankedLeads, crmAgents]
  );

  const byAgent = useMemo(() => {
    // Property Management rows are flagged, not filtered: their figures stay on
    // screen in full, and only the totals above exclude them.
    const rows = summarise(rankedLeads).map((r) => ({ ...r, pm: isPropertyManagement(r.name) }));
    const col = AGENT_COLS.find((c) => c.key === sort.key) ?? AGENT_COLS[5];
    const sign = sort.dir === "asc" ? 1 : -1;

    return [...rows].sort((a, b) => {
      // Property Management is pinned to the foot of the table, ahead of every
      // other rule and in every sort direction. They are excluded from the
      // headline, so letting them top a ranking they are not part of would
      // read as a leaderboard position — which is the one thing the greying is
      // meant to prevent. Within the pinned group the chosen sort still
      // applies, so the block is ordered rather than arbitrary.
      if (a.pm !== b.pm) return a.pm ? 1 : -1;

      const va = col.value(a);
      const vb = col.value(b);
      // Median is null for agents nobody ever touched — keep those last in
      // both directions rather than letting null masquerade as fastest.
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (va < vb) return -1 * sign;
      if (va > vb) return 1 * sign;
      // Stable tie-break: more leads first, so a 100% rate off two leads does
      // not outrank a 90% rate off a hundred.
      return b.total - a.total;
    });
    /* eslint-disable-next-line */
  }, [rankedLeads, sort]);

  // "Last 7 days · 1–7 Aug". Day windows end yesterday, so the dates are shown
  // rather than left to be assumed from the preset name. This same string is
  // what any export or PDF should carry.
  const { profile, user } = useAuth();

  /**
   * Everything the PDF needs, taken from the same values the screen renders —
   * not re-fetched and not recomputed, so the document cannot disagree with
   * what was on the page when Export was pressed. That includes the agent
   * filter, which the header states outright when one is active.
   *
   * Role scoping needs no handling here: `raw` was already scoped at the edge,
   * so a broker's export contains a broker's numbers by construction.
   */
  const pdfData = useMemo(() => ({
    rangeText: rangeSpelled(from, to),
    agentFilter,
    generatedAt: new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Dubai", day: "numeric", month: "long", year: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(new Date()),
    generatedBy: profile?.full_name || profile?.email || user?.email || "unknown user",
    totals: {
      leads: headlineLeads.length,
      cold: cold.length,
      statusOnly: statusOnly.length,
      median: med,
    },
    rows: byAgent,
    reconciliation,
    statusCounts,
    fmtHours,

    /**
     * Null when the fetch failed, so the document can say "unavailable"
     * instead of printing a zero. A quiet month and a broken API must not look
     * the same on a page someone reads without us in the room.
     */
    meta: meta?.ok ? {
      spend: fmtMoney(meta.totals.spend),
      campaigns: [...meta.campaigns]
        .sort((a, b) => b.spend - a.spend)
        .map((c) => ({ name: c.name, spend: fmtMoney(c.spend) })),
      conversions: meta.totals.conversions.map((c) => ({
        label: c.label,
        text: `${c.value} ${c.value === 1 ? c.one : c.label}`,
        each: `${fmtCost(costOf(meta.totals.spend, c.value))} each`,
      })),
    } : null,

    // Raw PropSpace source values, top five then a remainder, so the export
    // reconciles line for line against the dashboard.
    sources: (() => {
      const top = sources.slice(0, 5).map((r) => ({
        key: r.key,
        count: r.count,
        share: `${headlineLeads.length ? Math.round((r.count / headlineLeads.length) * 100) : 0}%`,
      }));
      const rest = sources.slice(5).reduce((n, r) => n + r.count, 0);
      if (rest > 0) {
        top.push({
          key: `Other (${sources.length - 5} source${sources.length - 5 === 1 ? "" : "s"})`,
          count: rest,
          share: `${headlineLeads.length ? Math.round((rest / headlineLeads.length) * 100) : 0}%`,
        });
      }
      return top;
    })(),
  }), [from, to, agentFilter, profile, user, leads, cold, statusOnly, med, byAgent, reconciliation, statusCounts, meta, sources]);

  const exportFilename = `aaronz-lead-performance-${from}-to-${to}.pdf`;

  // Never a PDF from partial data. If the pull failed, the figures on screen
  // are missing rather than low, and a document does not carry the error
  // banner that says so — it would be read as a finished report.
  const exportBlocked = error
    ? "Export is unavailable because the data on this page did not load fully."
    : loading
      ? "Still loading."
      : null;

  const period = range.preset === "custom"
    ? `${from} → ${to} (${spanDays(from, to)} days)`
    : rangeCaption(range, LEAD_PRESETS);
  const ctrl = "flex items-center gap-2 bg-white border border-slate-200 rounded-xl px-3 py-2 text-sm text-slate-700";

  return (
    <div className="min-h-screen bg-slate-50 flex">
      {/* sticky + h-screen keeps the rail in place while main scrolls. The
          parent is min-h-screen, so there is always room for it to stick to.
          overflow-y-auto so the nav can still scroll on a short window. */}
      <aside className="w-64 bg-slate-900 flex-shrink-0 hidden lg:flex flex-col py-6
                        sticky top-0 h-screen overflow-y-auto">
        <div className="px-5 pb-6">
          {/* White wordmark — only legible on the dark sidebar. The light main
              area would need the black version of the same asset. */}
          <img src={IMAGES.logoWhite} alt="Aaronz &amp; Co." width="268" height="132"
            className="w-36 h-auto" />
          <p className="text-slate-500 text-xs mt-2">Marketing &amp; Operations</p>
        </div>
        <nav className="px-2 space-y-1">
          <NavItem icon={BarChart3} label="Insights" active={tab === "leads"}
            onClick={() => goTo("leads")} />
          <NavItem icon={Contact} label="Brokers" active={tab === "brokers"}
            onClick={() => goTo("brokers")} />

          <NavGroup icon={Crosshair} label="Prospecting" badge="new"
            open={openGroups.prospecting} onToggle={() => toggleGroup("prospecting")}
            activeInside={["owner", "prospecting", "database"].includes(tab)}>
            <NavItem icon={Search} label="Owner search" active={tab === "owner"}
              onClick={() => goTo("owner")} />
            <NavItem icon={Crosshair} label="Apollo" active={tab === "prospecting"}
              onClick={() => goTo("prospecting")} />
            <NavItem icon={Database} label="Database" active={tab === "database"}
              onClick={() => goTo("database")} />
          </NavGroup>

          <NavItem icon={Globe} label="Property Finder" active={tab === "propertyfinder"}
            onClick={() => goTo("propertyfinder")} />

          {/* TruCheck reads Bayut's own listings and scores them, so it belongs
              under Bayut rather than beside it. The header is still the Bayut
              tab — it is a destination, not only a heading. */}
          <NavGroup icon={Home} label="Bayut"
            open={openGroups.bayut}
            onToggle={() => {
              // Opening it is also going there; closing it is just closing it.
              // Navigating on collapse would move you off TruCheck for the
              // crime of tidying the rail.
              if (!openGroups.bayut) setTab("bayut");
              toggleGroup("bayut");
            }}
            activeInside={["bayut", "trucheck"].includes(tab)}>
            <NavItem icon={Home} label="Listings &amp; leads" active={tab === "bayut"}
              onClick={() => goTo("bayut")} />
            <NavItem icon={ShieldCheck} label="TruCheck" active={tab === "trucheck"}
              onClick={() => goTo("trucheck")} badge="new" />
          </NavGroup>

          <NavItem icon={Building2} label="Listings" active={tab === "listings"}
            onClick={() => goTo("listings")} />
          <NavItem icon={Layers} label="Off-plan" active={tab === "offplan"}
            onClick={() => goTo("offplan")} badge="new" />

          <NavGroup icon={Megaphone} label="Marketing"
            open={openGroups.marketing} onToggle={() => toggleGroup("marketing")}
            activeInside={["campaigns", "branding"].includes(tab)}>
            <NavItem icon={Megaphone} label="Campaigns" active={tab === "campaigns"}
              onClick={() => goTo("campaigns")} />
            <NavItem icon={Sparkles} label="Personal Branding" active={tab === "branding"}
              onClick={() => goTo("branding")} />
          </NavGroup>

          <NavItem icon={GraduationCap} label="Training" active={tab === "training"}
            onClick={() => goTo("training")} />
          <NavItem icon={Settings} label="Settings" />
        </nav>

        {/*
          Whose session this is, above the way out of it.

          These machines are shared. Somebody who books a camera or writes a
          note under a colleague's login has left a false record, and the only
          thing that prevents it is being able to see the name without going
          looking for it. mt-auto pins this to the foot of the rail, which is
          why the aside is a flex column.
        */}
        <div className="mt-auto px-5 pt-4 border-t border-white/10">
          <p className="text-[11px] text-slate-500">Signed in as</p>
          <p className="text-sm text-white font-medium truncate"
            title={profile?.email ?? user?.email ?? undefined}>
            {profile?.full_name || profile?.email || user?.email || "Unknown user"}
          </p>
          <SignOutButton className="mt-2" />
        </div>
      </aside>

      <main className="flex-1 min-w-0 px-6 lg:px-10 py-8">
        {/* Sidebar is hidden below lg, so the tabs need a visible control here too. */}
        <div className="flex items-center gap-2 mb-6 lg:hidden">
          {[["leads", "Leads"], ["brokers", "Brokers"], ["listings", "Listings"], ["offplan", "Off-plan"], ["prospecting", "Apollo"], ["owner", "Owner search"], ["propertyfinder", "Property Finder"], ["bayut", "Bayut"], ["trucheck", "TruCheck"], ["campaigns", "Campaigns"], ["branding", "Personal Branding"], ["training", "Training"], ["database", "Database"]].map(([k, label]) => (
            <button key={k} onClick={() => goTo(k)}
              className={`px-3 py-1.5 text-sm rounded-lg border transition ${tab === k
                ? "bg-slate-900 text-white border-slate-900 font-medium"
                : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50 hover:border-slate-300"}`}>
              {label}
            </button>
          ))}
        </div>

        {tab === "prospecting" ? (
          <Prospecting />
        ) : tab === "command" ? (
          <CommandCentre />
        ) : tab === "campaigns" ? (
          <Campaigns initialRange={range} />
        ) : tab === "branding" ? (
          <PersonalBranding />
        ) : tab === "training" ? (
          <Training />
        ) : tab === "database" ? (
          <DatabaseTab />
        ) : tab === "brokers" ? (
          <Brokers />
        ) : tab === "propertyfinder" ? (
          <PropertyFinder />
        ) : tab === "bayut" ? (
          <Bayut />
        ) : tab === "trucheck" ? (
          <TruCheck />
        ) : tab === "owner" ? (
          <OwnerSearch />
        ) : tab === "equipment" ? (
          <Equipment />
        ) : tab === "offplan" ? (
          <OffPlan />
        ) : tab === "listings" ? (
          <>
            <Listings />
          </>
        ) : (
        <>
        <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
          <div>
            <p className="text-sm text-slate-500">Lead performance</p>
            <h1 className="text-2xl font-bold text-slate-900 tracking-tight mt-1">
              Who is working the leads
            </h1>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <DateRange value={range} onChange={setRange} presets={LEAD_PRESETS} />
            <div className={ctrl}>
              <Users className="w-4 h-4 text-slate-400" />
              <select value={agentFilter} onChange={(e) => setAgentFilter(e.target.value)}
                      className="bg-transparent outline-none cursor-pointer">
                <option>All agents</option>
                {agentNames.map((a) => <option key={a}>{a}</option>)}
              </select>
            </div>
            <button onClick={load}
              className={`${ctrl} hover:bg-slate-50 ${loading ? "is-fetching" : ""}`}>
              <RefreshCw className={`w-4 h-4 text-slate-400 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-4 px-4 py-3 rounded-xl bg-rose-50 border border-rose-200 text-sm text-rose-800">
            <span className="font-medium">Couldn't load from PropSpace.</span>{" "}
            {error}{" "}
            {/* Was "Check .env, then the response shape in propspace.js" — advice
                for whoever wrote this, on a machine that had a .env. On a
                deployed build there is neither, and the reason is already in
                the message above. */}
            <span className="text-rose-600">Try Refresh — most of these clear on their own.</span>{" "}
            <span className="text-rose-700 font-medium">
              Export is disabled until this loads, so a PDF cannot be built from partial figures.
            </span>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          {/* The lead pool is no longer a concept here, so the card is the
              number and its label. */}
          {/* The scope line is the whole reason this number can be trusted:
              without it, a figure that excludes PM looks like a figure that
              lost some leads. */}
          <Metric icon={Inbox} tint="bg-indigo-50 text-indigo-600"
            label="Leads received" period={period} value={headlineLeads.length}
            hint="Every sales lead that arrived in this range."
            scope={pmLeads.length
              ? `Excludes ${pmLeads.length} ${PM_LABEL} lead${pmLeads.length === 1 ? "" : "s"}, still shown per agent below`
              : null} />
          <Metric icon={UserX} tint="bg-rose-50 text-rose-600"
            label="Cold" period={period} value={cold.length}
            alert={headlineLeads.length ? `${Math.round(cold.length / headlineLeads.length * 100)}% of leads` : null}
            hint="No status change and no note. Nothing has been done with this lead."
            onOpen={() => setColdOpen(true)} openLabel="See which leads" />
          {/* Named for what it can actually see. PropSpace exposes no
              timestamp for a status change, so a lead worked without a note
              cannot be measured at all — calling this "first touch" claimed
              more than the data supports. */}
          <Metric icon={Clock} tint="bg-sky-50 text-sky-600"
            label="Median time to first note" period={period}
            value={fmtHours(med)}
            hint="Typical time from lead arrival to a broker logging a note."
            scope={`Brokers only${
              unrankedLeads.length
                ? ` · excludes ${unrankedLeads.length} lead${unrankedLeads.length === 1 ? "" : "s"} on management and system accounts`
                : ""}${pmLeads.length ? ` · excludes ${PM_LABEL}` : ""}`} />
          <Metric icon={AlertTriangle} tint="bg-amber-50 text-amber-600"
            label="Worked, but no note" period={period}
            value={statusOnly.length}
            alert={headlineLeads.length ? `${Math.round(statusOnly.length / headlineLeads.length * 100)}% of leads` : null}
            hint="Status was moved but nothing was written down." />
        </div>

        {/* Overview strip — same card treatment and spacing as the KPI row
            above, because it is the same kind of glance. Paid spend on the
            left, where leads actually arrived on the right. The two do not
            reconcile and are not meant to: a WhatsApp conversation is not a
            CRM lead. Side by side they answer "what did we spend, and where
            did the leads come from" without implying one produced the other. */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
          {/* Opens the Campaigns tab on the window this card is showing, so the
              figures there are the ones that were just clicked rather than
              whatever that tab last defaulted to. */}
          <Card className={`p-5 ${OPENABLE}`} {...openable(() => setTab("campaigns"))}>
            <div className="flex items-center gap-2">
              <span className="w-10 h-10 rounded-xl bg-blue-50 text-[#0081FB] flex items-center justify-center flex-shrink-0">
                <SiMeta className="w-5 h-5" />
              </span>
              <span className="w-10 h-10 rounded-xl bg-emerald-50 text-[#25D366] flex items-center justify-center flex-shrink-0">
                <SiWhatsapp className="w-[18px] h-[18px]" />
              </span>
              <div className="ml-1 min-w-0">
                <p className="text-sm font-medium text-slate-700 flex items-center gap-1.5">
                  Meta advertising
                  <InfoHint text="Spend and conversations from the Meta ads account for the
                                  same window. A conversation started is somebody opening a
                                  WhatsApp chat from an ad — it creates no PropSpace lead, so
                                  it will never tie to the lead figures above." />
                </p>
                <p className="text-xs text-slate-400">{period}</p>
              </div>
            </div>

            {meta === null ? (
              <p className="mt-4 text-sm text-slate-400">Loading…</p>
            ) : !meta.ok ? (
              /* Explicit, never a zero. A failed fetch and a month with no
                 spend must not look the same. */
              <p className="mt-4 text-sm text-amber-700">
                Couldn't load Meta figures — {meta.error}
              </p>
            ) : (
              /* A wide gap on purpose. These are two unrelated figures —
                 dirhams spent and conversations started — and at gap-x-10 the
                 caption under the spend ran close enough to the next number to
                 read as one continuous sentence. The space is what separates
                 them into two facts. */
              <div className="mt-4 flex flex-wrap items-end gap-x-16 gap-y-3">
                <div>
                  <p className="text-3xl font-bold text-slate-900 tracking-tight">
                    {fmtMoney(meta.totals.spend)}
                  </p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    spend · {meta.campaigns.length} campaign{meta.campaigns.length === 1 ? "" : "s"}
                  </p>
                </div>
                {meta.totals.conversions.length ? meta.totals.conversions.map((c) => (
                  <div key={c.key}>
                    <p className="text-3xl font-bold text-slate-900 tracking-tight">{c.value}</p>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {c.label} · {fmtCost(costOf(meta.totals.spend, c.value))} each
                    </p>
                  </div>
                )) : (
                  <p className="text-sm text-amber-700">no conversions recorded</p>
                )}
              </div>
            )}
            <OpenHint>See the campaigns behind this</OpenHint>
          </Card>

          <Card className="p-5">
            <p className="text-sm font-medium text-slate-700 flex items-center gap-1.5">
              Where leads came from
              <InfoHint text="The source the CRM recorded against each lead in this window.
                              Free text on the API, so it groups on whatever was written." />
            </p>
            <p className="text-xs text-slate-400 mt-0.5">{period}</p>

            <div className="mt-4 space-y-2.5">
              {sources.slice(0, 4).map((row) => (
                <div key={row.key} className="flex items-center gap-3">
                  <span className="text-sm text-slate-900 w-44 flex-shrink-0 break-words leading-snug">
                    {row.key}
                  </span>
                  <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
                    <div className="h-full rounded-full bg-indigo-400"
                      style={{ width: `${headlineLeads.length ? (row.count / headlineLeads.length) * 100 : 0}%` }} />
                  </div>
                  <span className="text-sm font-semibold text-slate-900 w-10 text-right flex-shrink-0">
                    {row.count}
                  </span>
                  <span className="text-xs text-slate-400 w-10 text-right flex-shrink-0">
                    {headlineLeads.length ? Math.round((row.count / headlineLeads.length) * 100) : 0}%
                  </span>
                </div>
              ))}
              {!sources.length && <p className="text-sm text-slate-400">No leads in this range.</p>}
            </div>
          </Card>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 mt-4">
          <Card className="xl:col-span-1 p-5">
            <p className="text-sm font-semibold text-slate-900">Status breakdown</p>
            <p className="text-xs text-slate-400 mt-0.5">{period}</p>
            <div className="mt-5 space-y-3">
              {statusCounts.map((s) => (
                <div key={s.status}>
                  <div className="flex justify-between text-sm mb-1.5">
                    <span className="text-slate-600">{s.status}</span>
                    <span className="text-slate-900 font-semibold">{s.count}</span>
                  </div>
                  <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                    <div className={`h-full rounded-full ${
                        /not contacted/i.test(s.status) ? "bg-rose-400" : "bg-violet-400"}`}
                      style={{ width: `${(s.count / maxStatus) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card className="xl:col-span-2 overflow-hidden">
            <div className="p-5 pb-4">
              <p className="text-sm font-semibold text-slate-900">By agent</p>
              <p className="text-xs text-slate-400 mt-0.5">
                Click any heading to rank by it · click a row for detail
              </p>
              {/* Stated here rather than left to be inferred from the greying,
                  because a row that looks faded and a number that does not add
                  up to the card above it is a bug until somebody says why. */}
              {pmLeads.length > 0 && (
                <p className="text-xs text-slate-500 mt-2 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                  <span className="font-medium">{PM_LABEL} rows are greyed.</span>{" "}
                  Their figures are their own and complete, but their{" "}
                  {pmLeads.length} lead{pmLeads.length === 1 ? "" : "s"} are not counted in the totals at the
                  top of this page — tenancy and landlord work is a different job from a sales enquiry, and
                  measuring the two as one flatters neither.
                </p>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500 border-y border-slate-200 bg-slate-50">
                    {AGENT_COLS.map((c, i) => {
                      const active = sort.key === c.key;
                      return (
                        <th key={c.key}
                          onClick={() => toggleSort(c)}
                          title={`Sort by ${c.label}`}
                          className={`py-2.5 font-medium cursor-pointer select-none hover:text-slate-900
                            ${i === 0 ? "px-5" : i === AGENT_COLS.length - 1 ? "px-5 w-32" : "px-3"}
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
                  {byAgent.map((a, i) => (
                    <tr key={a.name}
                      onClick={() => setOpenAgent(a.name)}
                      className={`border-b border-slate-100 last:border-0 cursor-pointer hover:bg-slate-50 ${
                        a.pm ? "bg-slate-50/60" : ""} ${
                        /* A rule above the first pinned row, so the block reads
                           as held apart rather than as the bottom of the
                           ranking. */
                        a.pm && byAgent[i - 1] && !byAgent[i - 1].pm
                          ? "border-t-2 border-t-slate-200" : ""}`}>
                      {/* Property Management rows are held back from the
                          headline, so they are drawn back from it too — greyed
                          rather than removed, because the work is real and the
                          figures are theirs. Everything in the row is their
                          own number; only the totals above exclude them. */}
                      <td className={`px-5 py-3 font-medium ${a.pm ? "text-slate-400" : "text-slate-900"}`}>
                        <span className="flex items-center gap-2.5">
                          <span className={a.pm ? "opacity-50" : ""}>
                            <Avatar name={agentInfo.get(a.name)?.fullName ?? a.name}
                              photo={agentInfo.get(a.name)?.photo} />
                          </span>
                          <span className="hover:underline">
                            {agentInfo.get(a.name)?.fullName ?? a.name}
                          </span>
                          {a.pm && (
                            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded
                                             bg-slate-900 text-white whitespace-nowrap flex-shrink-0"
                              title="Tenancy and landlord work. Counted here, but not in the figures at the top.">
                              {PM_LABEL}
                            </span>
                          )}
                        </span>
                      </td>
                      <td className={`px-3 py-3 text-right ${a.pm ? "text-slate-400" : "text-slate-600"}`}>{a.total}</td>
                      <td className="px-3 py-3 text-right">
                        {a.cold > 0
                          ? <span className={`inline-block px-2 py-0.5 rounded-lg font-semibold ${
                              a.pm ? "bg-slate-100 text-slate-500" : "bg-rose-50 text-rose-700"}`}>{a.cold}</span>
                          : <span className="text-slate-300">0</span>}
                      </td>
                      <td className={`px-3 py-3 text-right ${a.pm ? "text-slate-400" : "text-slate-600"}`}>{fmtHours(a.median)}</td>
                      <td className="px-3 py-3 text-right">
                        {a.statusOnly > 0
                          ? <span className={`inline-block px-2 py-0.5 rounded-lg font-semibold ${
                              a.pm ? "bg-slate-100 text-slate-500" : "bg-amber-50 text-amber-700"}`}>{a.statusOnly}</span>
                          : <span className="text-slate-300">0</span>}
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
                            <div className={`h-full rounded-full ${a.pm ? "bg-slate-300"
                                : a.rate > 0.75 ? "bg-emerald-400" : a.rate > 0.5 ? "bg-amber-400" : "bg-rose-400"}`}
                              style={{ width: `${a.rate * 100}%` }} />
                          </div>
                          <span className={`text-xs w-9 text-right ${a.pm ? "text-slate-400" : "text-slate-500"}`}>
                            {Math.round(a.rate * 100)}%
                          </span>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {!byAgent.length && (
                    <tr><td colSpan={6} className="px-5 py-8 text-center text-sm text-slate-400">
                      No leads in this range.
                    </td></tr>
                  )}

                  {/* Everyone the ranking leaves out, as one line. Without it
                      the Leads column stops matching "Leads received" above,
                      and a reader is left to wonder which number is wrong. Not
                      clickable and deliberately plainer than a broker row — it
                      is a reconciliation, not a participant. */}
                  {reconciliation && (
                    <tr className="border-t-2 border-slate-200 bg-slate-50/60">
                      <td className="px-5 py-3 text-slate-500">
                        <span className="flex items-center gap-2.5">
                          <span className="w-7 h-7 rounded-full bg-slate-100 text-slate-400
                                           flex items-center justify-center flex-shrink-0">
                            <Users className="w-3.5 h-3.5" />
                          </span>
                          <span>
                            {reconciliation.name}
                            <span className="block text-[11px] text-slate-400">
                              {reconciliation.agents} agent{reconciliation.agents === 1 ? "" : "s"} outside the broker ranking
                            </span>
                          </span>
                        </span>
                      </td>
                      <td className="px-3 py-3 text-right text-slate-500">{reconciliation.total}</td>
                      <td className="px-3 py-3 text-right text-slate-400">{reconciliation.cold}</td>
                      <td className="px-3 py-3 text-right text-slate-400">{fmtHours(reconciliation.median)}</td>
                      <td className="px-3 py-3 text-right text-slate-400">{reconciliation.statusOnly}</td>
                      <td className="px-5 py-3 text-xs text-slate-400">not ranked</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </div>


        <p className="text-xs text-slate-400 mt-6">
          Live from PropSpace. A lead counts as worked once its status moves off a
          default, with or without a note; {statusOnly.length} of these were worked
          without one. First touch is derived from the notes array, so it can only be
          measured on the {noted.length} that carry a note.
        </p>
        </>
        )}
      </main>

      <ColdPanel
        open={coldOpen}
        leads={cold}
        period={period}
        scope={agentFilter === "All agents" ? null : agentFilter}
        info={agentInfo}
        onClose={() => setColdOpen(false)}
      />

      <AgentPanel
        name={openAgent}
        leads={openAgent ? leads.filter((l) => agentOf(l) === openAgent) : []}
        info={openAgent ? agentInfo.get(openAgent) : null}
        onClose={() => setOpenAgent(null)}
      />

    </div>
  );
}
