-- bayut_listing_snapshot — one row per Bayut listing per crawl run.
--
-- Supersedes bayut_trucheck_snapshot, which held only the badge. The crawl now
-- pulls each listing's full public record, so the table carries the quality
-- signals the derived score is computed from and Bayut's own internal numbers
-- alongside them, kept separate because nobody outside Bayut knows what those
-- weigh.
--
-- Rows are append-only. A run is never updated in place: the useful question is
-- not only "what is true today" but "when did this listing get its floor plan",
-- and keeping every run answers that later without a schema change.
--
-- Run this in the Supabase SQL editor. The dashboard's publishable key cannot
-- create tables, which is why this is a file rather than something the app does.
--
-- Safe to run alongside the earlier migration; it does not touch that table.

create table if not exists public.bayut_listing_snapshot (
  id               bigint generated always as identity primary key,

  run_id           text        not null,
  scraped_at       timestamptz not null default now(),

  -- True when the detail pass reached this listing. A false here means every
  -- quality column below is UNKNOWN, not zero — the difference between "no
  -- photos" and "we did not look", which the derived score must not confuse.
  detailed         boolean     not null default false,

  bayut_listing_id text,
  bayut_url        text,

  -- The join key back to PropSpace. Bayut publishes no RERA permit number
  -- anywhere in its listing payload — verified against a live record, whose
  -- extraFields carries dldPropertySK and dldBuildingNK and nothing else — so
  -- reference does the work. permit_number stays for a future official source.
  reference        text,
  permit_number    text,

  -- TruCheck.
  is_trucheck         boolean not null default false,
  truchecked_at       timestamptz,
  verification_status text,
  checked             boolean,

  -- Core.
  title            text,
  price            numeric,
  purpose          text,
  category_class   text,
  beds             integer,
  baths            integer,
  size             numeric,
  community        text,
  agent_name       text,
  agent_bayut_id   text,
  listing_state    text,

  -- Quality signals, all nullable: null means the detail pass did not run.
  photo_count      integer,
  video_count      integer,
  panorama_count   integer,
  has_floor_plan   boolean,
  amenity_count    integer,

  -- Bayut's own numbers, captured raw and never interpreted. Stored as jsonb
  -- rather than columns because the set is theirs to change.
  native_scores    jsonb,

  -- Our derived completeness score and the factor breakdown behind it, so a
  -- row can explain itself without recomputing against whatever the weights
  -- happen to be on the day someone opens an old snapshot.
  derived_score    integer,
  score_factors    jsonb,

  raw              jsonb
);

create index if not exists bayut_listing_snapshot_scraped_at_idx
  on public.bayut_listing_snapshot (scraped_at desc);
create index if not exists bayut_listing_snapshot_run_idx
  on public.bayut_listing_snapshot (run_id);
create index if not exists bayut_listing_snapshot_reference_idx
  on public.bayut_listing_snapshot (upper(reference));

alter table public.bayut_listing_snapshot enable row level security;

-- Any signed-in dashboard user may read snapshots and write a new one. This
-- matches how crm_agents is reached: the app holds only the publishable key, so
-- writes arrive as the signed-in user rather than from a service role.
-- Deliberately no update or delete policy — the table is append-only.
drop policy if exists "read listing snapshots" on public.bayut_listing_snapshot;
create policy "read listing snapshots"
  on public.bayut_listing_snapshot for select
  to authenticated using (true);

drop policy if exists "write listing snapshots" on public.bayut_listing_snapshot;
create policy "write listing snapshots"
  on public.bayut_listing_snapshot for insert
  to authenticated with check (true);

-- RLS decides WHICH rows a role may touch; the table grant decides whether it
-- may touch the table at all. Both are needed, and a policy without a grant
-- fails as "permission denied for table" rather than as an empty result — which
-- reads like a broken query rather than a missing privilege. Supabase grants
-- these by default on tables made through its UI, so a table created from raw
-- SQL is the case that surprises you.
grant select, insert on public.bayut_listing_snapshot to authenticated;


-- Per-run bookkeeping: what the company page claimed, what the crawl actually
-- got, and how the detail pass fared. Kept in its own table rather than
-- repeated on every listing row, and read by the tab to surface the delta
-- rather than silently continuing when the two disagree.
create table if not exists public.bayut_crawl_run (
  run_id            text primary key,
  scraped_at        timestamptz not null default now(),
  detail_run_id     text,
  -- What the agency page says it has, when the crawl could read it.
  expected_count    integer,
  enumerated_count  integer not null default 0,
  detailed_count    integer not null default 0,
  failed_count      integer not null default 0,
  usage_usd         numeric,
  note              text
);

alter table public.bayut_crawl_run enable row level security;

drop policy if exists "read crawl runs" on public.bayut_crawl_run;
create policy "read crawl runs"
  on public.bayut_crawl_run for select to authenticated using (true);

drop policy if exists "write crawl runs" on public.bayut_crawl_run;
create policy "write crawl runs"
  on public.bayut_crawl_run for insert to authenticated with check (true);

grant select, insert on public.bayut_crawl_run to authenticated;
