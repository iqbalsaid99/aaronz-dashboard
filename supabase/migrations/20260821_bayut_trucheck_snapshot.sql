-- bayut_trucheck_snapshot — one row per Bayut listing per crawl run.
--
-- WHY A SNAPSHOT TABLE AND NOT A LIVE FETCH. There is no official API for
-- TruCheck status; the only source is the public badge, reached through Apify.
-- A crawl of ~242 listings takes minutes and costs money per run, so the tab
-- must never block on one. It renders the most recent run and offers a refresh.
--
-- Rows are append-only. A run is never updated in place, because the useful
-- question is not only "what is the badge today" but "when did it change" —
-- keeping every run makes that answerable later without a schema change.
--
-- Run this in the Supabase SQL editor. The dashboard's publishable key cannot
-- create tables, which is why this is a file rather than something the app does.

create table if not exists public.bayut_trucheck_snapshot (
  id               bigint generated always as identity primary key,

  -- Which crawl produced this row. Every row from one Apify run shares it, so
  -- "the latest snapshot" is a single lookup rather than a per-listing max.
  run_id           text        not null,
  scraped_at       timestamptz not null default now(),

  -- Bayut's own identity for the listing.
  bayut_listing_id text,
  bayut_url        text,

  -- The join key back to PropSpace. Bayut does NOT expose the RERA permit
  -- number anywhere in its payload — verified against a live listing record —
  -- so reference is the only usable join, and it matches PropSpace `ref`
  -- exactly. permit_number is kept nullable in case a future source carries it.
  reference        text,
  permit_number    text,

  -- The badge. `is_trucheck` is Bayut's isVerified. `truchecked_at` comes from
  -- the listing detail record's verification.trucheckedAt and is only present
  -- when the detail stage of the crawl ran, so it is nullable independently of
  -- is_trucheck being true.
  is_trucheck      boolean     not null default false,
  truchecked_at    timestamptz,
  verification_status text,

  -- Context, so the tab can render a row Bayut knows about but PropSpace does
  -- not without a second lookup.
  title            text,
  price            numeric,
  community        text,
  purpose          text,
  category         text,
  agent_name       text,
  listing_state    text,

  -- The untouched record. Cheap insurance: when a field turns out to matter
  -- later it is already captured, rather than needing another paid crawl.
  raw              jsonb
);

-- "Give me the newest run" and "give me this run" are the only two reads the
-- tab makes, and the reference index serves the PropSpace join.
create index if not exists bayut_trucheck_snapshot_scraped_at_idx
  on public.bayut_trucheck_snapshot (scraped_at desc);
create index if not exists bayut_trucheck_snapshot_run_idx
  on public.bayut_trucheck_snapshot (run_id);
create index if not exists bayut_trucheck_snapshot_reference_idx
  on public.bayut_trucheck_snapshot (upper(reference));

alter table public.bayut_trucheck_snapshot enable row level security;

-- Any signed-in user of the dashboard may read snapshots and write a new one.
-- This matches how crm_agents is reached: the app holds only the publishable
-- key, so writes arrive as the signed-in user rather than from a service role.
-- Deliberately no update or delete policy — the table is append-only.
drop policy if exists "read snapshots" on public.bayut_trucheck_snapshot;
create policy "read snapshots"
  on public.bayut_trucheck_snapshot for select
  to authenticated using (true);

drop policy if exists "write snapshots" on public.bayut_trucheck_snapshot;
create policy "write snapshots"
  on public.bayut_trucheck_snapshot for insert
  to authenticated with check (true);
