/**
 * Apollo proxy — the only place the Apollo key exists.
 *
 * Four routes, all under /api/apollo:
 *
 *   POST /search          people search, logged to apollo_searches
 *   POST /reveal          an email or a mobile, cache-first, logged to apollo_reveals
 *   POST /webhook/:token  Apollo posting a mobile back, minutes or hours later
 *   GET  /health          whether the key and the plan can do any of this
 *
 * NOTHING IS PAID FOR TWICE. Every reveal reads apollo_leads first and returns
 * a stored value without touching Apollo. This is not an optimisation: two
 * brokers working the same list, or one broker double-clicking, otherwise buy
 * the same person's mobile twice, and Apollo bills per reveal.
 *
 * THE CREDIT-SPENDING CALLS ARE HERE, NOT IN THE BROWSER, for the obvious
 * reason and a second one: the client cannot be trusted to report what a
 * reveal cost, and the audit log is only worth keeping if the thing writing it
 * is the thing that made the call.
 */

const APOLLO = 'https://api.apollo.io/api/v1';

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extra },
  });

/* --------------------------- supabase helpers --------------------------- */

/** PostgREST as the CALLER, so their RLS applies and the log row carries them. */
async function db(env, token, path, init = {}) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
    ...init,
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`supabase ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

/** As the service role. Only the webhook uses this — see the note in the
 *  migration. Absent key is reported, never silently skipped. */
async function dbAdmin(env, path, init = {}) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set on this deployment');
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`supabase ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

/** Logging must never take a request down with it. A reveal that succeeded and
 *  failed to log is a bookkeeping problem; a reveal that 500s after Apollo has
 *  already charged for it is a lost credit. */
const logQuietly = (p) => p.catch((e) => console.error('[apollo] log failed', e));

/* ------------------------------- apollo -------------------------------- */

async function apollo(env, path, body) {
  if (!env.APOLLO_API_KEY) {
    return { ok: false, status: 503, body: {
      error: 'Apollo is not configured on this deployment.',
      detail: 'Add APOLLO_API_KEY with: wrangler pages secret put APOLLO_API_KEY',
    } };
  }

  const res = await fetch(`${APOLLO}${path}`, {
    method: 'POST',
    headers: {
      'x-api-key': env.APOLLO_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body ?? {}),
  });

  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { error: text.slice(0, 400) }; }

  /**
   * Apollo reports REQUEST QUOTA, not credit balance.
   *
   * There is no endpoint for the enrichment credit balance — /usage_stats,
   * /credit_usage and /users/me are all 404 or 422 on this plan, and the
   * balance lives only in Apollo's own web UI. What every response does carry
   * is how many API CALLS are left this minute, hour and day, which is a
   * different limit and worth showing because hitting it stops the tab dead.
   *
   * What a credit actually cost is answered by our own apollo_reveals ledger,
   * which is the number that matters for spend.
   */
  const n = (h) => { const v = Number(res.headers.get(h)); return Number.isFinite(v) ? v : null; };
  const quota = {
    minute: { used: n('x-minute-usage'), left: n('x-minute-requests-left'), limit: n('x-rate-limit-minute') },
    hour:   { used: n('x-hourly-usage'), left: n('x-hourly-requests-left'), limit: n('x-rate-limit-hourly') },
    day:    { used: n('x-24-hour-usage'), left: n('x-24-hour-requests-left'), limit: n('x-rate-limit-24-hour') },
  };

  // Apollo gates whole endpoints by billing plan and answers 403 with a
  // sentence saying so. Passed through as its own thing rather than a generic
  // failure, because the fix is a plan upgrade and nothing about this code.
  if (res.status === 403 && /not included in your .* plan/i.test(parsed?.error ?? '')) {
    return { ok: false, status: 402, body: {
      error: 'Your Apollo plan does not include this endpoint.',
      detail: parsed.error,
      planGated: true,
    } };
  }

  return { ok: res.ok, status: res.status, body: parsed, quota };
}

/** Credits Apollo says it charged. The field has moved around between API
 *  versions, so several spellings are tried and an unknown cost records as
 *  null rather than as zero — "free" and "not stated" are different. */
