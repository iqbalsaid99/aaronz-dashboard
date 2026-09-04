/**
 * Apollo prospecting — client side.
 *
 * Every call goes to our own /api/apollo proxy. There is deliberately no
 * Apollo key in this file, in the bundle, or anywhere the browser can reach:
 * the key spends real money per reveal, and a key in a bundle is a key anyone
 * with devtools can spend.
 */

import { apiFetch } from "./apiFetch.js";

async function post(path, body) {
  const res = await apiFetch(`/api/apollo${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(payload.error ?? `Apollo request failed (${res.status})`);
    err.detail = payload.detail;
    err.planGated = payload.planGated === true;
    err.setupRequired = payload.setupRequired === true;
    err.status = res.status;
    throw err;
  }
  return payload;
}

export const searchPeople = (filters) => post("/search", filters);

/** Quota and configuration, without running a search. */
export async function apolloHealth() {
  const res = await apiFetch("/api/apollo/health");
  return res.json().catch(() => ({}));
}
export const revealContact = (body) => post("/reveal", body);

/** Company-name suggestions for the typeahead. Costs a request, not a credit. */
export const suggestCompanies = (q) => post("/companies", { q });

/* ------------------------------ filters ------------------------------- */

/**
 * Apollo's headcount bands are strings of the form "min,max" and only the
 * published bands are accepted — an arbitrary range is silently ignored, which
 * looks like a filter that did nothing rather than one that was refused.
 */
export const HEADCOUNT_BANDS = [
  "1,10", "11,20", "21,50", "51,100", "101,200",
  "201,500", "501,1000", "1001,2000", "2001,5000", "5001,10000", "10001,1000000",
];

export const SENIORITIES = [
  "owner", "founder", "c_suite", "partner", "vp", "head", "director", "manager",
];

const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};

/**
 * The three starting points.
 *
 * These are arguments, not shortcuts. Each one encodes a reason somebody would
 * be worth ringing about Dubai property, and the reason is on the button so a
 * broker can tell whether it is the list they wanted.
 */
export const PRESETS = [
  {
    key: "uk-hiring-dubai",
    label: "UK HQ hiring in Dubai",
    why: "British companies posting Dubai roles — they are opening here, and the founder is the one who signs for the flat.",
    filters: {
      organization_locations: ["United Kingdom"],
      organization_job_locations: ["Dubai, United Arab Emirates"],
      person_seniorities: ["founder", "c_suite"],
      // Job ads go stale. A posting from two years ago is not a company
      // arriving; it is a company that already did.
      organization_job_posted_at_range: { min: daysAgo(180), max: daysAgo(0) },
    },
  },
  {
    key: "uk-investment",
    label: "UK investment titles",
    why: "The people who allocate other people's money, in the market that buys the most Dubai property off-plan.",
    filters: {
      person_locations: ["United Kingdom"],
      person_titles: [
        "Investment Director", "Head of Investments", "Investment Manager",
        "Portfolio Manager", "Fund Manager", "Head of Real Estate",
        "Real Estate Investment Manager",
      ],
    },
  },
  {
    key: "dubai-owners",
    label: "Dubai owners, 1–200 staff",
    why: "Owner-operators already living here. Small enough that the owner is the buyer, established enough to be one.",
    filters: {
      person_locations: ["Dubai, United Arab Emirates"],
      person_seniorities: ["owner", "founder", "partner"],
      organization_num_employees_ranges: ["1,10", "11,20", "21,50", "51,100", "101,200"],
    },
  },
];

export const EMPTY_FILTERS = {
  q_organization_name: "",
  person_titles: [],
  person_seniorities: [],
  person_locations: [],
  organization_locations: [],
  organization_job_locations: [],
  organization_num_employees_ranges: [],
  organization_job_posted_at_range: null,
};

/** Comma-separated text <-> the arrays Apollo wants. */
export const toList = (s) =>
  String(s ?? "").split(",").map((x) => x.trim()).filter(Boolean);
export const fromList = (a) => (Array.isArray(a) ? a.join(", ") : "");

export const headcountLabel = (band) => {
  const [lo, hi] = String(band).split(",");
  return Number(hi) >= 1_000_000 ? `${Number(lo).toLocaleString()}+`
    : `${Number(lo).toLocaleString()}–${Number(hi).toLocaleString()}`;
};

/** True when a filter set would ask Apollo for "everyone". Apollo will happily
 *  answer, bill the search, and return noise. */
export const isEmptyFilters = (f) =>
  !Object.entries(f ?? {}).some(([, v]) =>
    Array.isArray(v) ? v.length : v != null && v !== "");
