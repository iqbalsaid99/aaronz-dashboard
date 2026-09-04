/**
 * Broker profile data layer — one record per broker, assembled from three
 * sources that do not share a key.
 *
 * WHAT THE API GIVES US, verified against the live account 2026-08-04:
 *
 *   Leads      /leads        yes. Statuses, notes, agent (first name + id).
 *   Listings   /listings     yes. Current book, agent (full name + id + photo).
 *   Viewings   /viewings     403. So is /appointments, /activities, /calendar,
 *                            /events, /tasks. Derived from notes instead — see
 *                            below.
 *   Billings   /deals        403. So is /transactions, /commissions, /invoices,
 *                            /payments, /offers, /contracts, /sales, /lettings.
 *                            No endpoint exists on this key, so billings are
 *                            entered by hand — see billings.json.
 *
 * The 403 is the WAF's generic answer for any path not on the key, so it means
 * "not available" rather than "blocked" — the same 403 comes back for /docs and
 * /options/*, and /leads and /listings return 200 on the same token.
 *
 * IDENTITY. Leads carry first names only ("Dennis") while listings carry the
 * full name ("Dennis Manalo"). Both carry the same numeric agent id, so the
 * roster is keyed on id and the display name is whichever source has the longer
 * one. Brokers with no id fall back to a lowercased-name key, which is why the
 * key is a string and not a number.
 */

import {
  agentOf, statusOf, isUntouched, isCold, isStatusOnly,
  hoursToFirstTouch, median, parseNoteDate, humanNotes,
} from "./propspace.js";
import { listingAgentOf, isHouseAccount } from "./listings.js";
import billingsFile from "./billings.json";
import crmUsersFile from "./crm-users.json";

/* ---------------------------- the roster ---------------------------- */

/**
 * Who is on the CRM, whether or not they have anything assigned.
 *
 * The roster used to be the union of leads and listings, which meant a broker
 * with neither did not exist as far as this screen was concerned — a new joiner
 * looks exactly like somebody who was never there. PropSpace exposes no agent
 * directory on this key (/options/agents, /agents and /users are all 403), so
 * the list is maintained in crm-users.json from the CRM's own Current Users
 * screen with the Active filter on.
 *
 * JOINED ON EMAIL. Every lead and listing agent object carries one, and it is
 * the only field that is both present everywhere and unique — leads carry first
 * names only ("Harry"), and matching those against a 45-person directory would
 * eventually put one person's leads under another's name. agentId is recorded
 * where the API has shown one and is preferred when present, but it is an
 * optimisation: email alone is enough.
 */
export const CRM_USERS = crmUsersFile.users ?? [];

const emailKey = (e) => String(e ?? "").trim().toLowerCase() || null;

/* ------------------------------ notes ------------------------------ */

/**
 * The CRM escapes apostrophes as "#sqoute#" on the way out — "didn#sqoute#t".
 * Left alone it shows up verbatim in the UI.
 */
