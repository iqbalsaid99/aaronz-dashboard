import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  Search, Mail, Phone, Linkedin, RefreshCw, Users, Activity as ActivityIcon,
  AlertTriangle, Check, Clock,
} from "lucide-react";
import {
  searchPeople, revealContact, apolloHealth, suggestCompanies, PRESETS, EMPTY_FILTERS, HEADCOUNT_BANDS,
  SENIORITIES, toList, fromList, headcountLabel, isEmptyFilters,
} from "./apollo.js";
import { supabase } from "./lib/supabase.js";
import { useAuth } from "./AuthGate.jsx";

/**
 * Prospecting — Apollo search, with the two things that keep it honest.
 *
 * NOTHING IS PAID FOR TWICE. Every reveal asks the proxy, which reads the
 * apollo_leads store before it reads Apollo. A contact somebody else already
 * bought comes back free and says so on the row. That check lives on the
 * server, not here: a cache the browser can skip is not a cache.
 *
 * AND EVERY CALL IS ON THE RECORD. Searches and reveals are logged server-side
 * with the user who made them, and the Activity tab reads those logs back per
 * broker. Apollo bills per reveal, so "who spent this" has to be answerable
 * without asking anybody.
 */

const Card = ({ children, className = "" }) => (
  <div className={`bg-white border border-slate-200 rounded-2xl ${className}`}>{children}</div>
);

const Field = ({ label, hint, children }) => (
  <label className="block">
    <span className="block text-[11px] font-semibold tracking-wide text-slate-500 uppercase mb-1">
      {label}
    </span>
    {children}
    {hint && <span className="block text-[11px] text-slate-400 mt-1">{hint}</span>}
  </label>
);

const input =
  "w-full px-3 py-2 text-sm rounded-lg border border-slate-200 bg-white text-slate-800 " +
  "placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-300";

/**
 * Company name, with suggestions.
 *
 * Apollo fuzzy-matches a partial name, so this doubles as the "did you mean":
 * typing "emaa" offers Emaar, Emaar Hospitality Group and EMAA Insurance, and
 * picking one puts the exact name into the filter rather than leaving a guess
 * in it.
 *
 * DEBOUNCED, AND NOT PER KEYSTROKE. Each lookup spends one of 200 requests a
 * minute — the same allowance the searches themselves come out of — so a
 * naive onChange would exhaust the minute in a single company name. Anything
 * under two characters is not asked at all, and a reply that arrives after a
 * newer one is discarded rather than overwriting it.
 */
