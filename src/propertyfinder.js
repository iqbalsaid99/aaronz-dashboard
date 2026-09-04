/**
 * Property Finder Enterprise API client — the data behind PF Expert.
 *
 * Base is atlas.propertyfinder.com, proxied at /pf by the dev server, which
 * also does the Basic -> JWT exchange. Endpoints and parameters below come from
 * the Enterprise API spec (v1.0.1) plus live probing on 2026-08-03, because
 * several documented things do not behave as written:
 *
 *   - /v1/locations only honours `search`. Every documented filter[...] returns
 *     an upstream 404, so there is NO way to turn a location id into a name.
 *     Listings carry location.id and nothing else, which is why areas show as
 *     blank rather than wrong. `learnLocations` below banks the id->name pairs
 *     that search results hand over, so anything you look up stays resolved.
 *     That whole endpoint is also intermittently 404 on PF's side; treat a
 *     failure as "no location data", never as an error worth surfacing.
 *   - /v1/leads will not return data older than three months. Asking for more
 *     is a 422, so the range picker stops at 90 days.
 *   - perPage caps differ per resource: 50 on leads, 100 everywhere else —
 *     including listing-verifications, which this note previously claimed was
 *     50. Re-probed 2026-08-09: verifications and listings both accept 100 and
 *     reject 101; leads accepts 50 and rejects 51. Exceeding the cap is a 400,
 *     not a silent clamp.
 *   - Unknown query parameters are ignored silently rather than rejected — a
 *     filter that does not exist looks like a filter that matched everything.
 *     Only the parameters listed here are real.
 *
 * The account's own listing set is small (288 records, 142 live), so listings,
 * users and stats are all pulled whole and filtered in memory. Only leads are
 * range-bound, and only because the API forces it.
 */

import { dubaiDay, dubaiDaysAgo, DUBAI_OFFSET } from "./time.js";
import { apiFetch } from "./apiFetch.js";

const BASE = "/pf";

/* ------------------------------ transport ------------------------------ */

const TTL_MS = 5 * 60 * 1000;
const cache = new Map();

export const clearPfCache = () => cache.clear();

function url(path, params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    qs.append(k, Array.isArray(v) ? v.join(",") : String(v));
  }
  const s = qs.toString();
  return `${BASE}${path}${s ? `?${s}` : ""}`;
}

async function get(path, params) {
  const u = url(path, params);
  const hit = cache.get(u);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.body;

  const res = await apiFetch(u);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Errors are RFC-7807ish: { title, detail, errors: [{ pointer, detail }] }.
    const first = body.errors?.[0];
    const err = new Error(body.title ?? `Property Finder API ${res.status}`);
    err.detail = first ? `${first.pointer ?? ""} ${first.detail}`.trim() : body.detail;
    err.status = res.status;
    throw err;
  }
  cache.set(u, { at: Date.now(), body });
  return body;
}

/**
 * Walk every page of a collection.
 *
 * `pick` pulls the rows out of the envelope, which is not consistent across the
 * API — listings use `results`, verifications use `submissions`, everything
 * else uses `data`. Pagination metadata moves too (`pagination` vs
 * `pageMetadata`). maxPages is a stop so a paging bug cannot spin forever.
 */
async function all(path, { params = {}, perPage = 100, pick = (j) => j.data, maxPages = 60 } = {}) {
  const rows = [];
  let total = null;
  for (let page = 1; page <= maxPages; page++) {
    const j = await get(path, { ...params, page, perPage });
    const batch = pick(j) ?? [];
    rows.push(...batch);
    const meta = j.pagination ?? j.pageMetadata ?? {};
    total = meta.total ?? total;
    if (!batch.length || !meta.nextPage || page >= (meta.totalPages ?? 1)) break;
  }
  return { rows, total: total ?? rows.length };
}

/* ------------------------------ fetchers ------------------------------ */

/**
 * Listings. `draft: false` is the published universe — live plus taken-down,
 * i.e. everything that has ever reached the portal. `draft: true` is the
 * separate work-in-progress set and is not counted anywhere as inventory.
 */
export async function fetchListings({ draft = false, state, archived } = {}) {
  const { rows, total } = await all("/v1/listings", {
    perPage: 100,
    pick: (j) => j.results,
    params: {
      draft: draft ? "true" : undefined,
      archived: archived ? "true" : undefined,
      "filter[state]": state,
      "sort[createdAt]": "desc",
    },
  });
  return { listings: rows.map(normaliseListing), total };
}