export const cleanNote = (text) =>
  String(text ?? "").replace(/#sqoute#/gi, "'").replace(/\s+/g, " ").trim();

/* ----------------------------- viewings ----------------------------- */

/**
 * TIER 1 — the CRM's viewing module writes a machine-readable note:
 *
 *   "New system note: Dennis has a viewing Scheduled with Hendrien Hodson,
 *    Lead ref: ARZ-L-46150, at 2026-07-27 16:15:48, feedback: Did viewing"
 *
 * Agent, state, client, lead ref, scheduled time and feedback, all parseable.
 * This is the only exact viewing record the API exposes.
 *
 * It is also barely used: 20 of them across 3,000 leads and four months, and 14
 * are one broker. Three variants exist — an extra "listing ref ARZ-R-7612"
 * clause, a trailing space before the comma, and a day-first date instead of
 * ISO — all three handled here because with 20 records total, losing three to a
 * strict pattern is losing 15% of the data.
 *
 * So this cannot be the headline number. It is the ceiling on what the CRM
 * actually knows, and the gap between it and the text signal below is the real
 * finding: viewings are recorded in prose, not in the viewing module.
 */
const SYSTEM_VIEWING =
  /^(?:new\s+)?system note:\s*(.+?)\s+has\s+a\s+viewing\s+(\S+)\s+with\s*(.*?),\s*lead ref:\s*([^\s,]+)(?:\s+listing ref\s+([^\s,]+))?\s*,\s*at\s+(\d{2,4}[-/]\d{2}[-/]\d{2,4}[ T]\d{1,2}:\d{2}(?::\d{2})?)\s*,?\s*(?:feedback:\s*(.*?))?\s*$/i;

/** Structured viewing records on a lead. Empty for all but a handful. */
export function systemViewingsOf(lead) {
  const out = [];
  for (const n of lead.notes ?? []) {
    const m = cleanNote(n.notes).match(SYSTEM_VIEWING);
    if (!m) continue;
    const [, agent, state, client, leadRef, listingRef, at, feedback] = m;
    out.push({
      tier: "confirmed",
      agent: agent.trim(),
      state: state.trim(),                       // Scheduled | Successful
      client: client.trim() || null,
      leadRef: leadRef.trim(),
      listingRef: listingRef?.trim() ?? null,
      at: parseNoteDate(at),
      feedback: feedback?.trim() || null,
      author: n.user_name,
      loggedAt: parseNoteDate(n.date ?? n.created_at),
      text: cleanNote(n.notes),
    });
  }
  return out;
}

/**
 * TIERS 2-4 — viewings written in prose, which is where nearly all of them are.
 *
 * The naive match on /viewing/ is badly wrong: it counts "refuse to view",
 * "waiting for viewing request" and "Viewing to schedule", none of which are
 * viewings. Over 2,000 leads the naive count was 125; split properly it is 36
 * done, 46 booked, 15 discussed-only and 37 too vague to call.
 *
 * DONE     past tense — the viewing happened
 * BOOKED   a commitment exists — scheduled, arranged, a named day
 * INTENT   the word appears but nothing is committed, including refusals and
 *          cancellations, which the naive match scored as viewings
 *
 * These are regexes over free text typed by twenty-odd people, so they are
 * approximate by construction. They are deliberately ordered most-specific
 * first and every tier is surfaced separately in the UI rather than summed into
 * one authoritative-looking figure.
 */
export const VIEWING_DONE = new RegExp([
  /\bviewing?s?\s+(?:is|was|has been|been|already)?\s*(?:done|completed|complete)\b/,
  /\b(?:already\s+)?done\s+(?:the\s+|a\s+)?viewing\b/,
  /\bdid\s+(?:a\s+|the\s+)?viewing\b/,
  /\bhad\s+(?:a\s+|the\s+)?viewing\b/,
  /\bafter\s+(?:the\s+)?viewing\b/,
  /\battended\s+(?:the\s+)?viewing\b/,
  /\b(?:unit|apartment|flat|villa|property|it)\s+(?:was\s+)?viewed\b/,
  /\bviewed\s+(?:the|it|this|unit|apartment|flat|villa|property)\b/,
  /\bshowed\s+(?:him|her|them|the|it|\d)\b/,
  /\bshowed\s+\w+\s+(?:the|a)\s+(?:unit|apartment|flat|villa|property)\b/,
].map((r) => r.source).join("|"), "i");

export const VIEWING_BOOKED = new RegExp([
  /\bviewing?s?\s+(?:is\s+|are\s+)?(?:scheduled|sched|arr?anged|booked|confirmed|set|rescheduled)\b/,
  /\b(?:scheduled|arr?anged|booked|set|confirmed)\s+(?:a\s+|the\s+|his\s+|her\s+)?viewing\b/,
  /\bviewing?s?\s+(?:tom|tomorrow|today|tonight|this\s+(?:morning|afternoon|evening))\b/,
  /\bviewing\s+(?:the\s+)?\w+\s+with\s+\w+\s+(?:tom|tomorrow|today)\b/,
  /\bhas\s+a\s+viewing\s+\w+\s+with\b/,
  /\bviewing\s+(?:on|at)\s+(?:\d|mon|tue|wed|thu|fri|sat|sun)/,
].map((r) => r.source).join("|"), "i");

export const VIEWING_INTENT = new RegExp([
  /\bwaiting\s+for\s+(?:a\s+|the\s+|his\s+|her\s+|their\s+)?(?:viewing|schedule)\b/,
  /\bviewing\s+to\s+(?:schedule|be\s+(?:schedul|reschedul))/,
  /\b(?:wants?|willing|need|needs|hoping)\s+to\s+view\b/,
  /\bneeds?\s+(?:a\s+)?viewing\b/,
  /\brefus\w*\s+to\s+view\b/,
  /\bcan'?t\s+confirm\s+(?:the\s+)?viewing\b/,
  /\bcancel\w*\s+(?:the\s+)?viewing\b/,
  /\barrang\w*\s+(?:to\s+view|viewing)\b/,
  /\bviewing\s+will\s+be\s+(?:arr?anged|shared|scheduled)\b/,
  /\basked\s+for\s+(?:a\s+)?viewing\b/,
  /\bfor\s+viewing\s+(?:request|later)\b/,
].map((r) => r.source).join("|"), "i");

/**
 * The loose net, built as the union of the three tiers plus a bare mention, so
 * it is a superset of them by construction. That makes `mentioned` mean exactly
 * "a viewing word appears and no tier claimed it" — a tier can never match
 * something the net misses, which is what happened when the net was written out
 * by hand and missed "wants to view" / "refuse to view".
 *
 * Bare "view" is deliberately NOT in here. Half the notes in a Dubai book say
 * "sea view" or "pool view", which is a vista, not a viewing. Only the verb
 * form "to view" counts.
 */
export const VIEWING_ANY = new RegExp([
  /\bview(?:ed|ing)s?\b/, /\bto\s+view\b/, /\bshow(?:ed|ing)\b/,
  VIEWING_DONE, VIEWING_BOOKED, VIEWING_INTENT,
].map((r) => r.source).join("|"), "i");

export const VIEWING_TIERS = ["confirmed", "done", "booked", "intent", "mentioned"];

export const TIER_META = {
  confirmed: { label: "Logged in the CRM", tint: "bg-emerald-50 text-emerald-700", dot: "bg-emerald-500",
    note: "Written by the CRM's own viewing module, with a client, a lead reference and a scheduled time." },
  done:      { label: "Happened", tint: "bg-sky-50 text-sky-700", dot: "bg-sky-500",
    note: "A note describes the viewing in the past tense." },
  booked:    { label: "Booked", tint: "bg-indigo-50 text-indigo-700", dot: "bg-indigo-500",
    note: "A note names a scheduled or arranged viewing." },
  intent:    { label: "Discussed only", tint: "bg-amber-50 text-amber-700", dot: "bg-amber-500",
    note: "The word appears but nothing was committed — includes refusals and cancellations." },
  mentioned: { label: "Unclear", tint: "bg-slate-100 text-slate-600", dot: "bg-slate-400",
    note: "A viewing word appears in a note but the sentence does not say whether one happened." },
};

/**
 * The lead's own sub-status, as evidence.
 *
 * This used to be excluded from the count on the grounds that a status is a
 * snapshot with no history. That is true, but it argues the opposite way: the
 * snapshot only ever LOSES viewings — a lead that was viewed and has since
 * moved to Offer Made no longer says so — it never invents one. A broker who
 * moved a lead to "Viewing arranged" recorded a viewing just as deliberately as
 * one who typed "viewing booked for Tuesday", and reading only the prose threw
 * that away.
 *
 * Measured over 1,200 live leads (24 June — 10 August 2026): 57 sat at a
 * viewing sub-status, and 23 of those were invisible to the note reader. Six
 * had no note at all; the rest wrote things like "Set for next week" and
 * "Waiting for confirmat", which name no viewing and never could be matched.
 * The headline read 60 where the defensible figure is 83.
 *
 *   "Viewing Done"      it happened            -> done
 *   "Viewing arranged"  it is on the calendar  -> booked
 *
 * Matched on a prefix rather than the two exact strings because the taxonomy is
 * editable in the CRM; anything else beginning "Viewing" is a commitment at
 * least as strong as arranged, so it lands in booked.
 */
export function statusViewingTier(lead) {
  const s = statusOf(lead);
  if (/^viewing\s*done\b/i.test(s)) return "done";
  return /^viewing/i.test(s) ? "booked" : null;
}

/**
 * Strongest evidence of a viewing on this lead, and everything that supports
 * it. Precedence is confirmed > done > booked > intent > mentioned, so a lead
 * whose viewing both happened and was logged properly counts once, at the top
 * tier.
 *
 * Two independent sources feed done and booked — what the broker wrote, and
 * where the broker put the lead. Either alone is enough; neither downgrades the
 * other, so a note saying the viewing happened still outranks a status that
 * only says it was arranged.
 */
/**
 * When the viewing happened, best available.
 *
 * Needed because the date range on the Brokers tab used to filter viewings by
 * when the LEAD arrived, which is a different question and a badly misleading
 * one: a broker who books a viewing today against a lead from May had that
 * viewing counted in May, or more often not at all. On "Last 7 days" that
 * showed 6 of the 125 viewings on the book.
 *
 * In order of trust:
 *   1. the scheduled time on a CRM viewing record — an actual appointment
 *   2. the note that evidences it — when the broker wrote it down
 *   3. last_updated on the lead — for a lead sitting at a viewing sub-status
 *      with nothing written, the last change to the record is the closest thing
 *      to a date that exists. It is an upper bound, not the appointment time.
 *
 * (3) was checked for bulk-update pollution before being trusted: across 3,000
 * live leads no timestamp is shared by more than six, so it reflects real edits
 * rather than a migration stamping every row.
 */
function viewingDate(lead, system, supporting) {
  const at = system[0]?.at ?? null;
  if (at) return { at, dateFrom: "appointment" };

  const noted = supporting
    .map((n) => parseNoteDate(n.date ?? n.created_at))
    .filter(Boolean)
    .sort((a, b) => b - a)[0] ?? null;
  if (noted) return { at: noted, dateFrom: "note" };

  const updated = parseNoteDate(lead.last_updated) ?? (lead.last_updated
    ? new Date(String(lead.last_updated).replace(" ", "T"))
    : null);
  return Number.isFinite(updated?.getTime())
    ? { at: updated, dateFrom: "last-updated" }
    : { at: null, dateFrom: null };
}

export function viewingEvidence(lead) {
  const system = systemViewingsOf(lead);
  const notes = humanNotes(lead);

  const hits = (re) => notes.filter((n) => re.test(cleanNote(n.notes)));

  const done = hits(VIEWING_DONE);
  const booked = hits(VIEWING_BOOKED);
  const intent = hits(VIEWING_INTENT);
  const any = hits(VIEWING_ANY);
  const fromStatus = statusViewingTier(lead);

  let tier = null;
  if (system.length) tier = "confirmed";
  else if (done.length || fromStatus === "done") tier = "done";
  else if (booked.length || fromStatus === "booked") tier = "booked";
  else if (intent.length) tier = "intent";
  else if (any.length) tier = "mentioned";

  const supporting =
    tier === "confirmed" ? []
      : tier === "done" ? done : tier === "booked" ? booked : tier === "intent" ? intent : any;

  let evidence;
  if (tier === "confirmed") {
    evidence = system.map((s) => ({ ...s, kind: "system" }));
  } else {
    evidence = supporting.map((n) => ({
      tier, kind: "note", author: n.user_name,
      loggedAt: parseNoteDate(n.date ?? n.created_at), text: cleanNote(n.notes),
    }));

    // Listed first, and always present when the status is what earned the tier
    // — otherwise a lead counted purely on its status would show as a viewing
    // with nothing at all behind it.
    if (fromStatus && fromStatus === tier) {
      evidence.unshift({
        tier, kind: "status", author: null, loggedAt: null,
        text: `The lead sits at the “${statusOf(lead)}” sub-status in the CRM.`,
      });
    }
  }

  const { at, dateFrom } = tier
    ? viewingDate(lead, system, supporting)
    : { at: null, dateFrom: null };

  return { tier, evidence, system, at, dateFrom };
}

/** Whether the CRM's own status currently claims a viewing. A snapshot, so it
 *  under-reports — see statusViewingTier, which folds it into the count. */
export const claimsViewing = (lead) => /^viewing/i.test(statusOf(lead));

/* ----------------------------- billings ----------------------------- */

/**
 * There is no billings endpoint, so this comes from src/billings.json, which is
 * maintained by hand — the same arrangement as assets-register.json behind the
 * Equipment tab.
 *
 * Shape, all fields optional except name:
 *
 *   {
 *     "currency": "AED",
 *     "asOf": "2026-07-31",
 *     "brokers": [
 *       { "name": "Dennis Manalo", "agentId": 1505580,
 *         "target": 500000, "billed": 412000, "actual": 388000,
 *         "deals": 6, "notes": "two rentals pending collection" }
 *     ]
 *   }
 *
 *   target   what they are expected to bill over the period
 *   billed   invoiced to date — "billings to date"
 *   actual   collected / recognised — "actual billings"
 *   agentId  optional but preferred; it makes the join exact
 *
 * Matching without an agentId is on name: exact first, then a unique
 * first-name match, because leads carry first names only. Anything that matches
 * nothing or matches two brokers is reported rather than dropped, so a typo in
 * the sheet is visible instead of silently zeroing someone.
 */
export const BILLINGS = billingsFile;

/**
 * What a broker billed inside a date range, from their individual invoices.
 *
 * The profile's headline used to show the year-to-date total whatever window
 * was selected, which put a figure covering seven months next to viewings and
 * leads covering thirty days — three numbers on one row answering three
 * different questions. Invoices carry their own date, so this answers the same
 * question the rest of the card does.
 *
 * Dated on the invoice, in Dubai days like everything else here. `billed` and
 * `actual` on an entry remain the period totals from the sheet and are left
 * alone: they are what the sheet says, not something to recompute.
 */
export function billedInRange(entry, from, to) {
  const invoices = entry?.invoices ?? [];
  if (!invoices.length) return null;

  const start = new Date(`${from}T00:00:00+04:00`).getTime();
  const end = new Date(`${to}T23:59:59.999+04:00`).getTime();

  const inRange = invoices.filter((i) => {
    const t = new Date(`${i.date}T12:00:00+04:00`).getTime();
    return Number.isFinite(t) && t >= start && t <= end;
  });

  return {
    amount: inRange.reduce((n, i) => n + (Number(i.amount) || 0), 0),
    deals: inRange.length,
    invoices: inRange,
  };
}

/** Every invoice on file, whatever the window — the to-date figure. */
export const billedToDate = (entry) => {
  const invoices = entry?.invoices ?? [];
  return invoices.length
    ? { amount: invoices.reduce((n, i) => n + (Number(i.amount) || 0), 0), deals: invoices.length }
    : null;
};

export function matchBillings(rows, billings = BILLINGS) {
  const entries = billings?.brokers ?? [];
  const byKey = new Map();
  const unmatched = [];
  const ambiguous = [];

  for (const entry of entries) {
    if (entry.agentId != null) {
      const hit = rows.find((r) => String(r.id) === String(entry.agentId));
      if (hit) { byKey.set(hit.key, entry); continue; }
    }
    const want = String(entry.name ?? "").trim().toLowerCase();
    if (!want) { unmatched.push(entry); continue; }

    const exact = rows.filter((r) => r.name.toLowerCase() === want);
    if (exact.length === 1) { byKey.set(exact[0].key, entry); continue; }

    // "Dennis" in the sheet against "Dennis Manalo" on the roster, and the
    // reverse — a full name in the sheet against a first-name-only roster row.
    const first = want.split(/\s+/)[0];
    const loose = rows.filter((r) => {
      const rn = r.name.toLowerCase();
      return rn === first || rn.split(/\s+/)[0] === first;
    });
    if (loose.length === 1) byKey.set(loose[0].key, entry);
    else if (loose.length > 1) ambiguous.push({ entry, candidates: loose.map((r) => r.name) });
    else unmatched.push(entry);
  }

  return { byKey, unmatched, ambiguous, currency: billings?.currency ?? "AED", asOf: billings?.asOf ?? null };
}

/** Locally-keyed billings, for typing numbers in before the sheet arrives.
 *  Per-browser, like the Equipment bookings — see the caveat in equipment.js. */
const LOCAL_KEY = "aaronz.billings.local.v1";

export const loadLocalBillings = () => {
  try { return JSON.parse(localStorage.getItem(LOCAL_KEY) ?? "{}"); }
  catch { return {}; }
};

export const saveLocalBillings = (map) => {
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(map)); return true; }
  catch { return false; }
};

