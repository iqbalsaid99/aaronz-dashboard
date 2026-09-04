import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseProject, normaliseDetail, FILTERS, ORDERINGS, DEAD_ORDERINGS,
  SALE_STATUSES, UNIT_TYPES, quarterRange, quarterOptions, quarterLabel,
  priceRange, sizeRange, fmtMoney, pageCount, PAGE_SIZE,
} from '../src/reellyParse.js';

/**
 * Reelly parsing, against rows captured from the live API on 2026-08-21.
 *
 * The docs are wrong in several places that matter — `developer` is a plain
 * string rather than `{ id, name }`, typical_units carries from_price_aed
 * rather than the documented min_price, and available_unit_types_display is a
 * list rather than a label. These tests are written from the live payload, and
 * that disagreement is the reason they exist.
 */

/* ------------------------- the measured filter matrix -------------------- */

test('the filters known to be dead are recorded as dead', () => {
  // Each measured live: every value, including deliberate nonsense, returned
  // the full 49-project dataset or nothing at all.
  assert.equal(FILTERS.bedrooms.active, false);
  assert.equal(FILTERS.completion_quarters.active, false);
  assert.equal(FILTERS.districts.active, false);
});

test('the filters the UI offers are all recorded as active', () => {
  for (const k of [
    'search_query', 'sale_status', 'status', 'unit_bedrooms', 'unit_types',
    'unit_price_from', 'unit_price_to', 'has_escrow', 'post_handover',
    'completion_date_ranges',
  ]) {
    assert.equal(FILTERS[k].active, true, `${k} is offered in the UI and must be verified active`);
  }
});

test('no dead ordering key is offered in the dropdown', () => {
  const offered = ORDERINGS.map(([v]) => v.replace(/^-/, ''));
  for (const dead of DEAD_ORDERINGS) {
    assert.ok(!offered.includes(dead), `${dead} is ignored by the API and must not be offered`);
  }
});

test('only the two sale statuses that exist in the data are offered', () => {
  // announced, presale and start_of_sales are accepted by the API and match
  // zero projects — three dropdown entries that always empty the screen.
  assert.deepEqual(SALE_STATUSES.map(([v]) => v), ['on_sale', 'out_of_stock']);
  assert.ok(!UNIT_TYPES.includes('Villa'), 'Villa is documented but matches nothing here');
});

/* -------------------------------- quarters ------------------------------- */

test('a quarter range matches the one verified against the live API', () => {
  // This exact range returned the 7 projects labelled "Q4 2027".
  assert.equal(quarterRange(2027, 4), '1822348800-1830297599');
});

test('quarter ranges are contiguous and non-overlapping', () => {
  const [, q3End] = quarterRange(2027, 3).split('-').map(Number);
  const [q4Start] = quarterRange(2027, 4).split('-').map(Number);
  assert.equal(q4Start - q3End, 1, 'Q4 must start the second after Q3 ends');
});

test('the quarter picker spans a year back to four years forward', () => {
  const opts = quarterOptions(new Date('2026-08-21T00:00:00Z'));
  assert.equal(opts.length, 21);
  assert.equal(opts[0].label, 'Q3 2025');
  assert.equal(opts[4].label, quarterLabel(2026, 3), 'the current quarter sits at index 4');
  assert.equal(opts[opts.length - 1].label, 'Q3 2030');
});

test('quarter maths rolls the year correctly at the boundary', () => {
  const opts = quarterOptions(new Date('2026-01-15T00:00:00Z'));
  assert.equal(opts[0].label, 'Q1 2025');
  assert.equal(opts[4].label, 'Q1 2026');
});

/* -------------------------------- the list ------------------------------- */

const LIST_ROW = {
  id: 12,
  slug_name: 'one-crescent-palm',
  name: 'One Crescent Palm',
  developer: 'AHS Properties',
  construction_status: 'under_construction',
  construction_status_display: 'Under Construction',
  sale_status: 'on_sale',
  sale_status_display: 'On Sale',
  available_unit_types_display: ['Apartments', 'Penthouse'],
  short_description: 'Ultra-luxury residences.',
  completion_date: 'Q4 2027',
  completion_datetime: '2027-12-31T00:00:00Z',
  min_price: 180000000.004825,
  max_price: 180000000.004825,
  price_currency: 'AED',
  min_size: 26050.0,
  max_size: 26050.0,
  area_unit: 'sqft',
  units_count: 25,
  building_count: 1,
  location: {
    id: 1267, region: 'Dubai', district: 'Palm Jumeirah', sector: 'Palm Jumeirah',
  },
  cover_image: { url: 'https://api.reelly.io/vault/x.png' },
  updated_at: '2026-08-21T04:49:47Z',
};

test('a list row normalises to what the card shows', () => {
  const p = normaliseProject(LIST_ROW);
  assert.equal(p.id, 12);
  assert.equal(p.name, 'One Crescent Palm');
  assert.equal(p.developer, 'AHS Properties');
  assert.equal(p.saleStatusLabel, 'On Sale');
  assert.equal(p.district, 'Palm Jumeirah');
  assert.equal(p.region, 'Dubai');
  assert.equal(p.completionLabel, 'Q4 2027');
  assert.deepEqual(p.unitTypes, ['Apartments', 'Penthouse']);
  assert.equal(p.cover, 'https://api.reelly.io/vault/x.png');
});

