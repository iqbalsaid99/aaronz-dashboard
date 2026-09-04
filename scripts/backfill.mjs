#!/usr/bin/env node
/**
 * PropSpace -> Supabase backfill. Run locally, once, to fill the mirror.
 *
 *   node scripts/backfill.mjs                 # every source
 *   node scripts/backfill.mjs leads           # one source
 *   node scripts/backfill.mjs --restart       # ignore the checkpoint
 *   node scripts/backfill.mjs --dry-run       # read and map, write nothing
 *
 * WHY A FULL SCAN IS THE ONLY OPTION FOR LEADS. The API honours no date filter
 * — `date_updated` is accepted and inert, and every other date parameter is a
 * 400 — and there is no sort control. Ordering is created_at DESC. So the only
 * way to see every lead is to walk all 431 pages of them.
 *
 * RESUMABILITY IS BY PAGE, WITH DELIBERATE OVERLAP. The checkpoint is the last
 * page fully written, kept in sync_state. On resume the script goes back
 * RESUME_OVERLAP pages before it, because the ordering is created_at DESC:
 * leads arriving during a long run push every older row further down, so a row
 * that was on page 40 when the run started may be on page 41 by the time it
 * resumes. Re-reading a couple of pages is free — the upsert is idempotent —
 * and skipping a row is not.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------- config -------------------------------- */

const CONCURRENCY   = 5;      // as specified; 8 concurrent pages trips the WAF
const PAGE_SIZE     = 100;    // per_page caps here
const UPSERT_BATCH  = 500;    // rows per insert statement
const RESUME_OVERLAP = 2;     // pages re-read on resume, see the note above
const MAX_RETRIES   = 5;

/** .env parsed by hand: this runs before anything that would load it. */
function env() {
  const out = { ...process.env };
  for (const file of ['.env', '.env.local']) {
    let text;
    try { text = readFileSync(resolve(ROOT, file), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !out[m[1]]) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return out;
}
const ENV = env();

const required = (k) => {
  const v = ENV[k];
  if (!v) {
    console.error(`\n  Missing ${k}.`);
    if (k === 'SUPABASE_SERVICE_ROLE_KEY') {
      console.error('  The mirror is written as the service role — RLS grants no insert to anyone else.');
      console.error('  Supabase -> Project Settings -> API -> service_role, then add it to .env.\n');
    }
    process.exit(1);
  }
  return v;
};

/* -------------------------------- utils -------------------------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (v) => { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d.toISOString(); };
const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const str = (v) => { const t = String(v ?? '').trim(); return t && t !== 'undefined' && t !== 'null' ? t : null; };

/** Runs `worker` over `items` with at most `limit` in flight. */
async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  }));
  return out;
}

/* ------------------------------ propspace ------------------------------ */

const API = 'https://api.propspace.com';
let token = null, tokenExp = 0, tokenInFlight = null;

async function getToken() {
  if (token && Date.now() < tokenExp - 60_000) return token;
  if (tokenInFlight) return tokenInFlight;
  tokenInFlight = (async () => {
    const res = await fetch(`${API}/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: required('PROPSPACE_CLIENT_ID'),
        client_secret: required('PROPSPACE_CLIENT_SECRET'),
      }),
    });
    if (!res.ok) throw new Error(`auth ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = await res.json();
    token = j.access_token;
    tokenExp = Date.now() + (j.expires_in ?? 3600) * 1000;
    return token;
  })().finally(() => { tokenInFlight = null; });
  return tokenInFlight;
}

/**
 * One page, with backoff.
 *
 * 429 and 5xx are retried; a 401 refreshes the token once and retries, because
 * a backfill outlives its own hour-long token. A 4xx that is not 401 or 429 is
 * a request this script got wrong and retrying it would only be slower.
 */
async function getPage(path, params, attempt = 0) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${API}${path}?${qs}`, {
    headers: { Authorization: `Bearer ${await getToken()}`, Accept: 'application/json' },
  });

  if (res.status === 401 && attempt < 2) { token = null; return getPage(path, params, attempt + 1); }

  if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
    const retryAfter = Number(res.headers.get('retry-after'));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : Math.min(30_000, 2 ** attempt * 1000) + Math.random() * 400;   // jitter: 5 workers must not retry in lockstep
    console.log(`    ${res.status} on ${path} p${params.page} — retrying in ${Math.round(wait)}ms (${attempt + 1}/${MAX_RETRIES})`);
    await sleep(wait);
    return getPage(path, params, attempt + 1);
  }

  const text = await res.text();
  if (!res.ok) throw new Error(`${path} p${params.page} -> ${res.status}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { throw new Error(`${path} p${params.page}: non-JSON response`); }
}

