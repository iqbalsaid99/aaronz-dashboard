import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dubaiDay, dubaiToday, dubaiYesterday, dubaiDaysAgo,
  lastCompleteDays, todayWindow, dubaiRange, dubaiMonthsAgo,
} from '../src/time.js';

/**
 * Window definitions, pinned to fixed instants.
 *
 * These exist because the windows are not what their names suggest: a day
 * window ends YESTERDAY. "Last 7 days" on 8 August is 1–7 August, not 1–8, and
 * not 2–8. The previous definition spanned eight calendar days, which put a
 * partial day in the denominator of every ratio on the Insights page.
 *
 * Dubai is UTC+4 with no daylight saving, so several of these deliberately sit
 * either side of the 20:00 UTC boundary where the Dubai date rolls over.
 */

// 08:00 Dubai on 8 August 2026 — comfortably mid-day, no boundary effects.
const AUG_8 = new Date('2026-08-08T04:00:00.000Z');

test('the worked example from the spec: 8 Aug, last 7 days = 1-7 Aug', () => {
  assert.equal(dubaiToday(AUG_8), '2026-08-08');
  assert.deepEqual(lastCompleteDays(7, AUG_8), { from: '2026-08-01', to: '2026-08-07' });
});

test('the window is exactly N days wide, and excludes today', () => {
  const days = (r) =>
    Math.round((new Date(r.to) - new Date(r.from)) / 86_400_000) + 1;

  for (const n of [1, 7, 30, 90]) {
    const r = lastCompleteDays(n, AUG_8);
    assert.equal(days(r), n, `${n}-day window spans ${days(r)} days`);
    assert.ok(r.to < dubaiToday(AUG_8), `${n}-day window must end before today`);
    assert.equal(r.to, dubaiYesterday(AUG_8));
  }
});

test('30 days on 8 Aug is 10 Jul - 7 Aug', () => {
  assert.deepEqual(lastCompleteDays(30, AUG_8), { from: '2026-07-09', to: '2026-08-07' });
});

test('month rollover: on the 1st, the window sits entirely in the previous month', () => {
  const aug1 = new Date('2026-08-01T04:00:00.000Z');       // 08:00 Dubai, 1 Aug
  assert.equal(dubaiToday(aug1), '2026-08-01');
  assert.deepEqual(lastCompleteDays(7, aug1), { from: '2026-07-25', to: '2026-07-31' });
});

test('month rollover across a short month', () => {
  const mar2 = new Date('2026-03-02T04:00:00.000Z');       // 08:00 Dubai, 2 Mar
  // 2026 is not a leap year: February has 28 days.
  assert.deepEqual(lastCompleteDays(7, mar2), { from: '2026-02-23', to: '2026-03-01' });
});

test('year rollover', () => {
  const jan1 = new Date('2026-01-01T04:00:00.000Z');
  assert.deepEqual(lastCompleteDays(7, jan1), { from: '2025-12-25', to: '2025-12-31' });
});

/* ------------------------- the UTC+4 offset itself ------------------------- */

test('Dubai date rolls over at 20:00 UTC, not midnight UTC', () => {
  // 19:59 UTC on 7 Aug is still 23:59 on 7 Aug in Dubai.
  assert.equal(dubaiDay(new Date('2026-08-07T19:59:00.000Z')), '2026-08-07');
  // 20:00 UTC on 7 Aug is already 00:00 on 8 Aug in Dubai.
  assert.equal(dubaiDay(new Date('2026-08-07T20:00:00.000Z')), '2026-08-08');
});

test('an overnight lead lands on the Dubai day, not the UTC one', () => {
  // 00:43 Dubai on 31 July carries a 30 July UTC stamp — the case that
  // motivated all of this, measured live on 31 July 2026.
  const overnight = '2026-07-30T20:43:00.000Z';
  assert.equal(overnight.slice(0, 10), '2026-07-30');     // what UTC says
  assert.equal(dubaiDay(overnight), '2026-07-31');        // what actually happened
});

test('a window computed just after Dubai midnight uses the new day', () => {
  // 21:00 UTC on 7 Aug = 01:00 Dubai on 8 Aug. Today is the 8th, so the
  // 7-day window is still 1-7 Aug — the same answer as at 08:00.
  const justAfterMidnight = new Date('2026-08-07T21:00:00.000Z');
  assert.equal(dubaiToday(justAfterMidnight), '2026-08-08');
  assert.deepEqual(lastCompleteDays(7, justAfterMidnight), { from: '2026-08-01', to: '2026-08-07' });
});

test('a window computed just before Dubai midnight uses the old day', () => {
  // 19:00 UTC on 7 Aug = 23:00 Dubai on 7 Aug. Today is still the 7th.
  const justBefore = new Date('2026-08-07T19:00:00.000Z');
  assert.equal(dubaiToday(justBefore), '2026-08-07');
  assert.deepEqual(lastCompleteDays(7, justBefore), { from: '2026-07-31', to: '2026-08-06' });
});

/* ------------------------------ today window ------------------------------ */

test('Today is the one window that includes today, and only today', () => {
  assert.deepEqual(todayWindow(AUG_8), { from: '2026-08-08', to: '2026-08-08' });
});

/* ------------------------------ range bounds ------------------------------ */

test('dubaiRange covers whole Dubai days in UTC instants', () => {
  const { start, end } = dubaiRange('2026-08-01', '2026-08-07');
  assert.equal(new Date(start).toISOString(), '2026-07-31T20:00:00.000Z');
  assert.equal(new Date(end).toISOString(), '2026-08-07T19:59:59.999Z');
});

test('a lead at 23:59 Dubai on the last day is inside the window', () => {
  const { start, end } = dubaiRange('2026-08-01', '2026-08-07');
  const lastMoment = new Date('2026-08-07T19:59:59.000Z').getTime();   // 23:59:59 Dubai
  assert.ok(lastMoment >= start && lastMoment <= end);
});

test('a lead at 00:00 Dubai on the day AFTER the window is outside it', () => {
  const { start, end } = dubaiRange('2026-08-01', '2026-08-07');
  const nextDay = new Date('2026-08-07T20:00:00.000Z').getTime();      // 00:00 Dubai, 8 Aug
  assert.ok(nextDay > end, 'today must not leak into a window that ends yesterday');
});

/* --------------------------- unchanged behaviour --------------------------- */

test('daysAgo still counts back from today', () => {
  assert.equal(dubaiDaysAgo(0, AUG_8), '2026-08-08');
  assert.equal(dubaiDaysAgo(1, AUG_8), '2026-08-07');
  assert.equal(dubaiDaysAgo(8, AUG_8), '2026-07-31');
});

test('month presets still anchor to the first of the month', () => {
  assert.equal(dubaiMonthsAgo(0, AUG_8), '2026-08-01');
  assert.equal(dubaiMonthsAgo(11, AUG_8), '2025-09-01');
});
