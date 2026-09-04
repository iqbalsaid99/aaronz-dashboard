/**
 * PropSpace client. All calls go through the Vite dev middleware at /ps,
 * so there is no token handling in the browser at all.
 *
 * Response envelopes are the one thing worth verifying against your account:
 * the spec defines LeadListResponse but not the exact key names, so unwrap()
 * below is deliberately forgiving. Log a raw response once and tighten it.
 */

import { dubaiRange, dubaiDaysAgo, dubaiToday, lastCompleteDays } from "./time.js";
import { apiFetch } from "./apiFetch.js";

const BASE = "/ps";

async function get(path, params = {}, opts) {
  return (await getWithMeta(path, params, opts)).json;
}

/**
 * As get(), plus how many records the page held *before* the edge scoped it.
 *
 * The proxy filters responses to the agents the signed-in user may see, so a
 * page of 100 can arrive holding 12. Paging stops on a short page, so counting
 * the rows we can see would end the pull early and silently truncate somebody's
 * own history. `X-Scope-Total` is the untouched count; it is absent when the
 * caller is unscoped or the payload had nothing to filter, and null then means
 * "just use the rows".
 */
async function getWithMeta(path, params = {}, { fresh = false } = {}) {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null)
  );
  const url = `${BASE}${path}${qs.toString() ? `?${qs}` : ""}`;
  // `fresh` asks the edge to skip its cache — see cacheTtl in
  // functions/ps/[[path]].js. Only the Refresh buttons set it; a normal read
  // is happy with an entry a couple of minutes old.
  const res = await apiFetch(url, fresh ? { headers: { 'Cache-Control': 'no-cache' } } : undefined);
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);

  // headers.get() returns null when the header is absent, and Number(null) is
  // 0 — which is finite, so the old check accepted it and reported "this page
  // held 0 records upstream". Paging stops on a page that small, so EVERY pull
  // by an unscoped caller ended after the first batch: the newest 400 leads and
  // nothing older, on every screen. The absent case has to be caught before the
  // cast, not after it.
  const raw = res.headers.get("X-Scope-Total");
  const header = raw === null ? NaN : Number(raw);
  return {
    json: await res.json(),
    upstreamCount: Number.isFinite(header) ? header : null,
  };
}

// Handles { data: [...] } / { leads: [...] } / bare arrays.
const unwrap = (json) =>
  Array.isArray(json) ? json : json.data ?? json.leads ?? json.items ?? [];

/**
 * The API has NO working server-side date filter. Verified against the live
 * account 2026-07-30: date_created_from/to are rejected outright (400
 * "property should not exist"), and date_of_enquiry is accepted but silently
 * ignored — it returns the full 41k regardless of value, including garbage.
 * Never reintroduce it thinking it filters.
 *
 * What we do have: results are strictly newest-first by created_at, and
 * per_page caps at 100. So we page from the top and stop as soon as we cross
 * the cutoff. ~7 pages for 30 days at current volume.
 *
 * `to` is inclusive of the whole day, in Dubai terms — a range ending
 * 2026-07-15 covers that entire local day. Because there is no server-side
 * filter, an end date in the past saves no requests: we still page from the
 * newest lead down to `from` and discard the recent ones.
 */
