/**
 * Listings analytics — the derivations behind the Bayut tab.
 *
 * Pure. No transport, no Supabase, so it runs under `node --test`.
 *
 * WHAT THIS SCREEN IS. PropSpace is the source of truth for inventory: Bayut
 * publishes from that feed, and every one of the 314 live listings carries
 * `bayut` in its `portals` array, so live PropSpace stock IS our Bayut stock.
 * Bayut's own API contributes one thing only — engagement counts — and it is
 * left-joined on, never used to decide what exists.
 *
 * FIELD NAMES HERE WERE READ OFF THE LIVE PAYLOAD on 2026-08-21, not guessed,
 * and two of them are not what you would assume:
 *
 *   - Offering is `type`, which holds "sale" or "rent". `property_status` is a
 *     different axis entirely — Available / Rented / Off-Plan / Upcoming.
 *   - `category` is the property type (Apartment, Office, Villa …), not a
 *     residential/commercial split. That split has to be derived from it,
 *     which is what CATEGORY_CLASS below is for.
 */

/* ------------------------------- offering ------------------------------- */

export const OFFERINGS = ['sale', 'rent'];

/** "sale" or "rent", or null when the record carries neither. */
export const offeringOf = (l) => {
  const t = String(l?.type ?? '').toLowerCase();
  return OFFERINGS.includes(t) ? t : null;
};

/* ------------------------------- category ------------------------------- */

/**
 * Residential or commercial, derived from PropSpace's `category`.
 *
 * Listed explicitly in both directions rather than "commercial, else
 * residential". A default would quietly file any category nobody has seen yet
 * on one side of a headline number, and the whole point of the third bucket is
 * that an unrecognised type shows up as unclassified instead of inflating a
 * figure somebody is going to act on.
 *
 * The eight values live today are Apartment, Hotel Apartment, Land
 * Residential, Office, Penthouse, Retail, Townhouse and Villa. The rest of
 * each list is the remainder of PropSpace's vocabulary, included so a first
 * commercial warehouse does not land in "residential".
 */
const RESIDENTIAL = [
  'apartment', 'hotel apartment', 'villa', 'townhouse', 'penthouse', 'duplex',
  'land residential', 'compound', 'bungalow', 'full floor', 'half floor',
  'whole building', 'residential floor', 'residential building', 'villa compound',
];

const COMMERCIAL = [
  'office', 'retail', 'shop', 'warehouse', 'showroom', 'factory',
  'land commercial', 'business centre', 'business center', 'staff accommodation',
  'labour camp', 'commercial floor', 'commercial building', 'commercial villa',
];

export const CATEGORY_CLASSES = ['residential', 'commercial'];

export function categoryClassOf(l) {
  const c = String(l?.category ?? '').trim().toLowerCase();
  if (!c) return 'unclassified';
  if (RESIDENTIAL.includes(c)) return 'residential';
  if (COMMERCIAL.includes(c)) return 'commercial';
  return 'unclassified';
}

/* ------------------------------- off-plan ------------------------------- */

/**
 * `completion_status` is the flag, and it is the only one needed.
 *
 * Measured across the 314 live records: completion_status starting "off_plan"
 * marks 11 listings, and property_status === "Off-Plan" marks 6 — a strict
 * SUBSET of those 11, with nothing outside it. So property_status adds no
 * listing and would only introduce a second definition that disagrees with the
 * first on five records.
 */
export const isOffPlan = (l) =>
  String(l?.completion_status ?? '').toLowerCase().startsWith('off_plan');

export const completionStatusOf = (l) => l?.completion_status ?? null;

/* ------------------------------- location ------------------------------- */

/**
 * The community a listing sits in.
 *
 * area_location is the level people name — Business Bay, JLT, Dubai Marina.
 * sub_area_location is the specific tower and is far too granular to group by;
 * region is only ever the emirate.
 */
export const communityOf = (l) => l?.area_location?.name?.trim() || null;

export const regionOf = (l) => l?.region?.name?.trim() || null;

/* -------------------------------- broker -------------------------------- */

/**
 * Who a listing belongs to, by id and name.
 *
 * The id is the join key for crm_agents and the identity everywhere here.
 * Agent records at Aaronz get reassigned and their emails stripped, so the
 * email on a listing is not a stable identity and is deliberately never read.
 *
 * `marketing_agent` is null on the overwhelming majority of records, so `agent`
 * is the field to attribute on — the same conclusion listings.js reached.
 */
export function brokerOf(l) {
  const a = l?.agent ?? l?.marketing_agent ?? null;
  const id = a?.id ?? null;
  return {
    id: id == null ? null : String(id),
    name: a?.name?.trim() || 'Unassigned',
  };
}

