/**
 * The pure half of truCheckSource.js — turning crawl records into snapshot rows.
 *
 * Extracted so it can run under `node --test`: truCheckSource.js imports the
 * Supabase client, which needs import.meta.env and throws outside a bundler.
 * truCheckSource.js re-exports from here, so there is one implementation.
 *
 * TWO RECORD SHAPES ARRIVE HERE, from the two stages of the crawl.
 *
 * The enumerate stage lists every listing the agency has on Bayut. It is cheap
 * and thin: reference, URL, agent, price, and isVerified. It has no photo
 * counts, no floor plan, no scores.
 *
 * The detail stage reads one listing page and returns Bayut's own Algolia hit,
 * which carries everything — photoCount, videoCount, panoramaCount,
 * floorPlanID, amenities, verification{trucheckedAt}, and several internal
 * scores. It costs per listing.
 *
 * Both normalise to the same row so the model above never has to know which
 * stage a field came from. `detailed` records which stage produced it, because
 * a zero photoCount from an enumerate-only row means "not crawled" and a zero
 * from a detail row means "no photos", and the score must not confuse them.
 *
 * FIELD NAMES ARE FROM LIVE RECORDS captured 2026-08-21, not from docs.
 */

const clean = (v) => {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  return !t || t === 'null' || t === 'None' ? null : t;
};

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const int = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};

/**
 * Bayut stamps are UNIX seconds; Postgres hands back ISO strings. Both arrive
 * here depending on whether a row is fresh off a crawl or read from a snapshot.
 */