export async function fetchLeads({ from, to, perPage = 100, maxPages = 60, batch = 4, onProgress }) {
  // Dubai calendar days, not UTC ones — an enquiry at 01:00 local carries the
  // previous day's UTC date. See time.js.
  const { start, end } = dubaiRange(from, to);

  // Deduped by id: pages are numbered, not cursored, so a lead arriving
  // mid-pull shifts every subsequent row down one slot and can hand back the
  // same record twice. Cheap insurance, and it also covers the small overshoot
  // the batching below can produce.
  const seen = new Map();
  let done = false;

  for (let page = 1; page <= maxPages && !done; page += batch) {
    const pages = [];
    for (let i = 0; i < batch && page + i <= maxPages; i++) pages.push(page + i);

    // Each request takes ~1.5s and there is no date filter to narrow it, so
    // the only way to make this quick is to overlap them. Worst case we fetch
    // `batch - 1` pages past the cutoff and discard them.
    const results = await Promise.all(
      pages.map((p) =>
        getWithMeta("/leads", { page: p, per_page: perPage })
          .then(({ json, upstreamCount }) => ({ rows: unwrap(json), upstreamCount }))
      )
    );

    for (const { rows, upstreamCount } of results) {
      for (const l of rows) seen.set(l.id, l);

      // How full the page was upstream, before scoping removed other people's
      // leads. Counting the visible rows here would call a heavily-filtered
      // page the end of the data.
      //
      // The larger of the two, never the header alone. Scoping can only ever
      // REMOVE rows, so a page holding more rows than the header claims means
      // the header is wrong — and trusting it would end the pull early and
      // silently truncate every figure on the dashboard. Rows on the page are
      // proof; the header is a hint.
      const pageSize = Math.max(upstreamCount ?? 0, rows.length);
      if (!pageSize || pageSize < perPage) { done = true; continue; }

      // Ordering is by created_at descending, so the oldest visible row still
      // dates the page even when most of it was filtered away. A page filtered
      // to nothing carries no date, so it cannot end the pull on its own.
      if (!rows.length) continue;
      const oldest = new Date(rows[rows.length - 1].created_at).getTime();
      if (oldest < start) done = true;
    }
    onProgress?.(seen.size);
  }

  return [...seen.values()]
    .filter((l) => {
      const t = new Date(l.created_at).getTime();
      return t >= start && t <= end;
    })
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

/* ------------------------ leads per account ------------------------ */

/**
 * How many leads sit under each CRM account, all time.
 *
 * ONE REQUEST PER ACCOUNT, NOT ONE PER PAGE. The envelope carries
 * `meta.total` — the size of the result set upstream — and `assigned_to` is
 * the one filter this API honours server-side. So `per_page=1&assigned_to=X`
 * answers "how many leads has X ever had" in a single round trip. Verified
 * against the live account on 2026-08-25: 45 accounts answered in about five
 * seconds, where tallying the same figures by paging the whole book is 429
 * requests and took seven and a half minutes.
 *
 * THE PARTS DO NOT SUM TO THE WHOLE, AND THAT IS REPORTED RATHER THAN HIDDEN.
 * The account totals came to 30,839 against a book of 42,869. The remainder is
 * leads carrying no agent at all, plus a few held by ids that are no longer in
 * the CRM's user list — neither of which is "under an account", which is what
 * this counts. `unattributed` is that difference, and the screen and the export
 * both state it.
 *
 * A SCOPED CALLER GETS NO TOTALS. The edge strips meta.total from a scoped
 * response, precisely so one broker cannot read another's count this way, so
 * `total` comes back null for them. Those rows are dropped rather than shown as
 * zero: a broker seeing "Dennis 0" would be reading an access boundary as a
 * fact about Dennis.
 */
export async function fetchLeadCountsByAccount({ onProgress, batch = 6 } = {}) {
  const accounts = await fetchAgents();

  const rows = [];
  for (let i = 0; i < accounts.length; i += batch) {
    const slice = accounts.slice(i, i + batch);
    const counted = await Promise.all(slice.map(async (a) => {
      const { json } = await getWithMeta("/leads", { assigned_to: a.id, per_page: 1 });
      const total = json?.meta?.total;
      return {
        id: String(a.id),
        // The CRM stores at least one address with a leading space.
        name: String(a.name ?? "").trim() || "Unnamed account",
        email: String(a.email ?? "").trim(),
        leads: Number.isFinite(total) ? total : null,
      };
    }));
    rows.push(...counted);
    onProgress?.(rows.length, accounts.length);
  }

  const { json: all } = await getWithMeta("/leads", { per_page: 1 });
  const crmTotal = Number.isFinite(all?.meta?.total) ? all.meta.total : null;

  // Accounts with nothing under them are not rows. An empty profile is not a
  // finding, and thirty of them would push the people who do hold leads off
  // the first page.
  const held = rows.filter((r) => r.leads > 0).sort((a, b) => b.leads - a.leads
    || a.name.localeCompare(b.name));

  const attributed = held.reduce((n, r) => n + r.leads, 0);

  return {
    rows: held.map((r, i) => ({ ...r, rank: i + 1 })),
    accounts: accounts.length,
    empty: rows.filter((r) => r.leads === 0).length,
    scoped: rows.some((r) => r.leads === null),
    attributed,
    crmTotal,
    unattributed: crmTotal == null ? null : crmTotal - attributed,
  };
}

/**
 * Every lead ever assigned to one agent, with no date filter.
 *
 * The Brokers roster is windowed, and a windowed viewing count rests on
 * last_updated for any viewing recorded only as a sub-status — which is the
 * last edit to the record, not the appointment. That approximation cannot be
 * removed, so the profile shows an exact figure beside it, and this is what
 * makes the exact one affordable: `assigned_to` is the ONE filter this API
 * honours server-side, so a broker's whole history is their own rows rather
 * than 42,055 leads paged down to a handful.
 *
 * Cost is per broker, not per account: measured live, most brokers are 1-25
 * requests and the largest is 62. That is far too slow for 26 roster rows, and
 * perfectly reasonable for one profile opened on purpose.
 *
 * ATTRIBUTION IS RE-CHECKED HERE. A caller scoped to their own leads has
 * `assigned_to` overwritten by the edge with their own id (see
 * functions/_lib/scope.js), so asking for another agent returns the CALLER's
 * leads, not an error. Nothing leaks — that is the scoping working — but
 * counting them would print one broker's viewings under another's name. So
 * rows are kept only when they actually carry the agent asked for; a scoped
 * caller correctly sees zero rather than somebody else's number.
 */
export async function fetchAgentLeads(
  agentId, { maxPages = 120, batch = 4, onProgress, onPartial, fresh = false } = {}
) {
  const id = String(agentId);
  const out = new Map();

  const keep = (rows) => {
    for (const l of rows) {
      if (l.agents?.some((a) => String(a?.id) === id)) out.set(l.id, l);
    }
  };

  /**
   * HOW MANY PAGES, IN ONE REQUEST.
   *
   * The envelope carries meta.total — the size of the result set upstream —
   * and this is the same trick fetchLeadCountsByAccount uses. Knowing the
   * count up front is the whole difference between fetching pages and probing
   * for them: probing is strictly sequential, because you cannot ask for page
   * n+1 until page n has told you whether it was full.
   *
   * That cost is not theoretical. Measured 27 Aug 2026, this account holds
   * 6,329 leads for agent 1498226 — 64 pages, which as a serial probe is
   * upwards of a minute and a half of somebody watching a spinner. With the
   * count in hand the same pull is 16 rounds of four.
   */
  let pages = null;
  try {
    const { json } = await getWithMeta("/leads", { assigned_to: id, page: 1, per_page: 1 }, { fresh });
    const total = json?.meta?.total;
    if (Number.isFinite(total)) pages = Math.max(1, Math.ceil(total / 100));
  } catch {
    // Fall through to probing. A failure here is not fatal — it just costs
    // the round trips the count would have saved.
  }

  if (pages !== null) {
    const last = Math.min(pages, maxPages);
    // Four at a time, the same width fetchLeads uses. Not more: eight
    // concurrent pages against this key returns the WAF's 403, and a pull
    // that trips the firewall is slower than one that never tried.
    for (let page = 1; page <= last; page += batch) {
      const nums = [];
      for (let i = 0; i < batch && page + i <= last; i++) nums.push(page + i);
      const results = await Promise.all(
        nums.map((n) =>
          getWithMeta("/leads", { assigned_to: id, page: n, per_page: 100 }, { fresh })
            .then(({ json }) => unwrap(json))
        )
      );
      results.forEach(keep);
      onProgress?.(out.size);
      // Hand back what has arrived so the screen can fill in rather than
      // holding a spinner until the last page lands.
      onPartial?.([...out.values()], { page: Math.min(page + batch - 1, last), pages: last });
    }
    return [...out.values()];
  }

  // NO COUNT, SO PROBE. The edge strips meta.total from a scoped response
  // precisely so one broker cannot read another's count from it, so a broker
  // signed in as themselves lands here and pages the old way.
  for (let page = 1; page <= maxPages; page++) {
    const { json, upstreamCount } = await getWithMeta("/leads", {
      assigned_to: id, page, per_page: 100,
    }, { fresh });
    const rows = unwrap(json);
    keep(rows);
    onProgress?.(out.size);
    onPartial?.([...out.values()], { page, pages: null });

    // Same reasoning as fetchLeads: a page scoped down to nothing upstream is
    // not the end of the data, so stop on the pre-scoping count where we have
    // one and only fall back to the visible rows when we do not.
    const pageSize = upstreamCount ?? rows.length;
    if (!pageSize || pageSize < 100) break;
  }

  return [...out.values()];
}

/**
 * Option endpoints use underscores, not hyphens — /options/sub_statuses, not
 * /options/lead-statuses. The hyphenated guesses returned the WAF's generic
 * 403, which it gives for any unlisted path, so they looked blocked rather
 * than simply wrong. Confirmed against PropSpace's OpenAPI spec.
 */
export const fetchSubStatuses  = () => get("/options/sub_statuses").then(unwrap);
export const fetchLeadStatuses = () => get("/options/statuses").then(unwrap);
export const fetchLeadSources  = () => get("/options/sources").then(unwrap);
export const fetchAgents       = () => get("/options/agents").then(unwrap);

/**
 * The default states — a lead sitting in one of these has not been moved on by
 * anybody. This set is what "worked" is measured against: leave a default and
 * you have worked the lead, whether or not you also wrote a note.
 *
 *   "Not yet contacted"  — the state a lead arrives in.
 *   The three "…to Agent" values describe the lead being routed TO the broker,
 *   not the broker doing anything with it. The CRM sets them itself when it
 *   distributes a lead, so they are the system talking, not a person. The API
 *   says only whether a sub-status is Open or Closed, so it cannot express that
 *   distinction itself.
 *   "Not Specified" is what statusOf falls back to when the CRM carries no
 *   sub-status at all. An absent status was never moved off anything, so
 *   counting it as work would credit a broker for a blank field.
 *
 * Everything else means somebody moved the lead. Deriving it this way — rather
 * than listing the sixteen that do — means a sub-status added in the CRM is
 * picked up automatically instead of being silently ignored. Three of the 25
 * defined sub-statuses had never appeared in 30 days of data, so a list built
 * from observation was already incomplete.
 */
export const NOT_CONTACTED = new Set([
  "Not yet contacted",
  "SMS sent to Agent",
  "Email sent to Agent",
  "Client Connected Online to Agent",
  "Not Specified",
]);

/** Fallback if /options/sub_statuses is unreachable — the 25 known values. */
const FALLBACK_SUB_STATUSES = [
  "In progress", "Not yet contacted", "Called no reply", "Follow up",
  "Viewing arranged", "Offer Made", "Needs more info", "Budget differs",
  "Needs time", "Client to revert", "Interested", "Interested to Meet",
  "Not Interested", "Look-see", "Client Connected Online to Agent",
  "SMS sent to Agent", "Email sent to Agent", "Client not reachable",
  "Incorrect Contact details", "Invalid inquiry", "Price too high",
  "Viewing Done", "Successful", "Unsuccessful", "Not Specified",
];

/**
 * The set of sub-statuses that imply contact happened, built from the live
 * taxonomy. Names are trimmed because at least one ships with a trailing
 * space ("Invalid inquiry ") which would otherwise never match.
 */
export async function fetchClaimsContact() {
  let names;
  try {
    const rows = await fetchSubStatuses();
    names = rows.map((r) => (typeof r === "string" ? r : r.name)).filter(Boolean);
    if (!names.length) throw new Error("empty taxonomy");
  } catch {
    names = FALLBACK_SUB_STATUSES;
  }
  return new Set(names.map((n) => n.trim()).filter((n) => !NOT_CONTACTED.has(n)));
}

/* ------------------------- source detail ------------------------- */

const autoNote = (lead) =>
  (lead.notes ?? []).find((n) => AUTO_AUTHORS.has(n.user_name))?.notes ?? "";

/**
 * How the enquiry arrived (whatsapp / call / email).
 *
 * `source_channel` is only populated on 58% of leads, and uses "0" and "" as
 * its two flavours of empty. The auto-import note text carries the same value
 * as "(Channel: whatsapp)", which recovers another 185 of the 258 gaps —
 * 88% coverage overall. The rest genuinely don't record it.
 */
export function channelOf(lead) {
  const raw = String(lead.source_channel ?? "").trim().toLowerCase();
  if (raw && raw !== "0") return raw;
  const m = autoNote(lead).match(/Channel:\s*([^,)]+)/i);
  return m ? m[1].trim().toLowerCase() : "unknown";
}