/**
 * Does this broker appear in the ranking?
 *
 * Absence from crm_agents means broker — the table is a list of corrections,
 * not a roster, so an unclassified new joiner ranks rather than vanishing.
 * That is listings.js's rule and it is repeated rather than inverted here on
 * purpose: two modules disagreeing about who counts is worse than one being
 * slightly permissive.
 */
export const isRankedBroker = (brokerId, crmAgents) => {
  if (!crmAgents || brokerId == null) return true;
  return crmAgents.get(String(brokerId))?.inRanking ?? true;
};

export const brokerTypeOf = (brokerId, crmAgents) =>
  brokerId == null ? null : crmAgents?.get(String(brokerId))?.type ?? null;

/* ------------------------------ enrichment ------------------------------ */

export const VIEW_CHANNELS = ['whatsapp', 'sms', 'phone'];

/**
 * Roll Bayut's view rows up into one { whatsapp, sms, phone } per reference.
 *
 * `rows` is what bayut.js already normalises: each carries a channel, a count
 * and the listing it belongs to. Several rows can share a reference, so they
 * are summed rather than replaced.
 */
export function viewsByReference(rows) {
  const out = new Map();
  for (const r of rows ?? []) {
    const ref = r?.entity?.reference;
    if (!ref) continue;
    const key = String(ref).trim().toUpperCase();
    const e = out.get(key) ?? { whatsapp: 0, sms: 0, phone: 0, total: 0 };
    const n = Number(r.count) || 0;
    if (VIEW_CHANNELS.includes(r.channel)) e[r.channel] += n;
    e.total += n;
    out.set(key, e);
  }
  return out;
}

const ZERO = { whatsapp: 0, sms: 0, phone: 0, total: 0 };

/**
 * One analytics row per live listing.
 *
 * A LEFT join, always. A listing Bayut has no engagement row for shows zeroes
 * and stays in the table; dropping it would make the inventory count depend on
 * whether anyone happened to tap a phone number, which is not what "how many
 * listings do we have" means. Today that is most of them — 298 of 314 have no
 * Bayut view row at all.
 */
export function buildRows(listings, views, crmAgents) {
  return (listings ?? []).filter(Boolean).map((l) => {
    const broker = brokerOf(l);
    const ref = l?.ref ? String(l.ref).trim() : null;
    const v = (ref && views?.get(ref.toUpperCase())) || ZERO;

    return {
      id: l.id,
      ref,
      name: l.name ?? null,
      community: communityOf(l),
      region: regionOf(l),
      offering: offeringOf(l),
      categoryClass: categoryClassOf(l),
      category: l.category ?? null,
      offPlan: isOffPlan(l),
      completionStatus: completionStatusOf(l),
      price: Number(l.price) || 0,
      permit: l.permit_number ? String(l.permit_number) : null,
      beds: l.beds ?? null,
      size: Number(l.size) || null,
      brokerId: broker.id,
      broker: broker.name,
      ranked: isRankedBroker(broker.id, crmAgents),
      brokerType: brokerTypeOf(broker.id, crmAgents),
      whatsapp: v.whatsapp,
      sms: v.sms,
      phone: v.phone,
      views: v.total,
      createdAt: l.created_at ?? null,
    };
  });
}

/* -------------------------------- filters ------------------------------- */

export const BLANK_FILTERS = {
  offering: '', categoryClass: '', broker: '', community: '',
  offPlan: '', priceFrom: '', priceTo: '',
};

/**
 * The one filter function.
 *
 * Every number on the screen is computed from ITS RESULT and nothing else —
 * the cards, the leaderboard and the table all read the same array. That is
 * what makes "the cards equal the table" true by construction rather than by
 * three separate filter implementations happening to agree.
 */
export function applyFilters(rows, f = BLANK_FILTERS) {
  const from = f.priceFrom === '' ? null : Number(f.priceFrom);
  const to = f.priceTo === '' ? null : Number(f.priceTo);

  return (rows ?? []).filter((r) => {
    if (f.offering && r.offering !== f.offering) return false;
    if (f.categoryClass && r.categoryClass !== f.categoryClass) return false;
    if (f.broker && r.brokerId !== f.broker) return false;
    if (f.community && r.community !== f.community) return false;
    if (f.offPlan === 'yes' && !r.offPlan) return false;
    if (f.offPlan === 'no' && r.offPlan) return false;
    if (from !== null && Number.isFinite(from) && r.price < from) return false;
    if (to !== null && Number.isFinite(to) && r.price > to) return false;
    return true;
  });
}

/* ------------------------------- summaries ------------------------------ */

/**
 * The summary cards, from the filtered rows.
 *
 * Every count here is a length of a subset of `rows`, so each card equals the
 * number of table lines you would see if you also applied that card's own
 * split. `unclassified` is carried so residential + commercial + unclassified
 * always equals total — a card that does not add up is how a taxonomy gap
 * hides.
 */
