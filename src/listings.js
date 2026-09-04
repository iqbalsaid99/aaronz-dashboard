/**
 * PropSpace listings client + new-listing logic.
 *
 * Everything here was derived by probing the live account on 2026-07-31,
 * because /docs, /options/listing-statuses and every history endpoint are 403
 * on this API key. Findings that drive the code below:
 *
 *   - GET /listings defaults to status=published only — 352 records. The full
 *     history lives behind ?status=unpublished (9,613) / draft (935) /
 *     pending_approval (545). Counting "new listings per month" off the default
 *     would undercount every past month, badly, because anything since rented
 *     or sold has left the published set.
 *   - Results are strictly newest-first by created_at, per_page caps at 100.
 *   - There is NO price history and no audit endpoint.
 */

import { dubaiRange, dubaiMonth, dubaiToday, dubaiDaysAgo } from "./time.js";
import { apiFetch } from "./apiFetch.js";

const BASE = "/ps";

/**
 * A listing that reached the market at some point is either still published or
 * has since been unpublished. `draft` never went live and `pending_approval`
 * has not gone live yet — counting those as "new listings" inflates the month.
 *
 * Checked against the admin's own July figure of 84: that is `published`
 * alone. The full breakdown for July 2026 is
 *   published 84 · unpublished 4 · draft 11 · pending_approval 15  = 114
 * so 88 went live, and the 26-record gap to 114 is work-in-progress records.
 */
export const WENT_LIVE = ["published", "unpublished"];
export const NOT_LIVE = ["draft", "pending_approval"];
const STATUSES = WENT_LIVE;

