/**
 * Command Centre — the daily briefing, computed from one broker's own book.
 *
 * BETA, and scoped to one person on purpose: Dennis Manalo (agent 1498226).
 * Everything here runs against the live CRM through the same proxy the rest of
 * the dashboard uses. Nothing on this screen is sample data.
 *
 * WHAT THE CRM DOES NOT GIVE US. The obvious way to build this would be to read
 * the fields the CRM already has for it. They are dead. Measured across a
 * broker's whole book on 27 Aug 2026:
 *
 *   hot_lead      "No" on all 800
 *   priority      "normal" on all 800
 *   finance       "" on all 800
 *   in_lead_pool  "No" on all 800
 *
 * Nobody fills them in, so a "hot lead" tile reading `hot_lead` would show zero
 * for ever. The score below is therefore ours, derived from the fields brokers
 * DO move — the sub-status — and from the clock. That is a real difference and
 * the UI says so: every card carries the reason it scored what it scored, so a
 * broker can disagree with the arithmetic rather than being told a number.
 *
 * It is scoring, not prediction. There is no model here and the screen should
 * never imply one.
 */

import {
  statusOf, humanNotes, parseNoteDate, listingOf, isCold, contactNameOf,
} from "./propspace.js";

/** The beta subject. One broker, so the screen can be judged against a book
 *  somebody actually recognises. */
export const SUBJECT = {
  id: 1505600, name: "Ravneet Chipra", first: "Ravneet", role: "Property Advisor",
};

/**
 * Statuses that end a lead. These are not "cold" or "low" — they are finished,
 * and a briefing that keeps offering them wastes the first minute of the day.
 */
export const CLOSED_STATUSES = new Set([
  "Successful", "Unsuccessful", "Not Interested",
  "Invalid inquiry", "Incorrect Contact details",
]);

/**
 * Base score per sub-status: how much buying intent the broker's own last
 * move implies. The ordering is the argument — an offer beats a viewing beats
 * a conversation beats a price objection.
 *
 * "Not yet contacted" sits deliberately high at 55. It carries no intent at
 * all, but it is the one state where the broker, not the client, is the thing
 * holding the deal up. they sit in it in bulk.
 */
export const INTENT = {
  "Offer Made": 92,
  "Viewing arranged": 85,
  "Interested to Meet": 80,
  "Viewing Done": 78,
  "Interested": 72,
  "Follow up": 62,
  "Client to revert": 58,
  "Needs more info": 55,
  "Not yet contacted": 55,
  "In progress": 50,
  "Needs time": 40,
  "Called no reply": 38,
  "Look-see": 35,
  "Budget differs": 30,
  "Price too high": 25,
  "Client not reachable": 20,
};

const DAY = 86_400_000;

export const isActionable = (lead) => {
  const s = statusOf(lead);
  if (CLOSED_STATUSES.has(s)) return false;
  const outer = typeof lead.status === "string" ? null : lead.status?.status;
  return outer !== "Closed";
};

/** The client, as the broker knows them. `contact` is populated on effectively
 *  every lead — 788 of 800 carry a mobile — which is what makes a real Call
 *  button possible rather than a decorative one. */
/** The CRM stores empties three ways in the contact block: "", the literal
 *  string "undefined", and the literal string "null". Joined naively they
 *  produce a client called "undefined", which is what the first cut of this
 *  screen displayed. */
const realText = (v) => {
  const t = String(v ?? "").trim();
  return t && t !== "undefined" && t !== "null" ? t : "";
};

export function clientOf(lead) {
  const c = lead.contact ?? {};
  return {
    // contactNameOf, not a join of the two fields. An earlier fix here stripped
    // a last_name that was ENTIRELY the word "undefined", which is not the
    // shape this CRM actually writes: it stores "<first name> undefined", so
    // the join survived that check and rendered "Hisham Hisham undefined".
    name: contactNameOf(lead),
    mobile: realText(c.mobile) || realText(c.phone) || null,
    email: realText(c.email) || null,
  };
}

/** Digits only, for tel: and wa.me. Leaves the number alone otherwise — these
 *  arrive in a dozen formats and guessing a country code would dial a stranger. */