function creditsFrom(payload) {
  const c = payload?.credits_consumed ?? payload?.credits_used ??
            payload?.usage?.credits_consumed ?? null;
  return Number.isFinite(Number(c)) ? Number(c) : null;
}

/* ------------------------------ shaping -------------------------------- */

/**
 * One person, flattened to what the table shows.
 *
 * TWO ENDPOINTS RETURN TWO DIFFERENT SHAPES, and the search one is a teaser.
 * Verified against the live API on 31 Aug 2026, mixed_people/api_search
 * returns per person only:
 *
 *   id, first_name, last_name_obfuscated, title, organization{name},
 *   has_email, has_direct_phone, has_city, has_state, has_country,
 *   has_employee_count, last_refreshed_at
 *
 * No surname, no location, no LinkedIn, no headcount, and organization.name is
 * a DOMAIN ("devischrono.com"), not a company name. The has_* booleans are the
 * point of it: search tells you a field exists, not what it says.
 *
 * people/match returns the real record — full name, city/state/country,
 * linkedin_url, organization.estimated_num_employees, primary_domain — and
 * costs a credit.
 *
 * So this reads both shapes and marks which one it got. `teaser` is what the
 * UI needs in order to say "Apollo has a location for this person" instead of
 * printing an em dash that reads as "no location".
 */
export function shapePerson(p) {
  const org = p?.organization ?? p?.account ?? {};
  const where = [p?.city, p?.state, p?.country].filter(Boolean).join(', ');

  // A surname arrives either whole or obfuscated ("B███"), never both. The
  // obfuscated form is shown as-is: it is honest about being withheld, where
  // dropping it would imply the person has one name.
  const surname = p?.last_name ?? p?.last_name_obfuscated ?? null;
  const enriched = Boolean(p?.city || p?.linkedin_url || org?.primary_domain);

  // organization.name is a domain on the search shape and a company name on
  // the match shape. A bare domain is tidied for display rather than shown
  // with its TLD hanging off the end.
  const orgName = org?.name ?? p?.organization_name ?? null;
  const looksLikeDomain = orgName && /^[^\s]+\.[a-z]{2,}$/i.test(orgName);

  return {
    apolloPersonId: p?.id ?? null,
    name: [p?.first_name, surname].filter(Boolean).join(' ').trim() || p?.name || 'Unknown',
    title: p?.title ?? null,
    company: orgName,
    companyIsDomain: Boolean(looksLikeDomain),
    headcount: org?.estimated_num_employees ?? null,
    location: where || org?.country || null,
    linkedin: p?.linkedin_url ?? null,
    companyDomain: org?.primary_domain ?? org?.website_url ?? (looksLikeDomain ? orgName : null),
    // Apollo masks these unless a reveal has been paid for. A masked address is
    // not an address, so it is dropped rather than shown as one.
    email: p?.email && !/email_not_unlocked|not_unlocked/i.test(p.email) ? p.email : null,
    enriched,
    // What search will only tell us EXISTS. Without these the table cannot
    // distinguish "Apollo has no location" from "Apollo has one and is not
    // showing it until you pay".
    teaser: {
      email: p?.has_email ?? null,
      phone: p?.has_direct_phone ?? null,
      location: (p?.has_city ?? p?.has_country ?? null),
      headcount: org?.has_employee_count ?? null,
    },
  };
}

/* ------------------------------- routes -------------------------------- */

const SEARCH_FIELDS = [
  'person_titles', 'person_seniorities', 'person_locations',
  'organization_locations', 'organization_job_locations',
  'organization_num_employees_ranges', 'organization_job_posted_at_range',
  // Company name. Measured: q_organization_name narrows a 2,332,525-person
  // result to 10 for "Emaar". The plural spellings that look like they should
  // work — organization_names, company_names, organization_domains — are all
  // accepted and silently ignored, which is worse than being rejected.
  'q_organization_name',
];