/**
 * Start of the range: midnight Dubai, `days - 1` days back.
 *
 * "Last 30 days" has to mean today plus the 29 whole days before it, not the
 * rolling 720 hours, or the daily chart — which is bucketed by calendar day —
 * holds fewer leads than the headline count sitting above it. Dubai days, not
 * the browser's and not UTC's, for the reason set out in time.js: a lead at
 * 00:43 Dubai carries the previous day's UTC stamp.
 */
function windowStart(days) {
  return new Date(`${dubaiDaysAgo(days - 1)}T00:00:00.000${DUBAI_OFFSET}`);
}

/** Leads. The API refuses anything older than three months. */
export async function fetchLeads({ days = 30 } = {}) {
  const from = windowStart(days);
  const { rows, total } = await all("/v1/leads", {
    perPage: 50,
    maxPages: 80,                     // 4,000 leads; the account runs ~350/quarter
    params: {
      createdAtFrom: from.toISOString().replace(/\.\d+Z$/, "Z"),
      orderBy: "createdAt",
      orderDirection: "desc",
    },
  });
  return { leads: rows.map(normaliseLead), total, from };
}

export async function fetchUsers() {
  const { rows } = await all("/v1/users", { perPage: 100 });
  return rows.map(normaliseUser);
}

/**
 * SuperAgent scoring. Only profiles enrolled in the programme appear — ten of
 * the account's users at the time of writing, not all of them — so anything
 * reading this must fall back to the plain user record.
 */
export async function fetchSuperAgent() {
  const { rows } = await all("/v1/stats/superagent-stats", { perPage: 100 });
  return rows;
}

/** Per-profile quality/response metrics. Same enrolment caveat as above. */
export async function fetchProfileStats() {
  const { rows } = await all("/v1/stats/public-profiles", { perPage: 100 });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    photo: r.imageUrl,
    leads: num(r.metrics?.leadsCount?.value),
    quality: num(r.metrics?.qualityScoreAvg?.value),
    responseRate: num(r.metrics?.responseRate?.value),
    responseTime: num(r.metrics?.responseTime?.value),      // seconds
    ratings: num(r.metrics?.ratingsCount?.value),
    rating: num(r.metrics?.ratingAverage?.value),
    transactions: num(r.metrics?.transactionsCount?.value),
    daysSinceTransaction: num(r.metrics?.transactionsDaysSinceLast?.value),
    verified: r.metrics?.verification?.pass === true,
  }));
}

/** Where our agents rank inside each area x category arena. */
export async function fetchArena() {
  const { rows } = await all("/v1/stats/public-profiles-arena-ranking", { perPage: 100 });
  return rows;
}

export const fetchCreditBalance = () => get("/v1/credits/balance");
export const fetchWallets = () => get("/v1/wallets/balance");

export async function fetchCreditTransactions({ days = 30 } = {}) {
  const from = windowStart(days);
  const { rows, total } = await all("/v1/credits/transactions", {
    perPage: 100,
    maxPages: 30,
    params: { createdAtFrom: from.toISOString().replace(/\.\d+Z$/, "Z") },
  });
  return { transactions: rows.map(normaliseTransaction), total };
}

export async function fetchVerifications() {
  const { rows, total } = await all("/v1/listing-verifications", {
    // 100 is the real cap here, not 50 — see the note at the top of the file.
    // At 132 records that is two pages rather than three, and one fewer
    // request is one fewer chance to meet the intermittent 500 this endpoint
    // has already thrown once.
    perPage: 100,
    pick: (j) => j.submissions,
  });
  return { submissions: rows, total };
}

/** Lifetime credits spent on specific listings. Hard cap of 20 ids per call. */
export async function fetchCreditsSpent(listingIds) {
  const ids = [...new Set(listingIds)].filter(Boolean).slice(0, 20);
  if (!ids.length) return new Map();
  const j = await get("/v1/credits/spent", { listingId: ids.join(",") });
  return new Map((j.listings ?? []).map((l) => [l.listingId, l.totalSpent]));
}

/* ------------------------------ locations ------------------------------ */

/**
 * id -> name, learned rather than looked up.
 *
 * There is no endpoint that resolves a location id, so the only names we can
 * ever hold are the ones a search happened to return. Every search result is
 * banked here — including each ancestor in the result's tree — so the more you
 * search, the more listing areas fill in. Kept in localStorage because it is
 * slow to accumulate and never goes stale: PF's ids are permanent.
 */
const LOC_KEY = "pf.locations.v1";

function loadLocations() {
  try { return new Map(Object.entries(JSON.parse(localStorage.getItem(LOC_KEY) ?? "{}"))); }
  catch { return new Map(); }
}

let locations = loadLocations();

export const locationName = (id) => (id == null ? null : locations.get(String(id)) ?? null);
export const locationsKnown = () => locations.size;