async function get(path, params = {}) {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null)
  );
  const res = await apiFetch(`${BASE}${path}${qs.toString() ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

const unwrap = (j) => (Array.isArray(j) ? j : j.data ?? j.listings ?? j.items ?? []);

/**
 * Page-level cache, keyed by status + page number.
 *
 * Paging is deterministic and newest-first, so page 3 of `unpublished` holds
 * the same records from one request to the next. Widening 30 days out to a
 * year therefore only pays for the pages it has not already read — the first
 * few come straight from memory. Without this, every range change re-fetched
 * from page 1.
 *
 * Five-minute TTL so a long session still picks up new listings, and Refresh
 * clears it outright for when you want to force the issue.
 */
const pageCache = new Map();
const TTL_MS = 5 * 60 * 1000;

export const clearListingCache = () => pageCache.clear();

async function getPage(status, page) {
  const key = `${status}|${page}`;
  const hit = pageCache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.rows;
  const rows = unwrap(await get("/listings", { page, per_page: 100, status }));
  pageCache.set(key, { at: Date.now(), rows });
  return rows;
}

/**
 * Pull listings created on or after `since` (ISO date), across all statuses.
 * Newest-first ordering lets us stop as soon as a page runs past the window —
 * pulling all 9.6k unpublished records takes ~2 minutes, a 12-month window
 * takes a few seconds.
 */
export async function fetchListings({
  since, until, statuses = STATUSES, maxPages = 120, batch = 4, onProgress,
}) {
  const { start, end } = dubaiRange(since, until);
  const seen = new Map();   // deduped by id, same page-shift reasoning as leads

  // The four statuses are independent queries, so they run concurrently too —
  // otherwise a 12-month pull waits through published before it starts on the
  // 9.6k unpublished records that hold most of the history.
  await Promise.all(statuses.map(async (status) => {
    let done = false;
    for (let page = 1; page <= maxPages && !done; page += batch) {
      const pages = [];
      for (let i = 0; i < batch && page + i <= maxPages; i++) pages.push(page + i);

      const results = await Promise.all(pages.map((p) => getPage(status, p)));

      for (const rows of results) {
        for (const r of rows) seen.set(r.id, { ...r, status: r.status ?? status });
        if (!rows.length || rows.length < 100) { done = true; continue; }
        if (new Date(rows[rows.length - 1].created_at).getTime() < start) done = true;
      }
      onProgress?.(seen.size);
    }
  }));

  return [...seen.values()]
    .filter((l) => {
      const t = new Date(l.created_at).getTime();
      return t >= start && t <= end;
    })
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

/**
 * Every record in one status, with no date window.
 *
 * Current state is a whole-book question — "what is live", "what is waiting" —
 * so windowing it by created_at would silently drop a listing that went up in
 * March and is still on the portals today. Only the current-state statuses are
 * small enough for this: published is ~350 and pending_approval ~550, against
 * 9,613 unpublished, which is why that one is still read through a window.
 */
export async function fetchAllOfStatus(status, { maxPages = 20 } = {}) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const rows = await getPage(status, page);
    if (!rows.length) break;
    out.push(...rows);
    if (rows.length < 100) break;
  }
  return out;
}

/** All currently-live listings. Only 352, so no window needed. */
export const fetchLiveListings = ({ maxPages = 20 } = {}) =>
  fetchAllOfStatus("published", { maxPages });

/** Everything submitted to a portal and not yet accepted. */
export const fetchPendingListings = ({ maxPages = 20 } = {}) =>
  fetchAllOfStatus("pending_approval", { maxPages });

/* --------------------------- attribution --------------------------- */

/**
 * `marketing_agent` is null on 88% of records (only recent ones carry it), so
 * `agent` is the field to attribute on — it is populated on all 11,445.
 */
export const listingAgentOf = (l) =>
  l.agent?.name ?? l.marketing_agent?.name ?? "Unassigned";

/**
 * Some listings are owned by house accounts rather than a person — 4,398 sit
 * under "Aaronz And Co Real Estate LLC" and 739 under "Marketing Aaronz",
 * nearly all of them older records. Counting these as somebody's personal
 * production would be wrong, so they are reported as their own row.
 */
const HOUSE = [/aaronz and co/i, /^marketing/i, /real estate llc/i];
export const isHouseAccount = (name) => HOUSE.some((re) => re.test(name ?? ""));

/* ------------------------ new vs amended vs relist ------------------------ */

/**
 * THE KEY FINDING, and it inverts the obvious assumption:
 *
 * `ref` is NOT reused. Across all 11,445 records there are 11,445 distinct
 * refs and 11,445 distinct ids — zero reuse. So a reference number cannot tell
 * you a listing was relisted; a relist gets a brand new ref and a brand new
 * record.
 *
 * The upside is that the reverse is also true and is what actually matters
 * here: an amendment — a price reduction, a description edit — does NOT create
 * a record. It mutates the existing one, moving `updated_at` while `id`, `ref`
 * and `created_at` stay put. Every one of the 352 live listings has
 * updated_at > created_at, i.e. all have been edited at least once, and none
 * of that edit activity shows up as a new listing.
 *
 * So counting new listings by created_at is already immune to price
 * reductions. That is the thing you were worried about, and it is safe.
 *
 * What is NOT free is relisting: the same unit remarketed later is a genuinely
 * new record and will count again. To catch it we identify the physical
 * property instead, by building + unit number + beds + type. Type matters —
 * without it, a flat listed for sale and for rent looks like a relist.
 *
 * In practice this is rare: 20 unit-groups across 11,445 records, median gap
 * 217 days between listings. It moves a monthly count by 0-1%. Worth flagging,
 * not worth agonising over.
 */
export function unitKeyOf(l) {
  const unit = (l.unit_number ?? "").trim().toLowerCase();
  const building = l.sub_area_location?.id;
  if (!unit || !building) return null;
  return `${building}|${unit}|${l.beds}|${l.type}`;
}

/**
 * Tags each listing as first-time or relist. Returns a Map keyed by listing id.
 * Same-day repeats are treated as duplicates (data entry), not relists.
 */
export function classifyRelists(listings) {
  const groups = new Map();
  for (const l of listings) {
    const k = unitKeyOf(l);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(l);
  }

  const tags = new Map();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    sorted.forEach((l, i) => {
      if (i === 0) return;
      const prev = sorted[i - 1];
      const days = Math.round(
        (new Date(l.created_at) - new Date(prev.created_at)) / 86_400_000
      );
      tags.set(l.id, {
        kind: days === 0 ? "duplicate" : "relist",
        days,
        priorRef: prev.ref,
        priorPrice: prev.price,
        priceDelta: (l.price ?? 0) - (prev.price ?? 0),
      });
    });
  }
  return tags;
}

/* ------------------------------ shaping ------------------------------ */

export const monthKey = (iso) => dubaiMonth(iso);

export const monthLabel = (k) => {
  const [y, m] = k.split("-");
  return `${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][+m - 1]} ${y.slice(2)}`;
};

/** Months from `since` to `until` (default now), oldest first — gaps included. */
export function monthRange(since, until) {
  const out = [];
  const d = new Date(since);
  d.setDate(1);
  const end = until ? new Date(until) : new Date();
  // Guard: a reversed or unset range would otherwise loop to the page cap.
  if (Number.isNaN(d.getTime()) || Number.isNaN(end.getTime()) || d > end) return out;
  while (d <= end && out.length < 120) {
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    d.setMonth(d.getMonth() + 1);
  }
  return out;
}

/**
 * Month × agent grid of genuinely-new listings. Relists are counted separately
 * rather than dropped, so the two numbers always reconcile to the raw total.
 */
export function newListingsByMonth(listings, since, until) {
  const tags = classifyRelists(listings);
  const months = monthRange(since, until);
  const agents = new Map();

  for (const l of listings) {
    const m = monthKey(l.created_at);
    if (!months.includes(m)) continue;
    const name = listingAgentOf(l);
    if (!agents.has(name)) {
      agents.set(name, {
        name,
        house: isHouseAccount(name),
        months: Object.fromEntries(months.map((k) => [k, { fresh: 0, relist: 0 }])),
        total: 0,
        relists: 0,
      });
    }
    const row = agents.get(name);
    const tag = tags.get(l.id);
    if (tag?.kind === "relist") { row.months[m].relist++; row.relists++; }
    else { row.months[m].fresh++; }
    row.total++;
  }

  return {
    months,
    rows: [...agents.values()].sort((a, b) => b.total - a.total),
    totals: Object.fromEntries(
      months.map((m) => [
        m,
        [...agents.values()].reduce((s, r) => s + r.months[m].fresh + r.months[m].relist, 0),
      ])
    ),
  };
}

/**
 * Where a listing is advertised. 17 distinct values appear across the book —
 * the big three plus a long tail of syndication partners. Domains are only
 * known for the ones worth showing an icon for; the rest fall back to a
 * lettered badge, which is also what happens if a favicon fails to load.
 */
export const PORTALS = {
  propertyfinder: { label: "Property Finder", domain: "propertyfinder.ae", tint: "bg-rose-100 text-rose-700" },
  bayut:          { label: "Bayut",           domain: "bayut.com",        tint: "bg-emerald-100 text-emerald-700" },
  dubizzle:       { label: "Dubizzle",        domain: "dubizzle.com",     tint: "bg-red-100 text-red-700" },
  ownWebsite:     { label: "Own website",     domain: "aaronz.co",        tint: "bg-slate-200 text-slate-700" },
  houza:          { label: "Houza",           domain: "houza.com",        tint: "bg-sky-100 text-sky-700" },
  rightmove:      { label: "Rightmove",       domain: "rightmove.co.uk",  tint: "bg-green-100 text-green-800" },
  Zoopla:         { label: "Zoopla",          domain: "zoopla.co.uk",     tint: "bg-purple-100 text-purple-700" },
  yalladeals:     { label: "Yalla Deals",     domain: "yalladeals.com",   tint: "bg-amber-100 text-amber-700" },
  JamesEdition:   { label: "JamesEdition",    domain: "jamesedition.com", tint: "bg-neutral-200 text-neutral-700" },
  propertywifi:   { label: "Property WiFi",   tint: "bg-cyan-100 text-cyan-700" },
  GNproperty:     { label: "GN Property",     tint: "bg-blue-100 text-blue-700" },
  YzerProperty:   { label: "Yzer Property",   tint: "bg-indigo-100 text-indigo-700" },
  SakaniHomes:    { label: "Sakani Homes",    tint: "bg-teal-100 text-teal-700" },
  adBooster:      { label: "adBooster",       tint: "bg-orange-100 text-orange-700" },
  coraly:         { label: "Coraly",          tint: "bg-pink-100 text-pink-700" },
  propQA:         { label: "propQA",          tint: "bg-lime-100 text-lime-700" },
};

export const portalMeta = (key) =>
  PORTALS[key] ?? { label: key, tint: "bg-slate-100 text-slate-600" };

/** Google's favicon service resolves the real icon and 404s cleanly for the
 *  obscure ones, which lets the <img> onError swap in a lettered badge. */
export const faviconUrl = (domain) =>
  domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=64` : null;