/* ------------------------------ roster ------------------------------ */

const agentIdentity = (a) =>
  a?.id != null ? `id:${a.id}` : `name:${String(a?.name ?? "Unassigned").toLowerCase()}`;

/**
 * One row per broker, joining leads to their current listing book.
 *
 * The roster is the UNION of both sources, not the intersection: a broker with
 * listings but no leads this month is still on the team and still has a book,
 * and a new joiner taking leads before their first listing goes live has no
 * listing record to be found in.
 */
/**
 * Viewings for a set of leads, optionally narrowed to a date range.
 *
 * Split out because the profile needs this twice over two different sets: once
 * windowed, and once over the broker's entire history with no date filter at
 * all. The unfiltered pass is the exact one — the approximation in
 * `viewingDate` only bites when you filter by date.
 *
 * ONE PER LEAD. `viewingEvidence` resolves to a single tier, so a lead with
 * both a "Viewing arranged" sub-status and a note saying the same thing counts
 * once, at the higher tier, not twice.
 */
export function summariseViewings(leads, inRange = null) {
  const viewings = leads
    .map((l) => ({ lead: l, ...viewingEvidence(l) }))
    .filter((v) => v.tier)
    .filter((v) => !inRange || inRange(v.at))
    .sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0));

  const tierCounts = Object.fromEntries(VIEWING_TIERS.map((t) => [t, 0]));
  for (const v of viewings) tierCounts[v.tier]++;

  // A viewing either happened or is on the calendar. Discussed and unclear are
  // excluded — they are not viewings.
  const real = tierCounts.confirmed + tierCounts.done + tierCounts.booked;

  return {
    viewings, tierCounts, real,
    approximated: viewings.filter(
      (v) => v.dateFrom === "last-updated" && REAL_TIERS.has(v.tier)
    ).length,
  };
}