export function summarise(rows) {
  const r = rows ?? [];
  const count = (fn) => r.filter(fn).length;

  return {
    total: r.length,
    sale: count((x) => x.offering === 'sale'),
    rent: count((x) => x.offering === 'rent'),
    noOffering: count((x) => x.offering === null),
    residential: count((x) => x.categoryClass === 'residential'),
    commercial: count((x) => x.categoryClass === 'commercial'),
    unclassified: count((x) => x.categoryClass === 'unclassified'),
    offPlan: count((x) => x.offPlan),
    whatsapp: r.reduce((s, x) => s + x.whatsapp, 0),
    sms: r.reduce((s, x) => s + x.sms, 0),
    phone: r.reduce((s, x) => s + x.phone, 0),
    views: r.reduce((s, x) => s + x.views, 0),
    withViews: count((x) => x.views > 0),
  };
}

/**
 * The broker leaderboard, from the same filtered rows.
 *
 * Un-ranked agents are held back into a single reconciliation row rather than
 * dropped, so the column still sums to the headline. Same arrangement the
 * Brokers tab uses, for the same reason: a table that quietly totals less than
 * the card above it makes both numbers untrustworthy.
 */
export function leaderboard(rows) {
  const m = new Map();

  for (const r of rows ?? []) {
    const key = r.brokerId ?? `name:${r.broker}`;
    const e = m.get(key) ?? {
      id: r.brokerId, name: r.broker, ranked: r.ranked, type: r.brokerType,
      total: 0, sale: 0, rent: 0, residential: 0, commercial: 0,
      offPlan: 0, whatsapp: 0, sms: 0, phone: 0, views: 0,
    };
    e.total++;
    if (r.offering === 'sale') e.sale++;
    if (r.offering === 'rent') e.rent++;
    if (r.categoryClass === 'residential') e.residential++;
    if (r.categoryClass === 'commercial') e.commercial++;
    if (r.offPlan) e.offPlan++;
    e.whatsapp += r.whatsapp;
    e.sms += r.sms;
    e.phone += r.phone;
    e.views += r.views;
    m.set(key, e);
  }

  const all = [...m.values()];
  const ranked = all.filter((b) => b.ranked).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  const held = all.filter((b) => !b.ranked);

  const remainder = held.length
    ? held.reduce((acc, b) => ({
        ...acc,
        total: acc.total + b.total,
        sale: acc.sale + b.sale,
        rent: acc.rent + b.rent,
        residential: acc.residential + b.residential,
        commercial: acc.commercial + b.commercial,
        offPlan: acc.offPlan + b.offPlan,
        whatsapp: acc.whatsapp + b.whatsapp,
        sms: acc.sms + b.sms,
        phone: acc.phone + b.phone,
        views: acc.views + b.views,
        people: acc.people + 1,
        types: b.type && !acc.types.includes(b.type) ? [...acc.types, b.type] : acc.types,
      }), {
        id: null, name: 'Not in broker ranking', ranked: false, people: 0, types: [],
        total: 0, sale: 0, rent: 0, residential: 0, commercial: 0,
        offPlan: 0, whatsapp: 0, sms: 0, phone: 0, views: 0,
      })
    : null;

  return { ranked, remainder };
}

/* -------------------------------- sorting ------------------------------- */

/**
 * Sort by any column, nulls last regardless of direction.
 *
 * Nulls last both ways because a missing permit number or an unpriced listing
 * is not "the smallest" — parking it at the top of an ascending sort buries
 * the rows somebody is actually looking for.
 */
export function sortRows(rows, key, dir = 'desc') {
  const sign = dir === 'asc' ? 1 : -1;
  return [...(rows ?? [])].sort((a, b) => {
    const x = a[key];
    const y = b[key];
    const xn = x === null || x === undefined || x === '';
    const yn = y === null || y === undefined || y === '';
    if (xn && yn) return 0;
    if (xn) return 1;
    if (yn) return -1;
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * sign;
    if (typeof x === 'boolean' && typeof y === 'boolean') return (Number(x) - Number(y)) * sign;
    return String(x).localeCompare(String(y)) * sign;
  });
}

/** Distinct values for a filter dropdown, sorted, blanks dropped. */
export const optionsFor = (rows, pick) =>
  [...new Set((rows ?? []).map(pick).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));

/* ------------------------------ formatting ------------------------------ */

export const fmtNum = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString() : '—');

export function fmtAed(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '—';
  if (v >= 1_000_000) return `AED ${(v / 1_000_000).toFixed(v >= 10_000_000 ? 1 : 2)}m`;
  if (v >= 1_000) return `AED ${Math.round(v / 1000)}k`;
  return `AED ${Math.round(v)}`;
}