export const dialable = (raw) => (raw ? String(raw).replace(/[^\d+]/g, "") : null);
export const waNumber = (raw) => (raw ? String(raw).replace(/\D/g, "") : null);

/**
 * The last time anything actually happened, as opposed to `last_updated`,
 * which any field edit or automation bumps. Falls back to the enquiry date,
 * because a lead nobody has touched has been quiet since it arrived.
 */
export function lastActivityAt(lead) {
  const times = humanNotes(lead)
    .map((n) => parseNoteDate(n.date ?? n.created_at))
    .filter(Boolean)
    .map((d) => d.getTime());
  if (times.length) return new Date(Math.max(...times));
  const created = new Date(lead.created_at);
  return Number.isNaN(created.getTime()) ? null : created;
}

export const daysSince = (date, now = new Date()) =>
  date ? Math.floor((now - date) / DAY) : null;

/** What the client enquired against, in dirhams. This is the asking price of
 *  the property they wrote in about — NOT a weighted forecast, and the tile
 *  that sums it has to say so. */
export const enquiryValueOf = (lead) => listingOf(lead).price ?? 0;

/**
 * The score, and the sentence explaining it.
 *
 * Reasons are collected as the score is built rather than reconstructed
 * afterwards, so the explanation cannot drift from the arithmetic.
 */
export function scoreLead(lead, now = new Date()) {
  const status = statusOf(lead);
  const base = INTENT[status] ?? 45;
  const reasons = [];
  let score = base;

  if (status === "Not yet contacted") reasons.push("never contacted");
  else reasons.push(`sits at “${status}”`);

  const created = new Date(lead.created_at);
  const ageDays = daysSince(created, now);
  const quietDays = daysSince(lastActivityAt(lead), now);

  // Fresh enquiries are worth more than old ones at the same status: the
  // client is still in the market and still remembers writing in.
  if (ageDays != null) {
    if (ageDays <= 1) { score += 15; reasons.push("enquired today"); }
    else if (ageDays <= 3) { score += 8; reasons.push(`enquired ${ageDays} days ago`); }
    else if (ageDays <= 7) { score += 3; reasons.push("enquired this week"); }
  }

  // And a lead that has sat still for two months is not hot whatever its
  // status claims — the status is just the last thing anyone did to it.
  if (quietDays != null) {
    if (quietDays >= 60) { score -= 25; reasons.push(`no activity in ${quietDays} days`); }
    else if (quietDays >= 30) { score -= 15; reasons.push(`quiet for ${quietDays} days`); }
    else if (quietDays >= 14) { score -= 7; reasons.push(`quiet for ${quietDays} days`); }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, band: score >= 70 ? "high" : score >= 40 ? "medium" : "low", reasons, quietDays, ageDays };
}

/** Statuses where the client has committed something. Going quiet on one of
 *  these is how a live deal dies, which is what "at risk" means here. */
const COMMITTED = new Set([
  "Offer Made", "Viewing arranged", "Viewing Done", "Interested to Meet",
  "Interested", "Follow up", "Client to revert",
]);

/**
 * At risk = the client moved towards a deal and then nothing happened.
 *
 * Deliberately NOT "old lead". An untouched enquiry from March is a failure of
 * follow-up, not a deal at risk, and it belongs in the never-contacted count
 * where it can be fixed in bulk.
 */
export function riskOf(lead, now = new Date()) {
  if (!isActionable(lead)) return null;
  const status = statusOf(lead);
  if (!COMMITTED.has(status)) return null;

  const quiet = daysSince(lastActivityAt(lead), now);
  if (quiet == null || quiet < 7) return null;

  const heavy = status === "Offer Made" || status === "Viewing arranged";
  const level = quiet >= 14 || heavy ? "high" : "medium";
  return {
    level,
    quiet,
    reason: `${status} — no activity in ${quiet} days`,
  };
}

/* --------------------------- inventory matching --------------------------- */