const REAL_TIERS = new Set(["confirmed", "done", "booked"]);

/**
 * @param leads         leads that ARRIVED in the selected range — everything
 *                      except viewings is measured on these
 * @param listings      the live book
 * @param viewingLeads  a wider pull, used only for viewings, because a viewing
 *                      booked this week is usually on a lead from weeks ago.
 *                      Defaults to `leads`, which is the old behaviour.
 * @param viewingInRange  predicate on the viewing's own date. Leads whose
 *                      viewing falls outside the range are dropped, so widening
 *                      the pull adds viewings without adding lead volume.
 * @param directory     everyone on the CRM, so a broker with nothing assigned
 *                      still gets a row. Pass [] to get the old leads-and-
 *                      listings-only behaviour.
 */
export function buildRoster({
  leads = [], listings = [], viewingLeads = null, viewingInRange = null,
  directory = CRM_USERS,
}) {
  const rows = new Map();

  const touch = (agent, patch = {}) => {
    const key = agentIdentity(agent);
    if (!rows.has(key)) {
      rows.set(key, {
        key, id: agent?.id ?? null, name: agent?.name ?? "Unassigned",
        jobTitle: null, photo: null, email: null, mobile: null,
        leads: [], listings: [], viewingLeads: [],
      });
    }
    const row = rows.get(key);
    // Only ever upgrade to a longer name — listings carry "Dennis Manalo",
    // leads carry "Dennis", and the id join makes them the same person.
    if (agent?.name && agent.name.length > row.name.length) row.name = agent.name;
    row.jobTitle ??= patch.jobTitle ?? agent?.job_title ?? null;
    row.photo ??= patch.photo ?? agent?.photo_url ?? null;
    row.email ??= agent?.email || null;
    row.mobile ??= agent?.mobile || agent?.whatsapp || null;
    return row;
  };

  for (const lead of leads) touch(lead.agents?.[0]).leads.push(lead);

  for (const l of listings) {
    // marketing_agent is null on 88% of records, so `agent` is the one to
    // attribute the book on — same reasoning as listings.js.
    const a = l.agent ?? l.marketing_agent;
    if (!a) continue;
    touch(a).listings.push(l);
  }

  // Attached to rows that already exist rather than creating new ones. The
  // wider pull reaches back months, and letting it mint roster rows would put
  // brokers who have since left back on the table with zero of everything else.
  for (const lead of viewingLeads ?? []) {
    const row = rows.get(agentIdentity(lead.agents?.[0]));
    if (row) row.viewingLeads.push(lead);
  }

  /**
   * Everyone on the CRM, merged in last.
   *
   * Matched to a row that already exists before a new one is made, or the same
   * person appears twice — once from their leads and once from the directory.
   * A directory entry that matches nothing becomes a row with zeroes, which is
   * the whole point: "no leads this window" and "not on the system" are
   * different facts, and only one of them is somebody's fault.
   *
   * The name and job title from the directory win. They are the full, correctly
   * spelled versions typed by a person, against a first name from a lead.
   */
  const byEmail = new Map();
  const byId = new Map();
  for (const row of rows.values()) {
    if (row.email) byEmail.set(emailKey(row.email), row);
    if (row.id != null) byId.set(String(row.id), row);
  }

  for (const user of directory) {
    const hit =
      (user.agentId != null && byId.get(String(user.agentId))) ||
      byEmail.get(emailKey(user.email)) ||
      null;

    if (hit) {
      if (user.name) hit.name = user.name;
      if (user.jobTitle) hit.jobTitle = user.jobTitle;
      hit.onCrm = true;
      continue;
    }

    const key = user.agentId != null ? String(user.agentId) : emailKey(user.email);
    rows.set(key, {
      key, id: user.agentId ?? null, name: user.name, jobTitle: user.jobTitle ?? null,
      photo: null, email: user.email ?? null, mobile: null,
      leads: [], listings: [], viewingLeads: [], onCrm: true,
    });
  }

  return [...rows.values()].map((row) => summariseBroker(row, {
    viewingLeads: viewingLeads ? row.viewingLeads : row.leads,
    viewingInRange,
  }));
}

