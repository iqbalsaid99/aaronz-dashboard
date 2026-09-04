import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unlinkSync } from 'node:fs';

/**
 * Command Centre.
 *
 * The briefing is arithmetic over one broker's book, and two of its sums are
 * the kind that look right and are not: adding annual rent to sale prices, and
 * a donut whose segments do not add up to the number in the middle of it.
 * Both are pinned here.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

// commandCentre.js imports propspace.js, which reads import.meta.env — Vite's
// job in the app, so the module is bundled and tested exactly as it ships.
const esbuild = (await import('esbuild')).default ?? (await import('esbuild'));
const bundle = join(here, '.command-centre-under-test.mjs');
await esbuild.build({
  entryPoints: [join(root, 'src', 'commandCentre.js')],
  bundle: true, format: 'esm', platform: 'node', outfile: bundle, logLevel: 'error',
  loader: { '.json': 'json' },
  define: { 'import.meta.env': '{"VITE_SUPABASE_URL":"http://x","VITE_SUPABASE_ANON_KEY":"x"}' },
});
const {
  buildBriefing, scoreLead, riskOf, matchesFor, isActionable, clientOf, normaliseBeds,
} = await import(bundle);
process.on('exit', () => { try { unlinkSync(bundle); } catch {} });

const NOW = new Date('2026-08-27T08:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

/** A lead as /leads actually returns it: nested status, contact block,
 *  requirements array, and an Auto Import note that proves nothing happened. */
const lead = ({
  id = 1, sub = 'In progress', type = 'Buyer', price = 1_000_000, created = daysAgo(1),
  notes = [], location = 'Dubai Marina', beds = 2, ref = null,
} = {}) => ({
  id,
  lead_type: type,
  created_at: created,
  status: { status: 'Open', sub_status: sub },
  contact: { first_name: 'A', last_name: 'Client', mobile: '+971 50 123 4567' },
  agents: [{ id: 1498226, name: 'Dennis' }],
  requirements: [{ location, sub_location: location, max_price: price, max_beds: beds, listing_reference: ref, unit_type: 'Apartment' }],
  notes: [{ user_name: 'Auto Import', notes: 'This lead is auto imported from Bayut.com', date: created }, ...notes],
});

const note = (text, at) => ({ user_name: 'Dennis', notes: text, date: at });

test('sale and rent are never added together', () => {
  const b = buildBriefing({
    leads: [
      lead({ id: 1, type: 'Buyer', price: 2_000_000 }),
      lead({ id: 2, type: 'Tenant', price: 120_000 }),
    ],
    now: NOW,
  });
  assert.equal(b.pipeline.total, 2_000_000, 'the ring is the sale book alone');
  assert.equal(b.rent.total, 120_000, 'rent is reported in its own units');
  assert.equal(b.pipeline.leads, 1);
  assert.equal(b.rent.leads, 1);
});

test('the ring segments add up to the number in the middle', () => {
  const leads = [
    lead({ id: 1, sub: 'Offer Made', price: 3_000_000 }),
    lead({ id: 2, sub: 'In progress', price: 2_000_000 }),
    lead({ id: 3, sub: 'Client not reachable', price: 1_000_000, created: daysAgo(90) }),
  ];
  const { pipeline } = buildBriefing({ leads, now: NOW });
  assert.equal(pipeline.high + pipeline.medium + pipeline.low, pipeline.total);
});

test('closed leads are out of the briefing entirely', () => {
  assert.equal(isActionable(lead({ sub: 'Successful' })), false);
  assert.equal(isActionable(lead({ sub: 'Not Interested' })), false);
  assert.equal(isActionable(lead({ sub: 'In progress' })), true);

  const b = buildBriefing({ leads: [lead({ id: 1, sub: 'Successful', price: 9_000_000 })], now: NOW });
  assert.equal(b.pipeline.total, 0, 'a won deal is not still in the pipeline');
  assert.equal(b.totals.closed, 1);
});

test('an untouched enquiry counts as never contacted, an Auto Import note notwithstanding', () => {
  const b = buildBriefing({ leads: [lead({ sub: 'Not yet contacted' })], now: NOW });
  assert.equal(b.neverContacted.length, 1);
});

