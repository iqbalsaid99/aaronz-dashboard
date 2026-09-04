import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveSnapshot, QUALITY_FIELDS, listingKey, normaliseCrawlItem,
} from '../src/truCheckSourceParse.mjs';
import { buildRows, summarise } from '../src/truCheckModel.js';
import { averageScore } from '../src/truCheckScore.js';

/**
 * The two-speed refresh.
 *
 * One rule matters more than all the others here: a cheap enumerate run must
 * never blank or zero the quality columns a full run filled. Getting that wrong
 * does not look like a bug — it looks like every listing suddenly having no
 * photos, which is a finding somebody would act on.
 */

const base = (over = {}) => ({
  bayutListingId: '1', reference: 'ARZ-R-1', isTruCheck: true, price: 100,
  agentName: 'Dennis Manalo', purpose: 'for-rent', detailed: false, ...over,
});

const quality = (over = {}) => ({
  bayutListingId: '1', reference: 'ARZ-R-1', detailed: true,
  photoCount: 15, videoCount: 0, panoramaCount: 2, hasFloorPlan: true,
  amenityCount: 12, score: 80, factors: [{ key: 'photos', got: 20 }],
  truCheckedAt: '2026-07-08T13:23:28.000Z', checked: true,
  verificationStatus: 'verified', nativeScores: { score: 75 },
  // Deliberately stale and wrong: the older full run saw a different badge and
  // price. Neither may leak through — those come from the newest run.
  isTruCheck: false, price: 999,
  ...over,
});

/* ------------------------ the rule that matters most ---------------------- */

test('an enumerate run keeps the last full run\'s quality data', () => {
  const [r] = resolveSnapshot([base()], [quality()]);
  assert.equal(r.photoCount, 15);
  assert.equal(r.hasFloorPlan, true);
  assert.equal(r.panoramaCount, 2);
  assert.equal(r.score, 80);
  assert.equal(r.detailed, true);
});

test('the newest run wins on everything that is not a quality field', () => {
  const [r] = resolveSnapshot([base({ isTruCheck: true, price: 100 })], [quality()]);
  // The old full run said false / 999. It must not win.
  assert.equal(r.isTruCheck, true);
  assert.equal(r.price, 100);
  assert.equal(r.agentName, 'Dennis Manalo');
});

test('quality fields are taken wholesale, never merged field by field', () => {
  // Photo count and score come from one moment. Mixing runs would produce a
  // row that never existed.
  const [r] = resolveSnapshot([base()], [quality({ photoCount: 3, score: 40 })]);
  assert.equal(r.photoCount, 3);
  assert.equal(r.score, 40);
});

test('every quality field is cleared before the quality run is applied', () => {
  // Guards against an enumerate row carrying a stray default into a column it
  // has no business filling.
  const dirty = base({ photoCount: 0, hasFloorPlan: false, score: 0, detailed: true });
  const [r] = resolveSnapshot([dirty], []);
  for (const f of QUALITY_FIELDS) {
    if (f === 'detailed') { assert.equal(r.detailed, false); continue; }
    if (f === 'factors') { assert.deepEqual(r.factors, []); continue; }
    assert.equal(r[f], null, `${f} must be null, not carried from the enumerate row`);
  }
});

/* ----------------------------- never detailed ----------------------------- */

test('a listing never detailed keeps its badge and gets NULL quality, not zero', () => {
  const [r] = resolveSnapshot([base({ bayutListingId: '2', reference: 'ARZ-R-2' })], []);
  assert.equal(r.isTruCheck, true, 'the badge is known from the cheap pass');
  assert.equal(r.photoCount, null);
  assert.notEqual(r.photoCount, 0, 'zero would read as "no photos"');
  assert.equal(r.hasFloorPlan, null);
  assert.equal(r.score, null);
  assert.equal(r.awaitingDetail, true);
});

