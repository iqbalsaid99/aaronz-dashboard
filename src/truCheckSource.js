/**
 * The TruCheck source — the ONE place that knows where listing data comes from.
 *
 * Everything above this module deals in normalised snapshot rows and knows
 * nothing about Apify, Bayut page structure, or the two-stage crawl. When Bayut
 * ships a Profolio endpoint, `readLatest` keeps its signature, the refresh
 * functions collapse into one call, and no component changes. That is the whole
 * reason this boundary exists.
 *
 * SNAPSHOT-FIRST. `readLatest` reads Supabase only and never touches Apify, so
 * the tab renders the last crawl immediately. A refresh runs alongside it.
 *
 * THE CRAWL IS TWO STAGES, because no single actor does both jobs:
 *
 *   1  enumerate  every listing on the agency's Bayut account — cheap, thin,
 *                 gives reference / URL / agent / isVerified
 *   2  detail     each listing's own page — costs per listing, and is the only
 *                 source of photo counts, floor plans, panoramas, the TruCheck
 *                 DATE, and Bayut's internal scores
 *
 * Stage one decides what exists. Stage two only ever enriches it, so a detail
 * fetch that fails costs that listing's quality signals and never its presence.
 */

import { supabase } from './lib/supabase.js';
import { apiFetch } from './apiFetch.js';
import { normaliseCrawlItem, mergeCrawl, resolveSnapshot } from './truCheckSourceParse.mjs';
import { scoreListing } from './truCheckScore.js';

export * from './truCheckSourceParse.mjs';

const TABLE = 'bayut_listing_snapshot';
const RUNS = 'bayut_crawl_run';

/* --------------------------------- reading -------------------------------- */

const fromDb = (r) => ({
  reference: r.reference ?? null,
  permit: r.permit_number ?? null,
  bayutListingId: r.bayut_listing_id ?? null,
  url: r.bayut_url ?? null,
  detailed: r.detailed === true,

  isTruCheck: r.is_trucheck === true,
  truCheckedAt: r.truchecked_at ?? null,
  verificationStatus: r.verification_status ?? null,
  checked: r.checked ?? null,

  title: r.title ?? null,
  price: r.price ?? null,
  purpose: r.purpose ?? null,
  categoryClass: r.category_class ?? null,
  beds: r.beds ?? null,
  baths: r.baths ?? null,
  size: r.size ?? null,
  community: r.community ?? null,
  agentName: r.agent_name ?? null,
  agentBayutId: r.agent_bayut_id ?? null,
  state: r.listing_state ?? null,

  photoCount: r.photo_count ?? null,
  videoCount: r.video_count ?? null,
  panoramaCount: r.panorama_count ?? null,
  hasFloorPlan: r.has_floor_plan ?? null,
  amenityCount: r.amenity_count ?? null,

  nativeScores: r.native_scores ?? null,
  // Read back rather than recomputed, so opening an old snapshot shows the
  // score as it was, not as today's weights would render it.
  score: r.derived_score ?? null,
  factors: r.score_factors ?? [],
});

const missingTable = (message) => /schema cache|does not exist|PGRST205/i.test(message ?? '');

const noTableError = () => {
  const err = new Error('The Bayut listing snapshot table does not exist yet.');
  err.code = 'NO_TABLE';
  err.detail =
    'Run supabase/migrations/20260821b_bayut_listing_snapshot.sql in the ' +
    'Supabase SQL editor. The dashboard key cannot create tables.';
  return err;
};

/** Every row of one run. */
async function rowsOfRun(runId) {
  const { data, error } = await supabase.from(TABLE).select('*').eq('run_id', runId);
  if (error) throw new Error(`${TABLE}: ${error.message}`);
  return (data ?? []).map(fromDb);
}

const runNote = async (runId) => {
  const { data, error } = await supabase.from(RUNS).select('*').eq('run_id', runId).maybeSingle();
  // A missing note is a missing note, not a broken snapshot — runs written
  // before the bookkeeping table existed have none.
  return error ? null : data ?? null;
};