test('a status move with no note is worked, so it is not never-contacted', () => {
  const b = buildBriefing({ leads: [lead({ sub: 'Called no reply' })], now: NOW });
  assert.equal(b.neverContacted.length, 0);
});

test('score rewards intent and punishes silence', () => {
  const fresh = scoreLead(lead({ sub: 'Offer Made', created: daysAgo(0) }), NOW);
  const stale = scoreLead(lead({
    sub: 'Offer Made', created: daysAgo(120), notes: [note('called', '01-04-2026 10:00')],
  }), NOW);
  assert.ok(fresh.score > stale.score, 'a live offer beats one nobody has touched since April');
  assert.equal(fresh.band, 'high');
  assert.ok(fresh.reasons.length >= 2, 'the score always ships with its reasons');
});

test('at risk means committed then quiet — not merely old', () => {
  // Committed and silent for three weeks.
  const r = riskOf(lead({ sub: 'Viewing arranged', created: daysAgo(30), notes: [note('booked', '06-08-2026 09:00')] }), NOW);
  assert.equal(r.level, 'high');
  assert.match(r.reason, /Viewing arranged/);

  // Old, but nobody ever committed to anything: that is a follow-up failure,
  // counted under never-contacted, not a deal at risk.
  assert.equal(riskOf(lead({ sub: 'Not yet contacted', created: daysAgo(200) }), NOW), null);

  // Committed yesterday: nothing is wrong yet.
  assert.equal(riskOf(lead({ sub: 'Offer Made', created: daysAgo(1) }), NOW), null);
});

test('matching honours what the client actually asked for', () => {
  const l = lead({ type: 'Buyer', price: 2_000_000, beds: 2, location: 'Dubai Marina', ref: 'OWN-1' });
  const listing = (over) => ({
    id: over.id, ref: over.ref ?? 'X', type: over.type ?? 'sale', price: over.price ?? 1_900_000,
    beds: over.beds ?? '2', area_location: { name: over.area ?? 'Dubai Marina' },
    sub_area_location: { name: over.sub ?? 'Marina Gate' },
  });

  const hits = matchesFor(l, [
    listing({ id: 1 }),                                  // fits
    listing({ id: 2, type: 'rent' }),                    // wrong type
    listing({ id: 3, area: 'Jumeirah Village Circle', sub: 'Marwa Homes' }), // wrong area
    listing({ id: 4, price: 4_000_000 }),                // double the budget
    listing({ id: 5, beds: '6' }),                       // far too big
    listing({ id: 7, beds: '1' }),                       // smaller than asked for
    listing({ id: 6, ref: 'OWN-1' }),                    // the one they enquired on
  ]);
  assert.deepEqual(hits.map((h) => h.listing.id), [1]);
});

test('a tenant is matched against rentals, not sales', () => {
  const t = lead({ type: 'Tenant', price: 150_000, beds: 1, location: 'JLT' });
  const base = { beds: '1', area_location: { name: 'Jumeirah Lake Towers' }, sub_area_location: { name: 'Cluster D' } };
  const hits = matchesFor(t, [
    { id: 1, ref: 'A', type: 'sale', price: 140_000, ...base },
    { id: 2, ref: 'B', type: 'rent', price: 140_000, ...base },
  ]);
  assert.deepEqual(hits.map((h) => h.listing.id), [2], 'and "JLT" resolves to "Jumeirah Lake Towers"');
});

test('the client block survives a lead with no contact details', () => {
  const bare = { ...lead(), contact: {} };
  const c = clientOf(bare);
  assert.equal(c.mobile, null, 'so the card shows "no number" rather than a dead Call button');
  assert.equal(c.name, 'Unnamed contact');
});

test('the two bedroom vocabularies are reconciled', () => {
  assert.equal(normaliseBeds('studio'), 0, 'leads say studio');
  assert.equal(normaliseBeds('0.5'), 0, 'the live book says 0.5 for the same thing');
  assert.equal(normaliseBeds('0'), 0);
  assert.equal(normaliseBeds('2'), 2);
  assert.equal(normaliseBeds(''), null, 'unstated is not zero');
});

