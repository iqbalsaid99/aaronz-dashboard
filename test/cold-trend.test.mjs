import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unlinkSync } from 'node:fs';

/**
 * The cold trend.
 *
 * Two things are easy to get wrong here and both mislead rather than merely
 * being wrong: a bucket with no leads reading as 0% cold, and the current
 * part-week being plotted as if it were a whole one.
 */
const here = dirname(fileURLToPath(import.meta.url));
const esbuild = (await import('esbuild')).default ?? (await import('esbuild'));
const bundle = join(here, '.cold-trend-under-test.mjs');
await esbuild.build({
  entryPoints: [join(here, '..', 'src', 'coldTrend.js')],
  bundle: true, format: 'esm', platform: 'node', outfile: bundle, logLevel: 'error',
  loader: { '.json': 'json' },
  define: { 'import.meta.env': '{"VITE_SUPABASE_URL":"https://x.supabase.co","VITE_SUPABASE_ANON_KEY":"x"}' },
});
const { bucketsFor, coldSeries, trendOf, RECORD_START } = await import(bundle);
process.on('exit', () => { try { unlinkSync(bundle); } catch {} });

/** Cold = no human note AND a sub-status nobody moved. */
const lead = (day, { cold = true, agent = 'Henna' } = {}) => ({
  id: `${day}-${Math.random()}`,
  created_at: `${day}T09:00:00.000Z`,
  status: { status: 'Open', sub_status: cold ? 'Not yet contacted' : 'In progress' },
  agents: [{ id: 1, name: agent }],
  notes: [{ user_name: 'Auto Import', notes: 'imported', date: `${day.split('-').reverse().join('-')} 09:00` }],
});

test('the record starts in August 2026', () => {
  assert.equal(RECORD_START, '2026-08-01');
});

test('seven-day blocks run from the record start, not calendar weeks', () => {
  // 1 August 2026 is a Saturday. Calendar weeks would open the series with a
  // two-day stub whose rate swings on a handful of leads.
  const b = bucketsFor('2026-08-01', '2026-08-29', 'week');
  assert.deepEqual(b.map((x) => x.from),
    ['2026-08-01', '2026-08-08', '2026-08-15', '2026-08-22', '2026-08-29']);
  assert.equal(b[0].to, '2026-08-07');
});

test('weekly while the record is young, monthly once there is something to compare', () => {
  assert.equal(bucketsFor('2026-08-01', '2026-08-29', 'auto').length, 5, 'weeks');
  const later = bucketsFor('2026-08-01', '2026-12-10', 'auto');
  assert.deepEqual(later.map((b) => b.label), ['Aug', 'Sept', 'Oct', 'Nov', 'Dec']);
});

test('the bucket we are standing in is marked partial', () => {
  const b = bucketsFor('2026-08-01', '2026-08-25', 'week');
  const last = b[b.length - 1];
  assert.equal(last.partial, true, 'or a short week reads as an improvement');
  assert.equal(last.to, '2026-08-25');
  assert.ok(!b[0].partial);
});

test('the rate is cold over total, per bucket', () => {
  const leads = [
    lead('2026-08-02'), lead('2026-08-03'), lead('2026-08-04', { cold: false }),
    lead('2026-08-10', { cold: false }), lead('2026-08-11', { cold: false }),
  ];
  const s = coldSeries(leads, { start: '2026-08-01', today: '2026-08-14', mode: 'week' });
  assert.equal(s[0].total, 3);
  assert.equal(s[0].cold, 2);
  assert.ok(Math.abs(s[0].rate - 2 / 3) < 1e-9);
  assert.equal(s[1].rate, 0, 'a real zero: leads arrived and all were worked');
});

test('a bucket with no leads has no rate, and does not plot as zero', () => {
  const s = coldSeries([lead('2026-08-02')], { start: '2026-08-01', today: '2026-08-14', mode: 'week' });
  assert.equal(s[1].total, 0);
  assert.equal(s[1].rate, null, 'nothing to be cold is not 0% cold');
});

test('Property Management is excluded, exactly as the Cold card excludes it', () => {
  const leads = [
    // Property Management is a named list of people, not an account called
    // "Property Management" — leads carry the bare first name.
    lead('2026-08-02', { cold: true, agent: 'Kamille' }),
    lead('2026-08-03', { cold: false }),
  ];
  const s = coldSeries(leads, { start: '2026-08-01', today: '2026-08-07', mode: 'week' });
  assert.equal(s[0].total, 1, 'the PM lead is not in the sales denominator');
  assert.equal(s[0].rate, 0);
});

test('leads outside the record are ignored', () => {
  const s = coldSeries([lead('2026-07-30'), lead('2026-08-02')],
    { start: '2026-08-01', today: '2026-08-07', mode: 'week' });
  assert.equal(s[0].total, 1);
});

test('one measurement is not a trend', () => {
  const one = coldSeries([lead('2026-08-02')], { start: '2026-08-01', today: '2026-08-05', mode: 'week' });
  assert.equal(trendOf(one), null);

  const two = coldSeries(
    [lead('2026-08-02'), lead('2026-08-03'), lead('2026-08-10', { cold: false })],
    { start: '2026-08-01', today: '2026-08-14', mode: 'week' });
  const t = trendOf(two);
  assert.equal(t.improving, true, 'cold falling is the good direction');
  assert.ok(t.deltaPts < 0);
});