function learnLocations(rows) {
  let added = 0;
  for (const r of rows ?? []) {
    for (const node of [r, ...(r.tree ?? [])]) {
      if (node?.id == null || !node.name) continue;
      const k = String(node.id);
      if (!locations.has(k)) { locations.set(k, node.name); added++; }
    }
  }
  if (added) {
    try { localStorage.setItem(LOC_KEY, JSON.stringify(Object.fromEntries(locations))); } catch { /* quota */ }
  }
  return added;
}

/**
 * Location search. Returns [] rather than throwing when PF's location service
 * is down, which it frequently is — an area filter that quietly offers no
 * suggestions is better than an error banner on a working page.
 */
export async function searchLocations(term) {
  if (!term || term.trim().length < 2) return [];
  try {
    const j = await get("/v1/locations", { search: term.trim(), perPage: 20 });
    learnLocations(j.data);
    return (j.data ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      path: (r.tree ?? []).map((t) => t.name).join(" › "),
    }));
  } catch {
    return [];
  }
}

/* ------------------------------- shaping ------------------------------- */

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const en = (v) => (typeof v === "string" ? v : v?.en ?? null);

/** premium beats featured beats standard — a listing can carry more than one. */
const LEVELS = ["premium", "featured", "standard"];

export function normaliseListing(l) {
  const products = l.products ?? {};
  const level = LEVELS.find((k) => products[k]) ?? null;
  const q = l.qualityScore ?? {};

  return {
    id: l.id,
    ref: l.reference,
    title: en(l.title),
    type: l.type,
    category: l.category,                                  // residential | commercial
    offering: l.price?.type === "sale" ? "sale" : "rent",
    price: l.price?.amounts?.[l.price?.type] ?? l.price?.amounts?.sale ?? null,
    priceType: l.price?.type,
    cheques: l.price?.numberOfCheques ?? null,
    beds: l.bedrooms,
    baths: l.bathrooms,
    size: num(l.size),
    plotSize: num(l.plotSize),
    // state.type carries compound values such as
    // "takendown_changes_publishing_failed" — the leading word is the state,
    // the rest is why. Splitting keeps the filter honest without losing detail.
    state: String(l.state?.type ?? "").split("_")[0] || "unknown",
    stateDetail: l.state?.type,
    stateReason: (l.state?.reasons ?? [])[0]?.en ?? null,
    live: l.portals?.propertyfinder?.isLive === true,
    publishedAt: date(l.portals?.propertyfinder?.publishedAt),
    level,
    levelExpiresAt: date(products[level]?.expiresAt),
    quality: num(q.value),
    qualityColor: q.color,
    qualityIssues: qualityIssues(q),
    verification: l.verificationStatus ?? null,
    permit: l.compliance?.listingAdvertisementNumber ?? null,
    permitType: l.compliance?.type ?? null,
    agentId: l.assignedTo?.id ?? null,
    agentName: l.assignedTo?.name ?? null,
    agentPhoto: l.assignedTo?.photos?.thumbnail ?? null,
    locationId: l.location?.id ?? null,
    photo: l.media?.images?.[0]?.watermarked?.url ?? l.media?.images?.[0]?.original?.url ?? null,
    images: (l.media?.images ?? []).length,
    createdAt: date(l.createdAt),
    updatedAt: date(l.updatedAt),
    availableFrom: date(l.availableFrom),
    furnishing: l.furnishingType,
    projectStatus: l.projectStatus ?? null,
  };
}

/**
 * The quality score is a weighted rubric. Each factor reports the points it
 * earned against the points available, so `weight - value` is what that listing
 * would gain by fixing it — which is the only form of this worth showing
 * someone. Factors that scored full marks are dropped.
 */
function qualityIssues(q) {
  return Object.entries(q.details ?? {})
    .map(([key, d]) => ({
      key,
      group: d.group,
      lost: Math.max(0, (d.weight ?? 0) - (d.value ?? 0)),
      weight: d.weight ?? 0,
      tag: d.tag,
      help: d.help ?? null,
      color: d.color,
    }))
    .filter((f) => f.lost > 0)
    .sort((a, b) => b.lost - a.lost);
}

export function normaliseLead(l) {
  return {
    id: l.id,
    at: date(l.createdAt),
    channel: l.channel,                                    // whatsapp | call | email
    status: l.status,                                      // sent | delivered | read | replied
    entityType: l.entityType,                              // listing | agent | company | project
    listingId: l.listing?.id ?? null,
    listingRef: l.listing?.reference ?? null,
    agentId: l.publicProfile?.id ?? null,
    senderName: l.sender?.name ?? null,
    phone: (l.sender?.contacts ?? []).find((c) => c.type === "phone")?.value ?? null,
    email: (l.sender?.contacts ?? []).find((c) => c.type === "email")?.value ?? null,
    responseLink: l.responseLink ?? null,
    tags: l.tags ?? null,
    call: l.call ?? null,
  };
}

