/**
 * Reading and writing the publication ledger.
 *
 * The one place that talks to the ledger tables. Everything above deals in
 * plain rows and does not know Supabase is involved.
 *
 * APPEND-ONLY IS ENFORCED IN THREE PLACES, deliberately. The table has no
 * update or delete policy, the unique constraint rejects a second row for the
 * same listing and portal, and this module never issues anything but insert.
 * Any one of the three would do; all three means a mistake in one is caught by
 * the others, and the guarantee does not rest on remembering it.
 */

import { supabase } from './lib/supabase.js';
import { fetchListings } from './listings.js';
import { categoryClassOf } from './bayutListings.js';
import {
  publicationEvents, newEvents, ledgerKey, trustedFrom,
  REACHED_PORTAL, ALL_STATUSES,
} from './publicationLedger.js';

const LEDGER = 'listing_publication';
const SYNCS = 'listing_publication_sync';

const missingTable = (m) => /schema cache|does not exist|PGRST205/i.test(m ?? '');

const noTableError = () => {
  const err = new Error('The publication ledger does not exist yet.');
  err.code = 'NO_TABLE';
  err.detail =
    'Run supabase/migrations/20260822b_listing_publication_ledger.sql in the ' +
    'Supabase SQL editor. The dashboard key cannot create tables.';
  return err;
};

const fromDb = (r) => ({
  id: r.id,
  listingRef: r.listing_ref,
  listingId: r.listing_id,
  portal: r.portal,
  wentLiveAt: r.went_live_at,
  wentLiveSource: r.went_live_source,
  brokerId: r.broker_id,
  brokerName: r.broker_name,
  offering: r.offering,
  category: r.category,
  categoryClass: r.category_class,
  community: r.community,
  region: r.region,
  price: r.price,
  recordedAt: r.recorded_at,
});

const toDb = (e) => ({
  listing_ref: e.listingRef,
  listing_id: e.listingId,
  portal: e.portal,
  went_live_at: e.wentLiveAt,
  went_live_source: e.wentLiveSource,
  broker_id: e.brokerId,
  broker_name: e.brokerName,
  offering: e.offering,
  category: e.category,
  category_class: e.categoryClass,
  community: e.community,
  region: e.region,
  price: e.price,
});

/* --------------------------------- reading -------------------------------- */

/**
 * The whole ledger, plus the sync history that dates it.
 *
 * Paged because this grows without bound by design — one row per listing per
 * portal, forever — and PostgREST caps a response at 1,000 rows by default.
 * A silent cap here would quietly drop the oldest months.
 */
