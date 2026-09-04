import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRows, indexSnapshot, matchListing, orphans, daysLive, applyFilters,
  summarise, rateBy, rateByBroker, BLANK_FILTERS, STATE_LABEL, fmtPct,
} from '../src/truCheckModel.js';
import { normaliseCrawlItem } from '../src/truCheckSourceParse.mjs';
import { isRunId, CONFIG } from '../functions/api/trucheck/[[path]].js';

/**
 * TruCheck: the three states, the join, and the rates.
 *
 * The rule these tests exist to hold is that "not found on Bayut" never
 * becomes "not TruChecked". They are different failures with different owners,
 * and the second one is a queue somebody works through.
 */

const listing = (over = {}) => ({
  id: 1, ref: 'ARZ-R-7569', permit: '7117-abc', community: 'Jumeirah Lake Towers',
  offering: 'rent', categoryClass: 'residential', price: 120000,
  brokerId: '1505580', broker: 'Paul Angeles', ranked: true,
  createdAt: '2026-08-01T10:00:00Z', ...over,
});

const snap = (over = {}) => ({
  reference: 'ARZ-R-7569', permit: null, isTruCheck: true,
  truCheckedAt: '2026-07-08T13:23:00Z', checked: null,
  url: 'https://www.bayut.com/property/details-15530078.html',
  bayutListingId: '15530078', agentName: 'Dennis Manalo', ...over,
});

/* ------------------------------ three states ----------------------------- */

test('the three states are labelled exactly as specified', () => {
  assert.equal(STATE_LABEL.truchecked, 'TruChecked');
  assert.equal(STATE_LABEL.not, 'Live on Bayut, not TruChecked');
  assert.equal(STATE_LABEL.missing, 'Not found on Bayut');
});

test('badge found -> TruChecked', () => {
  assert.equal(buildRows([listing()], [snap()])[0].state, 'truchecked');
});

test('on Bayut without a badge -> not TruChecked', () => {
  assert.equal(buildRows([listing()], [snap({ isTruCheck: false })])[0].state, 'not');
});

test('absent from the crawl -> Not found on Bayut, never "not TruChecked"', () => {
  const r = buildRows([listing()], [])[0];
  assert.equal(r.state, 'missing');
  assert.notEqual(r.state, 'not');
  assert.equal(r.bayutUrl, null);
});

/* -------------------------------- the join ------------------------------- */

test('permit is tried first, then exact reference', () => {
  const ix = indexSnapshot([snap({ reference: null, permit: '7117-ABC', bayutListingId: 'byPermit' })]);
  assert.equal(matchListing(listing(), ix).matchedOn, 'permit');

  const ix2 = indexSnapshot([snap()]);
  assert.equal(matchListing(listing({ permit: 'nomatch' }), ix2).matchedOn, 'reference');
});

test('reference matching ignores case and surrounding whitespace', () => {
  const rows = buildRows([listing({ ref: 'arz-r-7569' })], [snap({ reference: '  ARZ-R-7569 ' })]);
  assert.equal(rows[0].state, 'truchecked');
});

test('a listing with neither key is missing, not matched to something arbitrary', () => {
  const rows = buildRows([listing({ ref: null, permit: null })], [snap()]);
  assert.equal(rows[0].state, 'missing');
});

test('Bayut rows with no PropSpace listing are reported separately, not counted', () => {
  const extra = snap({ reference: 'SOMEONE-ELSE-1' });
  const rows = buildRows([listing()], [snap(), extra]);
  assert.equal(rows.length, 1, 'inventory is driven by PropSpace, never by the crawl');
  assert.deepEqual(orphans([listing()], [snap(), extra]).map((r) => r.reference), ['SOMEONE-ELSE-1']);
});

/* ------------------------------ the denominator --------------------------- */

const MIX = [
  listing({ id: 1, ref: 'A1' }), listing({ id: 2, ref: 'A2' }),
  listing({ id: 3, ref: 'A3' }), listing({ id: 4, ref: 'A4' }),
];
const MIX_SNAP = [
  snap({ reference: 'A1', isTruCheck: true }),
  snap({ reference: 'A2', isTruCheck: false }),
  snap({ reference: 'A3', isTruCheck: false }),
  // A4 absent -> missing
];