export const fmtAed = (n) =>
  !n ? "—" : n >= 1_000_000 ? `AED ${(n / 1_000_000).toFixed(2)}m` : `AED ${Math.round(n / 1000)}k`;

/* ------------------------------ prefetch ------------------------------ */

/**
 * Default window, deliberately small. A 12-month pull is ~2,600 records and
 * ~11s; 30 days is ~200 and ~2s. Wider ranges are a click away and, thanks to
 * the page cache above, only pay for the pages the short window did not read.
 */
export const DEFAULT_PRESET = "30d";

export const defaultSince = () => dubaiDaysAgo(30);

/**
 * Warms the cache on import so the Listings tab has its first pages in hand
 * before it is ever opened. Fire-and-forget: failures are swallowed here and
 * surfaced properly when the tab actually fetches.
 */
export const warmListings = (() => {
  const promise = fetchListings({ since: defaultSince() }).catch(() => null);
  return promise;
})();

/* ----------------------------- the listing book ---------------------------- */

/** Rent unless it says sale — `type` is the only field that carries it, and a
 *  missing value on a rental record is common enough to matter. */
const isSale = (l) => l.type === "sale";

/**
 * The broker breakdown: who is carrying what, right now.
 *
 * Counts only. Individual records are a dashboard question — filterable,
 * clickable — and printing several hundred of them buried the summary that
 * people actually read.
 *
 * Ranked on live stock, because that is the number the ranking is about: what
 * this broker has on the portals today. Awaiting-approval sits beside it as a
 * column rather than being added in — a listing waiting on Bayut's queue is
 * work done, but it is not stock, and summing the two would let a broker with
 * nothing live outrank one carrying fifty.
 *
 * House accounts are pinned below the ranked people and carry no rank number.
 * Four thousand-odd records sit under "Aaronz And Co Real Estate LLC"; reading
 * that as one person's production is exactly the mistake isHouseAccount exists
 * to prevent. They stay visible because the stock is real.
 */
