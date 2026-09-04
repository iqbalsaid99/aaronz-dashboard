/**
 * Campaign leads — joining what Meta charged for to what the CRM did with it.
 *
 * THERE IS NO CAMPAIGN ID ON A LEAD. The obvious join does not exist: nothing
 * in the CRM record names a campaign, an ad set or an ad. `source` says
 * "Facebook" and `other_source_of_lead` is null on every lead in the account.
 *
 * What does survive is the auto-import note, which the portal writes as prose
 * and which ends with the ad it came from:
 *
 *   Hi, I found your property on Facebook. Please contact me. Thank you.
 *   Additional Data: investment budget? - aed_2.8m_–_5m, timeline? -
 *   within_3_months (Ad Set: UK-Broad-30to65-Manual) (Ad: SYM-Comm-UK-Statics)
 *
 * So the join is: lead -> ad NAME out of that note -> the ad object Meta
 * returns -> its campaign id. It is a join on a human-typed string, which is
 * why matching is case- and space-insensitive and why a lead that cannot be
 * matched is reported as unmatched rather than quietly dropped.
 *
 * The same note carries the lead-form answers — budget, timeline, what they
 * are looking for — which are the only qualification the CRM ever receives.
 */

import {
  statusOf, humanNotes, agentOf, parseNoteDate, contactNameOf,
} from "./propspace.js";
// The CRM escapes apostrophes as #sqoute#; cleanNote is where that is undone.
import { cleanNote } from "./brokers.js";

const AUTO = "Auto Import";

const autoNote = (lead) =>
  (lead.notes ?? []).find((n) => n.user_name === AUTO)?.notes ?? "";

/** Meta's own leads. `source` is the CRM's channel field and reads "Facebook"
 *  for both Facebook and Instagram placements — Meta does not distinguish
 *  them here, and neither can we. */
export const isMetaLead = (lead) =>
  /facebook|instagram|meta/i.test(String(lead.source ?? "")) ||
  /found your property on facebook/i.test(autoNote(lead));

/** The ad and ad set the note names, or nulls. */
export function adTagOf(lead) {
  const note = autoNote(lead);
  const ad = note.match(/\(Ad:\s*([^)]+)\)/i);
  const set = note.match(/\(Ad Set:\s*([^)]+)\)/i);
  return { ad: ad ? ad[1].trim() : null, adSet: set ? set[1].trim() : null };
}

const key = (s) => String(s ?? "").toLowerCase().replace(/[\s_-]+/g, "");

/**
 * The lead-form answers, out of the "Additional Data:" run.
 *
 * Split on ", " only where the next token looks like a new question, because
 * the free-text answers contain commas of their own — one in this account runs
 * to a full sentence with three of them.
 */
export function formAnswersOf(lead) {
  const note = autoNote(lead)
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/\(Ad Set:[^)]*\)|\(Ad:[^)]*\)/gi, "");
  const at = note.search(/Additional Data:/i);
  if (at < 0) return [];
  const body = note.slice(at + "Additional Data:".length).trim();

  const out = [];
  const re = /([^,?]+\?)\s*-\s*/g;
  let m, prev = null;
  while ((m = re.exec(body))) {
    if (prev) out.push({ q: prev.q, a: body.slice(prev.end, m.index).replace(/[,\s]+$/, "").trim() });
    prev = { q: m[1].trim(), end: re.lastIndex };
  }
  if (prev) out.push({ q: prev.q, a: body.slice(prev.end).replace(/[,\s]+$/, "").trim() });

  return out
    .map(({ q, a }) => ({ q: q.replace(/\?$/, ""), a: a.replace(/_/g, " ").trim() }))
    .filter((x) => x.a);
}

/* --------------------------- authenticity --------------------------- */

/**
 * Mailbox providers that exist to be thrown away. A real buyer does not give
 * you a ten-minute address; the rest of the free providers say nothing at all,
 * because most genuine people use one.
 */
const DISPOSABLE = /(mailinator|guerrillamail|10minutemail|tempmail|throwaway|yopmail|trashmail|sharklasers|maildrop|getnada|fakeinbox|dispostable)\./i;

const EMAIL_RE = /^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/;

