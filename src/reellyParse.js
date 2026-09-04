/**
 * Reelly parsing and the filter matrix — every pure function behind the
 * off-plan project catalogue.
 *
 * Split from reelly.js so it runs under `node --test` with no browser and no
 * network, the same way metaParse.js and bayutParse.js are split.
 *
 * WHY THERE IS A FILTER MATRIX IN HERE AT ALL. Reelly's own docs warn: "Only
 * some filters are currently active on the backend. Others are declared but do
 * not affect the output yet — the API returns the full dataset regardless of
 * the parameter value." An inactive filter does not error and does not come
 * back empty; it returns everything, which on screen is indistinguishable from
 * a filter that matched everything. So FILTERS below records what was MEASURED
 * against the live API on 2026-08-21, not what the docs claim, and the UI is
 * built from the measurements. Anything not proven active is not offered.
 */

/* ------------------------------ the matrix ------------------------------ */

/**
 * What was measured, against a 49-project UAE dataset.
 *
 * The method for each: send a value that must narrow the set, and a value that
 * cannot match anything. An active filter changes the count for the first and
 * returns 0 for the second. A dead one returns 49 either way.
 */
export const FILTERS = {
  search_query:          { active: true,  note: 'palm -> 2, Emaar -> 1, nonsense -> 0' },
  sale_status:           { active: true,  note: 'on_sale 46 + out_of_stock 3 = 49' },
  status:                { active: true,  note: 'completed 5 + under_construction 44 = 49' },
  unit_bedrooms:         { active: true,  note: '1 -> 29, 2 -> 36, 3 -> 24, 99 -> 0' },
  unit_price_from:       { active: true,  note: '5m -> 19, 999m -> 0' },
  unit_price_to:         { active: true,  note: '1m -> 9' },
  unit_area_from:        { active: true,  note: '5000 sqft -> 10' },
  unit_area_to:          { active: true,  note: '400 sqft -> 4' },
  unit_types:            { active: true,  note: 'Apartments 43, Penthouse 6, Townhouse 1' },
  has_escrow:            { active: true,  note: 'true 36 + false 13 = 49' },
  post_handover:         { active: true,  note: 'true 14 + false 35 = 49' },
  region:                { active: true,  note: 'Dubai -> 38, Bogusland -> 0' },
  country:               { active: true,  note: 'Thailand -> 0' },
  project_ids:           { active: true,  note: 'single id -> 1' },
  completion_date_ranges:{ active: true,  note: 'UNIX seconds; 2027 -> 19, Q4 2027 -> 7' },

  // Dead. Every value returns the full 49, including deliberate nonsense —
  // the exact failure the docs warn about. unit_bedrooms does the same job.
  bedrooms:              { active: false, note: '1, 2 and 99 all return the full 49' },

  // Broken rather than merely inactive: returns 0 for every value, including
  // "Q4 2027", a label that is present on seven projects in the data. The
  // quarter control in the UI is built on completion_date_ranges instead.
  completion_quarters:   { active: false, note: '0 for every value, even labels present in the data' },

  // Unverified, so not offered. Every id tried returned 0, including the
  // location id off a project's own record — the parameter evidently wants a
  // district id from a metadata endpoint this proxy does not expose.
  districts:             { active: false, note: 'no id tried returned a result' },
};

/** Ordering keys that actually reorder the result set. */
export const ORDERINGS = [
  ['-updated_at', 'Recently updated'],
  ['min_price', 'Price, low to high'],
  ['-min_price', 'Price, high to low'],
  ['name', 'Name, A–Z'],
  ['-name', 'Name, Z–A'],
];

/**
 * Deliberately absent from ORDERINGS: completion_date, completion_datetime and
 * units_count. All three return the identical order to a deliberately bogus
 * key, i.e. the API ignores them and falls back to its default. A "sort by
 * completion" control that silently does nothing is worse than no control.
 */
export const DEAD_ORDERINGS = ['completion_date', 'completion_datetime', 'units_count'];

/**
 * Sale statuses that exist in the data. The API also accepts announced,
 * presale and start_of_sales; all three return zero projects, so offering them
 * would be three dropdown entries that always empty the screen.
 */