/* ------------------------------- supabase ------------------------------ */

const SB = () => required('SUPABASE_URL').replace(/\/$/, '');

async function sbFetch(path, init = {}) {
  const key = required('SUPABASE_SERVICE_ROLE_KEY');
  const res = await fetch(`${SB()}/rest/v1${path}`, {
    ...init,
    headers: {
      apikey: key, Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json', ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`supabase ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function upsert(table, rows, conflict = 'id') {
  for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
    const batch = rows.slice(i, i + UPSERT_BATCH);
    await sbFetch(`/${table}?on_conflict=${conflict}`, {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(batch),
    });
  }
}

const readState = async (source) =>
  (await sbFetch(`/sync_state?source=eq.${source}&select=*&limit=1`))?.[0] ?? null;

const writeState = (source, patch) =>
  sbFetch(`/sync_state?source=eq.${source}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });

/* ------------------------------- mappers ------------------------------- */

const first = (a) => (Array.isArray(a) && a.length ? a[0] : {});

export const mapLead = (l) => {
  const req = first(l.requirements);
  const agent = first(l.agents);
  const st = typeof l.status === 'string' ? { sub_status: l.status } : (l.status ?? {});
  return {
    id: l.id,
    reference: str(l.reference),
    lead_type: str(l.lead_type),
    source: str(l.source),
    other_source_of_lead: str(l.other_source_of_lead),
    source_channel: str(l.source_channel),
    priority: str(l.priority),
    hot_lead: str(l.hot_lead),
    finance: str(l.finance),
    in_lead_pool: str(l.in_lead_pool),
    status: str(st.status),
    sub_status: str(st.sub_status),
    assigned_to_id: num(agent.id),
    assigned_to_name: str(agent.name),
    contact_id: num(l.contact?.id),
    req_listing_reference: str(req.listing_reference),
    req_listing_id: num(req.listing_id),
    req_category: str(req.category),
    req_unit_type: str(req.unit_type),
    req_emirate: str(req.emirate),
    req_location: str(req.location),
    req_sub_location: str(req.sub_location),
    req_min_beds: str(req.min_beds),
    req_max_beds: str(req.max_beds),
    req_min_price: num(req.min_price),
    req_max_price: num(req.max_price),
    req_min_area: num(req.min_area),
    req_max_area: num(req.max_area),
    contact: l.contact ?? null,
    agents: l.agents ?? null,
    requirements: l.requirements ?? null,
    notes: l.notes ?? null,
    date_of_enquiry: iso(l.date_of_enquiry),
    source_created_at: iso(l.created_at),
    source_last_updated: iso(l.last_updated),
    synced_at: new Date().toISOString(),
    sync_source: 'backfill',
  };
};

export const mapListing = (l) => ({
  id: l.id,
  ref: str(l.ref),
  name: str(l.name),
  type: str(l.type),
  status: str(l.status),
  property_status: str(l.property_status),
  category: str(l.category),
  completion_status: str(l.completion_status),
  furnished: str(l.furnished),
  price: num(l.price),
  size: num(l.size),
  beds: str(l.beds),
  baths: num(l.baths),
  unit_number: str(l.unit_number),
  permit_number: str(l.permit_number),
  description: str(l.description),
  featured: typeof l.featured === 'boolean' ? l.featured : null,
  next_available_date: iso(l.next_available_date),
  client_id: num(l.client_id),
  agent_id: num(l.agent?.id),
  agent_name: str(l.agent?.name),
  marketing_agent_id: num(l.marketing_agent?.id),
  marketing_agent_name: str(l.marketing_agent?.name),
  area_location_id: num(l.area_location?.id),
  area_location_name: str(l.area_location?.name),
  sub_area_location_id: num(l.sub_area_location?.id),
  sub_area_location_name: str(l.sub_area_location?.name),
  region: l.region ?? null,
  amenities: l.amenities ?? null,
  features: l.features ?? null,
  portals: l.portals ?? null,
  images: l.images ?? null,
  source_created_at: iso(l.created_at),
  source_last_updated: iso(l.updated_at),
  synced_at: new Date().toISOString(),
  sync_source: 'backfill',
});

/** The landlord, kept out of crm_listings so it keeps its own RLS. */
export const mapOwner = (l) => (l.owner ? { listing_id: l.id, owner: l.owner, synced_at: new Date().toISOString() } : null);

export const mapContact = (c) => ({
  id: c.id,
  reference: str(c.reference),
  first_name: str(c.first_name),
  last_name: str(c.last_name),
  email: str(c.email), email_2: str(c.email_2), email_3: str(c.email_3),
  phone: str(c.phone), phone_2: str(c.phone_2), phone_3: str(c.phone_3),
  mobile: str(c.mobile), mobile_2: str(c.mobile_2), mobile_3: str(c.mobile_3),
  job_title: str(c.job_title),
  company: str(c.company),
  gender: str(c.gender),
  date_of_birth: str(c.date_of_birth),
  address: str(c.address),
  address_city: str(c.address_city),
  address_state: str(c.address_state),
  address_country: str(c.address_country),
  address_zip_po_box: str(c.address_zip_po_box),
  source_of_contact: str(c.source_of_contact),
  other_source_of_contact: str(c.other_source_of_contact),
  source_channel: str(c.source_channel),
  notes: c.notes ?? null,
  source_created_at: iso(c.date_added),
  source_last_updated: iso(c.date_updated),
  synced_at: new Date().toISOString(),
  sync_source: 'backfill',
});

const SOURCES = {
  leads:    { path: '/leads',    table: 'crm_leads',    map: mapLead },
  listings: { path: '/listings', table: 'crm_listings', map: mapListing, side: { table: 'crm_listing_owners', map: mapOwner, conflict: 'listing_id' } },
  contacts: { path: '/contacts', table: 'crm_contacts', map: mapContact },
};

/* --------------------------------- run --------------------------------- */

async function backfill(name, { restart, dryRun }) {
  const src = SOURCES[name];
  const started = Date.now();
  console.log(`\n=== ${name} -> ${src.table} ===`);

  // meta.total in one request tells us how many pages exist, so the work can
  // be planned and reported instead of discovered a page at a time.
  const head = await getPage(src.path, { page: 1, per_page: 1 });
  const total = head?.meta?.total ?? null;
  if (!total) { console.log('  no total returned — refusing to guess the page count'); return; }
  const pages = Math.ceil(total / PAGE_SIZE);

  let from = 1;
  if (!restart && !dryRun) {
    const state = await readState(name).catch(() => null);
    const done = Number(state?.last_cursor);
    if (Number.isFinite(done) && done > 0) {
      from = Math.max(1, done - RESUME_OVERLAP + 1);
      console.log(`  resuming: page ${done} was written, restarting at ${from} (${RESUME_OVERLAP}-page overlap)`);
    }
  }

  console.log(`  ${total.toLocaleString()} rows, ${pages} pages, ${CONCURRENCY} at a time${dryRun ? '  [DRY RUN]' : ''}`);

  const numbers = [];
  for (let p = from; p <= pages; p++) numbers.push(p);

  let written = 0, failed = 0, highest = from - 1;

  // Chunked so the checkpoint advances during the run rather than at the end
  // of it — a backfill that dies on page 400 of 431 must not start again at 1.
  for (let i = 0; i < numbers.length; i += CONCURRENCY) {
    const chunk = numbers.slice(i, i + CONCURRENCY);
    const results = await pool(chunk, CONCURRENCY, async (p) => {
      try {
        const body = await getPage(src.path, { page: p, per_page: PAGE_SIZE });
        const rows = body?.data ?? [];
        return { p, rows };
      } catch (e) {
        console.error(`    page ${p} FAILED: ${e.message}`);
        return { p, rows: null, error: e.message };
      }
    });

    const ok = results.filter((r) => r.rows);
    failed += results.length - ok.length;
    const mapped = ok.flatMap((r) => r.rows.map(src.map));

    if (mapped.length && !dryRun) {
      await upsert(src.table, mapped);
      if (src.side) {
        const side = ok.flatMap((r) => r.rows.map(src.side.map)).filter(Boolean);
        if (side.length) await upsert(src.side.table, side, src.side.conflict);
      }
    }
    written += mapped.length;

    // Only advance past a contiguous run of successes. A gap left by a failed
    // page must not be checkpointed over, or the retry never happens.
    if (!results.some((r) => !r.rows)) highest = Math.max(highest, ...chunk);

    const pct = Math.round(((i + chunk.length) / numbers.length) * 100);
    console.log(`  p${chunk[0]}-${chunk[chunk.length - 1]}  +${mapped.length} rows  ${written.toLocaleString()} total  ${pct}%`);

    if (!dryRun) {
      await writeState(name, {
        last_cursor: String(highest),
        rows_upserted: written,
        last_error: failed ? `${failed} page(s) failed` : null,
      }).catch((e) => console.error(`    checkpoint failed: ${e.message}`));
    }
  }

  const secs = ((Date.now() - started) / 1000).toFixed(0);
  console.log(`  done: ${written.toLocaleString()} rows in ${secs}s, ${failed} page(s) failed`);

  if (!dryRun && !failed) {
    await writeState(name, {
      last_success_at: new Date().toISOString(),
      last_full_sweep_at: new Date().toISOString(),
      last_error: null, last_error_at: null,
    });
  } else if (!dryRun) {
    await writeState(name, { last_error: `${failed} page(s) failed`, last_error_at: new Date().toISOString() });
  }
}

/**
 * Only run when invoked directly. Importing this file — to check a mapper
 * against the schema, or to reuse one in the cron worker — must not start a
 * backfill as a side effect.
 */
const invokedDirectly = process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (!invokedDirectly) {
  // exported for reuse; nothing else happens
} else {

const args = process.argv.slice(2);
const flags = { restart: args.includes('--restart'), dryRun: args.includes('--dry-run') };
const wanted = args.filter((a) => !a.startsWith('--'));
const list = wanted.length ? wanted : Object.keys(SOURCES);

for (const name of list) {
  if (!SOURCES[name]) { console.error(`unknown source "${name}" — one of ${Object.keys(SOURCES).join(', ')}`); process.exit(1); }
}

let exitCode = 0;
for (const name of list) {
  try {
    await backfill(name, flags);
  } catch (e) {
    exitCode = 1;
    console.error(`\n  ${name} aborted: ${e.message}`);
    if (/crm_contacts/.test(e.message)) {
      console.error('  crm_contacts is not in the stage 1 migration — see');
      console.error('  supabase/migrations/20260831_crm_contacts.sql, which is not applied by default.\n');
    }
    if (!flags.dryRun) {
      await writeState(name, { last_error: e.message.slice(0, 500), last_error_at: new Date().toISOString() }).catch(() => {});
    }
  }
}
process.exit(exitCode);

}   // end invokedDirectly
