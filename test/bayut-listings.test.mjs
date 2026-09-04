import test from 'node:test';
import assert from 'node:assert/strict';
import {
  offeringOf, categoryClassOf, isOffPlan, communityOf, brokerOf, isRankedBroker,
  viewsByReference, buildRows, applyFilters, summarise, leaderboard, sortRows,
  optionsFor, BLANK_FILTERS, fmtAed,
} from '../src/bayutListings.js';

/**
 * Listings analytics, against the shapes the live PropSpace account returns.
 *
 * The field names below were read off the real payload on 2026-08-21, and two
 * of them are the reason these tests exist: offering is `type`, not
 * `property_status`, and `category` is a property type that has to be mapped
 * to residential/commercial rather than being that split already.
 */

const listing = (over = {}) => ({
  id: 1, ref: 'ARZ-R-7796', name: 'A flat', type: 'rent', category: 'Apartment',
  completion_status: null, property_status: 'Available', price: 120000,
  permit_number: '7117...', beds: 1, size: 800,
  agent: { id: 1505580, name: 'Paul Angeles', email: 'paul.a@aaronz.co' },
  area_location: { id: 22, name: 'Jumeirah Lake Towers' },
  sub_area_location: { id: 2564, name: 'lake point' },
  region: { id: 1, name: 'Dubai' },
  portals: ['propertyfinder', 'bayut'],
  created_at: '2026-08-01T10:00:00Z',
  ...over,
});

/* ------------------------------- derivations ----------------------------- */

test('offering comes from `type`, not `property_status`', () => {
  assert.equal(offeringOf(listing({ type: 'sale' })), 'sale');
  assert.equal(offeringOf(listing({ type: 'rent' })), 'rent');
  // property_status is a different axis: Available / Rented / Off-Plan / Upcoming.
  assert.equal(offeringOf(listing({ type: null, property_status: 'Rented' })), null);
});

test('residential and commercial are derived from `category`', () => {
  for (const c of ['Apartment', 'Villa', 'Townhouse', 'Penthouse', 'Hotel Apartment', 'Land Residential']) {
    assert.equal(categoryClassOf(listing({ category: c })), 'residential', c);
  }
  for (const c of ['Office', 'Retail', 'Warehouse', 'Showroom']) {
    assert.equal(categoryClassOf(listing({ category: c })), 'commercial', c);
  }
});

test('an unrecognised category is unclassified, never quietly residential', () => {
  // A default either way would file a new type into a headline number.
  assert.equal(categoryClassOf(listing({ category: 'Marina Berth' })), 'unclassified');
  assert.equal(categoryClassOf(listing({ category: null })), 'unclassified');
});

test('off-plan is completion_status, which subsumes property_status', () => {
  assert.equal(isOffPlan(listing({ completion_status: 'off_plan_primary' })), true);
  assert.equal(isOffPlan(listing({ completion_status: 'off_plan_secondary' })), true);
  assert.equal(isOffPlan(listing({ completion_status: 'ready_secondary' })), false);
  assert.equal(isOffPlan(listing({ completion_status: null })), false);
  // Measured live: the 6 property_status "Off-Plan" records are a strict
  // subset of the 11 flagged by completion_status, so this field alone is enough.
  assert.equal(isOffPlan(listing({ completion_status: null, property_status: 'Off-Plan' })), false);
});

test('community is the area, not the tower or the emirate', () => {
  assert.equal(communityOf(listing()), 'Jumeirah Lake Towers');
  assert.equal(communityOf(listing({ area_location: null })), null);
});

test('broker identity is the agent id, and the email is never read', () => {
  const b = brokerOf(listing());
  assert.equal(b.id, '1505580');
  assert.equal(b.name, 'Paul Angeles');
  assert.equal(b.email, undefined, 'emails are stripped on reassignment and must not be an identity');
  assert.equal(brokerOf(listing({ agent: null })).name, 'Unassigned');
});

test('absence from crm_agents means ranked; only an explicit false demotes', () => {
  const crm = new Map([['1', { inRanking: false, type: 'coordinator' }]]);
  assert.equal(isRankedBroker('1', crm), false);
  assert.equal(isRankedBroker('999', crm), true, 'an unclassified new joiner must still rank');
  assert.equal(isRankedBroker('1', null), true, 'no crm_agents at all cannot silently demote anyone');
});

