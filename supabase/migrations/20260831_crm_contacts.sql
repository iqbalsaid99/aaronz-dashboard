-- crm_contacts — the third mirror table.
--
-- NOT PART OF THE STAGE 1 MIGRATION, AND NOT DERIVED FROM THE SPEC. The
-- OpenAPI document never arrived and cannot be fetched: every documentation
-- path on the API answers with the WAF's block page. So this is built the same
-- way crm_leads and crm_listings were — from the live response, profiled on
-- 31 Aug 2026 against /contacts, which returns 41,242 rows and a flat model of
-- 28 fields with no nesting at all.
--
-- Apply it separately, on purpose: it is the one table in the mirror that was
-- shaped without the document you meant to hand me. If the spec says something
-- different, this is the file to correct.
--
-- CONTACTS ARE REACHABLE. The token carries contacts:read and contacts:write
-- and /contacts answers 200 — it is blocked only by isForwardable in
-- functions/_lib/scope.js, which is the browser proxy's allowlist. The
-- backfill talks to PropSpace directly and is unaffected by it; the browser
-- must stay blocked, because this table is the whole contact book with no
-- agent attribution on it to scope by.

create table if not exists public.crm_contacts (
  id                      bigint primary key,
  reference               text,

  first_name              text,
  last_name               text,

  -- Three of each. The CRM stores them as separate columns rather than an
  -- array, and they are mirrored as found: collapsing them here would make
  -- "which address did we actually write to" unanswerable later.
  email                   text,
  email_2                 text,
  email_3                 text,
  phone                   text,
  phone_2                 text,
  phone_3                 text,
  mobile                  text,
  mobile_2                text,
  mobile_3                text,

  job_title               text,
  company                 text,
  gender                  text,
  -- Text, not date: the CRM's own format here has not been verified across
  -- enough rows to cast it, and a failed cast would drop the value silently.
  date_of_birth           text,

  address                 text,
  address_city            text,
  address_state           text,
  address_country         text,
  address_zip_po_box      text,

  source_of_contact       text,
  other_source_of_contact text,
  source_channel          text,

  notes                   jsonb,

  source_created_at       timestamptz,   -- date_added
  -- date_updated is a REAL field on this model, unlike on leads where the
  -- parameter of that name is accepted and inert. It is still only a column
  -- here, not a filter — the API offers no way to query on it.
  source_last_updated     timestamptz,

  synced_at               timestamptz not null default now(),
  sync_source             text
);

create index if not exists crm_contacts_email_idx   on public.crm_contacts (email) where email is not null;
create index if not exists crm_contacts_mobile_idx  on public.crm_contacts (mobile) where mobile is not null;
create index if not exists crm_contacts_updated_idx on public.crm_contacts (source_last_updated desc);
create index if not exists crm_contacts_created_idx on public.crm_contacts (source_created_at desc);
create index if not exists crm_contacts_company_idx on public.crm_contacts (company);

-- Admins only, as specified. This is the entire contact book — 41,242 people —
-- and it carries no agent attribution, so there is nothing to scope a broker
-- to. No insert or update policy for anyone: the sync writes as service role.
alter table public.crm_contacts enable row level security;

drop policy if exists crm_contacts_read on public.crm_contacts;
create policy crm_contacts_read on public.crm_contacts
  for select to authenticated using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and coalesce(p.is_active, true)
        and p.role in ('admin', 'super_admin')
    )
  );

insert into public.sync_state (source) values ('contacts')
  on conflict (source) do nothing;