export const SALE_STATUSES = [
  ['on_sale', 'On Sale'],
  ['out_of_stock', 'Out of Stock'],
];

export const CONSTRUCTION_STATUSES = [
  ['under_construction', 'Under Construction'],
  ['completed', 'Completed'],
];

/** Unit types present in this dataset. "Villa" is documented but matches none. */
export const UNIT_TYPES = ['Apartments', 'Duplex', 'Penthouse', 'Townhouse'];

export const PAGE_SIZE = 24;

/* ------------------------------- quarters ------------------------------- */

/**
 * A completion quarter, expressed as the UNIX-seconds range the API accepts.
 *
 * completion_quarters is the parameter built for this and it does not work, so
 * the same question is asked with completion_date_ranges, which does. Verified
 * against the live API: Q4 2027 as a range returns 7 projects, matching the
 * seven carrying that label.
 *
 * Seconds, UTC, end-inclusive to the last second of the quarter.
 */
export function quarterRange(year, quarter) {
  const startMonth = (quarter - 1) * 3;
  const start = Date.UTC(year, startMonth, 1, 0, 0, 0);
  const end = Date.UTC(year, startMonth + 3, 1, 0, 0, 0) - 1000;
  return `${Math.floor(start / 1000)}-${Math.floor(end / 1000)}`;
}

export const quarterLabel = (year, quarter) => `Q${quarter} ${year}`;

/**
 * The quarters offered in the picker: one year behind to four years ahead.
 *
 * A fixed span rather than one derived from the data, because the options have
 * to exist before the first request is made. The window covers everything in
 * the current dataset that a buyer would ask about — handovers run to 2029 —
 * without a dropdown of every quarter since 2017.
 */
export function quarterOptions(now = new Date()) {
  const y = now.getUTCFullYear();
  const q = Math.floor(now.getUTCMonth() / 3) + 1;
  const out = [];
  for (let i = -4; i <= 16; i++) {
    const abs = (y * 4 + (q - 1)) + i;
    const year = Math.floor(abs / 4);
    const quarter = (abs % 4) + 1;
    out.push({ value: quarterRange(year, quarter), label: quarterLabel(year, quarter) });
  }
  return out;
}

/* ------------------------------ normalising ----------------------------- */

const clean = (v) => {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  return !t || t === 'null' || t === 'None' ? null : t;
};

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * One row of the catalogue grid.
 *
 * Only the list-endpoint fields are read here. Payment plans, escrow and
 * post-handover exist only on the details endpoint, so a card must never
 * pretend to know them — see normaliseDetail.
 */
export function normaliseProject(row) {
  const loc = row?.location ?? {};
  return {
    id: row?.id ?? null,
    slug: clean(row?.slug_name),
    name: clean(row?.name) ?? 'Untitled project',
    developer: clean(row?.developer),

    constructionStatus: clean(row?.construction_status),
    constructionStatusLabel: clean(row?.construction_status_display),
    saleStatus: clean(row?.sale_status),
    saleStatusLabel: clean(row?.sale_status_display),

    // A list on live responses, despite reading like a single label.
    unitTypes: Array.isArray(row?.available_unit_types_display)
      ? row.available_unit_types_display.filter(Boolean)
      : [clean(row?.available_unit_types_display)].filter(Boolean),

    blurb: clean(row?.short_description),
    completionLabel: clean(row?.completion_date),
    completionAt: clean(row?.completion_datetime),

    minPrice: num(row?.min_price),
    maxPrice: num(row?.max_price),
    currency: clean(row?.price_currency) ?? 'AED',
    minSize: num(row?.min_size),
    maxSize: num(row?.max_size),
    areaUnit: clean(row?.area_unit) ?? 'sqft',

    unitsCount: num(row?.units_count),
    buildingCount: num(row?.building_count),

    region: clean(loc.region),
    district: clean(loc.district),
    sector: clean(loc.sector),

    cover: clean(row?.cover_image?.url),
    updatedAt: clean(row?.updated_at),
  };
}

