/**
 * The publication ledger — what went live, when, and on which portal.
 *
 * Pure. No transport, so it runs under `node --test`.
 *
 * THE DISTINCTION THIS WHOLE MODULE EXISTS TO ENFORCE. There are two questions
 * that look similar and are not:
 *
 *   "how many listings went live in August"   a past event. Fixed forever.
 *   "how many listings are live right now"    current state. Changes hourly.
 *
 * The monthly report answers the first and must therefore never be computed
 * from PropSpace's current state. Derived that way, a listing taken down in
 * October leaves August — and a listing deleted from the CRM leaves every month
 * at once. That is what was wrong: the figures were not being displayed
 * incorrectly, they were being *derived* from a source that forgets.
 *
 * So monthly counts read the ledger and nothing else. `monthlyCounts` takes no
 * listings argument at all, which is not an oversight — it is the guarantee,
 * expressed in a signature. There is a test that deletes a listing from the
 * feed entirely and asserts the month is unchanged.
 */

import { dubaiMonth } from './time.js';

/* ------------------------------ what is live ------------------------------ */

/**
 * The statuses that mean a listing reached a portal.
 *
 * `published` is live now. `unpublished` is the state a listing lands in after
 * being taken down, so it went live at some point — an inference, but the
 * established one in this codebase (see WENT_LIVE in listings.js) and the only
 * reading that makes historical months non-empty.
 *
 * `draft` never reached a portal. `pending_approval` has been submitted and is
 * waiting, which is not the same as accepted — counting it would report
 * listings as live that a portal may yet reject.
 */
export const LIVE_NOW = ['published'];
export const REACHED_PORTAL = ['published', 'unpublished'];
export const NEVER_LIVE = ['draft', 'pending_approval'];

/** PropSpace exposes exactly these four. There is no rejected/expired state. */
export const ALL_STATUSES = ['published', 'unpublished', 'draft', 'pending_approval'];

const clean = (v) => {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  return t || null;
};

/* --------------------------- deriving candidates -------------------------- */

/**
 * Turn observed listings into candidate ledger rows: one per listing per portal.
 *
 * `at` is what went_live_at becomes for observed rows — the moment the sync saw
 * it, which is accurate to the sync interval. It is NOT the listing's
 * created_at, and that difference matters: a listing drafted in June and
 * published in August has a June created_at, and dating its publication from
 * that would file an August go-live under June.
 *
 * Backfill is the exception and says so. Seeding the ledger from listings that
 * were already live before it existed can only use created_at, because
 * PropSpace records no publication date anywhere — verified against the live
 * account: the payload carries created_at and updated_at and nothing else.
 */
export function publicationEvents(listings, { at, source = 'observed' } = {}) {
  const stamp = at instanceof Date ? at.toISOString() : at;
  const out = [];

  for (const l of listings ?? []) {
    if (!l) continue;
    if (!REACHED_PORTAL.includes(String(l.status ?? '').toLowerCase())) continue;

    const ref = clean(l.ref);
    if (!ref) continue;

    const portals = Array.isArray(l.portals) ? l.portals.filter(Boolean) : [];
    if (!portals.length) continue;

    // Backfilled rows can only be dated from creation; observed rows are dated
    // from the observation, which is the whole accuracy difference between them.
    const wentLiveAt = source === 'backfill' ? clean(l.created_at) : stamp;
    if (!wentLiveAt) continue;

    const agent = l.agent ?? l.marketing_agent ?? null;

    for (const portal of portals) {
      out.push({
        listingRef: ref,
        listingId: l.id === undefined || l.id === null ? null : String(l.id),
        portal: String(portal),
        wentLiveAt,
        wentLiveSource: source,
        // Frozen as at publication. Never re-read from the listing later.
        brokerId: agent?.id === undefined || agent?.id === null ? null : String(agent.id),
        brokerName: clean(agent?.name) ?? 'Unassigned',
        offering: clean(l.type),
        category: clean(l.category),
        categoryClass: null,      // filled by the caller, which owns the mapping
        community: clean(l.area_location?.name),
        region: clean(l.region?.name),
        price: Number(l.price) || null,
      });
    }
  }
  return out;
}

/**
 * Which candidates are not already in the ledger.
 *
 * The database's unique constraint is the real guarantee — this only avoids
 * sending writes that would be discarded. Keyed on reference + portal, which is
 * the counting rule: a listing relisted under the same reference does not
 * increment a second month.
 */
export function newEvents(candidates, existingKeys) {
  const seen = new Set(existingKeys ?? []);
  const out = [];
  for (const c of candidates ?? []) {
    const key = ledgerKey(c.listingRef, c.portal);
    if (seen.has(key)) continue;
    seen.add(key);          // also dedupes within one batch
    out.push(c);
  }
  return out;
}

export const ledgerKey = (ref, portal) =>
  `${String(ref ?? '').trim().toUpperCase()}|${String(portal ?? '').trim().toLowerCase()}`;

/* -------------------------------- reporting ------------------------------- */

/**
 * Monthly publication counts, by portal.
 *
 * TAKES ONLY LEDGER ROWS. No listings, no current state, nothing that can
 * change after the fact. This signature is the immutability guarantee.
 *
 * `months` bounds the output so a chart has a dense axis; rows outside it are
 * counted in `outside` rather than dropped silently.
 */
