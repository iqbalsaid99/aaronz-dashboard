/**
 * CRM sync Worker — tiers 1 and 2 of four.
 *
 * WHY TWO TIERS AND NOT ONE FILTER. PropSpace honours no date filter
 * (`date_updated` is accepted and inert; every other date parameter is a 400)
 * and offers no sort control. Ordering is created_at DESC. So:
 *
 *   every 10m   NEW leads are cheap: page from 1 until created_at drops below
 *               the watermark, then stop. About one page a run.
 *   every 30m   UPDATED leads are invisible to that. A lead created in April that
 *               got a note this morning is still on page 40 and nothing moves
 *               it. So the first 30 pages are re-pulled unconditionally and
 *               upserted. No cursor, by design — a cursor is exactly what
 *               cannot work here.
 *
 * Anything older than page 30 that changes is caught by tier 3, the nightly
 * full sweep, which is the backfill script under a GitHub Action rather than a
 * Worker: 431 pages is past what one invocation should attempt.
 *
 * FAILS CLOSED. Any error writes last_error and leaves every watermark where
 * it was, so the next run re-covers the same ground. A cursor advanced past
 * records that were never read is silent, permanent data loss.
 */

const API = 'https://api.propspace.com';
const PAGE_SIZE = 100;
const HOT_PAGES = 30;          // tier 2 depth
const UPSERT_BATCH = 500;
const CONCURRENCY = 4;         // 8 concurrent pages trips this account's WAF
const OVERLAP_MINUTES = 5;     // as specified: re-read a little either side

/* ------------------------------- helpers ------------------------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (v) => { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d.toISOString(); };
const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const str = (v) => { const t = String(v ?? '').trim(); return t && t !== 'undefined' && t !== 'null' ? t : null; };
const first = (a) => (Array.isArray(a) && a.length ? a[0] : {});

async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i]);
    }
  }));
  return out;
}

/* ------------------------------ propspace ------------------------------ */

let token = null, tokenExp = 0;

