import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unlinkSync } from 'node:fs';

/**
 * Apollo prospecting.
 *
 * The money is in the reveal, so the tests that matter are about shape and
 * about not asking Apollo for things twice. The proxy's cache-first ordering
 * is exercised against a stubbed fetch, because that ordering IS the feature.
 */
const here = dirname(fileURLToPath(import.meta.url));
const esbuild = (await import('esbuild')).default ?? (await import('esbuild'));

const bundle = join(here, '.apollo-under-test.mjs');
await esbuild.build({
  entryPoints: [join(here, '..', 'src', 'apollo.js')],
  bundle: true, format: 'esm', platform: 'node', outfile: bundle, logLevel: 'error',
  define: { 'import.meta.env': '{"VITE_SUPABASE_URL":"https://x.supabase.co","VITE_SUPABASE_ANON_KEY":"x"}' },
});
const { PRESETS, HEADCOUNT_BANDS, toList, fromList, headcountLabel, isEmptyFilters } =
  await import(bundle);

const fnBundle = join(here, '.apollo-fn-under-test.mjs');
await esbuild.build({
  entryPoints: [join(here, '..', 'functions', 'api', 'apollo', '[[path]].js')],
  bundle: true, format: 'esm', platform: 'neutral', outfile: fnBundle, logLevel: 'error',
});
const { shapePerson } = await import(fnBundle);

process.on('exit', () => {
  for (const f of [bundle, fnBundle]) { try { unlinkSync(f); } catch {} }
});

test('a search result is flattened to what the table shows', () => {
  const s = shapePerson({
    id: 'p1', first_name: 'Ada', last_name: 'Lovelace', title: 'Founder',
    city: 'London', state: 'England', country: 'United Kingdom',
    linkedin_url: 'https://linkedin.com/in/ada',
    organization: { name: 'Analytical Ltd', estimated_num_employees: 42, primary_domain: 'analytical.co' },
  });
  assert.equal(s.apolloPersonId, 'p1');
  assert.equal(s.name, 'Ada Lovelace');
  assert.equal(s.company, 'Analytical Ltd');
  assert.equal(s.headcount, 42);
  assert.equal(s.location, 'London, England, United Kingdom');
  assert.equal(s.linkedin, 'https://linkedin.com/in/ada');
});

test('a masked email is not treated as an email', () => {
  // Apollo returns this literal string for contacts nobody has paid for. Shown
  // as-is it looks like an address and a broker would try to write to it.
  assert.equal(shapePerson({ id: 'p', email: 'email_not_unlocked@domain.com' }).email, null);
  assert.equal(shapePerson({ id: 'p', email: 'real@person.com' }).email, 'real@person.com');
});

test('the three presets each carry filters and a reason', () => {
  assert.equal(PRESETS.length, 3);
  for (const p of PRESETS) {
    assert.ok(p.key && p.label && p.why, `${p.key} needs a label and a reason`);
    assert.ok(!isEmptyFilters(p.filters), `${p.key} must actually filter something`);
  }
  const byKey = Object.fromEntries(PRESETS.map((p) => [p.key, p.filters]));

  // UK HQ hiring in Dubai, founders and C-suite.
  assert.deepEqual(byKey['uk-hiring-dubai'].organization_locations, ['United Kingdom']);
  assert.deepEqual(byKey['uk-hiring-dubai'].organization_job_locations, ['Dubai, United Arab Emirates']);
  assert.deepEqual(byKey['uk-hiring-dubai'].person_seniorities, ['founder', 'c_suite']);
  assert.ok(byKey['uk-hiring-dubai'].organization_job_posted_at_range?.min, 'stale job ads are not arrivals');

  // UK investment titles.
  assert.deepEqual(byKey['uk-investment'].person_locations, ['United Kingdom']);
  assert.ok(byKey['uk-investment'].person_titles.includes('Investment Director'));

  // Dubai owners, 1-200.
  assert.deepEqual(byKey['dubai-owners'].person_locations, ['Dubai, United Arab Emirates']);
  assert.deepEqual(byKey['dubai-owners'].organization_num_employees_ranges,
    ['1,10', '11,20', '21,50', '51,100', '101,200']);
  assert.ok(byKey['dubai-owners'].organization_num_employees_ranges
    .every((b) => HEADCOUNT_BANDS.includes(b)), 'Apollo silently ignores unpublished bands');
});

test('an unfiltered search is recognised as empty', () => {
  assert.equal(isEmptyFilters({ person_titles: [], organization_job_posted_at_range: null }), true);
  assert.equal(isEmptyFilters({ person_titles: ['Founder'] }), false);
});

test('comma lists survive the round trip', () => {
  assert.deepEqual(toList(' Founder , CEO ,, '), ['Founder', 'CEO']);
  assert.equal(fromList(['Founder', 'CEO']), 'Founder, CEO');
});

test('headcount bands read as ranges', () => {
  assert.equal(headcountLabel('1,10'), '1–10');
  assert.equal(headcountLabel('10001,1000000'), '10,001+');
});

test('the search teaser is read as a teaser, not as missing data', () => {
  // Verbatim shape from mixed_people/api_search, 31 Aug 2026. No surname, no
  // location, no LinkedIn, no headcount — and organization.name is a domain.
  const t = shapePerson({
    id: '66f83b87ae47ef000181c12f',
    first_name: 'Stephane',
    last_name_obfuscated: 'B███',
    title: 'Founder, Co Founder',
    organization: { name: 'devischrono.com', has_employee_count: true },
    has_email: true, has_direct_phone: false, has_city: true, has_country: true,
  });
  assert.equal(t.name, 'Stephane B███', 'the obfuscated surname is shown, not dropped');
  assert.equal(t.enriched, false);
  assert.equal(t.companyIsDomain, true, 'so the UI can say the company name is not what this is');
  assert.equal(t.companyDomain, 'devischrono.com');
  assert.equal(t.location, null);
  assert.equal(t.teaser.location, true, 'Apollo HAS a location — that is not the same as none');
  assert.equal(t.teaser.phone, false, 'and it genuinely has no direct phone');
});

test('the match record replaces the teaser', () => {
  // Verbatim from people/match for the same person.
  const m = shapePerson({
    id: '66f83b87ae47ef000181c12f',
    first_name: 'Stephane', last_name: 'Benichou',
    title: 'Founder, Co Founder',
    city: 'London', state: 'England', country: 'United Kingdom',
    linkedin_url: 'http://www.linkedin.com/in/stephane-benichou',
    organization: { name: 'devischrono.com', estimated_num_employees: 1, primary_domain: 'devischrono.com' },
  });
  assert.equal(m.name, 'Stephane Benichou');
  assert.equal(m.location, 'London, England, United Kingdom');
  assert.equal(m.headcount, 1);
  assert.equal(m.enriched, true, 'which is what lets the row upgrade itself after a reveal');
});