/* ------------------------------- enrichment ------------------------------ */

const view = (ref, channel, count) => ({
  channel, count, entity: { target: 'listing', reference: ref },
});

test('view rows sum per reference across channels', () => {
  const m = viewsByReference([
    view('ARZ-R-7796', 'whatsapp', 10),
    view('ARZ-R-7796', 'whatsapp', 5),
    view('ARZ-R-7796', 'phone', 3),
    view('ARZ-S-5846', 'sms', 2),
  ]);
  assert.deepEqual(m.get('ARZ-R-7796'), { whatsapp: 15, sms: 0, phone: 3, total: 18 });
  assert.deepEqual(m.get('ARZ-S-5846'), { whatsapp: 0, sms: 2, phone: 0, total: 2 });
});

test('references join case- and whitespace-insensitively', () => {
  const m = viewsByReference([view('  arz-r-7796  ', 'whatsapp', 4)]);
  const rows = buildRows([listing({ ref: 'ARZ-R-7796' })], m, null);
  assert.equal(rows[0].whatsapp, 4);
});

test('a listing with no Bayut row shows zero and is never dropped', () => {
  // 298 of the 314 live listings are in exactly this state.
  const rows = buildRows([listing(), listing({ id: 2, ref: 'ARZ-R-0001' })], new Map(), null);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].views, 0);
  assert.equal(rows[1].whatsapp, 0);
});

test('a listing with no reference at all still appears', () => {
  const rows = buildRows([listing({ ref: null })], new Map([['X', { whatsapp: 9, sms: 0, phone: 0, total: 9 }]]), null);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].views, 0);
});

/* ------------------------------ reconciliation --------------------------- */

const SET = [
  listing({ id: 1, ref: 'A1', type: 'rent', category: 'Apartment' }),
  listing({ id: 2, ref: 'A2', type: 'sale', category: 'Office' }),
  listing({ id: 3, ref: 'A3', type: 'sale', category: 'Villa', completion_status: 'off_plan_primary' }),
  listing({ id: 4, ref: 'A4', type: 'rent', category: 'Retail', agent: { id: 99, name: 'Coordinator' } }),
  listing({ id: 5, ref: 'A5', type: null, category: 'Marina Berth' }),
];

const CRM = new Map([['99', { inRanking: false, type: 'coordinator' }]]);

test('every card equals the row count you would see with that split applied', () => {
  const rows = buildRows(SET, new Map(), CRM);
  const s = summarise(rows);

  assert.equal(s.total, rows.length);
  assert.equal(s.sale, rows.filter((r) => r.offering === 'sale').length);
  assert.equal(s.rent, rows.filter((r) => r.offering === 'rent').length);
  assert.equal(s.residential, rows.filter((r) => r.categoryClass === 'residential').length);
  assert.equal(s.commercial, rows.filter((r) => r.categoryClass === 'commercial').length);
  assert.equal(s.offPlan, rows.filter((r) => r.offPlan).length);
});

test('the splits partition the total exactly — nothing double-counted or lost', () => {
  const s = summarise(buildRows(SET, new Map(), CRM));
  assert.equal(s.sale + s.rent + s.noOffering, s.total);
  assert.equal(s.residential + s.commercial + s.unclassified, s.total);
});

test('reconciliation survives every filter, not just the unfiltered set', () => {
  const rows = buildRows(SET, new Map(), CRM);
  for (const f of [
    { ...BLANK_FILTERS, offering: 'sale' },
    { ...BLANK_FILTERS, categoryClass: 'commercial' },
    { ...BLANK_FILTERS, offPlan: 'yes' },
    { ...BLANK_FILTERS, community: 'Jumeirah Lake Towers' },
    { ...BLANK_FILTERS, priceFrom: '100000' },
  ]) {
    const shown = applyFilters(rows, f);
    const s = summarise(shown);
    assert.equal(s.total, shown.length, JSON.stringify(f));
    assert.equal(s.sale + s.rent + s.noOffering, s.total, JSON.stringify(f));
    assert.equal(s.residential + s.commercial + s.unclassified, s.total, JSON.stringify(f));
  }
});