function summariseBroker(row, { viewingLeads, viewingInRange } = {}) {
  const leads = row.leads;
  // Cold is the only bucket that counts against the broker. Status-only means
  // they moved the lead on without writing a note — worked, just not recorded.
  const cold = leads.filter(isCold);
  const statusOnly = leads.filter(isStatusOnly);
  const noted = leads.filter((l) => !isUntouched(l));

  // Statuses present for this broker only, biggest first — the same taxonomy
  // and the same ordering as the Insights tab, so the two read alike.
  const statusCounts = new Map();
  for (const l of leads) {
    const s = statusOf(l);
    statusCounts.set(s, (statusCounts.get(s) ?? 0) + 1);
  }

  // Measured on their own pool and their own dates, unlike everything above.
  const { viewings, tierCounts, real, approximated } =
    summariseViewings(viewingLeads ?? leads, viewingInRange);

  const live = row.listings;
  const rent = live.filter((l) => l.type === "rent").length;

  return {
    ...row,
    // Explicitly false, not undefined: somebody carrying leads who is NOT on the
    // active user list has left, and that is worth being able to see rather than
    // wonder about.
    onCrm: row.onCrm === true,
    house: isHouseAccount(row.name),

    total: leads.length,
    cold: cold.length,
    statusOnly: statusOnly.length,
    noted: noted.length,
    worked: statusOnly.length + noted.length,
    rate: leads.length ? (statusOnly.length + noted.length) / leads.length : 0,
    // First touch needs a note to timestamp it, so this covers `noted` only.
    median: median(noted.map(hoursToFirstTouch)),

    statuses: [...statusCounts.entries()]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)),

    viewings,
    tierCounts,
    viewingsReal: real,
    // How many of those rest on last_updated rather than a real timestamp.
    // Surfaced on the card, not buried: a windowed figure built partly on the
    // last edit to a record must say so where it is read, or it will quietly
    // disagree with the exact all-time count beside it.
    viewingsApprox: approximated,
    // Counted over the same set the viewings came from, or the caption on the
    // profile contradicts the list beneath it.
    viewingsClaimed: viewings.filter((v) => claimsViewing(v.lead)).length,

    listingCount: live.length,
    listingRent: rent,
    listingSale: live.length - rent,
    listingValue: live.reduce((s, l) => s + (l.price ?? 0), 0),
  };
}