/**
 * The current view of the world, resolved from TWO runs.
 *
 * This is the heart of the two-speed refresh. A nightly enumerate is cheap and
 * knows every listing and its badge; it knows nothing about photo counts or
 * floor plans. A full crawl knows everything but costs per listing and runs
 * rarely. So the tab reads both:
 *
 *   base     the newest run of either kind — what exists, and its TruCheck
 *   quality  the newest run that actually read listing pages — the signals
 *
 * They are frequently the same run, and the code does not care either way.
 * When they differ, the badge is as fresh as last night and the photo counts
 * are as fresh as the last full crawl, which is exactly the trade the two
 * speeds are for. Both timestamps come back so the header can say so plainly
 * rather than presenting one freshness for two different things.
 *
 * Returns null only when no crawl has ever run.
 */
export async function readLatest() {
  const head = await supabase
    .from(TABLE)
    .select('run_id, scraped_at')
    .order('scraped_at', { ascending: false })
    .limit(1);

  if (head.error) {
    if (missingTable(head.error.message)) throw noTableError();
    throw new Error(`${TABLE}: ${head.error.message}`);
  }

  const newest = head.data?.[0];
  if (!newest) return null;

  // The newest run carrying quality data. Asked of the snapshot rather than of
  // the run table, because what matters is whether rows actually came back
  // detailed — a "full" run whose detail pass died is not a quality run.
  const detailHead = await supabase
    .from(TABLE)
    .select('run_id, scraped_at')
    .eq('detailed', true)
    .order('scraped_at', { ascending: false })
    .limit(1);

  const newestDetail = detailHead.error ? null : detailHead.data?.[0] ?? null;
  const sameRun = newestDetail?.run_id === newest.run_id;

  const [baseRows, qualityRows, run, qualityRun] = await Promise.all([
    rowsOfRun(newest.run_id),
    newestDetail && !sameRun ? rowsOfRun(newestDetail.run_id) : Promise.resolve(null),
    runNote(newest.run_id),
    newestDetail && !sameRun ? runNote(newestDetail.run_id) : Promise.resolve(null),
  ]);

  const quality = sameRun ? baseRows.filter((r) => r.detailed) : qualityRows ?? [];

  return {
    runId: newest.run_id,
    scrapedAt: newest.scraped_at,
    // Null when no full crawl has ever completed, which the header reports as
    // "no quality data yet" rather than as a date.
    qualityRunId: newestDetail?.run_id ?? null,
    qualityScrapedAt: newestDetail?.scraped_at ?? null,
    rows: resolveSnapshot(baseRows, quality),
    run,
    qualityRun: sameRun ? run : qualityRun,
  };
}

/* -------------------------------- refreshing ------------------------------ */

async function proxy(path, init) {
  const res = await apiFetch(`/api/trucheck${path}`, init);
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(body?.error ?? `TruCheck crawl returned ${res.status}.`);
    err.status = res.status;
    err.detail = body?.detail ?? null;
    throw err;
  }
  return body;
}

export const readConfig = () => proxy('/config');

/** Stage one. Returns immediately with a run id — never waits. */
export const startEnumerate = () => proxy('/run', { method: 'POST' });

/** Stage two, seeded from stage one's own dataset. Server-side; no URLs travel. */
export const startDetails = (runId) =>
  proxy('/details', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId }),
  });

export const pollRun = (runId) => proxy(`/run/${encodeURIComponent(runId)}`);
const runItems = (runId) => proxy(`/run/${encodeURIComponent(runId)}/items`);

export const TERMINAL = ['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'];

/**
 * Fold both stages into a snapshot and write it.
 *
 * `expected` is what the agency page claimed it has, when the enumerate actor
 * reported it. It is stored rather than compared away, so the tab can show the
 * delta instead of silently accepting whatever the crawl happened to reach.
 *
 * A run that enumerated NOTHING is refused rather than stored. An empty
 * snapshot renders as every listing missing from Bayut — a screen full of alarm
 * caused by a failed crawl, which is the worst thing this tab can produce.
 *
 * `mode` is 'enumerate' or 'full'. An enumerate run writes every listing with
 * detailed = false and no score; the tab then keeps showing quality data from
 * the last full run rather than blanking it. See readLatest.
 */