export function monthlyCounts(ledger, { months = null } = {}) {
  const byMonth = new Map();
  const portals = new Set();
  let outside = 0;

  for (const r of ledger ?? []) {
    if (!r?.wentLiveAt) continue;
    const m = dubaiMonth(r.wentLiveAt);
    if (months && !months.includes(m)) { outside++; continue; }
    portals.add(r.portal);

    const e = byMonth.get(m) ?? { month: m, total: 0, byPortal: {} };
    e.total++;
    e.byPortal[r.portal] = (e.byPortal[r.portal] ?? 0) + 1;
    byMonth.set(m, e);
  }

  const list = (months ?? [...byMonth.keys()].sort()).map(
    (m) => byMonth.get(m) ?? { month: m, total: 0, byPortal: {} }
  );

  return { months: list, portals: [...portals].sort(), outside };
}

/** The month currently in progress, which is never a complete figure. */
export const currentMonth = (now = new Date()) => dubaiMonth(now);

/**
 * Group ledger rows by any attribute recorded AT PUBLICATION.
 *
 * Broker especially: attribution comes from the row, never from the listing's
 * present owner. Listings get reassigned, and a report that re-reads ownership
 * moves a past month's credit between people long after the fact.
 */
export function ledgerBreakdown(ledger, keyOf, labelOf = (k) => k) {
  const m = new Map();
  for (const r of ledger ?? []) {
    const key = keyOf(r);
    if (key === null || key === undefined || key === '') continue;
    const e = m.get(key) ?? { key, label: labelOf(key), count: 0, portals: {} };
    e.count++;
    e.portals[r.portal] = (e.portals[r.portal] ?? 0) + 1;
    m.set(key, e);
  }
  return [...m.values()].sort((a, b) => b.count - a.count || String(a.label).localeCompare(String(b.label)));
}

/**
 * The earliest month whose figure can be trusted as a real observation.
 *
 * Everything before the first sync run is backfilled from created_at and is
 * approximate in two ways at once: the date is CRM creation rather than
 * go-live, and the set is only what still existed at seed time — anything
 * published and deleted before then is unrecoverable and those months are
 * therefore undercounts. The UI says so rather than presenting one continuous
 * line of equally solid numbers.
 */
export function trustedFrom(syncRuns) {
  const first = (syncRuns ?? [])
    .filter((r) => r?.mode === 'sync' && r?.ran_at)
    .map((r) => new Date(r.ran_at))
    .filter((d) => !Number.isNaN(d.getTime()))
    .sort((a, b) => a - b)[0];
  return first ? { at: first.toISOString(), month: dubaiMonth(first) } : null;
}

/** Is this month's figure still accumulating? */
export const isPartial = (month, now = new Date()) => month === currentMonth(now);

/** Is this month before the ledger became a real observation? */
export const isApproximate = (month, trusted) => !trusted || month < trusted.month;

/* ------------------ the month x broker grid, from the ledger --------------- */

/** Same house-account rule as listings.js, restated here to keep this pure. */
const HOUSE = [/aaronz and co/i, /^marketing/i, /real estate llc/i];
export const isHouseName = (name) => HOUSE.some((re) => re.test(name ?? ''));

/**
 * One row per reference — its FIRST publication, across every portal.
 *
 * The counting rule the tab needs: a listing counts once, in the month it went
 * live, no matter how many portals carried it and no matter how often it was
 * edited or repriced afterwards. The ledger holds a row per listing per portal,
 * so this collapses them to the earliest.
 */
export function firstPublicationPerRef(ledger) {
  const first = new Map();
  for (const r of ledger ?? []) {
    if (!r?.listingRef || !r?.wentLiveAt) continue;
    const key = String(r.listingRef).trim().toUpperCase();
    const prev = first.get(key);
    if (!prev || new Date(r.wentLiveAt) < new Date(prev.wentLiveAt)) first.set(key, r);
  }
  return [...first.values()];
}

/**
 * The month x broker grid, counted on PUBLICATION rather than record creation.
 *
 * WHY THIS TAKES LEDGER ROWS AND NOT LISTINGS. The grid used to bucket on
 * `created_at`, which is when a record was typed into the CRM — data entry, not
 * publication. A listing can be created in June and go live in August, or never
 * go live at all, and both were counted as June's work.
 *
 * PropSpace has no publication date to switch to instead. That is not an
 * assumption: asked to sort by one, the API itself answers "sort_by must be one
 * of the following values: ref, updated_at, price, created_at, beds, size".
 * Two date fields exist and neither is a go-live. So the date comes from the
 * publication ledger, which records when a listing was observed live and never
 * rewrites the row afterwards — which is what makes these months fixed.
 *
 * Broker is the one frozen on the ledger row at publication, never the
 * listing's present owner, so a reassignment cannot move a past month's credit.
 */
export function publishedByMonth(ledger, months) {
  const agents = new Map();
  const counted = [];

  for (const r of firstPublicationPerRef(ledger)) {
    const m = dubaiMonth(r.wentLiveAt);
    if (months && !months.includes(m)) continue;
    counted.push(r);

    const name = r.brokerName || 'Unassigned';
    if (!agents.has(name)) {
      agents.set(name, {
        name,
        house: isHouseName(name),
        months: Object.fromEntries((months ?? []).map((k) => [k, { fresh: 0, relist: 0 }])),
        total: 0,
        relists: 0,
      });
    }
    const row = agents.get(name);
    if (!row.months[m]) row.months[m] = { fresh: 0, relist: 0 };
    // Every counted row is a first publication by construction — the dedupe
    // above already removed second appearances, so nothing here is a relist.
    row.months[m].fresh++;
    row.total++;
  }

  return {
    months: months ?? [],
    rows: [...agents.values()].sort((a, b) => b.total - a.total),
    totals: Object.fromEntries(
      (months ?? []).map((m) => [m, [...agents.values()].reduce((s, r) => s + (r.months[m]?.fresh ?? 0), 0)])
    ),
    // Exactly what was counted, so a drill-through lists the same set.
    counted,
  };
}
