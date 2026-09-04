import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { unlinkSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * listings.js reaches the CRM through apiFetch, which imports the Supabase
 * client, which reads import.meta.env and does not exist outside Vite. Only the
 * pure shaping is under test here, so the client is stubbed out and the module
 * is written into src/ — its own './time.js' import has to keep resolving.
 */
const src = join(here, '..', 'src', 'listings.js');
const tmp = join(here, '..', 'src', '.listing-book-under-test.mjs');
await writeFile(tmp, (await readFile(src, 'utf8'))
  .replace(/import\s*\{\s*apiFetch\s*\}\s*from\s*["'][^"']+["'];?/,
    'const apiFetch = () => { throw new Error("no network in this test"); };'));
const { listingBookReport } = await import(tmp);
process.on('exit', () => { try { unlinkSync(tmp); } catch {} });

const listing = (over = {}) => ({
  id: Math.random(), ref: 'AZ-1', type: 'rent', price: 100_000,
  created_at: '2026-08-01T00:00:00Z', agent: { name: 'Dennis Manalo' }, ...over,
});

test('brokers rank on live stock, not on everything they hold', () => {
  const { rows } = listingBookReport({
    live: [
      listing({ agent: { name: 'Ana' } }),
      listing({ agent: { name: 'Ana' } }),
      listing({ agent: { name: 'Ben' } }),
    ],
    draft: Array.from({ length: 9 }, () => listing({ agent: { name: 'Ben' } })),
  });

  assert.equal(rows[0].name, 'Ana', 'two live beats one live plus nine drafts');
  assert.equal(rows[0].rank, 1);
  assert.equal(rows[1].name, 'Ben');
  assert.equal(rows[1].rank, 2);
});

test('a broker with nothing live still appears, with their drafts counted', () => {
  // The whole point of the breakdown: someone holding only unfinished work is
  // on the page, not missing from it.
  const { rows } = listingBookReport({
    live: [listing({ agent: { name: 'Ana' } })],
    pending: [listing({ agent: { name: 'Cara' } })],
    draft: [listing({ agent: { name: 'Cara' } }), listing({ agent: { name: 'Cara' } })],
  });

  const cara = rows.find((r) => r.name === 'Cara');
  assert.ok(cara, 'a broker with no live stock must still be listed');
  assert.equal(cara.live, 0);
  assert.equal(cara.pending, 1);
  assert.equal(cara.draft, 2);
  assert.equal(cara.held, 3);
});

test('held is live plus awaiting plus draft, per broker and in total', () => {
  const report = listingBookReport({
    live: [listing({ agent: { name: 'Ana' } }), listing({ agent: { name: 'Ben' } })],
    pending: [listing({ agent: { name: 'Ana' } })],
    draft: [listing({ agent: { name: 'Ana' } }), listing({ agent: { name: 'Ben' } })],
  });

  for (const r of report.rows) {
    assert.equal(r.held, r.live + r.pending + r.draft, `${r.name} does not add up`);
  }
  assert.equal(report.totals.held, 5);
  assert.equal(
    report.rows.reduce((n, r) => n + r.held, 0), report.totals.held,
    'the broker rows must sum to the headline, or the table is not auditable',
  );
});

test('house accounts carry no rank and sit below the people', () => {
  const { rows } = listingBookReport({
    live: [
      ...Array.from({ length: 40 }, () => listing({ agent: { name: 'Aaronz And Co Real Estate LLC' } })),
      listing({ agent: { name: 'Ana' } }),
    ],
  });

  assert.equal(rows[0].name, 'Ana', 'a house account must not top the ranking');
  assert.equal(rows[0].rank, 1);
  assert.equal(rows[1].house, true);
  assert.equal(rows[1].rank, null, 'nobody can be credited with the house book');
  assert.equal(rows[1].live, 40, 'but the stock is still reported');
});

test('rent and sale split only counts live stock', () => {
  const { totals } = listingBookReport({
    live: [listing({ type: 'sale' }), listing({ type: 'rent' }), listing({ type: 'rent' })],
    pending: [listing({ type: 'sale' }), listing({ type: 'sale' })],
    draft: [listing({ type: 'sale' })],
  });

  assert.equal(totals.live, 3);
  assert.equal(totals.sale, 1);
  assert.equal(totals.rent, 2);
  assert.equal(totals.sale + totals.rent, totals.live, 'every live listing is one or the other');
});

test('the report is counts only — no listing records travel into the document', () => {
  // The export is a headline summary. Carrying the records was what made it a
  // dozen pages nobody read.
  const report = listingBookReport({
    live: [listing({ ref: 'A' }), listing({ ref: 'B' })],
    pending: [listing({ ref: 'WAIT' })],
    draft: [listing({ ref: 'DRAFT' })],
  });

  assert.deepEqual(Object.keys(report).sort(), ['rows', 'totals']);
  for (const r of report.rows) {
    for (const v of Object.values(r)) {
      assert.ok(!Array.isArray(v), 'a broker row must carry numbers, not records');
    }
  }
  assert.equal(report.totals.live, 2);
  assert.equal(report.totals.draft, 1);
});

test('a listing older than the taken-down window is still counted as live', () => {
  // The January 2026 cut applies to withdrawals only. Stock is stock however
  // long it has been up.
  const { rows, totals } = listingBookReport({
    live: [listing({ created_at: '2019-04-04T00:00:00Z', agent: { name: 'Ana' } })],
  });
  assert.equal(totals.live, 1);
  assert.equal(rows[0].live, 1);
});