export async function readLedger() {
  const rows = [];
  const PAGE = 1000;

  for (let page = 0; page < 60; page++) {
    const { data, error } = await supabase
      .from(LEDGER)
      .select('*')
      .order('went_live_at', { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);

    if (error) {
      if (missingTable(error.message)) throw noTableError();
      throw new Error(`${LEDGER}: ${error.message}`);
    }
    rows.push(...(data ?? []));
    if ((data?.length ?? 0) < PAGE) break;
  }

  const { data: syncs, error: sErr } = await supabase
    .from(SYNCS)
    .select('*')
    .order('ran_at', { ascending: true });

  if (sErr && missingTable(sErr.message)) throw noTableError();

  return {
    rows: rows.map(fromDb),
    syncs: syncs ?? [],
    trusted: trustedFrom(syncs ?? []),
  };
}

/** Keys already in the ledger, so a sync only writes what is genuinely new. */
async function existingKeys() {
  const keys = new Set();
  const PAGE = 1000;

  for (let page = 0; page < 60; page++) {
    const { data, error } = await supabase
      .from(LEDGER)
      .select('listing_ref, portal')
      .range(page * PAGE, page * PAGE + PAGE - 1);

    if (error) {
      if (missingTable(error.message)) throw noTableError();
      throw new Error(`${LEDGER}: ${error.message}`);
    }
    for (const r of data ?? []) keys.add(ledgerKey(r.listing_ref, r.portal));
    if ((data?.length ?? 0) < PAGE) break;
  }
  return keys;
}

/* --------------------------------- writing -------------------------------- */

/**
 * Observe PropSpace and record any publication not already in the ledger.
 *
 * `mode` is 'sync' or 'backfill' and changes two things: which listings are
 * read, and how went_live_at is dated.
 *
 *   sync      reads currently-live listings and dates them NOW. Accurate to the
 *             interval between runs. This is the mode that makes the ledger
 *             trustworthy, and the first such run is the date the UI reports as
 *             the start of reliable history.
 *
 *   backfill  reads everything that ever reached a portal and dates it from
 *             created_at, because PropSpace records no publication date at all.
 *             Approximate, one-time, and clearly labelled wherever it surfaces.
 *
 * Existing rows are never rewritten. A listing that has since been repriced,
 * reassigned, expired or deleted keeps the row it already has.
 */
export async function syncPublications({ mode = 'sync', onProgress } = {}) {
  const ranAt = new Date();

  // A sync only needs what is live now: anything already taken down was either
  // recorded when it was live, or predates the ledger and belongs to backfill.
  const statuses = mode === 'backfill' ? REACHED_PORTAL : ['published'];

  const listings = await fetchListings({
    since: '2000-01-01',
    statuses,
    maxPages: mode === 'backfill' ? 120 : 20,
    onProgress,
  });

  const candidates = publicationEvents(listings, { at: ranAt, source: mode === 'backfill' ? 'backfill' : 'observed' })
    // categoryClass is owned by the Bayut listings module; applied here so the
    // ledger freezes it rather than the report deriving it later from a
    // category that may since have been edited.
    .map((e) => ({ ...e, categoryClass: categoryClassOf({ category: e.category }) }));

  const fresh = newEvents(candidates, await existingKeys());

  let written = 0;
  for (let i = 0; i < fresh.length; i += 200) {
    const batch = fresh.slice(i, i + 200).map(toDb);
    // ignoreDuplicates so a concurrent run cannot turn a race into an error,
    // and so the unique constraint stays the arbiter rather than this code.
    const { error } = await supabase
      .from(LEDGER)
      .upsert(batch, { onConflict: 'listing_ref,portal', ignoreDuplicates: true });

    if (error) {
      if (missingTable(error.message)) throw noTableError();
      throw new Error(`${LEDGER}: ${error.message}`);
    }
    written += batch.length;
  }

  await supabase.from(SYNCS).insert({
    ran_at: ranAt.toISOString(),
    mode,
    listings_seen: listings.length,
    rows_written: written,
    note: mode === 'backfill'
      ? 'Seeded from created_at; dates approximate.'
      : null,
  });

  return {
    mode,
    ranAt: ranAt.toISOString(),
    listingsSeen: listings.length,
    candidates: candidates.length,
    written,
    // Already present, i.e. publications recorded by an earlier run. On a
    // healthy sync this is nearly everything and `written` is a handful.
    alreadyRecorded: candidates.length - fresh.length,
  };
}

/* ------------------------------ current state ----------------------------- */

/**
 * The live pipeline: what is in draft, waiting, live, and taken down right now.
 *
 * Deliberately a SEPARATE call from the ledger, returning a separate shape, so
 * no component can accidentally mix a current-state number into a historical
 * one. They answer different questions and must never share a figure.
 */
/**
 * How far back the taken-down set is read.
 *
 * The other three states are the working book and are read whole: a draft
 * entered in 2023 is still a draft today, and a listing live since 2024 is
 * still stock. Taken-down is not like that — it is an ever-growing archive,
 * 9,700-odd records and rising, and reading all of it took two minutes to
 * produce a number nobody acts on.
 *
 * THE CUT IS ON created_at, NOT ON WHEN IT CAME DOWN. PropSpace records no
 * take-down date — four statuses, no transition history, and the only dates on
 * a record are created_at and updated_at. So this reads as "created since
 * January 2026 and no longer live", and a 2024 listing withdrawn last month is
 * outside it. Every label on this figure has to say so, or it will be read as
 * a count of recent withdrawals, which it is not.
 */
export const TAKEN_DOWN_SINCE = '2026-01-01';

const CURRENT_STATE = ALL_STATUSES.filter((s) => s !== 'unpublished');

export async function fetchPipeline() {
  // Two calls, because the two halves have different windows. They still run
  // concurrently, so the pipeline is no slower than the single call it replaces
  // — and considerably faster, since the archive no longer walks 97 pages.
  const [current, takenDown] = await Promise.all([
    fetchListings({ since: '2000-01-01', statuses: CURRENT_STATE, maxPages: 120 }),
    fetchListings({ since: TAKEN_DOWN_SINCE, statuses: ['unpublished'], maxPages: 120 }),
  ]);
  const listings = [...current, ...takenDown];

  const byStatus = {};
  for (const s of ALL_STATUSES) byStatus[s] = [];
  for (const l of listings) {
    const s = String(l.status ?? '').toLowerCase();
    if (byStatus[s]) byStatus[s].push(l);
  }

  return { listings, byStatus, takenDownSince: TAKEN_DOWN_SINCE, at: new Date().toISOString() };
}
