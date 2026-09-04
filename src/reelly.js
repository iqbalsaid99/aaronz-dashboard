/**
 * Reelly client — the off-plan project catalogue.
 *
 * Two endpoints, both through the proxy at /api/reelly so the X-API-Key stays
 * at the edge: a paginated project list and a project detail record.
 *
 * Parsing and the measured filter matrix live next door in reellyParse.js.
 * This half is transport.
 *
 * NO CLIENT CACHE HERE. The Function caches at the edge for an hour, which is
 * the right place for it — shared across everyone rather than rebuilt per tab,
 * and it survives a reload. A second cache in front of it would only make the
 * two disagree about how stale things are.
 */

import { apiFetch } from "./apiFetch.js";
import { normaliseProject, normaliseDetail, PAGE_SIZE } from "./reellyParse.js";

export * from "./reellyParse.js";

const BASE = "/api/reelly";

async function get(path, params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    qs.set(k, Array.isArray(v) ? v.join(",") : String(v));
  }
  const s = qs.toString();

  const res = await apiFetch(`${BASE}${path}${s ? `?${s}` : ""}`);
  const body = await res.json().catch(() => null);

  if (!res.ok) {
    // The proxy answers { error, detail }. The status is carried on the error
    // so the UI can name it — the docs' own advice is that a 500 from Reelly
    // is usually transient and a 404 is not, and those want different words.
    const err = new Error(body?.error ?? `Reelly returned ${res.status}.`);
    err.status = res.status;
    err.detail = body?.detail ?? null;
    throw err;
  }
  return body;
}

/**
 * One page of the catalogue.
 *
 * `filters` is passed through as-is: it is built by the UI from the verified
 * matrix in reellyParse.js, and the proxy drops anything not on its whitelist,
 * so a stray key here cannot reach Reelly.
 *
 * country, preferred_currency and preferred_area_unit are NOT sent from here.
 * The proxy applies them when absent, so "every list call is UAE, in AED, in
 * square feet" holds for any caller rather than depending on this function
 * remembering.
 */
export async function fetchProjects({ page = 1, ordering, filters = {} } = {}) {
  const body = await get("/projects", {
    limit: PAGE_SIZE,
    offset: (Math.max(1, page) - 1) * PAGE_SIZE,
    ordering,
    ...filters,
  });

  return {
    count: Number(body?.count) || 0,
    hasNext: Boolean(body?.next),
    hasPrevious: Boolean(body?.previous),
    projects: (Array.isArray(body?.results) ? body.results : [])
      .filter(Boolean)
      .map(normaliseProject),
  };
}

/** One project, with the payment plans and escrow the list does not carry. */
export async function fetchProject(id) {
  const body = await get(`/projects/${encodeURIComponent(id)}`);
  return normaliseDetail(body ?? {});
}