function CompanyField({ value, onChange }) {
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen] = useState(false);
  const [looking, setLooking] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const q = value.trim();
    if (q.length < 2) { setSuggestions([]); setLooking(false); return; }
    setLooking(true);
    const mine = ++seq.current;
    const t = setTimeout(() => {
      suggestCompanies(q)
        .then((r) => {
          if (mine !== seq.current) return;      // a newer keystroke has overtaken this
          setSuggestions(r.companies ?? []);
          setOpen(true);
        })
        .catch(() => { if (mine === seq.current) setSuggestions([]); })
        .finally(() => { if (mine === seq.current) setLooking(false); });
    }, 350);
    return () => clearTimeout(t);
  }, [value]);

  return (
    <div className="relative">
      <input className={input} value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => suggestions.length && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Emaar, Binghatti, Damac…" />
      {looking && (
        <RefreshCw className="w-3.5 h-3.5 animate-spin text-slate-300 absolute right-3 top-3" />
      )}
      {open && suggestions.length > 0 && (
        <ul className="absolute z-20 left-0 right-0 mt-1 bg-white border border-slate-200
                       rounded-lg shadow-lg overflow-hidden max-h-72 overflow-y-auto">
          {suggestions.map((c) => (
            <li key={c.id ?? c.name}>
              <button type="button"
                onMouseDown={(e) => { e.preventDefault(); onChange(c.name); setOpen(false); }}
                className="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center gap-2">
                {c.logo
                  ? <img src={c.logo} alt="" className="w-5 h-5 rounded object-contain flex-shrink-0" />
                  : <span className="w-5 h-5 rounded bg-slate-100 flex-shrink-0" />}
                <span className="min-w-0">
                  <span className="block text-sm text-slate-800 truncate">{c.name}</span>
                  {c.domain && <span className="block text-[11px] text-slate-400 truncate">{c.domain}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Apollo's search tells you a field EXISTS without telling you what it says.
 * An em dash in that cell would read as "there is no location", which is a
 * different and wronger thing than "Apollo is holding it back until a reveal".
 */
/**
 * What is left to spend.
 *
 * Two different limits, and conflating them would mislead. `quota` is Apollo's
 * REQUEST allowance — calls per minute, hour and day — which is what stops the
 * tab working when it runs out. Apollo publishes no endpoint for the
 * enrichment CREDIT balance on this plan (/usage_stats, /credit_usage and
 * /users/me are all 404 or 422), so the credit figure here is what this
 * dashboard has itself spent, out of the apollo_reveals ledger. It is a floor
 * on usage, not the balance in the account.
 */
function Quota({ quota, spent }) {
  if (!quota && spent == null) return null;
  const bar = (label, q) => {
    if (!q || q.limit == null) return null;
    const used = q.used ?? (q.limit - (q.left ?? 0));
    const pct = Math.min(100, Math.round((used / q.limit) * 100));
    return (
      <span key={label} className="flex items-center gap-1.5 whitespace-nowrap" title={`${used} of ${q.limit} API calls used this ${label}`}>
        <span className="text-slate-400">{label}</span>
        <span className="w-10 h-1 rounded-full bg-slate-200 overflow-hidden">
          <span className="block h-full bg-slate-700" style={{ width: `${Math.max(2, pct)}%` }} />
        </span>
        <span className="tabular-nums text-slate-600">{(q.left ?? 0).toLocaleString()}</span>
      </span>
    );
  };
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
      <span className="text-slate-500 font-medium">API calls left</span>
      {["minute", "hour", "day"].map((k) => bar(k, quota?.[k]))}
      {spent != null && (
        <span className="text-slate-500 pl-2 border-l border-slate-200">
          <span className="font-semibold text-slate-800 tabular-nums">{spent.toLocaleString()}</span> credits spent by this dashboard
        </span>
      )}
    </div>
  );
}

const Withheld = ({ has }) =>
  has
    ? <span className="text-slate-400" title="Apollo holds this — it arrives with a reveal">held</span>
    : <span className="text-slate-300">—</span>;

/* ------------------------------- search -------------------------------- */

function SearchTab({ brokerName }) {
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [preset, setPreset] = useState(null);
  const [people, setPeople] = useState(null);
  const [pagination, setPagination] = useState(null);
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // apolloPersonId -> { email?, mobile?, pending?, cached?, busy?, error? }
  const [revealed, setRevealed] = useState({});
  const [quota, setQuota] = useState(null);
  const [setupError, setSetupError] = useState(null);

  const set = (k, v) => { setFilters((f) => ({ ...f, [k]: v })); setPreset(null); };

  // Populated before anybody searches, so the allowance is visible when it
  // matters — deciding whether to run one — rather than only afterwards.
  useEffect(() => {
    let dead = false;
    apolloHealth().then((h) => { if (!dead && h?.quota) setQuota(h.quota); }).catch(() => {});
    return () => { dead = true; };
  }, []);

  const applyPreset = (p) => {
    setFilters({ ...EMPTY_FILTERS, ...p.filters });
    setPreset(p.key);
    setPage(1);
  };

  const run = useCallback(async (atPage = 1) => {
    setBusy(true); setError(null);
    try {
      const r = await searchPeople({ ...filters, page: atPage, per_page: 25, preset, brokerName });
      setPeople(r.people ?? []);
      setPagination(r.pagination ?? null);
      if (r.quota) setQuota(r.quota);
      setPage(atPage);
    } catch (e) {
      setError(e);
      setPeople(null);
    } finally {
      setBusy(false);
    }
  }, [filters, preset, brokerName]);

  async function reveal(person, type) {
    const id = person.apolloPersonId;
    setRevealed((r) => ({ ...r, [id]: { ...r[id], busy: type } }));
    try {
      const res = await revealContact({ apolloPersonId: id, type, person, brokerName });
      if (res.quota) setQuota(res.quota);
      setRevealed((r) => ({
        ...r,
        [id]: {
          ...r[id], busy: null, cached: res.cached,
          [type]: res.value ?? null,
          pending: type === "mobile" ? Boolean(res.pending) : r[id]?.pending,
        },
      }));
      // A reveal buys the whole record, not just the one field. Search returns
      // an obfuscated surname and no location or LinkedIn at all, so the row is
      // replaced with the enriched profile that came back with it.
      if (res.person?.enriched) {
        setPeople((list) => list.map((x) =>
          x.apolloPersonId === id ? { ...x, ...res.person } : x));
      }
    } catch (e) {
      // A setup failure is about the deployment, not this contact. Repeating
      // it on every row would read as twenty separate problems.
      if (e.setupRequired) { setSetupError(e); setRevealed((r) => ({ ...r, [id]: { ...r[id], busy: null } })); return; }
      setRevealed((r) => ({ ...r, [id]: { ...r[id], busy: null, error: e.message } }));
    }
  }

  const empty = isEmptyFilters(filters);

  return (
    <>
      {quota && (
        <div className="mb-3 px-4 py-2 bg-white border border-slate-200 rounded-xl">
          <Quota quota={quota} spent={null} />
        </div>
      )}

      {setupError && (
        <Card className="p-5 mb-4 border-amber-300 bg-amber-50">
          <p className="text-sm font-semibold text-slate-900 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-600" />
            {setupError.message}
          </p>
          <p className="text-xs text-slate-700 mt-1.5 max-w-3xl">{setupError.detail}</p>
          <p className="text-[11px] text-slate-500 mt-2">
            Search still works — it is only the reveals that are held back, and deliberately:
            without that table there is no way to know a colleague has already paid for a contact.
          </p>
        </Card>
      )}

      {/* ------------------------------ presets */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
        {PRESETS.map((p) => (
          <button key={p.key} onClick={() => applyPreset(p)}
            className={`text-left p-4 rounded-2xl border transition ${preset === p.key
              ? "bg-slate-900 border-slate-900 text-white"
              : "bg-white border-slate-200 hover:border-slate-300 hover:bg-slate-50"}`}>
            <p className="text-sm font-semibold">{p.label}</p>
            <p className={`text-[11px] mt-1 leading-snug ${preset === p.key ? "text-slate-300" : "text-slate-500"}`}>
              {p.why}
            </p>
          </button>
        ))}
      </div>

      {/* ------------------------------ filters */}
      <Card className="p-5 mb-4">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Field label="Company" hint="Start typing — Apollo suggests matches">
            <CompanyField value={filters.q_organization_name ?? ""}
              onChange={(v) => set("q_organization_name", v)} />
          </Field>
          <Field label="Job titles" hint="Comma separated">
            <input className={input} value={fromList(filters.person_titles)}
              onChange={(e) => set("person_titles", toList(e.target.value))}
              placeholder="Investment Director, Head of Real Estate" />
          </Field>
          <Field label="Person location">
            <input className={input} value={fromList(filters.person_locations)}
              onChange={(e) => set("person_locations", toList(e.target.value))}
              placeholder="United Kingdom, Dubai" />
          </Field>
          <Field label="Company HQ">
            <input className={input} value={fromList(filters.organization_locations)}
              onChange={(e) => set("organization_locations", toList(e.target.value))}
              placeholder="United Kingdom" />
          </Field>
          <Field label="Hiring in" hint="Where the company is posting jobs">
            <input className={input} value={fromList(filters.organization_job_locations)}
              onChange={(e) => set("organization_job_locations", toList(e.target.value))}
              placeholder="Dubai, United Arab Emirates" />
          </Field>
          <Field label="Seniority">
            <div className="flex flex-wrap gap-1.5">
              {SENIORITIES.map((s) => {
                const on = filters.person_seniorities.includes(s);
                return (
                  <button key={s} type="button"
                    onClick={() => set("person_seniorities", on
                      ? filters.person_seniorities.filter((x) => x !== s)
                      : [...filters.person_seniorities, s])}
                    className={`px-2 py-1 text-[11px] rounded-md border transition ${on
                      ? "bg-slate-900 text-white border-slate-900"
                      : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"}`}>
                    {s.replace("_", " ")}
                  </button>
                );
              })}
            </div>
          </Field>
          <Field label="Headcount">
            <div className="flex flex-wrap gap-1.5">
              {HEADCOUNT_BANDS.slice(0, 7).map((b) => {
                const on = filters.organization_num_employees_ranges.includes(b);
                return (
                  <button key={b} type="button"
                    onClick={() => set("organization_num_employees_ranges", on
                      ? filters.organization_num_employees_ranges.filter((x) => x !== b)
                      : [...filters.organization_num_employees_ranges, b])}
                    className={`px-2 py-1 text-[11px] rounded-md border transition ${on
                      ? "bg-slate-900 text-white border-slate-900"
                      : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"}`}>
                    {headcountLabel(b)}
                  </button>
                );
              })}
            </div>
          </Field>
        </div>

        <div className="flex items-center gap-3 mt-4 pt-4 border-t border-slate-100">
          <button onClick={() => run(1)} disabled={busy || empty}
            className="flex items-center gap-2 px-4 py-2 text-sm rounded-lg bg-slate-900 text-white
                       font-medium hover:bg-slate-800 disabled:opacity-40 disabled:pointer-events-none">
            {busy ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
            Search Apollo
          </button>
          {empty && <span className="text-xs text-slate-400">
            Add a filter first — an unfiltered search returns noise and still counts as a search.
          </span>}
          {pagination && (
            <span className="text-xs text-slate-500 ml-auto tabular-nums">
              {(pagination.total_entries ?? 0).toLocaleString()} people ·
              page {pagination.page ?? page} of {(pagination.total_pages ?? 1).toLocaleString()}
            </span>
          )}
        </div>
      </Card>

      {error && (
        <Card className={`p-5 mb-4 ${error.planGated ? "border-amber-300 bg-amber-50" : "border-rose-200"}`}>
          <p className="text-sm font-semibold text-slate-900 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-600" />
            {error.planGated ? "Apollo's plan is blocking this, not the dashboard." : error.message}
          </p>
          {error.detail && <p className="text-xs text-slate-600 mt-1.5">{error.detail}</p>}
          {error.planGated && (
            <p className="text-xs text-slate-600 mt-2">
              The key is valid — search and reveal are gated to paid plans. Everything on this page
              is wired and will work the moment the plan is upgraded; nothing here needs changing.
            </p>
          )}
        </Card>
      )}

      {/* ------------------------------ results */}
      {people && (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-500 text-xs">
                <tr className="border-b border-slate-200">
                  <th className="text-left font-medium px-5 py-2.5">Name</th>
                  <th className="text-left font-medium px-3 py-2.5">Company</th>
                  <th className="text-right font-medium px-3 py-2.5">Staff</th>
                  <th className="text-left font-medium px-3 py-2.5">Location</th>
                  <th className="text-right font-medium px-5 py-2.5">Contact</th>
                </tr>
              </thead>
              <tbody>
                {people.map((p) => {
                  const r = revealed[p.apolloPersonId] ?? {};
                  return (
                    <tr key={p.apolloPersonId} className="border-b border-slate-100 last:border-0 align-top">
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium text-slate-900">{p.name}</span>
                          {p.linkedin && (
                            <a href={p.linkedin} target="_blank" rel="noreferrer"
                              title="LinkedIn profile" className="text-slate-400 hover:text-sky-600">
                              <Linkedin className="w-3.5 h-3.5" />
                            </a>
                          )}
                        </div>
                        <p className="text-xs text-slate-500">{p.title ?? "—"}</p>
                      </td>
                      <td className="px-3 py-3 text-slate-700">
                        {p.company ?? "—"}
                        {p.companyIsDomain && (
                          <span className="block text-[10px] text-slate-400">domain — search does not return the company name</span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-right text-slate-500 tabular-nums">
                        {p.headcount ? p.headcount.toLocaleString() : <Withheld has={p.teaser?.headcount} />}
                      </td>
                      <td className="px-3 py-3 text-slate-500 text-xs">
                        {p.location ?? <Withheld has={p.teaser?.location} />}
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex flex-col items-end gap-1.5">
                          {/* email */}
                          {r.email ? (
                            <span className="flex items-center gap-1.5 text-xs">
                              <a href={`mailto:${r.email}`} className="text-slate-800 hover:underline">{r.email}</a>
                              {r.cached && <span title="Already bought — no credit spent"
                                className="text-[10px] px-1 py-0.5 rounded bg-emerald-50 text-emerald-700">free</span>}
                            </span>
                          ) : (
                            <button onClick={() => reveal(p, "email")} disabled={r.busy === "email"}
                              className="flex items-center gap-1.5 px-2 py-1 text-xs rounded-md border
                                         border-slate-200 hover:bg-slate-50 disabled:opacity-50">
                              {r.busy === "email" ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Mail className="w-3 h-3" />}
                              Get email
                            </button>
                          )}

                          {/* mobile */}
                          {r.mobile ? (
                            <span className="flex items-center gap-1.5 text-xs">
                              <a href={`tel:${r.mobile}`} className="text-slate-800 hover:underline">{r.mobile}</a>
                              {r.cached && <span className="text-[10px] px-1 py-0.5 rounded bg-emerald-50 text-emerald-700">free</span>}
                            </span>
                          ) : r.pending ? (
                            <span className="flex items-center gap-1.5 text-xs text-amber-700"
                              title="Apollo takes the request and posts the number back to our webhook">
                              <Clock className="w-3 h-3" /> mobile pending
                            </span>
                          ) : (
                            <button onClick={() => reveal(p, "mobile")} disabled={r.busy === "mobile"}
                              className="flex items-center gap-1.5 px-2 py-1 text-xs rounded-md border
                                         border-slate-200 hover:bg-slate-50 disabled:opacity-50">
                              {r.busy === "mobile" ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Phone className="w-3 h-3" />}
                              Get mobile
                            </button>
                          )}
                          {r.error && <span className="text-[11px] text-rose-600 max-w-[220px] text-right">{r.error}</span>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {!people.length && (
                  <tr><td colSpan={5} className="px-5 py-8 text-center text-sm text-slate-500">
                    Apollo returned nobody for those filters.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>

          {pagination && (pagination.total_pages ?? 1) > 1 && (
            <div className="flex items-center justify-between px-5 py-3 border-t border-slate-100">
              <button onClick={() => run(page - 1)} disabled={page <= 1 || busy}
                className="px-3 py-1.5 text-xs rounded-lg border border-slate-200 hover:bg-slate-50 disabled:opacity-40">
                Previous
              </button>
              <span className="text-xs text-slate-500 tabular-nums">Page {page}</span>
              <button onClick={() => run(page + 1)} disabled={busy || page >= (pagination.total_pages ?? 1)}
                className="px-3 py-1.5 text-xs rounded-lg border border-slate-200 hover:bg-slate-50 disabled:opacity-40">
                Next
              </button>
            </div>
          )}
        </Card>
      )}
    </>
  );
}

/* ------------------------------ activity ------------------------------- */

/**
 * Who has been using this, and what it cost.
 *
 * Read straight from the two log tables rather than from anything the search
 * screen remembers, because the question is "what happened", including on
 * somebody else's machine last Tuesday.
 */
function ActivityTab() {
  const [state, setState] = useState("loading");
  const [rows, setRows] = useState([]);
  const [feed, setFeed] = useState([]);
  const [quota, setQuota] = useState(null);
  const [error, setError] = useState(null);

  async function load() {
    setState("loading"); setError(null);
    try {
      const [s, r] = await Promise.all([
        supabase.from("apollo_searches")
          .select("user_id,user_email,broker_name,result_count,created_at")
          .order("created_at", { ascending: false }).limit(5000),
        supabase.from("apollo_reveals")
          .select("user_id,user_email,broker_name,reveal_type,credits,cached,status,created_at")
          .order("created_at", { ascending: false }).limit(5000),
      ]);
      if (s.error) throw s.error;
      if (r.error) throw r.error;

      const by = new Map();
      const touch = (row) => {
        const key = row.user_email ?? row.user_id ?? "unknown";
        if (!by.has(key)) {
          by.set(key, {
            key, name: row.broker_name || row.user_email || "Unknown",
            searches: 0, emails: 0, mobiles: 0, credits: 0, saved: 0, last: null,
          });
        }
        const b = by.get(key);
        const at = new Date(row.created_at);
        if (!b.last || at > b.last) b.last = at;
        return b;
      };
      for (const row of s.data ?? []) touch(row).searches++;
      for (const row of r.data ?? []) {
        const b = touch(row);
        if (row.reveal_type === "email") b.emails++; else b.mobiles++;
        b.credits += Number(row.credits ?? 0);
        // A cached hit is a reveal that did not cost anything. Counting them
        // is the only way to show the store is earning its keep.
        if (row.cached) b.saved++;
      }
      setRows([...by.values()].sort((a, b) => (b.last ?? 0) - (a.last ?? 0)));

      // The rollup answers "how much has each broker spent". It cannot answer
      // "who enriched this person, and when" — which is the question asked
      // when a number looks wrong or a contact was bought twice. So the
      // reveals are also kept as they were written.
      setFeed((r.data ?? []).slice(0, 200).map((x) => ({ ...x, at: new Date(x.created_at) })));
      setState("ready");
    } catch (e) {
      setError(String(e.message ?? e));
      setState("failed");
    }
  }

  useEffect(() => { load(); }, []);
  useEffect(() => {
    let dead = false;
    apolloHealth().then((h) => { if (!dead && h?.quota) setQuota(h.quota); }).catch(() => {});
    return () => { dead = true; };
  }, []);

  if (state === "loading") {
    return <Card className="p-10 text-center">
      <RefreshCw className="w-5 h-5 text-slate-300 mx-auto animate-spin" />
      <p className="text-sm text-slate-500 mt-3">Reading the logs…</p>
    </Card>;
  }
  if (state === "failed") {
    return <Card className="p-6">
      <p className="text-sm font-medium text-slate-900">Could not read the activity logs.</p>
      <p className="text-sm text-slate-500 mt-1">{error}</p>
      <p className="text-xs text-slate-400 mt-2">
        If this says the relation does not exist, the migration in
        supabase/migrations/20260829_apollo_prospecting.sql has not been run yet.
      </p>
    </Card>;
  }

  const totals = rows.reduce((a, r) => ({
    searches: a.searches + r.searches, emails: a.emails + r.emails,
    mobiles: a.mobiles + r.mobiles, credits: a.credits + r.credits, saved: a.saved + r.saved,
  }), { searches: 0, emails: 0, mobiles: 0, credits: 0, saved: 0 });

  return (
    <>
    {quota && (
      <div className="mb-4 px-4 py-2 bg-white border border-slate-200 rounded-xl">
        <Quota quota={quota} spent={totals.credits} />
      </div>
    )}
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-xs">
            <tr className="border-b border-slate-200">
              <th className="text-left font-medium px-5 py-2.5">Broker</th>
              <th className="text-right font-medium px-3 py-2.5">Searches</th>
              <th className="text-right font-medium px-3 py-2.5">Emails</th>
              <th className="text-right font-medium px-3 py-2.5">Mobiles</th>
              <th className="text-right font-medium px-3 py-2.5">Credits</th>
              <th className="text-right font-medium px-3 py-2.5">Free from store</th>
              <th className="text-right font-medium px-5 py-2.5">Last active</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-b border-slate-100 last:border-0">
                <td className="px-5 py-3 font-medium text-slate-900">{r.name}</td>
                <td className="px-3 py-3 text-right text-slate-600 tabular-nums">{r.searches}</td>
                <td className="px-3 py-3 text-right text-slate-600 tabular-nums">{r.emails}</td>
                <td className="px-3 py-3 text-right text-slate-600 tabular-nums">{r.mobiles}</td>
                <td className="px-3 py-3 text-right font-semibold text-slate-900 tabular-nums">
                  {r.credits.toLocaleString()}
                </td>
                <td className="px-3 py-3 text-right tabular-nums">
                  {r.saved
                    ? <span className="text-emerald-700 font-medium">{r.saved}</span>
                    : <span className="text-slate-300">0</span>}
                </td>
                <td className="px-5 py-3 text-right text-slate-500 text-xs">
                  {r.last ? r.last.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "—"}
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr><td colSpan={7} className="px-5 py-8 text-center text-sm text-slate-500">
                Nobody has run a search yet.
              </td></tr>
            )}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold text-slate-900">
                <td className="px-5 py-3">Everyone</td>
                <td className="px-3 py-3 text-right tabular-nums">{totals.searches}</td>
                <td className="px-3 py-3 text-right tabular-nums">{totals.emails}</td>
                <td className="px-3 py-3 text-right tabular-nums">{totals.mobiles}</td>
                <td className="px-3 py-3 text-right tabular-nums">{totals.credits.toLocaleString()}</td>
                <td className="px-3 py-3 text-right tabular-nums text-emerald-700">{totals.saved}</td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      <p className="text-[11px] text-slate-400 px-5 py-3 border-t border-slate-100">
        Written server-side by the proxy that made the call, so a reveal cannot be spent without
        appearing here. “Free from store” is reveals answered out of apollo_leads because somebody
        had already bought that contact.
      </p>
    </Card>

    {/* Every reveal, newest first, with the person who ran it. */}
    <Card className="mt-4 overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100">
        <h3 className="text-[11px] font-bold tracking-wider text-slate-500 uppercase">
          Enrichment log
        </h3>
        <span className="text-[11px] text-slate-400">
          {feed.length ? `last ${feed.length}` : "nothing yet"}
        </span>
      </div>
      {feed.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-slate-500">Nobody has revealed a contact yet.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {feed.map((f, i) => (
            <li key={i} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-5 py-2.5 text-xs">
              <span className="font-medium text-slate-900">
                {f.broker_name || f.user_email || "Unknown user"}
              </span>
              <span className="text-slate-500">
                revealed a {f.reveal_type === "mobile" ? "mobile" : "email"} for
              </span>
              <span className="text-slate-800">{f.person_name || "an unnamed contact"}</span>
              {f.cached ? (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700"
                  title="Served from apollo_leads — somebody had already bought this contact">
                  free · already owned
                </span>
              ) : (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 tabular-nums">
                  {Number(f.credits ?? 0)} credit{Number(f.credits ?? 0) === 1 ? "" : "s"}
                </span>
              )}
              {f.status !== "ok" && (
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                  f.status === "pending" ? "bg-amber-50 text-amber-700" : "bg-rose-50 text-rose-700"}`}>
                  {f.status}
                </span>
              )}
              <span className="ml-auto text-slate-400 tabular-nums whitespace-nowrap">
                {f.at.toLocaleString("en-GB", {
                  day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
    </>
  );
}

/* -------------------------------- shell -------------------------------- */

export default function Prospecting() {
  const [tab, setTab] = useState("search");
  const { profile, user } = useAuth();
  const brokerName = profile?.full_name || profile?.propspace_agent_name || user?.email || null;

  const TABS = [["search", "Search", Users], ["activity", "Activity", ActivityIcon]];

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Prospecting</h1>
            <span className="text-[10px] font-bold tracking-wider uppercase bg-slate-900 text-white
                             px-1.5 py-0.5 rounded">Apollo</span>
          </div>
          <p className="text-sm text-slate-500 mt-1">
            Find people worth ringing. Contacts are bought once and shared — a colleague’s reveal is
            free for everyone after.
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {TABS.map(([k, label, Icon]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg border transition ${tab === k
                ? "bg-slate-900 text-white border-slate-900 font-medium"
                : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"}`}>
              <Icon className="w-4 h-4" /> {label}
            </button>
          ))}
        </div>
      </div>

      {tab === "search" ? <SearchTab brokerName={brokerName} /> : <ActivityTab />}
    </>
  );
}
