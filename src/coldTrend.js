/**
 * How the cold share has moved since the record began.
 *
 * WHAT THIS SERIES IS, AND IS NOT. `isCold` reads the lead's state NOW: no
 * note, and a sub-status nobody has moved. So a point on this chart is not
 * "what August looked like in August". It is "of the leads that arrived in
 * August, how many are STILL untouched today".
 *
 * That distinction matters in one direction. A cold lead can be worked later
 * and stop being cold; a worked lead never becomes cold again. So every point
 * can only fall as time passes, and a past month improving is real work being
 * done on old leads rather than the chart drifting. The panel says so out
 * loud, because a number that moves on its own is otherwise alarming.
 *
 * There is no alternative available: PropSpace carries no timestamp for a
 * status change, so a true "cold on the day" figure cannot be reconstructed
 * for any date in the past. It could only be captured going forward, by
 * writing a snapshot down daily — which is a different feature.
 */

import { isCold, agentOf } from "./propspace.js";
import { isPropertyManagement } from "./propertyManagement.js";
import { dubaiDay } from "./time.js";

/** The first month anybody agreed to measure. Before this the book was not
 *  being worked the same way, so a line reaching back further would compare
 *  two different operations. */
export const RECORD_START = "2026-08-01";

const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const parse = (s) => new Date(`${s}T00:00:00Z`);
const addDays = (s, n) => { const d = parse(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };

/**
 * The buckets to plot, oldest first.
 *
 * Weekly until there are three whole months to compare, because a monthly
 * chart of a record that began three weeks ago is one dot and says nothing.
 * The caller can override; the default is whichever actually draws a line.
 */
export function bucketsFor(start = RECORD_START, today = dubaiDay(new Date()), mode = "auto") {
  const months = (Number(today.slice(0, 4)) - Number(start.slice(0, 4))) * 12
    + (Number(today.slice(5, 7)) - Number(start.slice(5, 7)));
  const grain = mode === "auto" ? (months >= 3 ? "month" : "week") : mode;

  const out = [];
  if (grain === "month") {
    let y = Number(start.slice(0, 4)), m = Number(start.slice(5, 7));
    while (`${y}-${pad(m)}` <= today.slice(0, 7)) {
      const from = `${y}-${pad(m)}-01`;
      const endM = m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`;
      out.push({
        key: `${y}-${pad(m)}`,
        label: new Date(`${from}T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" }),
        from, to: addDays(endM, -1),
      });
      if (++m > 12) { m = 1; y++; }
    }
  } else {
    // Seven-day blocks counted FROM the record start, not calendar weeks.
    // 1 August 2026 is a Saturday, so calendar weeks open the series with a
    // two-day stub whose rate swings on a handful of leads and reads as a
    // real movement. Equal blocks compare like with like.
    let from = start;
    while (from <= today) {
      const to = addDays(from, 6);
      out.push({
        key: from,
        label: new Date(`${from}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }),
        from, to,
      });
      from = addDays(to, 1);
    }
  }

  // The bucket we are standing in is incomplete and must say so, or a dip on
  // the right-hand end reads as improvement when it is just a short week.
  if (out.length) {
    const last = out[out.length - 1];
    if (last.to >= today) { last.to = today; last.partial = true; }
  }
  return out;
}

/**
 * The series.
 *
 * Measured on the same set the Cold card counts: sales leads only, Property
 * Management excluded, so the last point on the line equals the percentage on
 * the card when the card is showing the same window.
 *
 * A bucket with no leads has no rate — `rate` is null and the line breaks
 * rather than dropping to zero. Zero per cent cold and nothing to be cold are
 * different facts and the second one is not an achievement.
 */
export function coldSeries(leads, { start = RECORD_START, today = dubaiDay(new Date()), mode = "auto" } = {}) {
  const buckets = bucketsFor(start, today, mode);
  const sales = (leads ?? []).filter((l) => !isPropertyManagement(agentOf(l)));

  const rows = buckets.map((b) => ({ ...b, total: 0, cold: 0 }));
  const index = new Map(rows.map((r, i) => [i, r]));

  for (const lead of sales) {
    const day = dubaiDay(lead.created_at);
    if (day < start || day > today) continue;
    // Buckets are contiguous and ordered, so a scan is fine at this size and
    // avoids a second date library.
    for (let i = 0; i < rows.length; i++) {
      const r = index.get(i);
      if (day >= r.from && day <= r.to) {
        r.total++;
        if (isCold(lead)) r.cold++;
        break;
      }
    }
  }

  return rows.map((r) => ({
    ...r,
    rate: r.total ? r.cold / r.total : null,
  }));
}

/** Where it started, where it is now, and which way that is. Null when there
 *  is not yet a second point to compare against — one measurement is not a
 *  trend and should not be dressed as one. */
export function trendOf(series) {
  const points = series.filter((p) => p.rate !== null);
  if (points.length < 2) return null;
  const first = points[0], last = points[points.length - 1];
  return {
    first, last,
    deltaPts: (last.rate - first.rate) * 100,
    // Cold going down is the good direction.
    improving: last.rate < first.rate,
  };
}