test('available_unit_types_display is a list on live responses, not a label', () => {
  // Guarded because the docs read as though it were a single string.
  assert.deepEqual(normaliseProject({ available_unit_types_display: ['Duplex'] }).unitTypes, ['Duplex']);
  assert.deepEqual(normaliseProject({ available_unit_types_display: 'Duplex' }).unitTypes, ['Duplex']);
  assert.deepEqual(normaliseProject({}).unitTypes, []);
});

test('an empty row normalises rather than throwing', () => {
  const p = normaliseProject({});
  assert.equal(p.name, 'Untitled project');
  assert.equal(p.developer, null);
  assert.equal(p.region, null);
  assert.equal(p.currency, 'AED');
  assert.equal(p.areaUnit, 'sqft');
});

test('a blank region string is an absence, not an empty label', () => {
  // Three projects in the live set carry region "".
  assert.equal(normaliseProject({ location: { region: '' } }).region, null);
});

/* --------------------------------- money --------------------------------- */

test('a zero price is "not published", never AED 0', () => {
  // Four of the 49 live projects carry min_price 0.
  assert.equal(fmtMoney(0), null);
  assert.equal(priceRange(0, 0), null);
  assert.equal(priceRange(null, null), null);
});

test('a range collapses to one figure when both ends agree', () => {
  assert.equal(priceRange(180000000, 180000000, 'AED'), 'AED 180m');
});

test('a range with only one end shows that end', () => {
  assert.equal(priceRange(0, 11097828, 'AED'), 'AED 11m');
  assert.equal(priceRange(1641666, 0, 'AED'), 'AED 1.6m');
});

test('sizes read as a range in the unit the API was asked for', () => {
  assert.equal(sizeRange(500, 26050, 'sqft'), '500 – 26,050 sqft');
  assert.equal(sizeRange(26050, 26050, 'sqft'), '26,050 sqft');
  assert.equal(sizeRange(0, 0, 'sqft'), null);
});

/* ------------------------------- pagination ------------------------------- */

test('page count follows the fixed page size', () => {
  assert.equal(PAGE_SIZE, 24);
  assert.equal(pageCount(49), 3);
  assert.equal(pageCount(24), 1);
  assert.equal(pageCount(0), 1, 'an empty result is still one page, not zero');
});

/* -------------------------------- the detail ------------------------------ */

const DETAIL_ROW = {
  ...LIST_ROW,
  overview: 'A landmark address.',
  escrow_number: '12711866920002',
  post_handover: false,
  service_charge: '26 AED/sqft',
  readiness_progress: 68.7,
  furnishing_display: 'Furnished',
  marketing_brochure: 'https://reelly-backend.s3.amazonaws.com/x.pdf',
  project_amenities: [{ amenity: { name: 'World Class Spa' } }, { amenity: { name: 'Private Beach' } }],
  payment_plans: [{
    id: 39, name: 'Payment Plan 60/40', duration_months: 0, months_after_handover: null,
    steps: [
      { id: 1, name: 'On booking', percentage: 50.0, stage_type: 'on_booking', fixed_amount: 0.0 },
      { id: 2, name: 'During construction', percentage: 20.0, stage_type: 'during_construction', fixed_amount: 0.0 },
      { id: 3, name: 'Upon Handover', percentage: 30.0, stage_type: 'on_handover', fixed_amount: 0.0 },
    ],
  }],
  typical_units: [{
    bedrooms: 6, from_price_aed: 180000000, to_price_aed: 180000000,
    from_size_sqft: 26050.0, to_size_sqft: 26050.0,
  }],
  buildings: [{ id: 48, name: 'Building', building_type_display: 'Unknown', floors_count: null, description: 'Only 25 residences' }],
};

test('the detail carries what the list cannot', () => {
  const p = normaliseDetail(DETAIL_ROW);
  assert.equal(p.escrowNumber, '12711866920002');
  assert.equal(p.postHandover, false);
  assert.equal(p.serviceCharge, '26 AED/sqft');
  assert.equal(p.readiness, 68.7);
  assert.deepEqual(p.amenities, ['World Class Spa', 'Private Beach']);
  assert.equal(p.paymentPlans[0].steps.length, 3);
  assert.equal(p.paymentPlans[0].steps[0].percentage, 50);
});

test('typical units follow the live field names, not the documented ones', () => {
  // Docs promise min_price / max_price / unit_type; the API sends
  // from_price_aed / to_price_aed / from_size_sqft and no unit_type at all.
  const u = normaliseDetail(DETAIL_ROW).typicalUnits[0];
  assert.equal(u.bedrooms, 6);
  assert.equal(u.fromPrice, 180000000);
  assert.equal(u.fromSize, 26050);
});

test('post_handover false is preserved, and missing is null — they differ', () => {
  assert.equal(normaliseDetail({ post_handover: false }).postHandover, false);
  assert.equal(normaliseDetail({ post_handover: true }).postHandover, true);
  assert.equal(normaliseDetail({}).postHandover, null, 'unknown must not read as "no"');
});

test('a project with every optional block null normalises to empty lists', () => {
  // Two projects in the live set come back like this.
  const p = normaliseDetail({
    id: 29, name: null, payment_plans: null, typical_units: null,
    project_amenities: null, buildings: null, cover_image: null, developer: null,
  });
  assert.deepEqual(p.paymentPlans, []);
  assert.deepEqual(p.typicalUnits, []);
  assert.deepEqual(p.amenities, []);
  assert.deepEqual(p.buildings, []);
  assert.equal(p.cover, null);
  assert.equal(p.name, 'Untitled project');
});

