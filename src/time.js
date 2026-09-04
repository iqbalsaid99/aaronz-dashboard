/**
 * Dubai-time date handling.
 *
 * The API stamps created_at in UTC. Dubai is UTC+4, so anything that arrives
 * between midnight and 04:00 local carries the *previous* day's UTC date.
 * Bucketing on the raw UTC date pushes those onto the wrong day.
 *
 * Measured on 31 July 2026: 6 leads arrived that day Dubai time, but only 4
 * had a 31 July UTC stamp — two overnight WhatsApp enquiries at 00:43 and
 * 03:15 fell onto 30 July. A third of the day's leads, on the wrong date.
 *
 * The UAE has no daylight saving and has stayed on UTC+4 since 1972, so a
 * fixed offset is safe here. Boundaries are still built by letting Date parse
 * an explicit "+04:00" rather than adding four hours by hand, so this keeps
 * working if that ever stops being true for a given instant.
 */

export const DUBAI_OFFSET = "+04:00";

/** Calendar date in Dubai for a UTC instant, as "YYYY-MM-DD". */
export function dubaiDay(iso) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Dubai",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(iso));
}

/** Calendar month in Dubai, as "YYYY-MM". */
export const dubaiMonth = (iso) => dubaiDay(iso).slice(0, 7);

/**
 * Today's date in Dubai — not the browser's, and not UTC's.
 *
 * `now` is injectable so the window definitions below can be tested against
 * fixed instants; nothing in the app passes it.
 */
export const dubaiToday = (now = new Date()) => dubaiDay(now);

/** N days before today, counted in Dubai days. */
export function dubaiDaysAgo(n, now = new Date()) {
  const d = new Date(`${dubaiToday(now)}T12:00:00${DUBAI_OFFSET}`);
  d.setDate(d.getDate() - n);
  return dubaiDay(d);
}

/** Yesterday in Dubai — the most recent day that is actually over. */
export const dubaiYesterday = (now = new Date()) => dubaiDaysAgo(1, now);

/**
 * The N complete Dubai days ending yesterday. Today is excluded entirely.
 *
 * WHY TODAY IS LEFT OUT. Today is a partial day. A lead that arrived an hour
 * ago has not had a fair chance to be touched, but it still lands in the
 * denominator for cold rate and median time to first touch. Including it makes
 * every broker look worse first thing in the morning and steadily better by
 * evening — the same work, a different number depending on when you look. For
 * a measure people are held to, that is not a defensible way to count.
 *
 * The old definition was daysAgo(n) → today, which spans n+1 calendar days:
 * "Last 7 days" on 8 August ran 1–8 August, eight days wide. Now it is 1–7.
 *
 * Live check on the same data: minus 6 → 57 leads, minus 7 → 64, minus 8 → 72.
 *
 * Use `todayWindow()` when you actually want live activity.
 */
export function lastCompleteDays(n, now = new Date()) {
  return { from: dubaiDaysAgo(n, now), to: dubaiYesterday(now) };
}

/** Today only, in Dubai. The one window that is deliberately partial. */
export function todayWindow(now = new Date()) {
  const t = dubaiToday(now);
  return { from: t, to: t };
}

/** First of the month N months back, in Dubai. */
export function dubaiMonthsAgo(n, now = new Date()) {
  const d = new Date(`${dubaiToday(now).slice(0, 7)}-01T12:00:00${DUBAI_OFFSET}`);
  d.setMonth(d.getMonth() - n);
  return `${dubaiDay(d).slice(0, 7)}-01`;
}

/**
 * Turn a pair of Dubai calendar dates into the UTC instants that bound them.
 * `to` is inclusive of its whole day, so 15 Jul → 15 Jul covers that entire
 * Dubai day: 14 Jul 20:00 UTC through 15 Jul 19:59:59.999 UTC.
 */
export function dubaiRange(from, to) {
  return {
    start: from ? new Date(`${from}T00:00:00.000${DUBAI_OFFSET}`).getTime() : -Infinity,
    end: to ? new Date(`${to}T23:59:59.999${DUBAI_OFFSET}`).getTime() : Infinity,
  };
}

/** Is this UTC instant inside the given Dubai date range? */
export function inDubaiRange(iso, from, to) {
  const { start, end } = dubaiRange(from, to);
  const t = new Date(iso).getTime();
  return t >= start && t <= end;
}