export function normaliseUser(u) {
  const p = u.publicProfile ?? {};
  const brn = (p.compliances ?? []).find((c) => c.type === "brn");
  return {
    id: u.id,
    profileId: p.id ?? null,
    name: `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim(),
    email: u.email,
    mobile: u.mobile,
    role: u.role?.name ?? null,
    status: u.status,
    photo: p.imageVariants?.large?.jpg ?? p.imageVariants?.small?.jpg ?? null,
    brn: brn?.value ?? null,
    brnStatus: brn?.status ?? null,
    brnExpiry: date(brn?.expiryDate),
    createdAt: date(u.createdAt),
  };
}

export function normaliseTransaction(t) {
  return {
    at: date(t.createdAt),
    description: t.description,
    action: t.transactionInfo?.action,                     // charge | refund | ...
    type: t.transactionInfo?.type,                         // credits | premium_bundle | feature_bundle
    amount: num(t.transactionInfo?.amount) ?? 0,           // negative on a charge
    balance: num(t.transactionInfo?.balance),
    listingId: t.listingInfo?.id ?? null,
    listingRef: t.listingInfo?.reference ?? null,
    listingType: t.listingInfo?.type ?? null,
    listingCategory: t.listingInfo?.category ?? null,
    agentId: num(t.listingInfo?.publicProfileId),
    locationId: t.listingInfo?.locationId ?? null,
  };
}

function date(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/* ------------------------------ derived ------------------------------- */

export function tally(rows, keyOf) {
  const m = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    if (k === null || k === undefined || k === "") continue;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
}

/**
 * Dense daily series — days with nothing still appear, or the shape lies.
 *
 * Bucketed on Dubai calendar days. Keying on the UTC date instead silently
 * drops today's leads for the first four hours of every Dubai day and files
 * overnight enquiries under yesterday. The bucket's own `date` is noon Dubai so
 * that formatting it for an axis label cannot land on the wrong day either.
 */
export function byDay(rows, days, valueOf = () => 1, at = (r) => r.at) {
  const out = [];
  const index = new Map();
  for (let i = days - 1; i >= 0; i--) {
    const key = dubaiDaysAgo(i);
    index.set(key, out.length);
    out.push({ day: key, date: new Date(`${key}T12:00:00${DUBAI_OFFSET}`), value: 0 });
  }
  for (const r of rows) {
    const d = at(r);
    if (!d) continue;
    const i = index.get(dubaiDay(d));
    if (i !== undefined) out[i].value += valueOf(r);
  }
  return out;
}

/** Leads that got a reply, as a share of leads that could have had one. */
export function replyRate(leads) {
  if (!leads.length) return null;
  return leads.filter((l) => l.status === "replied").length / leads.length;
}

/* ------------------------------ formatting ---------------------------- */

export const fmtAed = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v) || !v) return "—";
  if (v >= 1_000_000) return `AED ${(v / 1_000_000).toFixed(v >= 10_000_000 ? 1 : 2)}m`;
  if (v >= 1_000) return `AED ${Math.round(v / 1000)}k`;
  return `AED ${Math.round(v)}`;
};

export const fmtNum = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString() : "—");

export const fmtPct = (v, digits = 0) =>
  v === null || v === undefined || !Number.isFinite(Number(v)) ? "—" : `${(Number(v) * 100).toFixed(digits)}%`;

/** Response times arrive in seconds and range from a minute to several days. */
export const fmtDuration = (seconds) => {
  const s = Number(seconds);
  if (!Number.isFinite(s)) return "—";
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172_800) return `${(s / 3600).toFixed(1)}h`;
  return `${Math.round(s / 86_400)}d`;
};

export const fmtDate = (d) =>
  d ? d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—";

export const fmtDateTime = (d) =>
  d ? d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";

export const daysUntil = (d) => (d ? Math.ceil((d.getTime() - Date.now()) / 86_400_000) : null);

/* ------------------------------- options ------------------------------ */

export const LEAD_DAYS = [
  [7, "7 days"],
  [30, "30 days"],
  [90, "90 days"],       // the API's hard ceiling
];

export const LISTING_STATES = [
  ["", "All published"],
  ["live", "Live"],
  ["takendown", "Taken down"],
];

export const CHANNELS = ["whatsapp", "call", "email"];
export const LEAD_STATUSES = ["sent", "delivered", "read", "replied"];