const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * Dubai place names, as the two sides of this CRM actually spell them.
 *
 * Leads and listings are typed by different people into different forms and
 * neither is normalised, so the same place arrives both ways: the live book
 * files ten listings under "JBR" and three under "DIFC" while a lead may carry
 * either the initials or the full name. Containment alone cannot bridge that —
 * "jlt" is not a substring of "jumeirah lake towers" — so both sides are
 * expanded to the long form before they are compared.
 *
 * Only entries observed in this account's data, plus the handful of initialisms
 * every Dubai broker types. Guessing at more would silently match places that
 * are not the same place.
 */
const ALIASES = new Map(Object.entries({
  jlt: "jumeirah lake towers",
  jvc: "jumeirah village circle",
  jvt: "jumeirah village triangle",
  jbr: "jumeirah beach residence",
  difc: "dubai international financial centre",
  mbr: "mohammad bin rashid city",
  "mbr city": "mohammad bin rashid city",
  dso: "dubai silicon oasis",
  marina: "dubai marina",
  downtown: "downtown dubai",
  palm: "palm jumeirah",
}));

const canonPlace = (s) => {
  const n = norm(s);
  return ALIASES.get(n) ?? n;
};

/** Two free-text place names referring to the same place. Matches either
 *  containing the other rather than demanding equality, because the CRM is
 *  inconsistent about how much of the address it stores. */
const placeMatches = (a, b) => {
  const x = canonPlace(a), y = canonPlace(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
};

/** A Tenant enquiry wants a rental; a Buyer wants a sale. `lead_type` is one
 *  of the few CRM fields on this record that is actually maintained. */
export const wantedType = (lead) => (lead.lead_type === "Buyer" ? "sale" : "rent");

/**
 * Bedrooms, from two vocabularies that do not agree.
 *
 * Leads say "studio", "", or a number. The live book says "0" on 106 of its
 * 311 listings and "0.5" on another 36 — both of which mean studio, from two
 * different import routes. Number("studio") is NaN, which silently skipped the
 * whole bedroom filter and was how a studio ended up offered to someone asking
 * for a one-bed.
 */
export function normaliseBeds(raw) {
  const t = String(raw ?? "").trim().toLowerCase();
  if (!t) return null;
  if (t.startsWith("studio")) return 0;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return n > 0 && n < 1 ? 0 : Math.round(n);   // "0.5" is a studio, not half a bedroom
}

/**
 * Live listings that fit what this client said they wanted.
 *
 * Every clause is a stated requirement off the lead, not an inference: the
 * type they are after, the area they named, the size they asked for, the
 * budget they gave. The listing they already enquired on is excluded — showing
 * a client the property they just wrote in about is not a match.
 *
 * BEDROOMS ONLY GO UP. The first cut allowed plus-or-minus one, which offered
 * two-beds to families asking for three and studios to one-bed hunters. A
 * broker will happily show something one size bigger at the same money; nobody
 * shows somebody less than they asked for. So: the size they asked for, or one
 * more.
 *
 * Budget carries 10% of headroom because a broker will absolutely show
 * something slightly over. There is no floor: a listing at half the budget is
 * a different conversation, not a match.
 *
 * SAME BUILDING RANKS FIRST. Almost every lead in this book names Jumeirah
 * Lake Towers, so an area-level match alone returns "here is our JLT stock"
 * for everyone. Sorting the client's own tower to the top is what makes the
 * panel a recommendation rather than a listing dump, and the flag rides along
 * so the card can say which it is.
 */
export function matchesFor(lead, listings, { limit = 4 } = {}) {
  const want = listingOf(lead);
  if (!want.location && !want.subLocation) return [];
  const type = wantedType(lead);
  const maxPrice = want.price ?? null;
  const beds = normaliseBeds(want.beds);

  const out = [];
  for (const l of listings) {
    if (l.type !== type) continue;
    if (want.ref && l.ref === want.ref) continue;

    const area = l.area_location?.name;
    const sub = l.sub_area_location?.name;
    const sameBuilding = placeMatches(sub, want.subLocation);
    if (!(sameBuilding || placeMatches(area, want.location) ||
          placeMatches(area, want.subLocation) || placeMatches(sub, want.location))) continue;

    if (beds != null) {
      const lb = normaliseBeds(l.beds);
      if (lb == null || lb < beds || lb > beds + 1) continue;
    }
    if (maxPrice && l.price && l.price > maxPrice * 1.1) continue;

    out.push({ listing: l, sameBuilding });
  }

  // Their own building first, then the closest fit on price under budget.
  out.sort((a, b) =>
    (b.sameBuilding === true) - (a.sameBuilding === true) ||
    (b.listing.price ?? 0) - (a.listing.price ?? 0));

  return out.slice(0, limit);
}

/* ------------------------------ the briefing ------------------------------ */

export const greeting = (now = new Date()) => {
  // The broker is in Dubai; the browser may not be.
  const h = Number(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Dubai", hour: "numeric", hour12: false,
  }).format(now));
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
};

