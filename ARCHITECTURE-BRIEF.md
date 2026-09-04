# Aaronz & Co. Dashboard — architecture brief

Context for advising on a migration to a hosted, multi-tenant deployment
(Cloudflare or similar) supporting ~100 users: brokers, line managers, admins.

---

## 1. What it is today

A **single-page React app with no backend and no database.** It runs only via
`npm run dev` on one person's laptop.

| | |
|---|---|
| Framework | React 18.3 (no router — tab state is a single `useState`) |
| Build | Vite 5, Tailwind 3, `lucide-react` icons |
| Total deps | 3 runtime packages: `react`, `react-dom`, `lucide-react` |
| Source size | ~7,600 lines across 22 files in `src/` |
| Auth | **None.** No login, no accounts, no roles, no sessions |
| Database | **None.** Persistent state is `localStorage` per browser |
| Server | **None in production.** See §2 — this is the critical fact |
| Hosting | Localhost only, port 5173 |

---

## 2. The API proxies — and why the production build is currently broken

`vite.config.js` (305 lines) defines **three Vite dev-server middlewares**.
These do the OAuth token exchange in Node so the client secrets never enter the
browser bundle, and so the browser never hits a cross-origin host (no CORS).

| Route | Upstream | Auth flow |
|---|---|---|
| `/ps/*` | `api.propspace.com` (the CRM) | OAuth2 client_credentials → Bearer. Token cached in memory, ~1h TTL, refreshed 60s early |
| `/pf/*` | `atlas.propertyfinder.com` | HTTP Basic `key:secret` → JWT at `auth.propertyfinder.com`, then Bearer. ~30 min TTL (1784s) |
| `/api/lookup` | `api.apify.com` (owner-search scraper) | Token in query string, `run-sync-get-dataset-items`, 180s timeout |

Both token flows use a **single-flight promise cache** — concurrent callers
await one exchange instead of each starting their own. This was added
deliberately: the front end fetches 4 pages at a time, and four simultaneous
cold-start token requests were tripping the upstream WAF.

**`configureServer` only runs under `vite dev`.** `npm run build` emits a
static `dist/` with no proxies at all, so **the current production build cannot
fetch any data.** Any migration must reimplement these three proxies as real
server endpoints — the README already anticipates a Cloudflare Worker, and the
front end wouldn't change beyond a base URL.

**Secrets currently in `.env`** (deliberately *not* `VITE_`-prefixed so they
stay in Node): `PROPSPACE_CLIENT_ID/SECRET`, `PROPERTYFINDER_API_KEY/SECRET`,
`APIFY_TOKEN`, `APIFY_ACTOR_ID`, `APIFY_PROXY_GROUP`, `APIFY_CONTACT_DETAILS`.

---

## 3. Screens built

Left rail, in order. **Live** = working against real data. **Stub** = nav item
exists, no screen behind it.

| Screen | State | Notes |
|---|---|---|
| **Insights** (`App.jsx`, 683 ln) | Live | Lead performance. KPI cards, status breakdown, per-agent sortable table, drill-down side panel per agent |
| **Brokers** (`Brokers.jsx`, 893 ln + `brokers.js`, 446 ln) | Live | One profile per broker: leads, listing book, derived viewings, manual billings |
| **Lead pool** | Stub | — |
| **Contacts** | Stub | — |
| **Owner search** (`OwnerSearch.jsx`, 291 ln) | Live, unverified | Paste a Bayut / PropertyFinder / Dubizzle URL → Apify scrape → contact details. Field mapping is guesswork; no Apify token has ever run against it |
| **Property Finder** (`PropertyFinder.jsx`, 1,608 ln + `propertyfinder.js`, 502 ln) | Live | Largest single screen. 6 sub-views: Overview, Listings, Leads, Agents, Quality, Credits. Includes an action list (unverified live listings, quality < 60, expiring featured/premium, expiring verifications, expired BRN, unanswered leads) |
| **Listings** (`Listings.jsx`, 663 ln + `listings.js`, 333 ln) | Live | New-listings-per-month, current book, agent attribution |
| **Equipment** (`Equipment.jsx`, 282 ln) | Live, **local only** | 27-asset register, book-out / book-in. See §5 |
| **Deals** | Stub | Blocked — no API endpoint (§4) |
| **Off-plan** (`OffPlan.jsx`, 220 ln) | Live | Off-plan stock via `completion_status` filter on `/listings` |
| **Campaigns** | Stub | — |
| **Database** (`Database.jsx`, 219 ln) | Live | Tilal Al Ghaf 2026 owner datasheet: 4,204 rows, 3,215 units, 3,775 owners, with phone/WhatsApp/copy |
| **Settings** | Stub | — |

---

## 4. Hard API constraints already discovered (do not re-litigate these)

All verified by live probing against the account, and documented in code
comments. They shape any caching or backend design.

**PropSpace CRM**
- **There is no working server-side date filter on `/leads`.**
  `date_created_from/to` → 400. `date_of_enquiry` is accepted and *silently
  ignored*, returning all ~41,000 leads. The only workaround: results are
  strictly newest-first by `created_at`, `per_page` caps at 100, so the client
  pages from the top and stops when it crosses the cutoff. **~7 pages for a
  30-day window, ~1.5s per request, 4 requests in flight at a time.**
- Pages are numbered, not cursored — a lead arriving mid-pull shifts every row,
  so results are deduped by `id`.
- `/listings` defaults to `status=published` (352 records). Full history needs
  explicit status queries: `unpublished` 9,613, `draft` 935,
  `pending_approval` 545.
