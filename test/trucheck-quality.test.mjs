import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseCrawlItem, mergeCrawl, communityOfCrawl, classOfCrawl,
  amenityCountOf, hasFloorPlanOf, nativeScoresOf,
} from '../src/truCheckSourceParse.mjs';
import {
  scoreListing, averageScore, floorPlanCoverage, FACTORS, TOTAL_WEIGHT,
  PHOTO_TARGET, AMENITY_TARGET, scoreBand,
} from '../src/truCheckScore.js';
import { buildRows, summarise, applyFilters, BLANK_FILTERS } from '../src/truCheckModel.js';

/**
 * The full-detail crawl: extraction, the derived score, and the distinction
 * that matters most — "not crawled" is not "zero".
 *
 * Every field name here came off live records captured 2026-08-21, from both
 * crawl stages, because the two return the same information in different
 * shapes and only one of them was ever documented.
 */

/* ------------------------------ the two shapes ---------------------------- */

test('the detail record: location is ascending, community is level 2', () => {
  // UAE -> Dubai -> Al Furjan -> tower
  assert.equal(communityOfCrawl([
    { level: 0, name: 'UAE' }, { level: 1, name: 'Dubai' },
    { level: 2, name: 'Al Furjan' }, { level: 3, name: 'Azizi Plaza' },
  ]), 'Al Furjan');
});

test('the enumerate record: location is the same hierarchy, joined and REVERSED', () => {
  // The trap. Reading either by index would take the tower from one and the
  // country from the other.
  assert.equal(
    communityOfCrawl('Icon Tower 2; JLT Cluster L; Jumeirah Lake Towers (JLT); Dubai; UAE'),
    'Jumeirah Lake Towers (JLT)'
  );
});

test('category resolves from both shapes', () => {
  assert.equal(classOfCrawl([{ level: 0, name: 'Residential' }]), 'residential');
  assert.equal(classOfCrawl('Residential; Apartments'), 'residential');
  assert.equal(classOfCrawl('Commercial; Offices'), 'commercial');
  assert.equal(classOfCrawl(undefined), null);
});

test('amenities count from an array or a joined string', () => {
  assert.equal(amenityCountOf(['Furnished', 'Gym or Health Club', 'Parking Spaces']), 3);
  assert.equal(amenityCountOf('Furnished; Gym or Health Club; Parking Spaces'), 3);
  assert.equal(amenityCountOf(null), 0);
});

test('a floor plan means one attached to THIS listing', () => {
  assert.equal(hasFloorPlanOf({ floorPlanID: '1107' }), true);
  assert.equal(hasFloorPlanOf({ hasUnitPlan: true }), true);
  // A plan existing for the unit type elsewhere is not a plan on this listing,
  // and the factor exists to tell an agent what to go and attach.
  assert.equal(hasFloorPlanOf({ hasMatchingFloorPlans: true }), false);
  assert.equal(hasFloorPlanOf({ floorPlanID: null, hasUnitPlan: false }), false);
});

test("Bayut's timestamp-shaped 'scores' are excluded from its score set", () => {
  // trucheckedScore is 1783517008 — a UNIX stamp sitting in a column of
  // two-digit numbers. Carrying it as a score would be nonsense.
  const n = nativeScoresOf({
    score: 75, indyScore: 140, productScore: 0, truBrokerScore: 0,
    trucheckedScore: 1783517008, verifiedScore: 0,
  });
  assert.deepEqual(Object.keys(n).sort(), ['indyScore', 'productScore', 'score', 'truBrokerScore']);
  assert.equal(nativeScoresOf({}), null);
});

/* --------------------------- not crawled vs zero -------------------------- */

const DETAIL = {
  externalID: '15450167', referenceNumber: 'ARZ-S-5846', title: 'VACANT | High Floor',
  price: 520000, purpose: 'for-sale', rooms: 0, baths: 1, area: 35.4,
  photoCount: 15, videoCount: 0, panoramaCount: 0, floorPlanID: null, hasUnitPlan: false,
  amenities: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'],
  isVerified: true,
  verification: { status: 'verified', trucheckedAt: 1783517008, eligible: true },
  score: 75, indyScore: 140, state: 'active',
  ownerAgent: { externalID: '2347968', name: 'Lyba Waqar' },
  category: [{ level: 0, name: 'Residential' }],
  location: [{ level: 0, name: 'UAE' }, { level: 1, name: 'Dubai' }, { level: 2, name: 'Al Furjan' }],
};