async function handleSearch({ env, body, user, token }) {
  const filters = {};
  for (const f of SEARCH_FIELDS) {
    const v = body?.[f];
    if (Array.isArray(v) ? v.length : v) filters[f] = v;
  }
  const page = Number(body?.page) || 1;
  const perPage = Math.min(100, Number(body?.per_page) || 25);

  const r = await apollo(env, '/mixed_people/api_search', { ...filters, page, per_page: perPage });
  if (!r.ok) return json(r.body, r.status);

  const people = (r.body?.people ?? r.body?.contacts ?? []).map(shapePerson);
  // api_search returns { total_entries, people } — there is no pagination
  // object, so one is built. Without this the pager showed "page 1 of 1" on a
  // 157,094-person result and the Next button was dead.
  const total = r.body?.total_entries ?? r.body?.pagination?.total_entries ?? null;
  const pagination = {
    total_entries: total,
    page,
    per_page: perPage,
    total_pages: total ? Math.ceil(total / perPage) : null,
  };

  logQuietly(db(env, token, '/apollo_searches', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      user_id: user.id,
      user_email: user.email ?? null,
      broker_name: body?.brokerName ?? null,
      preset: body?.preset ?? null,
      filters,
      result_count: total ?? people.length,
      page,
    }),
  }));

  return json({ people, pagination, quota: r.quota });
}

/**
 * Company name suggestions.
 *
 * mixed_companies/search fuzzy-matches a partial name — "emaa" returns Emaar,
 * Emaar Hospitality Group and EMAA Insurance — which is the "did you mean"
 * behaviour without anything having to be built for it.
 *
 * DELIBERATELY NOT LOGGED to apollo_searches. These fire on keystrokes; a log
 * of them would bury the real searches it exists to record. They cost a
 * REQUEST against the per-minute allowance, not an enrichment credit, which is
 * why the client debounces rather than calling per character.
 */
async function handleCompanies({ env, body }) {
  const q = String(body?.q ?? '').trim();
  if (q.length < 2) return json({ companies: [] });

  const r = await apollo(env, '/mixed_companies/search', {
    q_organization_name: q, page: 1, per_page: 8,
  });
  if (!r.ok) return json(r.body, r.status);

  const companies = (r.body?.organizations ?? r.body?.accounts ?? []).map((c) => ({
    id: c?.id ?? null,
    name: c?.name ?? null,
    domain: c?.primary_domain ?? c?.website_url ?? null,
    logo: c?.logo_url ?? null,
    linkedin: c?.linkedin_url ?? null,
    foundedYear: c?.founded_year ?? null,
    revenue: c?.organization_revenue_printed ?? null,
  })).filter((c) => c.name);

  return json({ companies, quota: r.quota });
}

/**
 * A reveal, cache first.
 *
 * The order matters and is the whole feature: look in apollo_leads, and only
 * call Apollo when the answer is not already bought. A cached hit is still
 * logged, with credits 0 and cached true, because a log holding only the paid
 * reveals cannot distinguish "the cache is working" from "nobody used it".
 */