- **403 on everything transactional**: `/viewings`, `/appointments`,
  `/activities`, `/calendar`, `/events`, `/tasks`, `/deals`, `/transactions`,
  `/commissions`, `/invoices`, `/payments`, `/offers`, `/contracts`, `/sales`,
  `/lettings`. The WAF returns the same 403 for nonexistent paths, so it means
  "not on this key" rather than "blocked".
- Consequence: **viewings are reverse-engineered by regex-parsing free-text
  note bodies** into five confidence tiers (confirmed / done / booked / intent /
  mentioned). **Billings are typed in by hand.**
- Identity is messy: leads carry first names only ("Dennis"), listings carry
  full names ("Dennis Manalo"). Joined on numeric agent id; brokers with no id
  fall back to a lowercased-name key.
- Agent photos and job titles exist **only** on listing agent records
  (`photo_url`, 130×130 — `photo_url_original` is 403), joined to leads by id.
- The CRM escapes apostrophes as `#sqoute#` in note text.

**Property Finder Enterprise API**
- `/v1/leads` will not return anything older than **90 days** (422 beyond) —
  the range picker is capped to match.
- `perPage` caps differ per resource: 50 on leads and verifications, 100
  elsewhere. Exceeding it is a 400, not a clamp.
- **Unknown query parameters are silently ignored** — a nonexistent filter
  looks like a filter that matched everything.
- `/v1/locations` only honours `search`; there is no id → name lookup. Names
  are learned opportunistically from search results and cached.
- The account's own set is small (288 listings, 142 live), so listings, users
  and stats are fetched whole and filtered in memory.

**Timezone**
- Everything is computed in **Asia/Dubai** calendar days (`time.js`,
  `dubaiRange`), not UTC — an enquiry at 01:00 local carries the previous UTC
  date and would land in the wrong day otherwise.

---

## 5. State that must move to a real database

This is the core of the multi-user problem. Everything below is currently
**per-browser `localStorage`**, invisible to anyone else.

| Key | What | Why it breaks at scale |
|---|---|---|
| `aaronz.equipment.bookings.v1` | Camera/laptop book-outs | A camera booked out on one laptop still reads "In Office" on everyone else's. Already flagged in code as "a personal record, not a shared register — needs a backend" |
| `aaronz.equipment.user.v1` | Who you say you are | There is no login, so the user **picks their own name** from the CRM agent roster. Nothing stops anyone selecting someone else's |
| `aaronz.billings.local.v1` | Hand-keyed broker billing figures | Per-browser, so two managers see different revenue numbers |
| `aaronz.pf.locations` | PF location id → name cache | Harmless; could stay client-side |

**Bundled / static files that are really data:**
- `src/assets-register.json` — 27 assets, transcribed from `Asset_Register.xlsx`
- `src/billings.json` — empty scaffold (`{ currency: "AED", brokers: [] }`),
  intended to be filled from a spreadsheet
- `public/data/tilal-al-ghaf-2026.json` — **782 KB**, served from `public/`
  rather than bundled precisely so it isn't downloaded by everyone who opens
  the dashboard

---

## 6. The metric definitions (business logic worth preserving)

The dashboard exists to answer one question: *who is actually working leads, not
just who says they are.*

- **Status is self-reported** — anyone can flip a lead to "Contacted" without
  picking up the phone. So status alone is not trusted.
- **First touch** is derived from the `notes[]` array, which carries `date` and
  `user_name` — the only field that proves a human did something. Deliberately
  **not** `last_updated`, which bumps on any field edit or automation.
- Leads are bucketed into three mutually exclusive states:
  - **Cold** — status never moved *and* no note. The only bucket that counts
    against anyone.
  - **Status-only** — worked but nothing written down. A record-keeping gap.
  - **Noted** — a real logged touch.
- `NOT_CONTACTED` is derived, not hard-coded: any sub-status *other than* the
  five system defaults ("Not yet contacted", the three "…to Agent" routing
  states the CRM sets itself, and "Not Specified") counts as worked. This means
  a new sub-status added in the CRM is picked up automatically.
- **"Worked %" is a compliance measure** — brokers are ranked on the rate with
  no volume threshold. Ties break on lead count so a 100% rate off two leads
  doesn't outrank 90% off a hundred.

---

## 7. What the migration has to solve

Stated plainly, for whoever advises on the target architecture:

1. **Reimplement the three dev-server proxies as real server endpoints.** The
   front end is already written against `/ps`, `/pf`, `/api/lookup` — only the
   base URL changes.
2. **Add authentication and identity.** There is currently none. Users
   self-select their name from a dropdown.
3. **Add roles.** Broker (own numbers only), line manager (their team),
   admin (everything). No data scoping exists today — every screen shows the
   whole company.
4. **Add a shared database** for equipment bookings, billings, and any future
   editable state.
5. **Solve the fan-out problem.** Today one browser pages the entire CRM lead
   history itself on every load — ~7 sequential-ish rounds of 4 concurrent
   requests at ~1.5s each, for a 30-day window. With 100 users doing that
   independently against **one shared OAuth client credential**, the CRM API and
   its WAF become the bottleneck, not the app. This almost certainly needs a
   scheduled server-side sync into own storage, with the UI reading from that
   rather than proxying live.
6. **Decide what happens to the 782 KB owner datasheet** and other static
   extracts once there is a real database behind them.
7. **Fill in the stub screens**: Lead pool, Contacts, Campaigns, Settings.
   Deals stays blocked until a billing data source exists.