const THIN = {
  externalID: '15530078', referenceNumber: 'ARZ-R-7569',
  url: 'https://www.bayut.com/property/details-15530078.html',
  isVerified: true, agentName: 'Dennis Manalo', price: 120000, purpose: 'for-rent',
  category: 'Residential; Apartments', state: 'active',
  location: 'Icon Tower 2; JLT Cluster L; Jumeirah Lake Towers (JLT); Dubai; UAE',
};

test('an enumerate-only row leaves quality signals NULL, never zero', () => {
  // The distinction the whole score depends on: a null photoCount means "we did
  // not read the page", and scoring it as zero photos would invent a fact.
  const r = normaliseCrawlItem(THIN, { detailed: false });
  assert.equal(r.detailed, false);
  assert.equal(r.photoCount, null);
  assert.equal(r.videoCount, null);
  assert.equal(r.hasFloorPlan, null);
  assert.equal(r.nativeScores, null);
  // The badge IS known from the cheap pass.
  assert.equal(r.isTruCheck, true);
});

test('a detail row carries the counts, the date and the raw native numbers', () => {
  const r = normaliseCrawlItem(DETAIL, { detailed: true });
  assert.equal(r.detailed, true);
  assert.equal(r.photoCount, 15);
  assert.equal(r.hasFloorPlan, false);
  assert.equal(r.amenityCount, 12);
  assert.equal(r.community, 'Al Furjan');
  assert.equal(r.truCheckedAt, new Date(1783517008 * 1000).toISOString());
  assert.equal(r.checked, true);
  assert.equal(r.agentName, 'Lyba Waqar');
  assert.deepEqual(r.nativeScores, { score: 75, indyScore: 140, productScore: null, truBrokerScore: null });
});

/* --------------------------------- merging -------------------------------- */

test('enumeration decides what exists; detail only enriches', () => {
  const enumerated = [THIN, { ...THIN, externalID: '999', referenceNumber: 'ARZ-R-0002' }]
    .map((i) => normaliseCrawlItem(i, { detailed: false }));
  const details = [normaliseCrawlItem({ ...DETAIL, externalID: '15530078', referenceNumber: 'ARZ-R-7569' }, { detailed: true })];

  const merged = mergeCrawl(enumerated, details);
  assert.equal(merged.length, 2, 'the enumerate count is the truth about what exists');
  assert.equal(merged.find((r) => r.bayutListingId === '15530078').photoCount, 15);
  assert.equal(merged.find((r) => r.bayutListingId === '999').detailed, false);
});

test('a detail record for something never enumerated is ignored, not added', () => {
  const merged = mergeCrawl(
    [normaliseCrawlItem(THIN, { detailed: false })],
    [normaliseCrawlItem({ ...DETAIL, externalID: 'stranger', referenceNumber: 'NOT-OURS' }, { detailed: true })]
  );
  assert.equal(merged.length, 1);
});

test('a failed detail fetch keeps the listing, thin', () => {
  const merged = mergeCrawl([normaliseCrawlItem(THIN, { detailed: false })], []);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].detailed, false);
  assert.equal(merged[0].isTruCheck, true, 'the badge survives a failed detail pass');
});

/* ---------------------------------- score --------------------------------- */

test('the weights sum to 100 — a reweighting that breaks this is a silent bug', () => {
  assert.equal(TOTAL_WEIGHT, 100);
  assert.equal(FACTORS.length, 5);
});

test('description is deliberately not a factor', () => {
  // It was specified, and the payload has no description field. Scoring it zero
  // would dock every listing equally: no signal, and a worse-looking number.
  assert.ok(!FACTORS.some((f) => /description/i.test(f.key + f.label)));
});

test('a perfect listing scores 100, an empty one scores only its TruCheck', () => {
  const full = { onBayut: true, isTruCheck: true, hasFloorPlan: true,
    photoCount: PHOTO_TARGET, videoCount: 1, panoramaCount: 0, amenityCount: AMENITY_TARGET };
  assert.equal(scoreListing(full).score, 100);

  const bare = { onBayut: true, isTruCheck: true, hasFloorPlan: false,
    photoCount: 0, videoCount: 0, panoramaCount: 0, amenityCount: 0 };
  assert.equal(scoreListing(bare).score, 30);
});

