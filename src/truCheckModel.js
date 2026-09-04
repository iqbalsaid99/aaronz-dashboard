/**
 * TruCheck — the three-state model, the join, and the breakdowns.
 *
 * Pure. No transport, no Supabase, so it runs under `node --test`.
 *
 * THE THREE STATES, and why the third one exists. PropSpace is the inventory.
 * Bayut's crawl says which of that inventory it can see and which of those
 * carry the badge. Those are different questions, and collapsing them loses the
 * one that matters most:
 *
 *   truchecked  the badge was found
 *   not         the listing is live on Bayut and has no badge   <- the action list
 *   missing     the listing is in PropSpace and absent from Bayut
 *
 * `missing` is not a milder form of `not`. A listing with no badge is a job for
 * whoever books TruCheck appointments; a listing Bayut has never heard of is a
 * publishing fault, and sending it to the TruCheck queue wastes everyone's time.
 * Measured on 2026-08-21 this is not a rounding error: Bayut reports 242 ads
 * against 314 live PropSpace listings.
 */

import { averageScore, floorPlanCoverage } from './truCheckScore.js';

export const STATES = ['truchecked', 'not', 'missing'];

/** The labels the UI must use. Defined once so no screen invents its own. */
export const STATE_LABEL = {
  truchecked: 'TruChecked',
  not: 'Live on Bayut, not TruChecked',
  missing: 'Not found on Bayut',
};

/* --------------------------------- joining -------------------------------- */

const norm = (v) => {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  return t ? t.toUpperCase() : null;
};

/**
 * Index a snapshot by the keys a PropSpace listing can be matched on.
 *
 * Reference is the only key that actually works. Bayut does not publish the
 * RERA permit number anywhere in its listing payload — checked against a live
 * record, where `extraFields` carries dldPropertySK and dldBuildingNK and no
 * permit — so the permit-first rule the spec asked for cannot be honoured from
 * this source. The permit index is still built, because a future Profolio
 * endpoint would carry it and this is where it would slot in; today it is
 * simply empty and the reference index does the work.
 */
export function indexSnapshot(rows) {
  const byPermit = new Map();
  const byReference = new Map();

  for (const r of rows ?? []) {
    if (!r) continue;
    const p = norm(r.permit);
    const ref = norm(r.reference);
    if (p && !byPermit.has(p)) byPermit.set(p, r);
    if (ref && !byReference.has(ref)) byReference.set(ref, r);
  }
  return { byPermit, byReference };
}

/**
 * Which snapshot row belongs to this listing, and how it was matched.
 *
 * Permit first, exact reference second — the order the spec asks for, kept even
 * though the permit half is dormant, so that turning it on later is data
 * arriving rather than logic changing.
 */
export function matchListing(listing, index) {
  const p = norm(listing?.permit);
  if (p) {
    const hit = index.byPermit.get(p);
    if (hit) return { row: hit, matchedOn: 'permit' };
  }
  const ref = norm(listing?.ref);
  if (ref) {
    const hit = index.byReference.get(ref);
    if (hit) return { row: hit, matchedOn: 'reference' };
  }
  return { row: null, matchedOn: null };
}

/* ------------------------------- the row model ---------------------------- */

/**
 * One row per PropSpace listing, carrying its TruCheck state.
 *
 * Driven by PropSpace, never by the snapshot: the inventory is what we have,
 * and a Bayut row with no PropSpace listing is somebody else's problem — it is
 * reported separately by `orphans` rather than silently inflating the counts.
 */
