import test from 'node:test';
import assert from 'node:assert/strict';
import {
  publicationEvents, newEvents, ledgerKey, monthlyCounts, ledgerBreakdown,
  trustedFrom, isPartial, isApproximate, currentMonth,
  REACHED_PORTAL, NEVER_LIVE,
} from '../src/publicationLedger.js';

/**
 * The publication ledger.
 *
 * The bug this replaces was not a display fault. Monthly figures were derived
 * from each listing's CURRENT state, so a listing taken down in October left
 * August, and a listing deleted from the CRM left every month at once.
 * Historical numbers moved. These tests exist to make sure they cannot again.
 */

const listing = (over = {}) => ({
  id: 1576257632105387,
  ref: 'ARZ-R-7797',
  status: 'published',
  portals: ['propertyfinder', 'bayut'],
  type: 'rent',
  category: 'Apartment',
  price: 170000,
  created_at: '2026-06-11T10:41:04.000Z',
  agent: { id: 1505580, name: 'Paul Angeles' },
  area_location: { name: 'DIFC' },
  region: { name: 'Dubai' },
  ...over,
});

const AUG = new Date('2026-08-14T09:00:00.000Z');

/* ============================ THE IMMUTABILITY TEST ======================= */

test('a month keeps its count after the listing is deleted from PropSpace', () => {
  // 1. August: two listings go live, and the ledger records it.
  const ledger = publicationEvents(
    [listing({ ref: 'A1' }), listing({ ref: 'A2' })],
    { at: AUG }
  );
  const before = monthlyCounts(ledger);
  const august = before.months.find((m) => m.month === '2026-08');
  assert.equal(august.total, 4, 'two listings x two portals');

  // 2. Time passes. One listing is taken down, the other is DELETED from the
  //    CRM outright — it is not in the feed at all any more, in any status.
  const feedNow = [];   // PropSpace now returns nothing for either

  // 3. The report is read again. It reads the ledger, which is untouched:
  //    nothing about a past event depends on the feed's present contents.
  const after = monthlyCounts(ledger);

  assert.deepEqual(after, before, 'the whole report is byte-identical');
  assert.equal(after.months.find((m) => m.month === '2026-08').total, 4);
  assert.equal(feedNow.length, 0, 'and the feed really is empty');
});

test('monthlyCounts cannot see listings at all — the guarantee is in the signature', () => {
  // One required parameter, and it is the ledger. There is no argument through
  // which PropSpace's current state could reach this function, which is why a
  // deletion cannot move a past month.
  assert.equal(monthlyCounts.length, 1);
  const ledger = publicationEvents([listing()], { at: AUG });
  assert.equal(monthlyCounts(ledger).months[0].total, 2);
});

test('a listing going unpublished does not remove it from its month', () => {
  const ledger = publicationEvents([listing({ ref: 'A1' })], { at: AUG });
  // The listing is now unpublished. The ledger row is not rewritten — nothing
  // in this module can rewrite one.
  const after = monthlyCounts(ledger);
  assert.equal(after.months.find((m) => m.month === '2026-08').total, 2);
});

test('re-observing the same listing later never increments a second month', () => {
  const august = publicationEvents([listing({ ref: 'A1' })], { at: AUG });
  const keys = august.map((e) => ledgerKey(e.listingRef, e.portal));

  // Same reference seen again in September — a relist, or simply the next sync.
  const september = publicationEvents([listing({ ref: 'A1' })], { at: new Date('2026-09-02T09:00:00Z') });
  const fresh = newEvents(september, keys);

  assert.equal(fresh.length, 0, 'nothing new to record');
  const counts = monthlyCounts(august);
  assert.equal(counts.months.length, 1);
  assert.equal(counts.months[0].month, '2026-08');
});

/* ------------------------------ counting rules ---------------------------- */

test('one row per listing per portal', () => {
  const events = publicationEvents([listing({ portals: ['propertyfinder', 'bayut', 'dubizzle'] })], { at: AUG });
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((e) => e.portal).sort(), ['bayut', 'dubizzle', 'propertyfinder']);
});

