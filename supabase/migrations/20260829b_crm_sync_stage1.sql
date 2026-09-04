-- CRM mirror, stage 1: the tables the sync writes into.
--
-- WHY A MIRROR AT ALL. Every CRM read currently live-proxies PropSpace, and
-- PropSpace cannot be asked a narrow question: it honours `assigned_to` and
-- nothing else. There is no date filter (date_updated is accepted and inert —
-- date_updated=2020-01-01 returns the same 43,096 rows as no filter) and no
-- sort control (sort/order/sort_by are 400s). So "leads updated since 09:00"
-- costs 431 pages. Locally it is an indexed query.
--
-- SHAPES ARE FROM THE LIVE API, not from the spec. Verified 29 Aug 2026
-- against 500 lead records and the full 311-listing published book. Where a
-- field's type is stated below it was observed, not assumed — hot_lead really
-- is the STRING "Yes"/"No", and beds really is a string carrying "0.5" for a
-- studio.
--
-- NOTHING HERE IS WRITTEN BY A BROWSER. Every policy below grants select only.
-- The sync writes as the service role, which bypasses RLS by design, so there
-- is no path by which a signed-in user can alter the mirror.
--
-- Run this in the Supabase SQL editor.

-- ---------------------------------------------------------------- leads

create table if not exists public.crm_leads (
  -- PropSpace's own id. Every tier upserts on this, so a lead written by the
  -- backfill and re-read by a webhook is one row, not two.
  id                      bigint primary key,

  reference               text,
  lead_type               text,                 -- Buyer | Tenant | Agent
  source                  text,                 -- Bayut.com | Propertyfinder.ae | Facebook
  other_source_of_lead    text,
  source_channel          text,                 -- whatsapp | call | email | '' | '0'

  -- Kept as text on purpose. The API returns the strings "Yes"/"No", and "No"
  -- is truthy in JavaScript — coercing here would hide that from the next
  -- person who reads the column and expects a boolean to behave like one.
  priority                text,
  hot_lead                text,
  finance                 text,
  in_lead_pool            text,

  -- status arrives nested as { status, sub_status }. Flattened because every
  -- screen filters on sub_status and none of them wants a jsonb operator.
  status                  text,                 -- Open | Closed | Not Specified
  sub_status              text,                 -- the 25-value taxonomy

  -- agents[0]. The array is kept whole below; this is the one the whole
  -- dashboard attributes on.
  assigned_to_id          bigint,
  assigned_to_name        text,

  contact_id              bigint,

  -- requirements[0], flattened. A lead may carry several, so the array is kept
  -- whole as well — but every screen reads the first, and matching on price,
  -- beds and area needs real columns to index.
  req_listing_reference   text,
  req_listing_id          bigint,
  req_category            text,
  req_unit_type           text,
  req_emirate             text,
  req_location            text,
  req_sub_location        text,
  req_min_beds            text,
  req_max_beds            text,
  req_min_price           numeric,
  req_max_price           numeric,
  req_min_area            numeric,
  req_max_area            numeric,

  -- The nested structures, whole. notes is not optional decoration: the
  -- viewing state in stage 5 is derived from it, and first-touch latency
  -- cannot be computed without it.
  contact                 jsonb,
  agents                  jsonb,
  requirements            jsonb,
  notes                   jsonb,

  -- ------------------------------------------------ source timestamps
  -- Named source_* so they can never be confused with our own bookkeeping.
  date_of_enquiry         timestamptz,
  source_created_at       timestamptz,          -- PropSpace created_at
  -- The drift column. Four tiers write this table; comparing this against
  -- synced_at shows which tier last saw a record and how stale a tier has got.
  source_last_updated     timestamptz,

  -- ------------------------------------------------ our bookkeeping
  synced_at               timestamptz not null default now(),
  -- backfill | cron_new | cron_hot | sweep | webhook
  sync_source             text
);

-- Filtering indexes, as asked. assigned_to and sub_status carry almost every
-- query the dashboard makes; the date columns carry the sync itself.
create index if not exists crm_leads_assigned_idx    on public.crm_leads (assigned_to_id);
create index if not exists crm_leads_status_idx      on public.crm_leads (status);
create index if not exists crm_leads_sub_status_idx  on public.crm_leads (sub_status);
create index if not exists crm_leads_created_idx     on public.crm_leads (source_created_at desc);
create index if not exists crm_leads_updated_idx     on public.crm_leads (source_last_updated desc);
create index if not exists crm_leads_enquiry_idx     on public.crm_leads (date_of_enquiry desc);
-- The shape the Insights and Brokers tabs actually ask for: one broker's
-- leads, newest first.
create index if not exists crm_leads_agent_created_idx
  on public.crm_leads (assigned_to_id, source_created_at desc);
create index if not exists crm_leads_synced_idx      on public.crm_leads (synced_at desc);

-- ---------------------------------------------------------------- listings

create table if not exists public.crm_listings (
  id                      bigint primary key,
  ref                     text,
  name                    text,

  type                    text,                 -- sale | rent
  status                  text,                 -- published | draft | ...
  property_status         text,
  category                text,                 -- Apartment | Townhouse | ...
  completion_status       text,
  furnished               text,

  price                   numeric,
  size                    numeric,
  -- Text, not integer: the live book carries "0.5" for a studio on 36 of 311
  -- listings and "0" for another 106. Casting here would silently merge two
  -- different import conventions into the same number.
  beds                    text,
  baths                   integer,

  unit_number             text,
  permit_number           text,
  description             text,
  featured                boolean,
  next_available_date     timestamptz,
  client_id               bigint,

  agent_id                bigint,
  agent_name              text,
  marketing_agent_id      bigint,
  marketing_agent_name    text,

  area_location_id        bigint,
  area_location_name      text,
  sub_area_location_id    bigint,
  sub_area_location_name  text,
  region                  jsonb,

  amenities               jsonb,
  features                jsonb,
  portals                 jsonb,
  images                  jsonb,

  source_created_at       timestamptz,
  source_last_updated     timestamptz,          -- PropSpace updated_at
  synced_at               timestamptz not null default now(),
  sync_source             text
);