export async function commitRun({
  runId, detailRunId = null, mode = 'full', expected = null, usageUsd = null,
}) {
  const listPass = await runItems(runId);
  const enumerated = (listPass.items ?? [])
    .map((i) => normaliseCrawlItem(i, { detailed: false }))
    .filter((r) => r.reference || r.bayutListingId);

  if (!enumerated.length) {
    const err = new Error('The crawl finished but found no listings.');
    err.detail =
      'Nothing was saved. An empty snapshot would render as every listing ' +
      'missing from Bayut, which is a crawl failure, not a publishing one.';
    throw err;
  }

  let details = [];
  // An enumerate run must never write quality data, even if a detail run id is
  // passed by mistake. Enforced here rather than trusted to the caller, because
  // one bad write poisons the quality columns until the next full crawl.
  if (mode === 'full' && detailRunId) {
    // A failed detail pass must not lose the listing pass with it. The rows
    // stay thin, `detailed` stays false, and the tab reports the shortfall.
    try {
      const detailPass = await runItems(detailRunId);
      details = (detailPass.items ?? [])
        .filter((i) => i && (i.referenceNumber || i.externalID))
        .map((i) => normaliseCrawlItem(i, { detailed: true }));
    } catch {
      details = [];
    }
  }

  const merged = mergeCrawl(enumerated, details).map((r) => {
    // Only a detailed row is ever scored. The factors are unknown otherwise, and
    // a score computed from nulls is a number nobody measured — it would read as
    // "this listing is poor" when it means "we did not look".
    if (!r.detailed) return { ...r, score: null, factors: [] };
    const { score, factors } = scoreListing({ ...r, onBayut: true });
    return { ...r, score, factors };
  });

  const scrapedAt = new Date().toISOString();
  const detailedCount = merged.filter((r) => r.detailed).length;

  const payload = merged.map((r) => ({
    run_id: runId,
    scraped_at: scrapedAt,
    detailed: r.detailed === true,
    bayut_listing_id: r.bayutListingId,
    bayut_url: r.url,
    reference: r.reference,
    permit_number: r.permit,
    is_trucheck: r.isTruCheck,
    truchecked_at: r.truCheckedAt,
    verification_status: r.verificationStatus,
    checked: r.checked,
    title: r.title,
    price: r.price,
    purpose: r.purpose,
    category_class: r.categoryClass,
    beds: r.beds,
    baths: r.baths,
    size: r.size,
    community: r.community,
    agent_name: r.agentName,
    agent_bayut_id: r.agentBayutId,
    listing_state: r.state,
    photo_count: r.photoCount,
    video_count: r.videoCount,
    panorama_count: r.panoramaCount,
    has_floor_plan: r.hasFloorPlan,
    amenity_count: r.amenityCount,
    native_scores: r.nativeScores,
    derived_score: r.score,
    score_factors: r.factors,
  }));

  for (let i = 0; i < payload.length; i += 100) {
    const { error } = await supabase.from(TABLE).insert(payload.slice(i, i + 100));
    if (error) {
      if (missingTable(error.message)) throw noTableError();
      throw new Error(`${TABLE}: ${error.message}`);
    }
  }

  // Bookkeeping is best-effort: losing the note must not lose the snapshot.
  await supabase.from(RUNS).insert({
    run_id: runId,
    scraped_at: scrapedAt,
    run_type: mode,
    detail_run_id: mode === 'full' ? detailRunId ?? null : null,
    expected_count: expected,
    enumerated_count: merged.length,
    detailed_count: detailedCount,
    failed_count: Math.max(0, merged.length - detailedCount),
    usage_usd: usageUsd,
  });

  return {
    runId,
    scrapedAt,
    mode,
    enumerated: merged.length,
    detailed: detailedCount,
    // Only meaningful on a full run. An enumerate run detailed nothing by
    // design, and reporting that as 242 failures would be nonsense.
    failed: mode === 'full' ? Math.max(0, merged.length - detailedCount) : 0,
    expected,
  };
}