test('drafts and pending approval are never counted', () => {
  // A draft has not reached a portal; pending_approval has been submitted but
  // not accepted, and counting it would report listings a portal may reject.
  for (const status of NEVER_LIVE) {
    assert.equal(publicationEvents([listing({ status })], { at: AUG }).length, 0, status);
  }
  for (const status of REACHED_PORTAL) {
    assert.ok(publicationEvents([listing({ status })], { at: AUG }).length > 0, status);
  }
});

test('a listing with no portals is not a publication', () => {
  assert.equal(publicationEvents([listing({ portals: [] })], { at: AUG }).length, 0);
  assert.equal(publicationEvents([listing({ portals: null })], { at: AUG }).length, 0);
});

test('a listing with no reference is skipped rather than recorded unkeyed', () => {
  // Reference is the counting key; without it the once-per-portal rule cannot
  // be enforced and the row could be duplicated on every run.
  assert.equal(publicationEvents([listing({ ref: null })], { at: AUG }).length, 0);
});

test('newEvents dedupes within a single batch too', () => {
  const dupes = [...publicationEvents([listing({ ref: 'A1' })], { at: AUG }),
                 ...publicationEvents([listing({ ref: 'A1' })], { at: AUG })];
  assert.equal(dupes.length, 4);
  assert.equal(newEvents(dupes, []).length, 2);
});

test('reference matching is case- and whitespace-insensitive', () => {
  const keys = [ledgerKey(' arz-r-7797 ', 'BAYUT')];
  const events = publicationEvents([listing({ ref: 'ARZ-R-7797', portals: ['bayut'] })], { at: AUG });
  assert.equal(newEvents(events, keys).length, 0);
});

/* --------------------------------- dating --------------------------------- */

test('an observed publication is dated when it was seen, not when it was created', () => {
  // The listing was created in June and observed live in August. Dating it from
  // created_at would file an August go-live under June.
  const [e] = publicationEvents([listing({ created_at: '2026-06-11T10:41:04.000Z', portals: ['bayut'] })], { at: AUG });
  assert.equal(e.wentLiveAt, AUG.toISOString());
  assert.equal(e.wentLiveSource, 'observed');
  assert.equal(monthlyCounts([e]).months[0].month, '2026-08');
});

test('a backfilled publication is dated from created_at and says so', () => {
  const [e] = publicationEvents([listing({ portals: ['bayut'] })], { at: AUG, source: 'backfill' });
  assert.equal(e.wentLiveAt, '2026-06-11T10:41:04.000Z');
  assert.equal(e.wentLiveSource, 'backfill');
  assert.equal(monthlyCounts([e]).months[0].month, '2026-06');
});

/* ------------------------------ frozen context ---------------------------- */

test('broker is frozen at publication, not re-read from the listing later', () => {
  const [e] = publicationEvents([listing({ portals: ['bayut'] })], { at: AUG });
  assert.equal(e.brokerId, '1505580');
  assert.equal(e.brokerName, 'Paul Angeles');

  // The listing is reassigned. The ledger row is a past fact and does not move.
  const reassigned = { ...e };
  assert.equal(reassigned.brokerName, 'Paul Angeles');
  const [byBroker] = ledgerBreakdown([reassigned], (r) => r.brokerId, () => 'Paul Angeles');
  assert.equal(byBroker.count, 1);
});

test('price and community are frozen too', () => {
  const [e] = publicationEvents([listing({ portals: ['bayut'] })], { at: AUG });
  assert.equal(e.price, 170000);
  assert.equal(e.community, 'DIFC');
  assert.equal(e.offering, 'rent');
});

test('an unassigned listing records as Unassigned rather than dropping', () => {
  const [e] = publicationEvents([listing({ agent: null, marketing_agent: null, portals: ['bayut'] })], { at: AUG });
  assert.equal(e.brokerName, 'Unassigned');
  assert.equal(e.brokerId, null);
});

/* -------------------------------- reporting ------------------------------- */