test('a listing that has been detailed is not marked as awaiting', () => {
  const [r] = resolveSnapshot([base()], [quality()]);
  assert.equal(r.awaitingDetail, false);
});

test('never-detailed listings are excluded from the average, not counted as zero', () => {
  const rows = resolveSnapshot(
    [base({ bayutListingId: '1' }), base({ bayutListingId: '2', reference: 'ARZ-R-2' })],
    [quality({ bayutListingId: '1', score: 80 })]
  ).map((r) => ({ ...r, onBayut: true }));

  // 80, not 40 — the undetailed listing has no score to average.
  assert.equal(averageScore(rows), 80);
});

/* -------------------------------- existence ------------------------------- */

test('a listing in the quality run but gone from the newest run is dropped', () => {
  // It has left the account since the last full crawl. Carrying it forward on
  // old quality data would report a listing that is no longer there.
  const rows = resolveSnapshot([base()], [quality(), quality({ bayutListingId: '99', reference: 'GONE' })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reference, 'ARZ-R-1');
});

test('the newest run alone decides how many listings exist', () => {
  const rows = resolveSnapshot(
    [base({ bayutListingId: '1' }), base({ bayutListingId: '2', reference: 'B' }), base({ bayutListingId: '3', reference: 'C' })],
    [quality({ bayutListingId: '1' })]
  );
  assert.equal(rows.length, 3);
  assert.equal(rows.filter((r) => r.awaitingDetail).length, 2);
});

/* --------------------------------- identity ------------------------------- */

test('listings match on Bayut id first, reference second', () => {
  assert.equal(listingKey({ bayutListingId: '15530078', reference: 'X' }), 'id:15530078');
  assert.equal(listingKey({ reference: ' arz-r-7569 ' }), 'ref:ARZ-R-7569');
  assert.equal(listingKey({}), null);
});

test('a row with no identity at all is left alone rather than matched by accident', () => {
  const [r] = resolveSnapshot([{ reference: null, bayutListingId: null, isTruCheck: true }], [quality()]);
  assert.equal(r.photoCount, null);
  assert.equal(r.awaitingDetail, true);
});

/* ------------------------- through the whole model ------------------------ */

test('the tab renders fresh badges over older quality without contradiction', () => {
  // The realistic case: last night's enumerate, last week's full crawl.
  const snapshotRows = resolveSnapshot(
    [
      base({ bayutListingId: '1', reference: 'A1', isTruCheck: true }),
      base({ bayutListingId: '2', reference: 'A2', isTruCheck: false }),
    ],
    [quality({ bayutListingId: '1', reference: 'A1', score: 80, isTruCheck: false })]
  );

  const listings = [
    { id: 1, ref: 'A1', permit: null, brokerId: '1', broker: 'B', ranked: true, offering: 'rent', categoryClass: 'residential', community: 'JLT', price: 1 },
    { id: 2, ref: 'A2', permit: null, brokerId: '1', broker: 'B', ranked: true, offering: 'rent', categoryClass: 'residential', community: 'JLT', price: 1 },
  ];

  const rows = buildRows(listings, snapshotRows);
  const s = summarise(rows);

  // Badge from last night, not from the older full crawl.
  assert.equal(rows.find((r) => r.ref === 'A1').state, 'truchecked');
  assert.equal(rows.find((r) => r.ref === 'A2').state, 'not');
  assert.equal(s.truchecked, 1);
  assert.equal(s.not, 1);

  // Quality only where the full crawl reached.
  assert.equal(rows.find((r) => r.ref === 'A1').photoCount, 15);
  assert.equal(rows.find((r) => r.ref === 'A2').photoCount, null);
  assert.equal(s.avgScore, 80);
  assert.equal(s.detailed, 1);
});

test('resolveSnapshot handles empty and missing inputs', () => {
  assert.deepEqual(resolveSnapshot([], []), []);
  assert.deepEqual(resolveSnapshot(null, null), []);
  assert.equal(resolveSnapshot([base()], null).length, 1);
});