/** Roster columns, each with the value to rank on. Mirrors AGENT_COLS in
 *  App.jsx: names read A-Z, everything else highest-first. */
export const BROKER_COLS = [
  { key: "name",     label: "Broker",       align: "left",  value: (r) => r.name.toLowerCase(), firstDir: "asc" },
  // Both read the invoice list where there is one, falling back to a
  // hand-keyed figure. "Billed" is everything on file; "In range" follows the
  // date picker, like leads and viewings do.
  { key: "billed",   label: "Billed",       align: "right",
    value: (r) => r.billing?.toDate?.amount ?? r.billing?.billed ?? null },
  { key: "actual",   label: "In range",     align: "right",
    value: (r) => r.billing?.period?.amount ?? r.billing?.actual ?? null },
  { key: "viewings", label: "Viewings",     align: "right", value: (r) => r.viewingsReal },
  { key: "listings", label: "Live listings", align: "right", value: (r) => r.listingCount },
  { key: "total",    label: "Leads",        align: "right", value: (r) => r.total },
  { key: "median",   label: "Median first note", align: "right", value: (r) => r.median },
  { key: "rate",     label: "Worked",       align: "left",  value: (r) => r.rate },
];

/**
 * Sorts the roster. Nulls last in both directions — a broker with no billings
 * figure and one with a zero are different things, and a null median means
 * nobody was ever touched rather than "instant".
 *
 * Worked rate carries no volume threshold: it is a compliance measure, so 100%
 * off three leads is full compliance on three leads. The tie-break puts more
 * leads first so the bigger book wins an exact draw.
 */
export function sortRoster(rows, sort) {
  const col = BROKER_COLS.find((c) => c.key === sort.key) ?? BROKER_COLS[0];
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = col.value(a);
    const vb = col.value(b);
    if (va == null && vb == null) return b.total - a.total;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (va < vb) return -1 * sign;
    if (va > vb) return 1 * sign;
    return b.total - a.total;
  });
}

/* ------------------------------ format ------------------------------ */

/**
 * The figure to the fils, for the places money is reconciled rather than
 * scanned. fmtMoney's "AED 228k" is right for a table of forty brokers and
 * useless against an invoice sheet reading 228,459.52.
 */
export const fmtMoneyExact = (n, currency = "AED") =>
  n == null ? "—" : `${currency} ${n.toLocaleString("en-GB", {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;

export const fmtMoney = (n, currency = "AED") =>
  n == null ? "—"
    : n >= 1_000_000 ? `${currency} ${(n / 1_000_000).toFixed(2)}m`
    : n >= 1_000 ? `${currency} ${Math.round(n / 1000)}k`
    : `${currency} ${n}`;

export const fmtDateTime = (d) =>
  !d ? "—" : new Intl.DateTimeFormat("en-GB", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(d);