export function buildRows(listings, snapshotRows) {
  const index = indexSnapshot(snapshotRows);

  return (listings ?? []).filter(Boolean).map((l) => {
    const { row, matchedOn } = matchListing(l, index);

    const state = !row ? 'missing' : row.isTruCheck ? 'truchecked' : 'not';

    return {
      ...l,
      state,
      stateLabel: STATE_LABEL[state],
      matchedOn,
      onBayut: state !== 'missing',
      bayutUrl: row?.url ?? null,
      bayutListingId: row?.bayutListingId ?? null,
      truCheckedAt: row?.truCheckedAt ?? null,
      // Bayut's separate "Checked" badge. Only the detail stage of the crawl
      // carries it, so null means "the crawl did not look", not "no badge".
      checked: row?.checked ?? null,
      verificationStatus: row?.verificationStatus ?? null,
      bayutAgent: row?.agentName ?? null,

      // Quality signals. All null when the detail pass did not reach this
      // listing — which is NOT the same as zero, and the score respects that.
      detailed: row?.detailed === true,
      photoCount: row?.photoCount ?? null,
      videoCount: row?.videoCount ?? null,
      panoramaCount: row?.panoramaCount ?? null,
      hasFloorPlan: row?.hasFloorPlan ?? null,
      amenityCount: row?.amenityCount ?? null,

      // Bayut's own numbers, passed through untouched and never mixed with ours.
      nativeScores: row?.nativeScores ?? null,

      // Read from the snapshot rather than recomputed, so an old snapshot shows
      // the score as it was rather than as today's weights would render it.
      score: row?.score ?? null,
      factors: row?.factors ?? [],
    };
  });
}

/** Snapshot rows that matched no live listing — on Bayut, not in our inventory. */
export function orphans(listings, snapshotRows) {
  const refs = new Set((listings ?? []).map((l) => norm(l?.ref)).filter(Boolean));
  const permits = new Set((listings ?? []).map((l) => norm(l?.permit)).filter(Boolean));
  return (snapshotRows ?? []).filter(
    (r) => r && !refs.has(norm(r.reference)) && !permits.has(norm(r.permit))
  );
}

/* --------------------------------- days live ------------------------------ */

/** Whole days since the listing was created, or null when there is no date. */
export function daysLive(createdAt, now = new Date()) {
  if (!createdAt) return null;
  const t = new Date(createdAt).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
}

/* ---------------------------------- filters ------------------------------- */

export const BLANK_FILTERS = {
  state: '', broker: '', offering: '', categoryClass: '', community: '',
  scoreFrom: '', scoreTo: '',
};

/**
 * The one filter function. Cards, breakdowns and both tables read its result,
 * which is what makes the counts reconcile by construction rather than by three
 * implementations agreeing today.
 */
/**
 * A pseudo-state meaning "the crawl found it", i.e. TruChecked or not.
 *
 * It exists because the Live on Bayut card counts both, and a card that shows
 * a number has to be able to filter to exactly the rows behind it — otherwise
 * clicking it would show a different set than the one it counted.
 */
export const ON_BAYUT = 'onBayut';

export function applyFilters(rows, f = BLANK_FILTERS) {
  return (rows ?? []).filter((r) => {
    if (f.state === ON_BAYUT) {
      if (!r.onBayut) return false;
    } else if (f.state && r.state !== f.state) return false;
    if (f.broker && r.brokerId !== f.broker) return false;
    if (f.offering && r.offering !== f.offering) return false;
    if (f.categoryClass && r.categoryClass !== f.categoryClass) return false;
    if (f.community && r.community !== f.community) return false;

    // A listing with no score is excluded whenever a score bound is set. It is
    // not a zero — it is unmeasured — so it can be neither above nor below a
    // threshold, and quietly keeping it would let "score under 50" return rows
    // that have no score at all.
    const from = f.scoreFrom === '' ? null : Number(f.scoreFrom);
    const to = f.scoreTo === '' ? null : Number(f.scoreTo);
    if (from !== null || to !== null) {
      if (r.score === null || r.score === undefined) return false;
      if (from !== null && Number.isFinite(from) && r.score < from) return false;
      if (to !== null && Number.isFinite(to) && r.score > to) return false;
    }
    return true;
  });
}

/* -------------------------------- summaries ------------------------------- */

/**
 * The summary cards.
 *
 * `liveOnBayut` is truchecked + not — the listings Bayut can actually see. The
 * percentages are deliberately taken against THAT and not against the whole
 * inventory: a TruCheck rate whose denominator includes listings Bayut has
 * never heard of measures two failures at once and improves when publishing
 * breaks, which is exactly backwards.
 */
export function summarise(rows) {
  const r = rows ?? [];
  const truchecked = r.filter((x) => x.state === 'truchecked').length;
  const not = r.filter((x) => x.state === 'not').length;
  const missing = r.filter((x) => x.state === 'missing').length;
  const liveOnBayut = truchecked + not;

  return {
    total: r.length,
    liveOnBayut,
    truchecked,
    not,
    missing,
    truCheckedPct: liveOnBayut ? truchecked / liveOnBayut : null,
    notPct: liveOnBayut ? not / liveOnBayut : null,

    // Both measured against listings the crawl actually saw, never the whole
    // inventory — same rule as the TruCheck rate, same reason.
    detailed: r.filter((x) => x.detailed).length,
    floorPlanCoverage: floorPlanCoverage(r),
    avgScore: averageScore(r),
  };
}