create index if not exists crm_listings_agent_idx   on public.crm_listings (agent_id);
create index if not exists crm_listings_status_idx  on public.crm_listings (status);
create index if not exists crm_listings_type_idx    on public.crm_listings (type);
create index if not exists crm_listings_ref_idx     on public.crm_listings (ref);
create index if not exists crm_listings_area_idx    on public.crm_listings (area_location_name);
create index if not exists crm_listings_created_idx on public.crm_listings (source_created_at desc);
create index if not exists crm_listings_updated_idx on public.crm_listings (source_last_updated desc);

-- ------------------------------------------------------- listing owners
--
-- SEPARATE TABLE BECAUSE OF WHO MAY READ IT.
--
-- A listing carries an `owner` object with the landlord's contact details. The
-- live proxy already treats that as need-to-know: redactOwnerContacts strips
-- it for anyone who is not admin or super_admin (see functions/_lib/scope.js).
--
-- crm_listings is readable by every authenticated user, as specified. Postgres
-- RLS is row-level, not column-level, so an `owner` column on that table would
-- hand every broker the landlord's phone number and quietly undo a control
-- that exists today. The owner therefore lives in its own table with its own
-- policy, and crm_listings keeps only the non-identifying client_id.
create table if not exists public.crm_listing_owners (
  listing_id  bigint primary key references public.crm_listings (id) on delete cascade,
  owner       jsonb,
  synced_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------- sync state

create table if not exists public.sync_state (
  -- 'leads' | 'listings' | 'contacts'
  source                text primary key,

  last_success_at       timestamptz,
  last_cursor           text,

  -- Three watermarks, because one cannot describe four tiers.
  --
  --   last_created_cursor  the newest source_created_at the */10 tier has
  --                        seen. It pages until it reads older than this, so
  --                        it costs about one page a run.
  --   last_hot_sweep_at    when the */30 tier last re-pulled pages 1-30
  --                        unconditionally. That tier has no cursor by design:
  --                        it exists precisely because an updated lead does
  --                        not move in a created_at ordering.
  --   last_full_sweep_at   when the whole 431-page book was last reconciled by
  --                        the nightly job.
  last_created_cursor   timestamptz,
  last_hot_sweep_at     timestamptz,
  last_full_sweep_at    timestamptz,

  rows_upserted         integer not null default 0,

  -- Fails closed: a tier that errors writes here and leaves every watermark
  -- untouched, so the next run re-covers the same ground rather than stepping
  -- over the records it never read.
  last_error            text,
  last_error_at         timestamptz,

  updated_at            timestamptz not null default now()
);

-- ---------------------------------------------------------------- RLS

alter table public.crm_leads           enable row level security;
alter table public.crm_listings        enable row level security;
alter table public.crm_listing_owners  enable row level security;
alter table public.sync_state          enable row level security;

-- No insert, update or delete policy is granted anywhere below, to anyone.
-- With RLS enabled and no policy for a command, that command is denied. The
-- sync writes as the service role, which bypasses RLS entirely.

-- Listings are the shared book: everyone signed in sees all of it.
drop policy if exists crm_listings_read on public.crm_listings;
create policy crm_listings_read on public.crm_listings
  for select to authenticated using (true);

-- Leads: admins see everything, a broker sees their own.
--
-- auth.uid() IS A UUID AND assigned_to_id IS A PROPSPACE INTEGER, so the two
-- cannot be compared directly — written literally, the policy would match
-- nothing and every broker would see an empty dashboard. The link between them
-- is profiles.propspace_agent_id, which is what scope.js already joins on, so
-- that is the join used here.
drop policy if exists crm_leads_read on public.crm_leads;
create policy crm_leads_read on public.crm_leads
  for select to authenticated using (
    exists (
      select 1
      from public.profiles p
      where p.id = auth.uid()
        and coalesce(p.is_active, true)
        and (
          p.role in ('admin', 'super_admin')
          -- Cast both sides. profiles.propspace_agent_id may be stored as
          -- text or as a number -- scope.js stringifies it before use, so
          -- the underlying type is not something to bet a policy on. A
          -- mismatch fails the comparison silently and shows the broker an
          -- empty dashboard, which reads as no data rather than as a bug.
          -- Unqualified table name: a three-part reference does not resolve
          -- inside the policy subquery.
          or p.propspace_agent_id::text = crm_leads.assigned_to_id::text
        )
    )
  );

-- Owner contact details: admins only, matching canSeeOwnerContacts.
drop policy if exists crm_listing_owners_read on public.crm_listing_owners;
create policy crm_listing_owners_read on public.crm_listing_owners
  for select to authenticated using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and coalesce(p.is_active, true)
        and p.role in ('admin', 'super_admin')
    )
  );

-- Sync health is readable so a screen can say when the mirror last succeeded.
-- A stale mirror that looks live is the failure mode worth surfacing.
drop policy if exists sync_state_read on public.sync_state;
create policy sync_state_read on public.sync_state
  for select to authenticated using (true);

insert into public.sync_state (source) values ('leads'), ('listings')
  on conflict (source) do nothing;