export const dubaiDateLabel = (now = new Date()) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Dubai", weekday: "long", day: "numeric", month: "long", year: "numeric",
  }).format(now);

/**
 * Everything the screen renders, computed once.
 *
 * Single pass over the book, because it is 800+ leads and each of the panels
 * below wants a different slice of the same three derived values.
 */
export function buildBriefing({ leads = [], listings = [], now = new Date() } = {}) {
  const live = leads.filter(isActionable);

  const rows = live.map((lead) => {
    const scored = scoreLead(lead, now);
    return {
      lead,
      client: clientOf(lead),
      want: listingOf(lead),
      value: enquiryValueOf(lead),
      risk: riskOf(lead, now),
      ...scored,
    };
  });

  const byScore = [...rows].sort((a, b) =>
    b.score - a.score || b.value - a.value || (a.quietDays ?? 0) - (b.quietDays ?? 0));

  const hot = byScore.filter((r) => r.band === "high");
  const atRisk = rows.filter((r) => r.risk)
    .sort((a, b) => (b.risk.level === "high") - (a.risk.level === "high") || b.risk.quiet - a.risk.quiet);
  const neverContacted = rows.filter((r) => isCold(r.lead));

  /**
   * SALE AND RENT ARE NOT ADDED TOGETHER.
   *
   * The obvious implementation sums max_price across the open book and calls
   * it pipeline. Run against Dennis it returns AED 616m, which is nonsense:
   * 429 of his 800 leads are tenants, and their max_price is an ANNUAL RENT of
   * a hundred-odd thousand. Adding a year's rent to a villa's asking price
   * produces a number with no unit, and it flatters the total by the count of
   * rentals rather than by anything anyone will earn.
   *
   * So the ring is the sale book alone, and rent is reported beside it in its
   * own units. Split on `lead_type`, which unlike hot_lead is maintained.
   */
  const saleRows = rows.filter((r) => wantedType(r.lead) === "sale");
  const rentRows = rows.filter((r) => wantedType(r.lead) === "rent");

  const band = (b) => saleRows.filter((r) => r.band === b).reduce((s, r) => s + r.value, 0);
  const pipeline = {
    total: saleRows.reduce((s, r) => s + r.value, 0),
    high: band("high"), medium: band("medium"), low: band("low"),
    priced: saleRows.filter((r) => r.value > 0).length,
    unpriced: saleRows.filter((r) => !r.value).length,
    leads: saleRows.length,
  };

  const rent = {
    total: rentRows.reduce((s, r) => s + r.value, 0),
    leads: rentRows.length,
    priced: rentRows.filter((r) => r.value > 0).length,
  };

  // Matching runs over the actionable book but only the part of it worth
  // showing inventory to — a lead at "Price too high" does not need more
  // listings at that price.
  const matchable = byScore.filter((r) => r.score >= 40).slice(0, 120);
  const matches = [];
  // One card per person. The same client legitimately raises several enquiries
  // — one contact id shows up twice in Dennis's top matches alone — and three
  // identical cards is a bug wearing the costume of a busy pipeline.
  const seenContact = new Set();
  for (const r of matchable) {
    const who = r.lead.contact?.id ?? r.client.mobile ?? r.lead.id;
    if (seenContact.has(who)) continue;
    const hits = matchesFor(r.lead, listings);
    if (!hits.length) continue;
    seenContact.add(who);
    matches.push({ ...r, listings: hits });
    if (matches.length >= 12) break;
  }

  return {
    rows, byScore, hot, atRisk, neverContacted, pipeline, rent, matches,
    totals: { book: leads.length, live: live.length, closed: leads.length - live.length },
  };
}