/* ------------------------------- breakdowns ------------------------------- */

/**
 * TruCheck rate for an arbitrary grouping.
 *
 * `missing` is counted and reported but kept OUT of the rate's denominator, for
 * the reason in summarise: it is a different failure. A group that is entirely
 * missing from Bayut gets a null rate rather than 0% — 0% says "we have not
 * TruChecked these", null says "there is nothing here to TruCheck yet", and a
 * broker should not be marked down for the second.
 */
export function rateBy(rows, keyOf, labelOf) {
  const m = new Map();
  // Guarded rather than defaulted: a default parameter only fires on
  // `undefined`, and rateByBroker passes null deliberately — it attaches the
  // display name afterwards, from the row, because an id cannot produce one.
  const label = typeof labelOf === 'function' ? labelOf : (k) => k;

  for (const r of rows ?? []) {
    const key = keyOf(r);
    if (key === null || key === undefined || key === '') continue;
    const e = m.get(key) ?? {
      key, label: label(key), ranked: r.ranked !== false,
      total: 0, truchecked: 0, not: 0, missing: 0, scores: [],
    };
    e.total++;
    e[r.state]++;
    if (r.score !== null && r.score !== undefined) e.scores.push(r.score);
    if (r.ranked === false) e.ranked = false;
    m.set(key, e);
  }

  return [...m.values()]
    .map((e) => {
      const denom = e.truchecked + e.not;
      return {
        ...e,
        liveOnBayut: denom,
        rate: denom ? e.truchecked / denom : null,
        avgScore: e.scores.length
          ? Math.round(e.scores.reduce((a, b) => a + b, 0) / e.scores.length)
          : null,
      };
    })
    .sort((a, b) => {
      // Nulls last: a group with nothing on Bayut has no rate to rank on.
      if (a.rate === null && b.rate === null) return b.total - a.total;
      if (a.rate === null) return 1;
      if (b.rate === null) return -1;
      return b.rate - a.rate || b.total - a.total;
    });
}

/**
 * The broker breakdown, with crm_agents' exclusions respected.
 *
 * Excluded agents never rank. Their listings are still counted, aggregated into
 * one remainder line so the column adds up to the card above it — the same
 * arrangement the Brokers and Bayut tabs use, for the same reason.
 */
export function rateByBroker(rows) {
  const ranked = rateBy(
    (rows ?? []).filter((r) => r.ranked !== false),
    (r) => r.brokerId ?? `name:${r.broker}`,
    null
  ).map((e) => e);

  // rateBy cannot know the display name from the id alone, so it is attached here.
  const nameOf = new Map();
  for (const r of rows ?? []) nameOf.set(r.brokerId ?? `name:${r.broker}`, r.broker);
  for (const e of ranked) e.label = nameOf.get(e.key) ?? String(e.key);

  const held = (rows ?? []).filter((r) => r.ranked === false);
  const remainder = held.length
    ? (() => {
        const e = {
          key: '__remainder', label: 'Not in broker ranking', ranked: false,
          total: held.length,
          truchecked: held.filter((r) => r.state === 'truchecked').length,
          not: held.filter((r) => r.state === 'not').length,
          missing: held.filter((r) => r.state === 'missing').length,
          people: new Set(held.map((r) => r.brokerId ?? r.broker)).size,
        };
        e.liveOnBayut = e.truchecked + e.not;
        e.rate = e.liveOnBayut ? e.truchecked / e.liveOnBayut : null;
        const scores = held.map((r) => r.score).filter((v) => v !== null && v !== undefined);
        e.avgScore = scores.length
          ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
          : null;
        return e;
      })()
    : null;

  return { ranked, remainder };
}

/* -------------------------------- formatting ------------------------------ */

export const fmtPct = (v, digits = 0) =>
  v === null || v === undefined || !Number.isFinite(Number(v))
    ? '—'
    : `${(Number(v) * 100).toFixed(digits)}%`;

export const fmtDate = (v) => {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};

export const fmtDateTime = (v) => {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};