/**
 * The CRM writes last_name as "<first name> undefined" on Meta leads, so the
 * only real name is first_name and last_name must be ignored entirely. Reading
 * both gives every lead a doubled name and a literal "undefined".
 */
export function displayName(lead) {
  return contactNameOf(lead, "");
}

const words = (s) => s.split(/[\s.]+/).filter(Boolean);

/** A name that is not a name. Each test is something seen in this account. */
function nameFaults(name) {
  const f = [];
  if (!name) { f.push("no name given"); return f; }
  const w = words(name);

  // "+447427276507" — the number typed into the name box.
  if (/^[+\d\s()-]+$/.test(name)) f.push("name is a phone number");
  // "1 billion dollars into my mouth right now."
  else if (w.length >= 5 || /[.!?]\s*\S/.test(name)) f.push("name is a sentence, not a name");
  // "G g. G g g g. Gg g g. G g g g g g g g gg."
  //
  // SINGLE characters, not short ones. The first cut tested for tokens of two
  // characters or fewer, which flagged "Ji su shy" as gibberish — a rule that
  // reads plenty of Korean, Chinese and Vietnamese names as fake and would
  // have had a broker binning real buyers on the strength of it.
  else if (w.length >= 3 && w.filter((x) => x.length === 1).length / w.length >= 0.5)
    f.push("name is repeated single letters");

  if (name.length > 40) f.push("name is unusually long");
  if (/(.)\1{3,}/.test(name)) f.push("name has repeated characters");
  return f;
}

/** Does the email look like it belongs to the person who gave the name? */
function emailMatchesName(name, email) {
  const local = String(email).split("@")[0].toLowerCase().replace(/[^a-z]/g, "");
  if (!local) return false;
  const toks = words(name).map((w) => w.toLowerCase().replace(/[^a-z]/g, "")).filter((w) => w.length >= 3);
  if (!toks.length) return false;
  if (toks.some((t) => local.includes(t) || t.includes(local))) return true;
  // initials + surname, e.g. "Matthew White" -> matwhite
  return toks.some((t) => t.length >= 4 && local.includes(t.slice(0, 4)));
}

function phoneFaults(raw) {
  const digits = String(raw ?? "").replace(/\D/g, "");
  const f = [];
  if (!digits) { f.push("no number given"); return f; }
  if (digits.length < 7 || digits.length > 15) f.push(`number is ${digits.length} digits`);
  if (/^(\d)\1+$/.test(digits)) f.push("number is one repeated digit");
  if (/^(0?1234567|9876543)/.test(digits)) f.push("number is a sequence");
  return f;
}

/**
 * How much of this record looks like a real person, 0–100, with the reasons.
 *
 * Starts at a deliberately unconfident 70 and moves on evidence. It scores the
 * RECORD, not the person: a genuine buyer who typed their phone number into
 * the name box scores badly and should, because what reached the CRM is not
 * usable. And it cannot catch everything — a joke name spelled like a real one
 * passes, which is why the number sits next to the name rather than replacing
 * it.
 */
export function authenticity(lead) {
  const name = displayName(lead);
  const email = String(lead.contact?.email ?? "").trim();
  const phone = lead.contact?.mobile || lead.contact?.phone || "";

  let score = 70;
  const bad = [];
  const good = [];

  const nf = nameFaults(name);
  if (nf.length) { score -= 45; bad.push(...nf); }
  else if (words(name).length === 1) { score -= 6; bad.push("first name only"); }
  else good.push("name looks like a name");

  if (!email) { score -= 30; bad.push("no email"); }
  else if (!EMAIL_RE.test(email)) { score -= 30; bad.push("email is malformed"); }
  else if (DISPOSABLE.test(email)) { score -= 35; bad.push("disposable email domain"); }
  else if (emailMatchesName(name, email)) { score += 18; good.push("email matches the name"); }
  else { score -= 8; bad.push("email does not match the name"); }

  const pf = phoneFaults(phone);
  if (pf.length) { score -= 25; bad.push(...pf); }
  else good.push("number is plausible");

  score = Math.max(0, Math.min(100, Math.round(score)));
  return {
    score,
    band: score >= 70 ? "real" : score >= 40 ? "check" : "junk",
    bad, good,
  };
}