export function toIso(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return new Date(v * 1000).toISOString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * The community, from either shape of location.
 *
 * The detail record gives an array of levels — UAE, Dubai, Al Furjan, tower.
 * The enumerate record gives the same hierarchy joined with semicolons, but in
 * the OPPOSITE order: "Icon Tower 2; JLT Cluster L; Jumeirah Lake Towers (JLT);
 * Dubai; UAE". So each is read from its own end rather than by index.
 */
export function communityOfCrawl(location) {
  if (Array.isArray(location)) {
    // Ascending levels: 0 country, 1 emirate, 2 community, 3+ cluster/tower.
    const named = location.filter((l) => clean(l?.name));
    return clean(named[2]?.name) ?? clean(named[named.length - 1]?.name);
  }
  const parts = String(location ?? '').split(';').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  // Descending: …tower; cluster; COMMUNITY; emirate; country.
  return parts.length >= 3 ? parts[parts.length - 3] : parts[0];
}

/** Residential or commercial, from either shape of category. */
export function classOfCrawl(category) {
  const first = Array.isArray(category)
    ? clean(category.find((c) => c?.level === 0)?.name) ?? clean(category[0]?.name)
    : String(category ?? '').split(';')[0]?.trim();
  const t = String(first ?? '').toLowerCase();
  if (t.startsWith('residential')) return 'residential';
  if (t.startsWith('commercial')) return 'commercial';
  return null;
}

/** Amenities arrive as an array on detail records and a joined string on thin ones. */
export function amenityCountOf(amenities) {
  if (Array.isArray(amenities)) return amenities.filter(Boolean).length;
  const t = clean(amenities);
  return t ? t.split(';').map((s) => s.trim()).filter(Boolean).length : 0;
}

/**
 * Does this listing carry a floor plan?
 *
 * Three fields answer it and they do not always agree: floorPlanID is the
 * attached plan, hasUnitPlan is Bayut's own flag, and hasMatchingFloorPlans
 * means a plan exists for the unit type even if this listing has not attached
 * one. Any of the first two counts; the third deliberately does not, because a
 * plan that exists elsewhere is not a plan on this listing, and the whole point
 * of the factor is telling an agent what to go and attach.
 */
export const hasFloorPlanOf = (item) =>
  Boolean(clean(item?.floorPlanID)) || item?.hasUnitPlan === true;

/**
 * Bayut's own numbers, captured raw and never interpreted.
 *
 * Nobody outside Bayut knows what these weigh, so they are carried through
 * untouched and displayed as theirs. trucheckedScore and verifiedScore are
 * excluded on purpose: both hold a UNIX timestamp rather than a score, which is
 * obvious once you see 1783517008 sitting in a column of two-digit numbers.
 */
export function nativeScoresOf(item) {
  const pick = (k) => (item?.[k] === undefined || item?.[k] === null ? null : num(item[k]));
  const out = {
    score: pick('score'),
    indyScore: pick('indyScore'),
    productScore: pick('productScore'),
    truBrokerScore: pick('truBrokerScore'),
  };
  return Object.values(out).some((v) => v !== null) ? out : null;
}

/**
 * One crawl record -> one snapshot row.
 *
 * `detailed` is true when the record came from the detail stage. Everything
 * that only the detail stage can know is left null otherwise, rather than
 * defaulted to zero — see the note at the top of this file.
 */
export function normaliseCrawlItem(item, { detailed = false } = {}) {
  const verification = item?.verification ?? null;
  const agent = item?.ownerAgent ?? null;

  return {
    reference: clean(item?.referenceNumber),
    // Bayut publishes no RERA permit anywhere in the listing payload —
    // extraFields carries dldPropertySK and dldBuildingNK and nothing else.
    // Kept so a future official endpoint can fill it without a schema change.
    permit: clean(item?.permitNumber) ?? null,
    bayutListingId: clean(item?.externalID),
    url:
      clean(item?.url) ??
      (clean(item?.externalID)
        ? `https://www.bayut.com/property/details-${clean(item.externalID)}.html`
        : null),

    isTruCheck: item?.isVerified === true,
    truCheckedAt: toIso(verification?.trucheckedAt ?? null),
    verificationStatus: clean(verification?.status),
    // Bayut's "Checked" badge. Only the detail stage carries it.
    checked: typeof verification?.eligible === 'boolean' ? verification.eligible : null,

    title: clean(item?.title),
    price: num(item?.price),
    community: communityOfCrawl(item?.location),
    purpose: clean(item?.purpose),
    categoryClass: classOfCrawl(item?.category),
    beds: item?.rooms === undefined ? null : int(item?.rooms),
    baths: item?.baths === undefined ? null : int(item?.baths),
    size: num(item?.area),
    agentName: clean(item?.agentName) ?? clean(agent?.name),
    agentBayutId: clean(agent?.externalID),
    state: clean(item?.state),

    // Quality signals. Null rather than 0 when the stage could not know them.
    detailed,
    photoCount: detailed ? int(item?.photoCount) : null,
    videoCount: detailed ? int(item?.videoCount) : null,
    panoramaCount: detailed ? int(item?.panoramaCount) : null,
    hasFloorPlan: detailed ? hasFloorPlanOf(item) : null,
    amenityCount: detailed || item?.amenities !== undefined ? amenityCountOf(item?.amenities) : null,

    nativeScores: detailed ? nativeScoresOf(item) : null,
  };
}

/**
 * Fold the detail pass onto the enumerate pass.
 *
 * Enumeration decides WHICH listings exist — it is the pass that saw the
 * company page — so a detail record for something not enumerated is ignored
 * rather than added. Detail values win field by field where they are not null,
 * so a listing whose detail fetch failed keeps its thin row and is reported as
 * undetailed rather than vanishing from the count.
 */
export function mergeCrawl(enumerated, details) {
  const byKey = new Map();
  const keyOf = (r) => (r.bayutListingId ? `id:${r.bayutListingId}` : r.reference ? `ref:${String(r.reference).toUpperCase()}` : null);

  for (const r of enumerated ?? []) {
    const k = keyOf(r);
    if (k) byKey.set(k, r);
  }

  for (const d of details ?? []) {
    const k = keyOf(d);
    if (!k || !byKey.has(k)) continue;
    const base = byKey.get(k);
    const merged = { ...base };
    for (const [field, value] of Object.entries(d)) {
      if (value !== null && value !== undefined) merged[field] = value;
    }
    merged.detailed = true;
    byKey.set(k, merged);
  }

  return [...byKey.values()];
}

/* ------------------------- resolving across two runs ---------------------- */

/**
 * Which fields may only ever come from a run that actually read the listing
 * pages. Everything NOT in this set comes from the newest run of either kind.
 *
 * The split is the whole point of the two-speed refresh. A nightly enumerate
 * knows every listing and its badge, and knows nothing about photo counts —
 * so if it were allowed to write these fields, running it would silently blank
 * the quality columns and drop every score to nothing. The columns would read
 * as "these listings have no photos" the morning after a cheap refresh, which
 * is worse than stale data because it looks like a finding.
 */
export const QUALITY_FIELDS = [
  'detailed',
  'photoCount',
  'videoCount',
  'panoramaCount',
  'hasFloorPlan',
  'amenityCount',
  'nativeScores',
  'score',
  'factors',
  // The TruCheck DATE and the Checked badge, unlike the TruCheck status itself,
  // exist only on the detail record. Status comes from the newest run; when it
  // was checked comes from the newest detailed one.
  'truCheckedAt',
  'checked',
  'verificationStatus',
];

/** A listing's identity across runs. Bayut's id first; reference as fallback. */
export const listingKey = (r) =>
  r?.bayutListingId
    ? `id:${r.bayutListingId}`
    : r?.reference
      ? `ref:${String(r.reference).trim().toUpperCase()}`
      : null;

/**
 * Resolve one view of the world from two runs.
 *
 * `base` is the newest run of any kind and is the authority on WHAT EXISTS:
 * every listing on the account, its badge, its price, its agent. `quality` is
 * the newest run that actually read the listing pages, and contributes only
 * QUALITY_FIELDS.
 *
 * Three rules, and each exists because the obvious alternative is wrong:
 *
 *   A listing in `base` with no `quality` row keeps its badge and gets NULL
 *   quality — not zero. It has never been detailed, or it was added after the
 *   last full crawl. Zero would say "no photos"; null says "not measured", and
 *   only one of those is true.
 *
 *   A listing in `quality` but not in `base` is DROPPED. It has left the
 *   account since the last full crawl, and carrying it forward on the strength
 *   of old quality data would report a listing that is no longer there.
 *
 *   Quality fields are taken wholesale, not merged field by field. Photo count
 *   and floor plan and score come from one moment in time; mixing fields from
 *   different runs would produce a row that never existed.
 */
export function resolveSnapshot(base, quality) {
  const byKey = new Map();
  for (const r of quality ?? []) {
    const k = listingKey(r);
    if (k) byKey.set(k, r);
  }

  return (base ?? []).map((r) => {
    const k = listingKey(r);
    const q = k ? byKey.get(k) : null;

    // Start from the base row with every quality field cleared, so nothing
    // leaks through from an enumerate row that happens to carry a default.
    const out = { ...r };
    for (const f of QUALITY_FIELDS) out[f] = null;
    out.detailed = false;
    out.factors = [];

    if (q) {
      for (const f of QUALITY_FIELDS) {
        if (q[f] !== undefined) out[f] = q[f];
      }
      out.detailed = q.detailed === true;
      out.factors = q.factors ?? [];
    }

    // True when this listing is in the newest run but the newest detailed run
    // never saw it — the state rule 4 asks to mark rather than hide.
    out.awaitingDetail = !q;
    return out;
  });
}