async function getToken(env) {
  if (token && Date.now() < tokenExp - 60_000) return token;
  const res = await fetch(`${API}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: env.PROPSPACE_CLIENT_ID,
      client_secret: env.PROPSPACE_CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`auth ${res.status}`);
  const j = await res.json();
  token = j.access_token;
  tokenExp = Date.now() + (j.expires_in ?? 3600) * 1000;
  return token;
}

async function getPage(env, page, attempt = 0) {
  const res = await fetch(`${API}/leads?page=${page}&per_page=${PAGE_SIZE}`, {
    headers: { Authorization: `Bearer ${await getToken(env)}`, Accept: 'application/json' },
  });
  if (res.status === 401 && attempt < 2) { token = null; return getPage(env, page, attempt + 1); }
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    await sleep(Math.min(20_000, 2 ** attempt * 1000) + Math.random() * 300);
    return getPage(env, page, attempt + 1);
  }
  if (!res.ok) throw new Error(`/leads p${page} -> ${res.status}`);
  return res.json();
}

/* ------------------------------- supabase ------------------------------ */

async function sb(env, path, init = {}) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const res = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1${path}`, {
    ...init,
    headers: {
      apikey: key, Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json', ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`supabase ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function upsert(env, rows) {
  for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
    await sb(env, '/crm_leads?on_conflict=id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows.slice(i, i + UPSERT_BATCH)),
    });
  }
}

const readState = async (env) =>
  (await sb(env, '/sync_state?source=eq.leads&select=*&limit=1'))?.[0] ?? null;

const writeState = (env, patch) =>
  sb(env, '/sync_state?source=eq.leads', {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });

/* -------------------------------- mapper ------------------------------- */

/** Identical to the backfill's mapper — the tiers must agree column for
 *  column, or a row's shape would depend on which one happened to write it. */
function mapLead(l, syncSource) {
  const req = first(l.requirements);
  const agent = first(l.agents);
  const st = typeof l.status === 'string' ? { sub_status: l.status } : (l.status ?? {});
  return {
    id: l.id,
    reference: str(l.reference), lead_type: str(l.lead_type), source: str(l.source),
    other_source_of_lead: str(l.other_source_of_lead), source_channel: str(l.source_channel),
    priority: str(l.priority), hot_lead: str(l.hot_lead), finance: str(l.finance),
    in_lead_pool: str(l.in_lead_pool),
    status: str(st.status), sub_status: str(st.sub_status),
    assigned_to_id: num(agent.id), assigned_to_name: str(agent.name),
    contact_id: num(l.contact?.id),
    req_listing_reference: str(req.listing_reference), req_listing_id: num(req.listing_id),
    req_category: str(req.category), req_unit_type: str(req.unit_type),
    req_emirate: str(req.emirate), req_location: str(req.location),
    req_sub_location: str(req.sub_location),
    req_min_beds: str(req.min_beds), req_max_beds: str(req.max_beds),
    req_min_price: num(req.min_price), req_max_price: num(req.max_price),
    req_min_area: num(req.min_area), req_max_area: num(req.max_area),
    contact: l.contact ?? null, agents: l.agents ?? null,
    requirements: l.requirements ?? null, notes: l.notes ?? null,
    date_of_enquiry: iso(l.date_of_enquiry),
    source_created_at: iso(l.created_at),
    source_last_updated: iso(l.last_updated),
    synced_at: new Date().toISOString(),
    sync_source: syncSource,
  };
}

/* --------------------------------- tiers -------------------------------- */

/**
 * Tier 1: everything created since the watermark, minus five minutes.
 *
 * Stops at the first page whose OLDEST row predates the cutoff — the ordering
 * guarantees nothing newer lies beyond it. maxPages is a backstop against a
 * watermark that is missing or absurdly old, not a budget.
 */
async function syncNew(env) {
  const state = await readState(env);
  const since = state?.last_created_cursor
    ? new Date(new Date(state.last_created_cursor).getTime() - OVERLAP_MINUTES * 60_000)
    : new Date(Date.now() - 24 * 3600_000);   // first run: a day, not the whole book

  const seen = new Map();
  let newest = null;

  for (let page = 1; page <= 40; page++) {
    const rows = (await getPage(env, page))?.data ?? [];
    if (!rows.length) break;
    for (const l of rows) {
      const at = new Date(l.created_at);
      if (at >= since) seen.set(l.id, l);
      if (!newest || at > newest) newest = at;
    }
    const oldest = new Date(rows[rows.length - 1].created_at);
    if (oldest < since) break;
  }

  const mapped = [...seen.values()].map((l) => mapLead(l, 'cron_new'));
  if (mapped.length) await upsert(env, mapped);

  await writeState(env, {
    // Only ever advanced on success, and only to what was actually read.
    last_created_cursor: (newest ?? since).toISOString(),
    last_success_at: new Date().toISOString(),
    rows_upserted: mapped.length,
    last_error: null, last_error_at: null,
  });
  return { tier: 'new', rows: mapped.length };
}

/**
 * Tier 2: the first HOT_PAGES pages, unconditionally.
 *
 * No cursor, and that is the design rather than an omission. An updated lead
 * does not move in a created_at ordering, so there is nothing to be a cursor
 * ON — the only way to notice a change is to look again.
 */
async function syncHot(env) {
  const pages = Array.from({ length: HOT_PAGES }, (_, i) => i + 1);
  const results = await pool(pages, CONCURRENCY, async (p) => {
    try { return (await getPage(env, p))?.data ?? []; }
    catch { return null; }
  });

  const failed = results.filter((r) => r === null).length;
  // A partial sweep must not be recorded as a sweep. Half of the hot window is
  // not the hot window, and last_hot_sweep_at is how anyone judges staleness.
  if (failed) throw new Error(`hot sweep: ${failed} of ${HOT_PAGES} pages failed`);

  const seen = new Map();
  for (const rows of results) for (const l of rows) seen.set(l.id, l);
  const mapped = [...seen.values()].map((l) => mapLead(l, 'cron_hot'));
  if (mapped.length) await upsert(env, mapped);

  await writeState(env, {
    last_hot_sweep_at: new Date().toISOString(),
    last_success_at: new Date().toISOString(),
    rows_upserted: mapped.length,
    last_error: null, last_error_at: null,
  });
  return { tier: 'hot', rows: mapped.length };
}

/* ------------------------------- entrypoint ----------------------------- */

async function run(env, cron) {
  // Both crons fire together every 30 minutes. The deeper sweep is a superset
  // of the shallow one, so running both would pay for the same pages twice.
  const hot = cron === '*/30 * * * *';
  return hot ? syncHot(env) : syncNew(env);
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        const r = await run(env, event.cron);
        console.log(`[crm-sync] ${r.tier}: ${r.rows} rows`);
      } catch (e) {
        console.error('[crm-sync]', e.message);
        // Fails closed: the error is recorded, no watermark moves.
        try {
          await writeState(env, { last_error: String(e.message).slice(0, 500), last_error_at: new Date().toISOString() });
        } catch (inner) {
          console.error('[crm-sync] could not even record the failure', inner.message);
        }
      }
    })());
  },

  // Manual trigger, so a tier can be run without waiting for its cron.
  //   curl -X POST https://<worker>/run?tier=hot -H "authorization: Bearer $SYNC_TRIGGER_TOKEN"
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/run') return new Response('not found', { status: 404 });
    const auth = request.headers.get('authorization') ?? '';
    if (!env.SYNC_TRIGGER_TOKEN || auth !== `Bearer ${env.SYNC_TRIGGER_TOKEN}`) {
      return new Response('unauthorized', { status: 401 });
    }
    try {
      const r = await run(env, url.searchParams.get('tier') === 'hot' ? '*/30 * * * *' : '*/10 * * * *');
      return Response.json(r);
    } catch (e) {
      await writeState(env, { last_error: String(e.message).slice(0, 500), last_error_at: new Date().toISOString() }).catch(() => {});
      return Response.json({ error: e.message }, { status: 500 });
    }
  },
};