test('the leaderboard always sums to the listings card', () => {
  const rows = buildRows(SET, new Map(), CRM);
  const { ranked, remainder } = leaderboard(rows);
  const summed = ranked.reduce((n, b) => n + b.total, 0) + (remainder?.total ?? 0);
  assert.equal(summed, summarise(rows).total);
});

test('an excluded agent never ranks, but their listings still count', () => {
  const rows = buildRows(SET, new Map(), CRM);
  const { ranked, remainder } = leaderboard(rows);
  assert.ok(!ranked.some((b) => b.name === 'Coordinator'), 'coordinator must not appear in the ranking');
  assert.equal(remainder.total, 1);
  assert.deepEqual(remainder.types, ['coordinator']);
  assert.equal(summarise(rows).total, 5, 'their listing is still in the headline');
});

test('with no crm_agents everyone ranks and there is no remainder row', () => {
  const { ranked, remainder } = leaderboard(buildRows(SET, new Map(), null));
  assert.equal(remainder, null);
  assert.equal(ranked.reduce((n, b) => n + b.total, 0), 5);
});

/* --------------------------------- filters ------------------------------- */

test('price bounds are inclusive at both ends', () => {
  const rows = buildRows([
    listing({ id: 1, price: 100000 }), listing({ id: 2, price: 200000 }), listing({ id: 3, price: 300000 }),
  ], new Map(), null);
  assert.equal(applyFilters(rows, { ...BLANK_FILTERS, priceFrom: '200000' }).length, 2);
  assert.equal(applyFilters(rows, { ...BLANK_FILTERS, priceTo: '200000' }).length, 2);
  assert.equal(applyFilters(rows, { ...BLANK_FILTERS, priceFrom: '200000', priceTo: '200000' }).length, 1);
});

test('an empty filter set changes nothing', () => {
  const rows = buildRows(SET, new Map(), CRM);
  assert.equal(applyFilters(rows, BLANK_FILTERS).length, rows.length);
});

test('the broker filter matches on id, so two people sharing a name stay apart', () => {
  const rows = buildRows([
    listing({ id: 1, agent: { id: 7, name: 'Sam Smith' } }),
    listing({ id: 2, agent: { id: 8, name: 'Sam Smith' } }),
  ], new Map(), null);
  assert.equal(applyFilters(rows, { ...BLANK_FILTERS, broker: '7' }).length, 1);
});

/* --------------------------------- sorting ------------------------------- */

test('nulls sort last in both directions', () => {
  const rows = [{ permit: 'B' }, { permit: null }, { permit: 'A' }];
  assert.deepEqual(sortRows(rows, 'permit', 'asc').map((r) => r.permit), ['A', 'B', null]);
  assert.deepEqual(sortRows(rows, 'permit', 'desc').map((r) => r.permit), ['B', 'A', null]);
});

test('numbers sort numerically, not as strings', () => {
  const rows = [{ views: 9 }, { views: 100 }, { views: 20 }];
  assert.deepEqual(sortRows(rows, 'views', 'desc').map((r) => r.views), [100, 20, 9]);
});

test('sorting never mutates the input', () => {
  const rows = [{ views: 1 }, { views: 2 }];
  sortRows(rows, 'views', 'desc');
  assert.deepEqual(rows.map((r) => r.views), [1, 2]);
});

/* ------------------------------- formatting ------------------------------ */

test('options are distinct, sorted and free of blanks', () => {
  const rows = buildRows(SET, new Map(), CRM);
  assert.deepEqual(optionsFor(rows, (r) => r.community), ['Jumeirah Lake Towers']);
  assert.deepEqual(optionsFor([{ c: null }, { c: '' }], (r) => r.c), []);
});

test('a zero or missing price reads as a dash, never AED 0', () => {
  assert.equal(fmtAed(0), '—');
  assert.equal(fmtAed(null), '—');
  assert.equal(fmtAed(120000), 'AED 120k');
  assert.equal(fmtAed(2_500_000), 'AED 2.50m');
});