test('photos and amenities are graded, so one upload does not jump the score', () => {
  const at = (n) => scoreListing({ onBayut: true, isTruCheck: false, hasFloorPlan: false,
    photoCount: n, videoCount: 0, panoramaCount: 0, amenityCount: 0 }).score;
  assert.equal(at(0), 0);
  assert.equal(at(6), 10);                 // half of a 20-point factor
  assert.equal(at(PHOTO_TARGET), 20);
  assert.equal(at(PHOTO_TARGET * 5), 20, 'capped, never bonus points');
});

test('a video OR a panorama satisfies the media factor', () => {
  const base = { onBayut: true, isTruCheck: false, hasFloorPlan: false,
    photoCount: 0, amenityCount: 0, panoramaCount: 0, videoCount: 0 };
  assert.equal(scoreListing({ ...base, videoCount: 1 }).score, 15);
  assert.equal(scoreListing({ ...base, panoramaCount: 1 }).score, 15);
  assert.equal(scoreListing({ ...base, videoCount: 1, panoramaCount: 3 }).score, 15, 'not 30');
});

test('the breakdown adds up to the score and names what is missing', () => {
  const l = { onBayut: true, isTruCheck: true, hasFloorPlan: false,
    photoCount: 15, videoCount: 0, panoramaCount: 0, amenityCount: 12 };
  const { score, factors } = scoreListing(l);
  assert.equal(factors.reduce((n, f) => n + f.got, 0), score);
  assert.equal(score, 65);
  assert.equal(factors.find((f) => f.key === 'floorPlan').say, 'No floor plan');
  assert.equal(factors.find((f) => f.key === 'media').say, 'No video or 360');
});

test('a listing not on Bayut has no score at all', () => {
  // Zero would drag the average down with a number meaning "we could not
  // look", which is not the same as "this listing is bad".
  assert.equal(scoreListing({ onBayut: false, isTruCheck: false }).score, null);
  assert.equal(scoreListing(null).score, null);
});

test('the average and coverage ignore listings the crawl never saw', () => {
  const rows = [
    { onBayut: true, score: 80, hasFloorPlan: true },
    { onBayut: true, score: 60, hasFloorPlan: false },
    { onBayut: false, score: null, hasFloorPlan: null },
  ];
  assert.equal(averageScore(rows), 70);
  assert.equal(floorPlanCoverage(rows), 0.5, 'denominator is on-Bayut, not the whole inventory');
  assert.equal(floorPlanCoverage([]), null);
});

test('score bands', () => {
  assert.equal(scoreBand(90), 'good');
  assert.equal(scoreBand(60), 'fair');
  assert.equal(scoreBand(20), 'poor');
  assert.equal(scoreBand(null), 'none');
});

/* -------------------------------- filtering ------------------------------- */

const listing = (over = {}) => ({
  id: 1, ref: 'A1', permit: null, community: 'Al Furjan', offering: 'sale',
  categoryClass: 'residential', price: 1, brokerId: '1', broker: 'B', ranked: true,
  createdAt: '2026-08-01T00:00:00Z', ...over,
});

test('a score bound excludes unscored listings rather than treating them as zero', () => {
  const snap = [
    { reference: 'A1', isTruCheck: true, detailed: true, score: 80, url: 'u' },
    { reference: 'A2', isTruCheck: true, detailed: false, score: null, url: 'u' },
  ];
  const rows = buildRows([listing({ id: 1, ref: 'A1' }), listing({ id: 2, ref: 'A2' })], snap);

  assert.equal(applyFilters(rows, BLANK_FILTERS).length, 2);
  // "score under 50" must not return a row that has no score.
  assert.equal(applyFilters(rows, { ...BLANK_FILTERS, scoreTo: '50' }).length, 0);
  assert.equal(applyFilters(rows, { ...BLANK_FILTERS, scoreFrom: '70' }).length, 1);
});

test('the cards still reconcile to the filtered rows once a score bound is on', () => {
  const snap = [
    { reference: 'A1', isTruCheck: true, detailed: true, score: 90, hasFloorPlan: true, url: 'u' },
    { reference: 'A2', isTruCheck: false, detailed: true, score: 40, hasFloorPlan: false, url: 'u' },
  ];
  const rows = buildRows([listing({ id: 1, ref: 'A1' }), listing({ id: 2, ref: 'A2' })], snap);
  for (const f of [BLANK_FILTERS, { ...BLANK_FILTERS, scoreFrom: '50' }, { ...BLANK_FILTERS, scoreTo: '50' }]) {
    const shown = applyFilters(rows, f);
    const s = summarise(shown);
    assert.equal(s.total, shown.length);
    assert.equal(s.truchecked + s.not + s.missing, s.total);
  }
});
