-- Distinguish the two kinds of crawl in the run history.
--
-- The tab now has two refresh modes with very different costs and very
-- different payloads:
--
--   enumerate  every listing and its TruCheck badge. Cheap enough to run daily.
--              Writes rows with detailed = false and no quality signals.
--   full       enumerate plus a read of every listing's own page, which is the
--              only source of photo counts, floor plans, video/360 and Bayut's
--              internal numbers. Costs per listing.
--
-- Without this column the two are indistinguishable in the history, and "why is
-- the quality data three weeks old when I refreshed yesterday" has no answer
-- visible anywhere.
--
-- Additive and idempotent. Safe to run after 20260821b.

alter table public.bayut_crawl_run
  add column if not exists run_type text not null default 'full';

comment on column public.bayut_crawl_run.run_type is
  'enumerate = badges only (detailed=false rows); full = badges + per-listing detail.';

-- Existing rows predate the split and were all full crawls, which the default
-- already gives them. Stated rather than assumed.
update public.bayut_crawl_run set run_type = 'full' where run_type is null;

-- Finding the newest run of a given kind is the query the tab makes on every
-- load, twice: once for any run, once for the newest full one.
create index if not exists bayut_crawl_run_type_scraped_idx
  on public.bayut_crawl_run (run_type, scraped_at desc);

-- The other half of that question is asked against the snapshot itself —
-- "which is the newest run that carries quality data" — so the partial index
-- covers only the rows that can answer it.
create index if not exists bayut_listing_snapshot_detailed_idx
  on public.bayut_listing_snapshot (scraped_at desc) where detailed;

-- RLS decides which rows a role may touch; the grant decides whether it may
-- touch the table at all. Repeated here because a table altered from raw SQL
-- does not inherit the grants Supabase adds to tables made through its UI.
grant select, insert on public.bayut_crawl_run to authenticated;
grant select, insert on public.bayut_listing_snapshot to authenticated;
