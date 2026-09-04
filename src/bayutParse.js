/**
 * Bayut response parsing — every pure function behind the Bayut tab.
 *
 * Split from bayut.js for the reason metaParse.js is split from meta.js: this
 * half has no transport in it, so it can be exercised against captured
 * responses under `node --test` with no browser, no session and no network.
 *
 * Shapes come from Bayut's sample documents plus live responses captured on
 * 2026-08-21, not from a schema, so every field is read with optional chaining
 * and nothing is required to be present. A lead whose inquirer_details is
 * missing normalises to a lead with no name, which is the truth; it does not
 * throw and take a section down with it.
 */

import { dubaiRange, DUBAI_OFFSET } from "./time.js";

/* ------------------------------- the pulls ------------------------------ */

/**
 * Every valid combination, grouped by what it produces.
 *
 * `kind` is what the rows ARE — which normaliser reads them and which section
 * shows them — and is not something the API reports. is_trulead is the whole
 * difference between a lead and a view: the same type/target pair returns
 * enquiries at 1 and impression counts at 0.
 */
export const PULLS = [
  // Leads — somebody made contact.
  { id: "lead:email:listing",    kind: "lead", type: "email",    target: "listing", is_trulead: 1 },
  { id: "lead:email:agent",      kind: "lead", type: "email",    target: "agent",   is_trulead: 1 },
  { id: "lead:email:agency",     kind: "lead", type: "email",    target: "agency",  is_trulead: 1 },
  { id: "lead:whatsapp:listing", kind: "lead", type: "whatsapp", target: "listing", is_trulead: 1 },
  { id: "lead:whatsapp:agent",   kind: "lead", type: "whatsapp", target: "agent",   is_trulead: 1 },

  // Views — somebody revealed a contact detail without using it. Note there is
  // no email view: revealing an email address is not something Bayut counts.
  { id: "view:whatsapp:listing", kind: "view", type: "whatsapp", target: "listing", is_trulead: 0 },
  { id: "view:whatsapp:agent",   kind: "view", type: "whatsapp", target: "agent",   is_trulead: 0 },
  { id: "view:sms:listing",      kind: "view", type: "sms",      target: "listing", is_trulead: 0 },
  { id: "view:sms:agent",        kind: "view", type: "sms",      target: "agent",   is_trulead: 0 },
  { id: "view:phone:listing",    kind: "view", type: "phone",    target: "listing", is_trulead: 0 },
  { id: "view:phone:agent",      kind: "view", type: "phone",    target: "agent",   is_trulead: 0 },
  { id: "view:phone:agency",     kind: "view", type: "phone",    target: "agency",  is_trulead: 0 },

  // These two take no target and no is_trulead — timestamp is the only filter.
  { id: "call_logs",   kind: "call",  type: "call_logs" },
  { id: "story_leads", kind: "story", type: "story_leads" },
];

/** Channels that produce a view count, and the field each one reports it in. */
export const VIEW_CHANNELS = ["whatsapp", "sms", "phone"];
const VIEW_FIELD = { whatsapp: "whatsapp_views", sms: "sms_views", phone: "phone_views" };

/** Lead channels, in the order the summary card splits them. */
export const LEAD_CHANNELS = ["email", "whatsapp"];

/** WhatsApp delivery, in order. Used to break a tie when timestamps match. */
export const DELIVERY_STATUSES = ["sent", "delivered", "read"];
const DELIVERY_RANK = Object.fromEntries(DELIVERY_STATUSES.map((s, i) => [s, i]));

/* ------------------------------- parsing -------------------------------- */

/**
 * Bayut's several ways of saying "nothing", collapsed to null.
 *
 * Measured on live responses: `call_recordingurl` is the STRING "None" when
 * there is no recording, `listing_reference` is "" on every call log that is
 * not against a listing, and `caller_location` is a real null. Left alone,
 * "None" renders as a link to a page called None and "" renders as a blank
 * cell that looks like a bug rather than an absence.
 */
const clean = (v) => {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  return !t || t === "None" || t === "null" || t === "N/A" ? null : t;
};