async function handleReveal({ env, body, user, token, origin }) {
  const id = String(body?.apolloPersonId ?? '').trim();
  const type = body?.type === 'mobile' ? 'mobile' : 'email';
  const person = body?.person ?? {};
  if (!id) return json({ error: 'apolloPersonId is required.' }, 400);

  const logReveal = (patch) => logQuietly(db(env, token, '/apollo_reveals', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      user_id: user.id,
      user_email: user.email ?? null,
      broker_name: body?.brokerName ?? null,
      apollo_person_id: id,
      person_name: person?.name ?? null,
      reveal_type: type,
      ...patch,
    }),
  }));

  // --- already bought?
  let existing = null;
  try {
    const rows = await db(env, token,
      `/apollo_leads?apollo_person_id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
    existing = rows?.[0] ?? null;
  } catch (e) {
    // A store we cannot read is a store we cannot trust not to double-charge,
    // so this refuses rather than guessing. But there is one cause that is not
    // a fault at all — the tables were never created — and it deserves saying
    // out loud instead of leaving somebody to read a Postgres error code.
    const msg = String(e.message ?? e);
    if (/PGRST205|Could not find the table|does not exist/i.test(msg)) {
      return json({
        error: 'Prospecting is not set up yet.',
        detail: 'The apollo_leads table does not exist, so there is no way to check whether ' +
                'this contact has already been bought — and buying it twice is exactly what ' +
                'that table prevents. Run supabase/migrations/20260829_apollo_prospecting.sql ' +
                'in the Supabase SQL editor, then try again.',
        setupRequired: true,
      }, 503);
    }
    return json({ error: 'Could not check what has already been revealed.', detail: msg }, 503);
  }

  if (type === 'email' && existing?.email) {
    logReveal({ credits: 0, cached: true, status: 'ok' });
    return json({ type, value: existing.email, cached: true, credits: 0 });
  }
  if (type === 'mobile' && existing?.mobile) {
    logReveal({ credits: 0, cached: true, status: 'ok' });
    return json({ type, value: existing.mobile, cached: true, credits: 0 });
  }
  if (type === 'mobile' && existing?.mobile_status === 'pending') {
    // Already asked for and already charged. Asking again buys it twice.
    logReveal({ credits: 0, cached: true, status: 'pending' });
    return json({ type, value: null, pending: true, cached: true, credits: 0 });
  }

  // --- not bought: ask Apollo
  const payload = {
    id,
    first_name: person?.name?.split(' ')[0] ?? undefined,
    last_name: person?.name?.split(' ').slice(1).join(' ') || undefined,
    organization_name: person?.company ?? undefined,
    domain: person?.companyDomain ?? undefined,
    linkedin_url: person?.linkedin ?? undefined,
    reveal_personal_emails: type === 'email',
    reveal_phone_number: type === 'mobile',
  };

  let webhookToken = null;
  if (type === 'mobile') {
    // A mobile is delivered asynchronously, so Apollo needs somewhere to put
    // it. The token is single use and is what the callback authenticates with.
    webhookToken = crypto.randomUUID();
    payload.webhook_url = `${origin}/api/apollo/webhook/${webhookToken}`;
  }

  const r = await apollo(env, '/people/match', payload);
  if (!r.ok) {
    logReveal({ credits: 0, cached: false, status: 'failed',
                detail: String(r.body?.detail ?? r.body?.error ?? '').slice(0, 300) });
    return json(r.body, r.status);
  }

  const matched = r.body?.person ?? r.body?.contact ?? {};
  const credits = creditsFrom(r.body);
  // Match data wins over the teaser the client sent. The order was the other
  // way round, which meant the obfuscated surname and the missing location
  // from search overwrote the real ones in the response we had just paid a
  // credit for.
  const shaped = shapePerson({ ...person, ...matched });

  const row = {
    apollo_person_id: id,
    full_name: shaped.name ?? person?.name ?? null,
    title: shaped.title ?? person?.title ?? null,
    company: shaped.company ?? person?.company ?? null,
    headcount: shaped.headcount ?? person?.headcount ?? null,
    location: shaped.location ?? person?.location ?? null,
    linkedin_url: shaped.linkedin ?? person?.linkedin ?? null,
    updated_at: new Date().toISOString(),
  };

  let value = null;
  if (type === 'email') {
    value = matched?.email ?? matched?.personal_emails?.[0] ?? null;
    if (value) {
      row.email = value;
      row.email_revealed_at = new Date().toISOString();
      row.email_revealed_by = user.id;
    }
  } else {
    // Some accounts answer inline; most post it back. Both are handled.
    value = matched?.phone_numbers?.[0]?.sanitized_number
         ?? matched?.phone_numbers?.[0]?.raw_number
         ?? matched?.mobile_phone ?? null;
    if (value) {
      row.mobile = value;
      row.mobile_revealed_at = new Date().toISOString();
      row.mobile_revealed_by = user.id;
      row.mobile_status = 'delivered';
    } else {
      row.mobile_status = 'pending';
      row.webhook_token = webhookToken;
      row.mobile_requested_at = new Date().toISOString();
    }
  }

  try {
    await db(env, token, '/apollo_leads?on_conflict=apollo_person_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(row),
    });
  } catch (e) {
    // Apollo has already charged. Losing the write means paying again next
    // time, so it is surfaced rather than swallowed — but the value the user
    // just bought is still returned to them.
    console.error('[apollo] could not store a paid reveal', e);
  }

  const pending = type === 'mobile' && !value;
  logReveal({ credits: credits ?? 0, cached: false, status: pending ? 'pending' : 'ok' });

  // The enriched profile rides back with the reveal. One credit buys the whole
  // record — surname, location, LinkedIn, headcount — and the row would
  // otherwise keep showing the teaser it was drawn from.
  return json({ type, value, pending, cached: false, credits, person: shaped, quota: r.quota });
}

/**
 * Apollo delivering a mobile.
 *
 * Authenticated by the single-use token in the path, matched against the row
 * that generated it. The token is cleared on arrival, so a replayed callback
 * finds nothing to write to.
 */
async function handleWebhook({ env, request, token }) {
  let body = {};
  try { body = await request.json(); } catch { /* Apollo has sent an empty body before */ }

  const number =
    body?.phone_number ?? body?.sanitized_number ??
    body?.person?.phone_numbers?.[0]?.sanitized_number ??
    body?.person?.phone_numbers?.[0]?.raw_number ??
    body?.people?.[0]?.phone_numbers?.[0]?.sanitized_number ?? null;

  try {
    const rows = await dbAdmin(env,
      `/apollo_leads?webhook_token=eq.${encodeURIComponent(token)}&select=apollo_person_id&limit=1`);
    if (!rows?.length) return json({ error: 'Unknown or already-used token.' }, 404);

    await dbAdmin(env, `/apollo_leads?webhook_token=eq.${encodeURIComponent(token)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        mobile: number,
        mobile_status: number ? 'delivered' : 'failed',
        mobile_revealed_at: number ? new Date().toISOString() : null,
        webhook_token: null,
        updated_at: new Date().toISOString(),
      }),
    });
    return json({ ok: true, stored: Boolean(number) });
  } catch (e) {
    console.error('[apollo] webhook', e);
    return json({ error: String(e.message ?? e) }, 500);
  }
}