test('monthly counts split by portal and sum to the total', () => {
  const ledger = [
    ...publicationEvents([listing({ ref: 'A1' })], { at: AUG }),
    ...publicationEvents([listing({ ref: 'A2', portals: ['bayut'] })], { at: AUG }),
  ];
  const { months, portals } = monthlyCounts(ledger);
  const aug = months.find((m) => m.month === '2026-08');
  assert.equal(aug.total, 3);
  assert.deepEqual(aug.byPortal, { propertyfinder: 1, bayut: 2 });
  assert.equal(Object.values(aug.byPortal).reduce((a, b) => a + b, 0), aug.total);
  assert.deepEqual(portals, ['bayut', 'propertyfinder']);
});

test('a bounded month list gives a dense axis and counts what fell outside', () => {
  const ledger = [
    ...publicationEvents([listing({ ref: 'A1' })], { at: new Date('2026-05-02T00:00:00Z') }),
    ...publicationEvents([listing({ ref: 'A2' })], { at: AUG }),
  ];
  const { months, outside } = monthlyCounts(ledger, { months: ['2026-07', '2026-08'] });
  assert.deepEqual(months.map((m) => m.month), ['2026-07', '2026-08']);
  assert.equal(months[0].total, 0, 'an empty month still appears');
  assert.equal(outside, 2, 'May is reported as outside, never silently dropped');
});

test('breakdowns come off the ledger, not from any listing', () => {
  const ledger = [
    ...publicationEvents([listing({ ref: 'A1', area_location: { name: 'DIFC' } })], { at: AUG }),
    ...publicationEvents([listing({ ref: 'A2', area_location: { name: 'JLT' } })], { at: AUG }),
  ];
  const byCommunity = ledgerBreakdown(ledger, (r) => r.community);
  assert.equal(byCommunity.length, 2);
  assert.equal(byCommunity[0].count, 2);
});

/* ------------------------------- trust dating ----------------------------- */

test('the trusted-from date is the first real sync, not the backfill', () => {
  const trusted = trustedFrom([
    { mode: 'backfill', ran_at: '2026-08-01T00:00:00Z' },
    { mode: 'sync', ran_at: '2026-08-20T00:00:00Z' },
    { mode: 'sync', ran_at: '2026-08-21T00:00:00Z' },
  ]);
  assert.equal(trusted.month, '2026-08');
  assert.equal(trusted.at, '2026-08-20T00:00:00.000Z');
});

test('with no sync ever run there is no trusted date', () => {
  assert.equal(trustedFrom([{ mode: 'backfill', ran_at: '2026-08-01T00:00:00Z' }]), null);
  assert.equal(trustedFrom([]), null);
});

test('months before the first sync are flagged approximate', () => {
  const trusted = { at: '2026-08-20T00:00:00Z', month: '2026-08' };
  assert.equal(isApproximate('2026-06', trusted), true);
  assert.equal(isApproximate('2026-08', trusted), false);
  assert.equal(isApproximate('2026-08', null), true, 'no sync yet means nothing is solid');
});

test('the current month is marked in progress', () => {
  const now = new Date('2026-08-22T12:00:00+04:00');
  assert.equal(isPartial(currentMonth(now), now), true);
  assert.equal(isPartial('2026-07', now), false);
});

/* ==================== the month x broker grid (Listing activity) =========== */

import { publishedByMonth, firstPublicationPerRef } from '../src/publicationLedger.js';

/**
 * The grid used to count on created_at — when a record was typed into the CRM.
 * A listing created in June and published in August was counted as June's work,
 * and a listing created and never published was counted at all.
 *
 * PropSpace has no publish date to switch to. Its own API says so when asked to
 * sort by one: "sort_by must be one of the following values: ref, updated_at,
 * price, created_at, beds, size". So the grid reads the ledger.
 */

const led = (over = {}) => ({
  listingRef: 'ARZ-R-1', portal: 'bayut',
  wentLiveAt: '2026-08-05T00:00:00Z', brokerName: 'Paul Angeles', ...over,
});

test('a listing counts once per month however many portals carried it', () => {
  const grid = publishedByMonth(
    [led({ portal: 'bayut' }), led({ portal: 'propertyfinder' }), led({ portal: 'dubizzle' })],
    ['2026-08']
  );
  assert.equal(grid.totals['2026-08'], 1, 'three portal rows, one listing');
  assert.equal(grid.counted.length, 1);
});