test('the rate is measured against listings live on Bayut, not the whole inventory', () => {
  const s = summarise(buildRows(MIX, MIX_SNAP));
  assert.equal(s.total, 4);
  assert.equal(s.liveOnBayut, 3);
  assert.equal(s.truchecked, 1);
  assert.equal(s.not, 2);
  assert.equal(s.missing, 1);
  // 1/3, not 1/4. Including the missing listing would mean the rate IMPROVES
  // when publishing breaks, which is exactly backwards.
  assert.equal(s.truCheckedPct, 1 / 3);
});

test('the three states partition the total exactly', () => {
  const s = summarise(buildRows(MIX, MIX_SNAP));
  assert.equal(s.truchecked + s.not + s.missing, s.total);
  assert.equal(s.truchecked + s.not, s.liveOnBayut);
});

test('a group with nothing on Bayut gets a null rate, not 0%', () => {
  // 0% reads as "we failed to TruCheck these". null says "there is nothing here
  // to TruCheck". A broker must not be marked down for the second.
  const rows = buildRows([listing({ brokerId: 'x', broker: 'New Joiner' })], []);
  const [g] = rateBy(rows, (r) => r.brokerId);
  assert.equal(g.rate, null);
  assert.equal(g.missing, 1);
  assert.equal(fmtPct(null), '—');
});

/* -------------------------------- filters -------------------------------- */

test('every card equals the row count for the same filter', () => {
  const rows = buildRows(MIX, MIX_SNAP);
  for (const f of [
    BLANK_FILTERS,
    { ...BLANK_FILTERS, state: 'not' },
    { ...BLANK_FILTERS, state: 'missing' },
    { ...BLANK_FILTERS, offering: 'rent' },
    { ...BLANK_FILTERS, community: 'Jumeirah Lake Towers' },
  ]) {
    const shown = applyFilters(rows, f);
    const s = summarise(shown);
    assert.equal(s.total, shown.length, JSON.stringify(f));
    assert.equal(s.truchecked, shown.filter((r) => r.state === 'truchecked').length);
    assert.equal(s.not, shown.filter((r) => r.state === 'not').length);
    assert.equal(s.missing, shown.filter((r) => r.state === 'missing').length);
  }
});

/* ------------------------------- leaderboard ------------------------------ */

test('excluded agents never rank but their listings still count', () => {
  const rows = buildRows([
    listing({ id: 1, ref: 'A1', brokerId: '10', broker: 'Broker', ranked: true }),
    listing({ id: 2, ref: 'A2', brokerId: '99', broker: 'Coordinator', ranked: false }),
  ], [snap({ reference: 'A1' }), snap({ reference: 'A2' })]);

  const { ranked, remainder } = rateByBroker(rows);
  assert.ok(!ranked.some((e) => e.label === 'Coordinator'));
  assert.equal(remainder.total, 1);
  assert.equal(ranked.reduce((n, e) => n + e.total, 0) + remainder.total, summarise(rows).total);
});

/* --------------------------------- crawl ---------------------------------- */

test('a crawl item normalises to the source-neutral snapshot shape', () => {
  // Field names taken verbatim from a live Bayutrix run on 2026-08-21.
  const r = normaliseCrawlItem({
    id: 12059220, externalID: '15530078',
    url: 'https://www.bayut.com/property/details-15530078.html',
    referenceNumber: 'ARZ-R-7569', isVerified: true, price: 120000,
    title: 'Upgraded | Furnished', purpose: 'for-rent', state: 'active',
    category: 'Residential; Apartments', agentName: 'Dennis Manalo',
    location: 'Icon Tower 2; JLT Cluster L; Jumeirah Lake Towers (JLT); Dubai; UAE',
  });
  assert.equal(r.reference, 'ARZ-R-7569');
  assert.equal(r.isTruCheck, true);
  assert.equal(r.bayutListingId, '15530078');
  // The community, not the tower and not the emirate.
  assert.equal(r.community, 'Jumeirah Lake Towers (JLT)');
  assert.equal(r.permit, null, 'Bayut publishes no RERA permit');
});