test('nobody is shown less than they asked for', () => {
  const l = lead({ type: 'Buyer', price: 2_000_000, beds: 2, location: 'Dubai Marina' });
  const at = (id, beds) => ({
    id, ref: 'R' + id, type: 'sale', price: 1_500_000, beds,
    area_location: { name: 'Dubai Marina' }, sub_area_location: { name: 'Marina Gate' },
  });
  const ids = matchesFor(l, [at(1, '0.5'), at(2, '1'), at(3, '2'), at(4, '3'), at(5, '4')])
    .map((h) => h.listing.id).sort();
  assert.deepEqual(ids, [3, 4], 'their size or one bigger — never a studio, never smaller');
});

test('a studio hunter is not sold a four-bed', () => {
  const l = lead({ type: 'Tenant', price: 60_000, beds: 'studio', location: 'JLT' });
  const at = (id, beds) => ({
    id, ref: 'R' + id, type: 'rent', price: 55_000, beds,
    area_location: { name: 'Jumeirah Lake Towers' }, sub_area_location: { name: 'Icon Tower 2' },
  });
  const ids = matchesFor(l, [at(1, '0'), at(2, '1'), at(3, '4')]).map((h) => h.listing.id).sort();
  assert.deepEqual(ids, [1, 2]);
});

test('the client’s own building sorts to the front', () => {
  const l = lead({ type: 'Buyer', price: 2_000_000, beds: 2, location: 'Jumeirah Lake Towers' });
  l.requirements[0].sub_location = 'Icon Tower 2';
  const at = (id, sub) => ({
    id, ref: 'R' + id, type: 'sale', price: 1_500_000, beds: '2',
    area_location: { name: 'Jumeirah Lake Towers' }, sub_area_location: { name: sub },
  });
  const hits = matchesFor(l, [at(1, 'Lake Point Tower'), at(2, 'Icon Tower 2')]);
  assert.equal(hits[0].listing.id, 2);
  assert.equal(hits[0].sameBuilding, true);
  assert.equal(hits[1].sameBuilding, false);
});

test('the CRM’s literal "undefined" is not a client name', () => {
  const l = lead();
  l.contact = { first_name: '', last_name: 'undefined', mobile: '43039222' };
  assert.equal(clientOf(l).name, 'Unnamed contact');
});

test('one card per person, however many enquiries they raise', () => {
  const mk = (id) => {
    const x = lead({ id, sub: 'Viewing arranged', price: 2_000_000, beds: 2, location: 'Dubai Marina' });
    x.contact = { id: 999, first_name: 'Same', last_name: 'Person', mobile: '+97150' };
    return x;
  };
  const listing = {
    id: 1, ref: 'R1', type: 'sale', price: 1_800_000, beds: '2',
    area_location: { name: 'Dubai Marina' }, sub_area_location: { name: 'Marina Gate' },
  };
  const b = buildBriefing({ leads: [mk(1), mk(2), mk(3)], listings: [listing], now: NOW });
  assert.equal(b.matches.length, 1);
});

test('the CRM writes "<first name> undefined" into last_name, and it never reaches the screen', () => {
  // Not a rare record: this is the shape of all 500 leads in a live sample,
  // 471 of which repeat the first name verbatim. Joining the two fields put
  // "Hisham Hisham undefined" on the Command Centre.
  const withName = (first, last) => ({ ...lead(), contact: { first_name: first, last_name: last } });

  assert.equal(clientOf(withName('Hisham', 'Hisham undefined')).name, 'Hisham');
  assert.equal(clientOf(withName('Evelyn Jones-Day', 'Evelyn Jones-Day undefined')).name, 'Evelyn Jones-Day');
  assert.equal(clientOf(withName('Ar.', 'Ar. undefined')).name, 'Ar.');

  // A whole-field "undefined", which an earlier fix already covered.
  assert.equal(clientOf(withName('', 'undefined')).name, 'Unnamed contact');

  // And a genuine surname must still survive all of that.
  assert.equal(clientOf(withName('Matthew', 'White')).name, 'Matthew White');
});
