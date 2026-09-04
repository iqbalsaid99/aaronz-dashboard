/**
 * Bayut lead-stats client — the data behind the Bayut tab.
 *
 * ONE upstream endpoint, /api-v7/stats/website-client-leads, proxied at
 * /api/bayut so the API key stays at the edge. Everything it can tell you is
 * selected by four query parameters, and which combinations are meaningful is
 * not derivable from the parameters themselves — `type=call_logs&target=agent`
 * is accepted and means nothing. PULLS below is that list, written out, and it
 * is the only place a combination is decided.
 *
 * `timestamp` is a SINCE filter and the only date control there is. There is no
 * end parameter, so an end date is applied to the returned rows here instead —
 * see `withinRange`.
 *
 * Parsing lives next door in bayutParse.js — everything pure, so it can be
 * tested against captured responses without a network. This half is transport:
 * one pull, and the fourteen of them together.
 */

import { apiFetch } from "./apiFetch.js";
import { PULLS, NORMALISE, RANGE_BOUND, withinRange, timestampFor } from "./bayutParse.js";

/**
 * Re-exported so the tab imports one module and does not have to know which
 * half a given helper lives in. The split is about what can run under
 * `node --test`, not about making callers keep track of it.
 */
export * from "./bayutParse.js";

const BASE = "/api/bayut";

/* ------------------------------- transport ------------------------------ */

/**
 * One pull.
 *
 * Values are encoded rather than assembled with URLSearchParams for the same
 * reason the proxy does it: timestamp carries a literal space, and `+` is not
 * what this API reads back as one.
 */
async function pull(params) {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");

  const res = await apiFetch(`${BASE}?${qs}`);

  // The proxy always answers JSON, but a Pages platform error in front of it
  // may not, so a parse failure must not become an unhandled throw with no
  // status attached — the section error is built from `status`.
  const body = await res.json().catch(() => null);

  if (!res.ok) {
    // `error`/`detail` is the proxy's own shape. `message` is Bayut's, and it
    // reaches here unwrapped only if a platform layer answered instead of the
    // proxy — but it is the field that carries the useful sentence (the
    // timestamp floor below arrives that way), so it is read as a fallback
    // rather than discarded in favour of a bare status code.
    const err = new Error(body?.error ?? body?.message ?? `Bayut returned ${res.status}.`);
    err.status = res.status;
    err.detail = body?.detail ?? (body?.error ? null : body?.message ?? null);
    throw err;
  }

  // Documented as a bare array. Accepting a wrapped one costs a line and means
  // an envelope appearing upstream shows as no rows rather than as a crash.
  if (Array.isArray(body)) return body;
  for (const k of ["data", "results", "leads"]) if (Array.isArray(body?.[k])) return body[k];
  return [];
}

/* -------------------------------- fetching ------------------------------ */

/**
 * Every valid pull, in parallel, each reported on its own.
 *
 * Promise.allSettled rather than Promise.all: fourteen calls to one upstream
 * will not all succeed forever, and one 500 must cost its own section rather
 * than the tab. The result is always one entry per pull — rows or an error,
 * never neither — so a section always has something to render.
 */
export async function fetchAll({ from, to } = {}) {
  const timestamp = timestampFor(from);

  const settled = await Promise.allSettled(
    PULLS.map((p) =>
      pull({
        type: p.type,
        target: p.target,
        is_trulead: p.is_trulead,
        timestamp,
      })
    )
  );

  return PULLS.map((p, i) => {
    const r = settled[i];
    if (r.status === "rejected") {
      const e = r.reason ?? {};
      return {
        ...p,
        rows: [],
        error: { message: e.message ?? String(e), status: e.status ?? null, detail: e.detail ?? null },
      };
    }
    const rows = (r.value ?? [])
      .filter(Boolean)
      .map((row) => NORMALISE[p.kind](row, p));
    return {
      ...p,
      rows: RANGE_BOUND.has(p.kind) ? withinRange(rows, from, to) : rows,
      error: null,
    };
  });
}

/**
 * Just the listing-view pulls — the three the Listings Analytics tab needs.
 *
 * WhatsApp, SMS and phone reveals against a listing, each reported separately
 * so one failing channel costs its own count rather than the whole enrichment.
 *
 * THE TIMESTAMP IS SENT AND IS IGNORED. Measured on 2026-08-21: the same pull
 * at 2026-08-20, 2026-06-01 and 2026-03-01 returned an identical 51 rows and
 * 5,019 views, while the equivalent lead pull swung from 62 rows to 900. View
 * rows are lifetime counters per listing and `is_trulead=0` does not honour a
 * since filter. It is still passed, because it costs nothing and this starts
 * working the day Bayut implements it — but nothing downstream may present
 * these counts as belonging to a date range.
 */
export async function fetchListingViews({ from } = {}) {
  const wanted = PULLS.filter((p) => p.kind === "view" && p.target === "listing");
  const timestamp = timestampFor(from);

  const settled = await Promise.allSettled(
    wanted.map((p) =>
      pull({ type: p.type, target: p.target, is_trulead: p.is_trulead, timestamp })
    )
  );

  return wanted.map((p, i) => {
    const r = settled[i];
    if (r.status === "rejected") {
      const e = r.reason ?? {};
      return {
        ...p,
        rows: [],
        error: { message: e.message ?? String(e), status: e.status ?? null, detail: e.detail ?? null },
      };
    }
    return {
      ...p,
      rows: (r.value ?? []).filter(Boolean).map((row) => NORMALISE[p.kind](row, p)),
      error: null,
    };
  });
}
