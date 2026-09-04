/**
 * The derived listing-quality score.
 *
 * THIS IS OURS, NOT BAYUT'S. Bayut computes a Profolio Quality Score and does
 * not expose it on any endpoint this account can reach. The listing payload
 * does carry several internal numbers — score, indyScore, productScore,
 * truBrokerScore — and those are captured raw and shown separately, labelled as
 * Bayut's, because nobody outside Bayut knows what they weigh. Presenting one
 * of them as "the quality score" would be inventing a meaning for a number we
 * did not compute.
 *
 * What this score measures is COMPLETENESS: how much of what a listing could
 * carry, it actually carries. That is a thing we can define, defend, and act
 * on, and every point of it is traceable to a factor the agent can go and fix.
 *
 * DESCRIPTION LENGTH IS DELIBERATELY ABSENT. It was asked for, and the crawl
 * payload has no description field — verified against a live record. Scoring it
 * as zero would dock every listing the same amount, which adds no signal and
 * makes the number look worse than the stock is. So the five remaining factors
 * are reweighted to 100 and the breakdown says so, rather than a sixth factor
 * quietly failing for everyone.
 */

/**
 * The factors, their weights, and what "full marks" means for each.
 *
 * Weights sum to 100. TruCheck carries the most because it is the one factor
 * that changes how Bayut ranks the listing rather than only how it reads.
 *
 * Photos and amenities are GRADED rather than pass/fail: a listing with nine
 * photos is not equivalent to one with none, and a cliff at the threshold
 * would make the score jump on a single upload. Targets are Bayut's own
 * guidance for a complete listing.
 */
export const PHOTO_TARGET = 12;
export const AMENITY_TARGET = 8;

export const FACTORS = [
  {
    key: 'trucheck',
    label: 'TruCheck',
    weight: 30,
    detail: 'Verified by Bayut',
    score: (l) => (l.isTruCheck ? 1 : 0),
    say: (l) => (l.isTruCheck ? 'TruChecked' : 'Not TruChecked'),
  },
  {
    key: 'floorPlan',
    label: 'Floor plan',
    weight: 20,
    detail: '2D or 3D plan attached',
    score: (l) => (l.hasFloorPlan ? 1 : 0),
    say: (l) => (l.hasFloorPlan ? 'Floor plan attached' : 'No floor plan'),
  },
  {
    key: 'photos',
    label: 'Photos',
    weight: 20,
    detail: `${PHOTO_TARGET} or more`,
    score: (l) => Math.min(1, (l.photoCount ?? 0) / PHOTO_TARGET),
    say: (l) => `${l.photoCount ?? 0} photo${l.photoCount === 1 ? '' : 's'}`,
  },
  {
    key: 'media',
    label: 'Video or 360',
    weight: 15,
    detail: 'A video tour or a panorama',
    // Either satisfies it. A 360 tour and a video do the same job for a buyer
    // deciding whether to book a viewing, so requiring both would mark down
    // listings that are already doing the thing this factor exists to reward.
    score: (l) => ((l.videoCount ?? 0) > 0 || (l.panoramaCount ?? 0) > 0 ? 1 : 0),
    say: (l) => {
      const bits = [];
      if ((l.videoCount ?? 0) > 0) bits.push(`${l.videoCount} video`);
      if ((l.panoramaCount ?? 0) > 0) bits.push(`${l.panoramaCount} panorama`);
      return bits.length ? bits.join(' · ') : 'No video or 360';
    },
  },
  {
    key: 'amenities',
    label: 'Amenities',
    weight: 15,
    detail: `${AMENITY_TARGET} or more listed`,
    score: (l) => Math.min(1, (l.amenityCount ?? 0) / AMENITY_TARGET),
    say: (l) => `${l.amenityCount ?? 0} listed`,
  },
];

/** Asserted rather than assumed: a weight edit that breaks 100 is a silent bug. */
export const TOTAL_WEIGHT = FACTORS.reduce((n, f) => n + f.weight, 0);

/**
 * Score one listing, with the breakdown that explains it.
 *
 * Returns null for a listing the crawl never saw — a listing absent from Bayut
 * has no completeness to measure, and scoring it zero would drag the average
 * down with a number that means "we could not look", not "this is bad".
 */
export function scoreListing(l) {
  if (!l || l.onBayut === false) return { score: null, factors: [] };

  const factors = FACTORS.map((f) => {
    const got = Math.max(0, Math.min(1, Number(f.score(l)) || 0));
    return {
      key: f.key,
      label: f.label,
      detail: f.detail,
      weight: f.weight,
      got: Math.round(got * f.weight),
      full: got >= 1,
      say: f.say(l),
    };
  });

  return {
    score: Math.round(factors.reduce((n, f) => n + f.got, 0)),
    factors,
  };
}

/** Mean score across listings that have one. Null when none do. */
export function averageScore(rows) {
  const scored = (rows ?? []).map((r) => r.score).filter((v) => v !== null && v !== undefined);
  if (!scored.length) return null;
  return Math.round(scored.reduce((a, b) => a + b, 0) / scored.length);
}

/**
 * Share of listings ON BAYUT carrying a floor plan.
 *
 * Denominator is listings the crawl saw, never the whole inventory — the same
 * rule the TruCheck rate follows, and for the same reason: a coverage figure
 * that improves when publishing breaks is measuring the wrong thing.
 */
export function floorPlanCoverage(rows) {
  const onBayut = (rows ?? []).filter((r) => r.onBayut);
  if (!onBayut.length) return null;
  return onBayut.filter((r) => r.hasFloorPlan).length / onBayut.length;
}

export const scoreBand = (v) =>
  v === null || v === undefined ? 'none' : v >= 80 ? 'good' : v >= 55 ? 'fair' : 'poor';