test('isVerified absent or falsey is not TruChecked', () => {
  assert.equal(normaliseCrawlItem({ referenceNumber: 'X' }).isTruCheck, false);
  assert.equal(normaliseCrawlItem({ referenceNumber: 'X', isVerified: 'yes' }).isTruCheck, false);
});

test('the TruCheck date comes from the detail record and is null without it', () => {
  const withDate = normaliseCrawlItem({
    referenceNumber: 'X', isVerified: true,
    verification: { status: 'verified', trucheckedAt: 1783517008, eligible: true },
  });
  assert.equal(withDate.truCheckedAt, new Date(1783517008 * 1000).toISOString());
  assert.equal(withDate.verificationStatus, 'verified');
  // Stage one alone gives the badge but not the date, and null must not read
  // as "never TruChecked" — that is a different state entirely.
  assert.equal(normaliseCrawlItem({ referenceNumber: 'X', isVerified: true }).truCheckedAt, null);
});

/* --------------------------------- misc ----------------------------------- */

test('days live counts whole days and survives a missing date', () => {
  const now = new Date('2026-08-21T12:00:00Z');
  assert.equal(daysLive('2026-08-01T10:00:00Z', now), 20);
  assert.equal(daysLive(null, now), null);
  assert.equal(daysLive('nonsense', now), null);
});

test('run ids are validated before reaching a URL path', () => {
  assert.equal(isRunId('abc123XYZ'), true);
  for (const bad of ['../../etc', 'a b', '', null, 'x'.repeat(64), 'a/b']) {
    assert.equal(isRunId(bad), false, String(bad));
  }
});

test('the crawl is pinned to our agency in config, not chosen by the caller', () => {
  assert.equal(CONFIG.agencyName, 'Aaronz & Co Real Estate');
  assert.equal(CONFIG.bayutAgencyExternalId, '10500');
  assert.match(CONFIG.bayutCompanyUrl, /aaronz-co-real-estate-10500/);
});

/* --------------------------- the card filters ----------------------------- */

import { ON_BAYUT } from '../src/truCheckModel.js';

/**
 * Each summary card filters to exactly the rows it counted. If a card reading
 * 237 filtered to a different set, the number and the table below it would
 * disagree — which is the one thing a clickable figure must never do.
 */

const mixed = () => buildRows(
  [
    listing({ id: 1, ref: 'A1' }),
    listing({ id: 2, ref: 'A2' }),
    listing({ id: 3, ref: 'A3' }),
  ],
  [snap({ reference: 'A1', isTruCheck: true }), snap({ reference: 'A2', isTruCheck: false })]
);

test('each card filters to exactly the rows it counted', () => {
  const rows = mixed();
  const s = summarise(rows);

  assert.equal(applyFilters(rows, { ...BLANK_FILTERS, state: 'truchecked' }).length, s.truchecked);
  assert.equal(applyFilters(rows, { ...BLANK_FILTERS, state: 'not' }).length, s.not);
  assert.equal(applyFilters(rows, { ...BLANK_FILTERS, state: 'missing' }).length, s.missing);
  assert.equal(applyFilters(rows, { ...BLANK_FILTERS, state: ON_BAYUT }).length, s.liveOnBayut);
});

test('the Live on Bayut filter spans both TruChecked and not, and excludes missing', () => {
  const rows = mixed();
  const onBayut = applyFilters(rows, { ...BLANK_FILTERS, state: ON_BAYUT });
  assert.equal(onBayut.length, 2);
  assert.equal(onBayut.every((r) => r.state !== 'missing'), true);
  assert.deepEqual(onBayut.map((r) => r.state).sort(), ['not', 'truchecked']);
});

test('a filtered view still reconciles with its own cards', () => {
  const rows = mixed();
  for (const state of [ON_BAYUT, 'truchecked', 'not', 'missing', '']) {
    const shown = applyFilters(rows, { ...BLANK_FILTERS, state });
    const s = summarise(shown);
    assert.equal(s.total, shown.length, state);
    assert.equal(s.truchecked + s.not + s.missing, s.total, state);
  }
});