/**
 * The detail view.
 *
 * Built on top of the list shape, then the fields that exist only here. The
 * docs are wrong about several of these — `developer` is a plain string, not
 * `{ id, name }`, and typical_units carries from_price_aed / from_size_sqft
 * rather than the documented min_price / unit_type — so this follows the live
 * payload, and everything is optional because two projects in the set carry
 * null for nearly all of it.
 */
export function normaliseDetail(row) {
  const base = normaliseProject(row);
  return {
    ...base,
    overview: clean(row?.overview),
    escrowNumber: clean(row?.escrow_number),
    postHandover: typeof row?.post_handover === 'boolean' ? row.post_handover : null,
    serviceCharge: clean(row?.service_charge),
    readiness: num(row?.readiness_progress),
    furnishing: clean(row?.furnishing_display) ?? clean(row?.furnishing),
    brochure: clean(row?.marketing_brochure),

    amenities: (Array.isArray(row?.project_amenities) ? row.project_amenities : [])
      .map((a) => clean(a?.amenity?.name))
      .filter(Boolean),

    paymentPlans: (Array.isArray(row?.payment_plans) ? row.payment_plans : []).map((p) => ({
      id: p?.id ?? null,
      name: clean(p?.name) ?? 'Payment plan',
      months: num(p?.duration_months),
      monthsAfterHandover: num(p?.months_after_handover),
      steps: (Array.isArray(p?.steps) ? p.steps : []).map((s) => ({
        id: s?.id ?? null,
        name: clean(s?.name),
        percentage: num(s?.percentage),
        stage: clean(s?.stage_type),
        fixedAmount: num(s?.fixed_amount),
        notes: clean(s?.notes),
      })),
    })),

    typicalUnits: (Array.isArray(row?.typical_units) ? row.typical_units : []).map((u) => ({
      bedrooms: num(u?.bedrooms),
      fromPrice: num(u?.from_price_aed),
      toPrice: num(u?.to_price_aed),
      fromSize: num(u?.from_size_sqft),
      toSize: num(u?.to_size_sqft),
    })),

    buildings: (Array.isArray(row?.buildings) ? row.buildings : []).map((b) => ({
      id: b?.id ?? null,
      name: clean(b?.name),
      type: clean(b?.building_type_display) ?? clean(b?.building_type),
      floors: num(b?.floors_count),
      description: clean(b?.description),
    })),
  };
}

/* ------------------------------ formatting ------------------------------ */

export const fmtNum = (n) =>
  Number.isFinite(Number(n)) ? Number(n).toLocaleString() : '—';

/** Prices run from a few hundred thousand to 180 million, so they abbreviate. */
export function fmtMoney(n, currency = 'AED') {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return null;
  if (v >= 1_000_000) return `${currency} ${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}m`;
  if (v >= 1_000) return `${currency} ${Math.round(v / 1000)}k`;
  return `${currency} ${Math.round(v)}`;
}

/**
 * "AED 1.6m – 11m", or a single figure when both ends agree.
 *
 * Returns null rather than "0" when there is no price. Four of the 49 live
 * projects carry min_price 0, which means "not published", not "free" — and a
 * card reading AED 0 is worse than a card reading nothing.
 */
export function priceRange(min, max, currency = 'AED') {
  const lo = fmtMoney(min, currency);
  const hi = fmtMoney(max, currency);
  if (!lo && !hi) return null;
  if (!hi || lo === hi) return lo;
  if (!lo) return hi;
  return `${lo} – ${hi}`;
}

export function sizeRange(min, max, unit = 'sqft') {
  const lo = Number(min);
  const hi = Number(max);
  const ok = (v) => Number.isFinite(v) && v > 0;
  if (!ok(lo) && !ok(hi)) return null;
  if (!ok(hi) || Math.round(lo) === Math.round(hi)) return `${fmtNum(Math.round(lo))} ${unit}`;
  if (!ok(lo)) return `${fmtNum(Math.round(hi))} ${unit}`;
  return `${fmtNum(Math.round(lo))} – ${fmtNum(Math.round(hi))} ${unit}`;
}

export const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};

/** Total pages for a count, at the catalogue's fixed page size. */
export const pageCount = (count, size = PAGE_SIZE) =>
  Math.max(1, Math.ceil((Number(count) || 0) / size));
