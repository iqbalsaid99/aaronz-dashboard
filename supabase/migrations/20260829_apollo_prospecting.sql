-- Apollo prospecting — the contact store and the two audit logs.
--
-- THE POINT OF apollo_leads IS THAT A CONTACT IS PAID FOR ONCE. Apollo bills
-- per revealed email and per revealed mobile. Two brokers working the same
-- list, or one broker clicking twice, would buy the same person's number
-- twice over. So every reveal is written here first, and every reveal is read
-- from here first: a second request for a number we already hold returns it
-- without touching Apollo and without spending a credit.
--
-- That makes this table the ledger of what has been bought, which is why
-- nothing here is deleted on a re-reveal — the row is updated in place and
-- keeps its original revealed_at.
--
-- Run this in the Supabase SQL editor.

create table if not exists public.apollo_leads (
  -- Apollo's own person id is the key. It is stable across searches, which is
  -- what makes "have we already paid for this person" answerable at all;
  -- name and company are not, because people change both.
  apollo_person_id   text primary key,

  -- The free fields, as the search returned them. Kept so the Activity tab and
  -- a re-opened search can show who a reveal was for without re-querying.
  full_name          text,
  title              text,
  company            text,
  headcount          integer,
  location           text,
  linkedin_url       text,

  -- The paid fields. Null means never bought.
  email              text,
  email_revealed_at  timestamptz,
  email_revealed_by  uuid references auth.users (id),

  mobile             text,
  mobile_revealed_at timestamptz,
  mobile_revealed_by uuid references auth.users (id),

  -- A mobile does not arrive with the response. Apollo takes the request,
  -- charges for it, and posts the number back later, so a row sits at
  -- 'pending' in between and the UI has something truthful to show.
  --   none | pending | delivered | failed
  mobile_status      text not null default 'none',

  -- Ties an inbound webhook to the row that asked for it. Single use: cleared
  -- when the number lands, so a replayed callback cannot write to a row that
  -- is no longer expecting one.
  webhook_token      text unique,
  mobile_requested_at timestamptz,

  raw                jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists apollo_leads_email_idx  on public.apollo_leads (email) where email is not null;
create index if not exists apollo_leads_status_idx on public.apollo_leads (mobile_status) where mobile_status = 'pending';

-- Every search, so "what is this team actually looking for" is answerable and
-- so a spike in credits has a shape behind it. Filters are stored whole: the
-- useful question later is usually "what exactly did they run", and a set of
-- columns guessed today will not cover the filter added next month.
create table if not exists public.apollo_searches (
  id           bigint generated always as identity primary key,
  user_id      uuid references auth.users (id),
  user_email   text,
  broker_name  text,
  preset       text,                -- which preset button, or null for a hand-built search
  filters      jsonb not null,
  result_count integer,
  page         integer,
  created_at   timestamptz not null default now()
);

create index if not exists apollo_searches_user_idx on public.apollo_searches (user_id, created_at desc);

-- Every reveal, including the ones that cost nothing.
--
-- CACHED HITS ARE LOGGED TOO. They are the evidence the cache is working: a
-- log of only the paid reveals cannot tell "we spent little" from "nobody used
-- it". `credits` is what Apollo said it charged, and stays 0 on a cache hit.
create table if not exists public.apollo_reveals (
  id                bigint generated always as identity primary key,
  user_id           uuid references auth.users (id),
  user_email        text,
  broker_name       text,
  apollo_person_id  text,
  person_name       text,
  reveal_type       text not null check (reveal_type in ('email', 'mobile')),
  credits           numeric not null default 0,
  cached            boolean not null default false,
  status            text not null default 'ok',   -- ok | pending | failed
  detail            text,
  created_at        timestamptz not null default now()
);

create index if not exists apollo_reveals_user_idx   on public.apollo_reveals (user_id, created_at desc);
create index if not exists apollo_reveals_person_idx on public.apollo_reveals (apollo_person_id);

-- ---------------------------------------------------------------- RLS
--
-- This is a shared prospecting desk, not private books: everyone signed in
-- reads everything, which is the whole point of not paying twice — a broker
-- must be able to see that a colleague already bought this number. Writes are
-- stamped with the writer, and nobody may rewrite somebody else's log row.
--
-- The logs are append-only by policy: no update, no delete grants at all. An
-- audit trail somebody can edit is not an audit trail.

alter table public.apollo_leads    enable row level security;
alter table public.apollo_searches enable row level security;
alter table public.apollo_reveals  enable row level security;

drop policy if exists apollo_leads_read   on public.apollo_leads;
drop policy if exists apollo_leads_write  on public.apollo_leads;
drop policy if exists apollo_leads_update on public.apollo_leads;
create policy apollo_leads_read   on public.apollo_leads for select to authenticated using (true);
create policy apollo_leads_write  on public.apollo_leads for insert to authenticated with check (true);
create policy apollo_leads_update on public.apollo_leads for update to authenticated using (true) with check (true);

drop policy if exists apollo_searches_read  on public.apollo_searches;
drop policy if exists apollo_searches_write on public.apollo_searches;
create policy apollo_searches_read  on public.apollo_searches for select to authenticated using (true);
create policy apollo_searches_write on public.apollo_searches for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists apollo_reveals_read  on public.apollo_reveals;
drop policy if exists apollo_reveals_write on public.apollo_reveals;
create policy apollo_reveals_read  on public.apollo_reveals for select to authenticated using (true);
create policy apollo_reveals_write on public.apollo_reveals for insert to authenticated
  with check (user_id = auth.uid());

-- The webhook writes as the service role, which bypasses RLS by design: the
-- caller is Apollo, has no session, and must still be able to complete a
-- mobile that has already been paid for.