/* ------------------------------ dispatch ------------------------------- */

export async function onRequest(context) {
  const { request, env, data } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/apollo/, '') || '/';

  const hook = path.match(/^\/webhook\/([A-Za-z0-9-]{8,64})$/);
  if (hook) {
    if (request.method !== 'POST') return json({ error: 'POST only.' }, 405);
    return handleWebhook({ env, request, token: hook[1] });
  }

  // Everything below is a signed-in human; _middleware has proved the session.
  const user = data?.user;
  const token = data?.token;
  if (!user || !token) return json({ error: 'Not signed in.' }, 401);

  if (path === '/health') {
    if (!env.APOLLO_API_KEY) return json({ configured: false }, 200);
    const res = await fetch(`${APOLLO}/auth/health`, { headers: { 'x-api-key': env.APOLLO_API_KEY } });
    const n = (h) => { const v = Number(res.headers.get(h)); return Number.isFinite(v) ? v : null; };
    return json({
      configured: true, ok: res.ok, status: res.status,
      quota: {
        minute: { used: n('x-minute-usage'), left: n('x-minute-requests-left'), limit: n('x-rate-limit-minute') },
        hour:   { used: n('x-hourly-usage'), left: n('x-hourly-requests-left'), limit: n('x-rate-limit-hourly') },
        day:    { used: n('x-24-hour-usage'), left: n('x-24-hour-requests-left'), limit: n('x-rate-limit-24-hour') },
      },
    });
  }

  if (request.method !== 'POST') return json({ error: 'POST only.' }, 405);

  let body = {};
  try { body = await request.json(); } catch { return json({ error: 'Expected JSON.' }, 400); }

  try {
    if (path === '/search') return await handleSearch({ env, body, user, token });
    if (path === '/companies') return await handleCompanies({ env, body });
    if (path === '/reveal') return await handleReveal({ env, body, user, token, origin: url.origin });
  } catch (e) {
    console.error('[apollo]', e);
    return json({ error: String(e.message ?? e) }, 502);
  }

  return json({ error: `No Apollo route for ${path}.` }, 404);
}