/**
 * "YYYY-MM-DD HH:MM:SS" as a Date.
 *
 * Read as Dubai local time, not UTC and not the browser's zone. Bayut is a UAE
 * portal and the `timestamp` parameter takes this same bare format, so the two
 * ends have to agree about what a bare stamp means — and every other date in
 * this dashboard is a Dubai date for the reasons in time.js. Safari will not
 * parse the space form at all, which is the other reason this is not `new
 * Date(s)`.
 *
 * A stamp that already carries a zone keeps it.
 */
export function parseAt(s) {
  if (!s) return null;
  const t = String(s).trim();
  if (!t) return null;
  const zoned = /(?:[Zz]|[+-]\d{2}:?\d{2})$/.test(t);
  const d = new Date(`${t.replace(" ", "T")}${zoned ? "" : DUBAI_OFFSET}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Call logs split the stamp across two fields rather than one. */
const parseCallAt = (row) =>
  parseAt(row?.date && row?.time ? `${row.date} ${row.time}` : row?.date ?? row?.call_time);

/**
 * Whichever of listing / agent / agency this row is about.
 *
 * Only one of the three is ever present, and which one it is is the `target`
 * the pull asked for — but it is read off the row rather than assumed, because
 * a row that came back with a different shape than requested should render as
 * what it is.
 */
function entityOf(row) {
  const l = row?.listing_details;
  if (l) {
    return {
      target: "listing",
      label: clean(l.listing_reference) ?? (l.listing_id != null ? `#${l.listing_id}` : null),
      reference: clean(l.listing_reference),
      listingId: l.listing_id ?? null,
      propertyType: clean(l.current_type),
      url: null,
    };
  }
  const a = row?.agent_details;
  if (a) return { target: "agent", label: clean(a.name), email: clean(a.email), url: clean(a.url) };

  const g = row?.agency_details;
  if (g) return { target: "agency", label: clean(g.name), url: clean(g.url) };

  return { target: null, label: null, url: null };
}

/**
 * The most recent delivery notification, or null.
 *
 * Ordered by created_at, falling back to the sent → delivered → read
 * progression when two share a stamp or none carry one. The array is not
 * promised to be in order, and taking the last element would be a guess.
 */
export function latestDelivery(notifications) {
  if (!Array.isArray(notifications)) return null;
  let best = null;
  for (const n of notifications) {
    if (!n?.status) continue;
    const at = parseAt(n.created_at);
    const rank = DELIVERY_RANK[String(n.status).toLowerCase()] ?? -1;
    if (
      !best ||
      (at && best.at && at > best.at) ||
      (at && !best.at) ||
      ((!at === !best.at || (at && best.at && +at === +best.at)) && rank > best.rank)
    ) {
      best = { status: String(n.status).toLowerCase(), at, rank };
    }
  }
  return best;
}

/* ----------------------------- normalisers ------------------------------ */

function normaliseLead(row, p) {
  const inq = row?.inquirer_details ?? {};
  const delivery = latestDelivery(row?.delivery_notifications);
  return {
    id: row?.lead_id ?? null,
    at: parseAt(row?.date_time),
    channel: p.type,
    target: entityOf(row).target ?? p.target,
    entity: entityOf(row),
    source: clean(row?.source),
    name: clean(inq.name),
    cell: clean(inq.cell),
    email: clean(inq.email),
    message: clean(inq.message),
    delivery,
    // WhatsApp only, and not on every WhatsApp lead.
    intent: row?.visitor_intent ?? null,
  };
}

function normaliseView(row, p) {
  return {
    id: row?.lead_id ?? null,
    at: parseAt(row?.date_time),
    channel: p.type,
    entity: entityOf(row),
    count: Number(row?.[VIEW_FIELD[p.type]] ?? 0) || 0,
  };
}

const normaliseCall = (row) => ({
  id: row?.call_log_id ?? null,
  at: parseCallAt(row),
  reference: clean(row?.listing_reference),
  caller: clean(row?.caller_number),
  receiver: clean(row?.receiver_number),
  status: clean(row?.call_status),
  totalDuration: clean(row?.call_total_duration),
  connectedDuration: clean(row?.call_connected_duration),
  pickupTime: clean(row?.call_pickup_time),
  recording: clean(row?.call_recordingurl),
  location: clean(row?.caller_location),
  type: clean(row?.call_type),
});