export function listingBookReport({ live = [], pending = [], draft = [] }) {
  const brokers = new Map();
  const touch = (name) => {
    if (!brokers.has(name)) {
      brokers.set(name, {
        name, house: isHouseAccount(name),
        live: 0, rent: 0, sale: 0, pending: 0, draft: 0, held: 0, value: 0,
      });
    }
    return brokers.get(name);
  };

  for (const l of live) {
    const r = touch(listingAgentOf(l));
    r.live++;
    r[isSale(l) ? "sale" : "rent"]++;
    r.value += l.price ?? 0;
  }
  for (const l of pending) touch(listingAgentOf(l)).pending++;
  for (const l of draft) touch(listingAgentOf(l)).draft++;
  for (const r of brokers.values()) r.held = r.live + r.pending + r.draft;

  /**
   * Ranked on live stock, then on everything held.
   *
   * `held` is the tie-break rather than the rank itself, deliberately: a broker
   * with thirty drafts and nothing live has not put thirty listings on the
   * market. But every broker holding anything at all appears, which is why a
   * nil-live row is still a row.
   */
  const byStock = (a, b) => b.live - a.live || b.held - a.held
    || a.name.localeCompare(b.name);
  const all = [...brokers.values()];
  const people = all.filter((r) => !r.house).sort(byStock);
  const house = all.filter((r) => r.house).sort(byStock);

  const rows = [
    ...people.map((r, i) => ({ ...r, rank: i + 1, valueText: fmtAed(r.value) })),
    ...house.map((r) => ({ ...r, rank: null, valueText: fmtAed(r.value) })),
  ];

  const value = live.reduce((sum, l) => sum + (l.price ?? 0), 0);

  return {
    rows,
    totals: {
      live: live.length,
      pending: pending.length,
      draft: draft.length,
      held: live.length + pending.length + draft.length,
      brokers: people.length,
      rent: live.filter((l) => !isSale(l)).length,
      sale: live.filter(isSale).length,
      value,
      valueText: fmtAed(value),
    },
  };
}