/**
 * The specific listing the enquiry came in against. Present on 96% of leads.
 * Note sub_location is free text and inconsistently cased in the CRM
 * ("icon 1" vs "Icon Tower 2"), so group on the lowercased value.
 */
export function listingOf(lead) {
  const r = (lead.requirements ?? [])[0] ?? {};
  return {
    ref: r.listing_reference || null,
    category: r.category || null,
    unitType: r.unit_type || null,
    emirate: r.emirate || null,
    location: r.location || null,
    subLocation: r.sub_location || null,
    beds: r.max_beds || r.min_beds || null,
    price: r.max_price || r.min_price || null,
    area: r.max_area || r.min_area || null,
  };
}

export const fmtPrice = (n) =>
  !n ? "—" : n >= 1_000_000 ? `AED ${(n / 1_000_000).toFixed(1)}m` : `AED ${Math.round(n / 1000)}k`;

/** Count occurrences of a key across leads, most common first. */
export function tally(leads, keyFn) {
  const m = new Map();
  for (const l of leads) {
    const k = keyFn(l) || "Unknown";
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
}

/* ------------------------- derived metrics ------------------------- */

/**
 * The client's name, out of a contact block that cannot be trusted to hold one.
 *
 * The CRM writes last_name as "<first name> undefined" — on all 500 leads in a
 * live sample, and 471 of them repeat the first name verbatim. Joining the two
 * fields the obvious way renders "Hisham Hisham undefined" on screen, which is
 * what the Command Centre showed until this existed.
 *
 * So: take the first name, strip that same name back off the front of the last
 * name, drop the literal words the CRM uses for empty, and keep whatever real
 * surname is left. A lead genuinely carrying "Matthew" / "White" still reads
 * "Matthew White".
 */
const EMPTYISH = new Set(["", "undefined", "null", "n/a", "-"]);

const cleanNamePart = (v) => {
  const t = String(v ?? "").trim();
  return EMPTYISH.has(t.toLowerCase()) ? "" : t;
};

export function contactNameOf(lead, fallback = "Unnamed contact") {
  const c = lead?.contact ?? {};
  const first = cleanNamePart(c.first_name);
  let last = cleanNamePart(c.last_name);

  // "Hisham undefined" -> "undefined" -> ""
  if (first && last.toLowerCase().startsWith(first.toLowerCase())) {
    last = last.slice(first.length).trim();
  }
  last = cleanNamePart(last.replace(/\bundefined\b/gi, "").trim());

  return [first, last].filter(Boolean).join(" ").trim() || fallback;
}

export const agentOf = (lead) =>
  lead.agents?.[0]?.name ?? lead.assigned_to?.name ?? "Unassigned";

/**
 * Live shape is { status, sub_status }, e.g. { status: "Open",
 * sub_status: "Not yet contacted" }. There is no `name` key — reading it
 * returned "Unknown" for all 620 leads in the 30-day window.
 *
 * `status` is only Open/Closed/Not Specified, which is too coarse to say
 * anything about contact. sub_status is the field with the real detail.
 */
export const subStatusOf = (lead) => {
  const raw = typeof lead.status === "string" ? lead.status : lead.status?.sub_status;
  // "Invalid inquiry " ships with a trailing space in the CRM; untrimmed it
  // fails every set lookup and quietly lands in the wrong bucket.
  return (raw ?? "Not Specified").trim() || "Not Specified";
};

export const statusOf = subStatusOf;

/**
 * Every lead is created with an auto-generated note from the portal import
 * ("This lead is auto imported from Bayut.com..."), authored by "Auto Import".
 * 619 of 620 leads in the last 30 days carry one.
 *
 * That note proves nothing happened — it IS the lead arriving. Counting it as
 * activity makes 99.8% of leads look worked when the real figure is 55.6%.
 */
const AUTO_AUTHORS = new Set(["Auto Import"]);

export const humanNotes = (lead) =>
  (lead.notes ?? []).filter((n) => !AUTO_AUTHORS.has(n.user_name));

/**
 * Note dates come back in four formats, none of which `new Date()` parses:
 *   "30-07-2026 16:20"          DD-MM-YYYY HH:mm
 *   "30/07/2026 03:52:02 PM"    DD/MM/YYYY hh:mm:ss AM/PM
 *   "2026-07-29 14:05"          YYYY-MM-DD HH:mm
 * The first two are day-first, so V8 returns Invalid Date (month 30). Left to
 * the built-in parser every latency silently became null.
 */
export function parseNoteDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();

  // YYYY-MM-DD HH:mm[:ss] — unambiguous, hand to the built-in parser.
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(s.replace(" ", "T"));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const m = s.match(
    /^(\d{2})[-/](\d{2})[-/](\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i
  );
  if (!m) return null;

  const [, dd, mm, yyyy, hh, min, ss, ampm] = m;
  let hour = Number(hh);
  if (ampm) {
    const pm = ampm.toUpperCase() === "PM";
    if (hour === 12) hour = pm ? 12 : 0;
    else if (pm) hour += 12;
  }
  const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd), hour, Number(min), Number(ss ?? 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * First genuine human touch. Deliberately NOT last_updated, because any
 * field edit or automation bumps that — and deliberately not the auto-import
 * note either, for the same reason.
 */
export function firstTouchAt(lead) {
  const times = humanNotes(lead)
    .map((n) => parseNoteDate(n.date ?? n.created_at))
    .filter(Boolean)
    .map((d) => d.getTime());
  return times.length ? new Date(Math.min(...times)) : null;
}

export function hoursToFirstTouch(lead) {
  const t = firstTouchAt(lead);
  if (!t) return null;
  return (t - new Date(lead.created_at)) / 3_600_000;
}

/** No human has logged a note against this lead. A low-level predicate — on its
 *  own it does NOT mean the lead was ignored. See isWorked below. */
export const isUntouched = (lead) => humanNotes(lead).length === 0;

/**
 * Every lead falls into exactly one of three buckets.
 *
 *   COLD         nothing has happened at all — no note, and the sub-status is
 *                still a system default. This is the only bucket that counts
 *                against a broker.
 *   STATUS ONLY  somebody moved the sub-status off a default but never wrote a
 *                note. The lead was worked; there is just no record of what was
 *                said.
 *   NOTED        a human logged a note. Worked, with evidence.
 *
 * Moving a status IS work. A broker who calls a client, gets "not interested"
 * and sets the status to Unsuccessful has done the job, whether or not they
 * typed anything afterwards. The dashboard used to require a note before it
 * would credit any of that, which put leads at In progress and Unsuccessful in
 * the same "cold" bucket as ones nobody had opened.
 *
 * "Default" means NOT_CONTACTED above: the arrival state plus the three
 * "…to Agent" values. Those three stay defaults deliberately — the CRM sets
 * them itself when it routes a lead to a broker, so they record the lead being
 * handed over, not the broker doing anything with it.
 */
export const isCold = (lead) =>
  isUntouched(lead) && NOT_CONTACTED.has(statusOf(lead));

export const isStatusOnly = (lead) =>
  isUntouched(lead) && !NOT_CONTACTED.has(statusOf(lead));

export const isNoted = (lead) => !isUntouched(lead);

/** Worked = anything but cold. The compliance measure. */
export const isWorked = (lead) => !isCold(lead);

export function median(values) {
  const s = values.filter((v) => v != null).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Per-agent rollup. Every lead lands in exactly one of the three buckets above,
 * so cold + statusOnly + noted === total.
 *
 * `rate` is the share that is not cold — the compliance measure. `noteRate` is
 * the share that also has a note, which is a data-quality measure rather than a
 * performance one: the gap between the two is work that happened but was never
 * written down.
 *
 * `median` is first-touch latency and can only be measured on leads that carry
 * a note, since a status change has no timestamp of its own on this API. It
 * therefore covers the `noted` leads only, not everything counted as worked.
 */
export function summarise(leads) {
  const byAgent = new Map();

  for (const lead of leads) {
    const name = agentOf(lead);
    if (!byAgent.has(name)) {
      byAgent.set(name, { name, total: 0, cold: 0, statusOnly: 0, noted: 0, touchTimes: [] });
    }
    const row = byAgent.get(name);
    row.total++;

    if (isCold(lead)) row.cold++;
    else if (isStatusOnly(lead)) row.statusOnly++;
    else {
      row.noted++;
      row.touchTimes.push(hoursToFirstTouch(lead));
    }
  }

  return [...byAgent.values()]
    .map((r) => ({
      ...r,
      worked: r.statusOnly + r.noted,
      median: median(r.touchTimes),
      rate: r.total ? (r.statusOnly + r.noted) / r.total : 0,
      noteRate: r.total ? r.noted / r.total : 0,
    }))
    .sort((a, b) => b.cold - a.cold || b.statusOnly - a.statusOnly);
}

export const fmtHours = (h) =>
  h == null ? "—" : h < 1 ? `${Math.round(h * 60)}m` : h < 48 ? `${h.toFixed(1)}h` : `${Math.round(h / 24)}d`;

/** Dubai calendar date N days ago. Kept under the old name so callers
 *  elsewhere keep working; the semantics are now Dubai, not UTC. */
export const isoDaysAgo = (days) => (days === 0 ? dubaiToday() : dubaiDaysAgo(days));

/* ------------------------------ prefetch ------------------------------ */

/**
 * Kicks off the default 30-day pull the moment this module is evaluated —
 * before React mounts, before the first component renders. The request is
 * already in flight (7 sequential pages, a second or two) while the browser is
 * still parsing the rest of the bundle, so the dashboard has data on screen
 * noticeably sooner than if it waited for an effect to fire.
 *
 * Resolved to a { rows, error } envelope rather than left to reject, because
 * nothing awaits it until App mounts and a floating rejection in between would
 * surface as an unhandled promise error in the console.
 */
export const DEFAULT_DAYS = 30;

export const prefetch = (() => {
  // Must use the SAME window the UI resolves to, or the first render sees a
  // mismatch on { from, to }, declines to reuse this, and fires an identical
  // second request — the exact waste the prefetch exists to avoid.
  const { from, to } = lastCompleteDays(DEFAULT_DAYS);
  const promise = fetchLeads({ from, to })
    .then((rows) => ({ rows, error: null }))
    .catch((error) => ({ rows: [], error: String(error.message ?? error) }));
  return { from, to, promise };
})();