function normaliseStory(row) {
  const inq = row?.inquirer_details ?? {};
  const story = row?.story_details ?? {};
  const listing = story.listing_details ?? {};
  const project = story.project_details ?? {};
  return {
    id: row?.lead_id ?? null,
    at: parseAt(row?.date_time),
    storyId: story.story_id ?? null,
    reference: clean(listing.listing_reference),
    propertyType: clean(listing.current_type),
    url: clean(listing.listing_url),
    project: clean(project.project_name_en),
    developer: clean(project.developer_name_en),
    image: clean(project.project_image_path),
    name: clean(inq.name),
    cell: clean(inq.cell),
    email: clean(inq.email),
    message: clean(inq.message),
  };
}


/**
 * Drop rows outside the window.
 *
 * Only ever applied when an end date is set. `timestamp` already bounds the
 * start upstream, but the start is checked again here so a pull that ignored
 * it cannot quietly widen the range the summary cards are counting.
 *
 * A row with no parseable date is KEPT. It cannot be judged against the window,
 * and dropping it would mean a missing field silently removing a real lead —
 * which is the failure this whole module is written to avoid.
 *
 * NOT APPLIED TO VIEWS. See the note on `RANGE_BOUND` below.
 */
export function withinRange(rows, from, to) {
  if (!to) return rows;
  const { start, end } = dubaiRange(from, to);
  return rows.filter((r) => {
    if (!r.at) return true;
    const t = r.at.getTime();
    return t >= start && t <= end;
  });
}

/** The `timestamp` parameter for a start date: midnight on that day. */
export const timestampFor = (from) => `${from} 00:00:00`;

/**
 * How far back `timestamp` is allowed to reach.
 *
 * Roughly six months, and it MOVES — the API answers an older stamp with a 422
 * naming the exact floor to the second ("must be a date after or equal to
 * 2026-02-21 13:06:04"). Nothing here tries to compute that boundary; the 422
 * carries a better sentence than anything this module could invent, and it
 * reaches the section error intact.
 */
export const APPROX_FLOOR_DAYS = 180;

/**
 * Which kinds are actually events in the window.
 *
 * MEASURED, not assumed. Leads, calls and story leads are one row per thing
 * that happened, and `timestamp` bounds them. Views are not: a view row is a
 * running total for one listing or one agent — 943 WhatsApp views on a single
 * row — and its `date_time` is the most recent of them, not the moment of a
 * view. `timestamp` does not filter them at all: asked for views since
 * yesterday, the API returned 51 rows dated from a year earlier.
 *
 * So the end-date filter is deliberately NOT applied to views. Applying it
 * would drop nearly every row and report a confident near-zero for a channel
 * that is doing thousands of reveals — the single worst thing this screen
 * could do, because a wrong number that looks calm gets believed. The tab says
 * on its face that view totals are lifetime figures instead.
 */
export const RANGE_BOUND = new Set(["lead", "call", "story"]);

/* ------------------------------- dispatch ------------------------------- */

export const NORMALISE = {
  lead: normaliseLead,
  view: normaliseView,
  call: (row) => normaliseCall(row),
  story: (row) => normaliseStory(row),
};

/* ------------------------------- formatting ----------------------------- */

export const fmtNum = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString() : "—");

export const fmtDateTime = (d) =>
  d ? d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";

/**
 * Call durations arrive as a string and the unit is not documented. Anything
 * that parses as a plain number is read as seconds; anything already formatted
 * ("00:01:24") is passed through untouched rather than guessed at.
 */
export function fmtDuration(v) {
  if (v === null || v === undefined || v === "") return "—";
  const s = Number(v);
  if (!Number.isFinite(s)) return String(v);
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(Math.round(s % 60)).padStart(2, "0")}s`;
}

/** Digits only, so a number with spaces or brackets still dials. */
export const telHref = (cell) => {
  const digits = String(cell ?? "").replace(/[^\d+]/g, "");
  return digits ? `tel:${digits}` : null;
};
