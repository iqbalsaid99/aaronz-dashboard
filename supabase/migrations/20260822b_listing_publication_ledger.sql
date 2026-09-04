-- listing_publication — an append-only record of listings going live on portals.
--
-- WHY THIS TABLE EXISTS. "How many listings went live in August" is a question
-- about a past event. The answer must be the same read today and read in a
-- year. Deriving it from PropSpace's CURRENT state cannot do that: a listing
-- that went live in August and was taken down in October stops being published,
-- and August silently shrinks. Worse, a listing deleted from the CRM vanishes
-- from every month at once. Historical figures that move are not history.
--
-- So publication is recorded when it is observed and then never touched again.
-- No updates, no deletes. A row here means "this listing was live on this
-- portal, and we saw it" — which stays true no matter what happens to the
-- listing afterwards, including being deleted from PropSpace entirely.
--
-- THE UNIQUE CONSTRAINT IS THE COUNTING RULE. One row per listing per portal,
-- so a listing relisted under the same reference cannot increment a second
-- month. Writers insert with ON CONFLICT DO NOTHING; the database enforces
-- "count once, on first go-live" rather than the application remembering to.
--
-- Run this in the Supabase SQL editor.

create table if not exists public.listing_publication (
  id              bigint generated always as identity primary key,

  -- Identity of the listing as PropSpace knew it. Reference is the stable
  -- human key and the one the rest of the dashboard joins on; the numeric id is
  -- kept alongside because references have been known to be re-cut on relist.
  listing_ref     text        not null,
  listing_id      text,
  portal          text        not null,

  -- When it went live. See went_live_source: this is exact for rows written by
  -- a sync that watched it happen, and approximate for backfilled rows.
  went_live_at    timestamptz not null,
  went_live_source text       not null default 'observed',

  -- Everything below is frozen AS AT PUBLICATION and deliberately not a join.
  -- Listings get reassigned, repriced and recategorised; a monthly report that
  -- reads today's owner would move a past month's credit from one broker to
  -- another months later. The ledger answers "who published it", so it has to
  -- remember who that was.
  broker_id       text,
  broker_name     text,
  offering        text,
  category        text,
  category_class  text,
  community       text,
  region          text,
  price           numeric,

  -- When this row was written, as opposed to when the event happened.
  recorded_at     timestamptz not null default now(),

  -- One publication per listing per portal, forever.
  constraint listing_publication_once unique (listing_ref, portal)
);

comment on table public.listing_publication is
  'Append-only. A row is a past event; never update or delete one.';
comment on column public.listing_publication.went_live_source is
  'observed = a sync run saw it go live, accurate to the sync interval. '
  'backfill = seeded from the listing''s created_at, which is CRM creation and '
  'may precede the actual go-live by weeks.';

create index if not exists listing_publication_month_idx
  on public.listing_publication (went_live_at desc);
create index if not exists listing_publication_portal_idx
  on public.listing_publication (portal, went_live_at desc);
create index if not exists listing_publication_broker_idx
  on public.listing_publication (broker_id);

alter table public.listing_publication enable row level security;

-- Read and insert only. The absence of update and delete policies is the
-- append-only guarantee expressed where it cannot be forgotten — not a
-- convention the writing code is trusted to honour.
drop policy if exists "read publications" on public.listing_publication;
create policy "read publications"
  on public.listing_publication for select to authenticated using (true);

drop policy if exists "write publications" on public.listing_publication;
create policy "write publications"
  on public.listing_publication for insert to authenticated with check (true);

grant select, insert on public.listing_publication to authenticated;


-- Sync bookkeeping. Also the source of "the ledger is trustworthy from", which
-- is the first time a sync actually ran: before that, rows are backfilled from
-- created_at and the months they land in are approximate.
create table if not exists public.listing_publication_sync (
  id            bigint generated always as identity primary key,
  ran_at        timestamptz not null default now(),
  mode          text        not null,          -- 'backfill' | 'sync'
  listings_seen integer     not null default 0,
  rows_written  integer     not null default 0,
  note          text
);

alter table public.listing_publication_sync enable row level security;

drop policy if exists "read publication syncs" on public.listing_publication_sync;
create policy "read publication syncs"
  on public.listing_publication_sync for select to authenticated using (true);

drop policy if exists "write publication syncs" on public.listing_publication_sync;
create policy "write publication syncs"
  on public.listing_publication_sync for insert to authenticated with check (true);

grant select, insert on public.listing_publication_sync to authenticated;