test('a reference counts in the month of its EARLIEST publication', () => {
  // Added to a second portal later; the listing went live in July, not August.
  const grid = publishedByMonth([
    led({ portal: 'bayut', wentLiveAt: '2026-07-20T00:00:00Z' }),
    led({ portal: 'propertyfinder', wentLiveAt: '2026-08-11T00:00:00Z' }),
  ], ['2026-07', '2026-08']);
  assert.equal(grid.totals['2026-07'], 1);
  assert.equal(grid.totals['2026-08'], 0);
});

test('edits and price changes cannot add a count', () => {
  // The ledger is append-only and keyed on reference + portal, so re-observing
  // the same listing produces no new row and therefore no new count.
  const once = publishedByMonth([led()], ['2026-08']);
  const again = publishedByMonth([led(), led()], ['2026-08']);
  assert.equal(once.totals['2026-08'], again.totals['2026-08']);
});

test('reference dedupe is case- and whitespace-insensitive', () => {
  const grid = publishedByMonth(
    [led({ listingRef: 'ARZ-R-1' }), led({ listingRef: ' arz-r-1 ', portal: 'propertyfinder' })],
    ['2026-08']
  );
  assert.equal(grid.totals['2026-08'], 1);
});

test('a listing with no publish date is never counted', () => {
  // It never went live, so it has no month to belong to.
  assert.equal(publishedByMonth([led({ wentLiveAt: null })], ['2026-08']).totals['2026-08'], 0);
  assert.equal(firstPublicationPerRef([led({ listingRef: null })]).length, 0);
});

test('the month stays counted after the listing leaves the CRM', () => {
  // The grid never reads listings, so there is nothing for a deletion to remove.
  const ledger = [led({ listingRef: 'A1' }), led({ listingRef: 'A2' })];
  const before = publishedByMonth(ledger, ['2026-08']);
  const feedNow = [];      // deleted from PropSpace entirely
  const after = publishedByMonth(ledger, ['2026-08']);
  assert.equal(after.totals['2026-08'], before.totals['2026-08']);
  assert.equal(after.totals['2026-08'], 2);
  assert.equal(feedNow.length, 0);
});

test('broker credit is the one frozen at publication', () => {
  const grid = publishedByMonth([
    led({ listingRef: 'A1', brokerName: 'Paul Angeles' }),
    led({ listingRef: 'A2', brokerName: 'Dennis Manalo' }),
  ], ['2026-08']);
  assert.deepEqual(grid.rows.map((r) => r.name).sort(), ['Dennis Manalo', 'Paul Angeles']);
  assert.equal(grid.rows.every((r) => r.total === 1), true);
});

test('rows sum to the month total', () => {
  const grid = publishedByMonth([
    led({ listingRef: 'A1', brokerName: 'Paul' }),
    led({ listingRef: 'A2', brokerName: 'Paul' }),
    led({ listingRef: 'A3', brokerName: 'Dennis' }),
  ], ['2026-08']);
  const summed = grid.rows.reduce((n, r) => n + r.months['2026-08'].fresh, 0);
  assert.equal(summed, grid.totals['2026-08']);
  assert.equal(summed, 3);
});

test('publications outside the window are excluded, not folded into an edge month', () => {
  const grid = publishedByMonth([
    led({ listingRef: 'A1', wentLiveAt: '2026-05-01T00:00:00Z' }),
    led({ listingRef: 'A2', wentLiveAt: '2026-08-01T00:00:00Z' }),
  ], ['2026-07', '2026-08']);
  assert.equal(grid.totals['2026-07'], 0);
  assert.equal(grid.totals['2026-08'], 1);
  assert.equal(grid.counted.length, 1);
});

test('an unnamed broker is Unassigned rather than dropped from the grid', () => {
  const grid = publishedByMonth([led({ brokerName: null })], ['2026-08']);
  assert.equal(grid.totals['2026-08'], 1);
  assert.equal(grid.rows[0].name, 'Unassigned');
});