export const BAND_META = {
  real:  { label: "Looks real", tint: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  check: { label: "Worth checking", tint: "bg-amber-50 text-amber-700 border-amber-200" },
  junk:  { label: "Likely junk", tint: "bg-rose-50 text-rose-700 border-rose-200" },
};

/* ----------------------------- the join ----------------------------- */

/** Last human touch, or null when nobody has written anything. */
export function lastTouchOf(lead) {
  const times = humanNotes(lead)
    .map((n) => parseNoteDate(n.date ?? n.created_at))
    .filter(Boolean)
    .map((d) => d.getTime());
  return times.length ? new Date(Math.max(...times)) : null;
}

/**
 * Meta leads for one campaign.
 *
 * `ads` is what the Campaigns tab already holds — each carries a name and a
 * campaignId — so the ad name in the note resolves to a campaign without any
 * further request. Ad names are matched loosely because one is typed into Ads
 * Manager and the other is echoed through the portal.
 */
export function leadsForCampaign(leads, campaignId, ads) {
  const adToCampaign = new Map();
  for (const a of ads ?? []) {
    if (a?.name && a?.campaignId) adToCampaign.set(key(a.name), String(a.campaignId));
  }

  const rows = [];
  for (const lead of leads ?? []) {
    if (!isMetaLead(lead)) continue;
    const { ad, adSet } = adTagOf(lead);
    if (!ad) continue;
    if (adToCampaign.get(key(ad)) !== String(campaignId)) continue;
    rows.push(decorate(lead, ad, adSet));
  }
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}

/** Meta leads whose ad name matches no ad Meta returned. Reported, not hidden:
 *  an ad deleted since it ran still produced these people. */
export function unmatchedMetaLeads(leads, ads) {
  const known = new Set((ads ?? []).filter((a) => a?.name).map((a) => key(a.name)));
  return (leads ?? [])
    .filter(isMetaLead)
    .filter((l) => { const { ad } = adTagOf(l); return !ad || !known.has(key(ad)); })
    .map((l) => { const { ad, adSet } = adTagOf(l); return decorate(l, ad, adSet); })
    .sort((a, b) => b.createdAt - a.createdAt);
}

function decorate(lead, ad, adSet) {
  const touch = lastTouchOf(lead);

  /**
   * What the broker wrote, oldest first.
   *
   * The form answers already on this row are what the CLIENT said; these are
   * what the person working the lead said back, and the two disagree often
   * enough to matter. One Symphony lead scores 88 on authenticity — a
   * well-formed name whose email agrees with it — and carries a single broker
   * note reading "Spam". The score cannot see that. The note can, so it is
   * shown next to it rather than instead of it.
   */
  const notes = humanNotes(lead)
    .map((n) => ({
      text: cleanNote(n.notes),
      author: n.user_name || "Unknown",
      at: parseNoteDate(n.date ?? n.created_at),
    }))
    .filter((n) => n.text)
    .sort((a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0));
  return {
    lead,
    id: lead.id,
    reference: lead.reference ?? null,
    name: displayName(lead) || "No name given",
    email: String(lead.contact?.email ?? "").trim() || null,
    phone: lead.contact?.mobile || lead.contact?.phone || null,
    status: statusOf(lead),
    agent: agentOf(lead),
    ad, adSet,
    answers: formAnswersOf(lead),
    notes,
    createdAt: new Date(lead.created_at),
    lastTouch: touch,
    touched: touch !== null,
    auth: authenticity(lead),
  };
}

/** Headline counts for the tab — what the CRM has actually done with them. */
export function summariseCampaignLeads(rows) {
  const n = rows.length;
  const untouched = rows.filter((r) => !r.touched).length;
  const byStatus = new Map();
  const byAgent = new Map();
  for (const r of rows) {
    byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
    byAgent.set(r.agent, (byAgent.get(r.agent) ?? 0) + 1);
  }
  const band = (b) => rows.filter((r) => r.auth.band === b).length;
  return {
    total: n,
    untouched,
    worked: n - untouched,
    real: band("real"), check: band("check"), junk: band("junk"),
    statuses: [...byStatus.entries()].map(([k, v]) => ({ key: k, count: v }))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)),
    agents: [...byAgent.entries()].map(([k, v]) => ({ key: k, count: v }))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)),
  };
}
