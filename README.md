# Lead performance dashboard

Shows who is actually working the leads, not just who says they are.

## Run it

```bash
npm install
cp .env.example .env      # add your PropSpace client id + secret
npm run dev               # http://localhost:5173
```

It boots in **Demo** mode with sample data. Flip the toggle top-right to
**Live** once your credentials are in `.env`.

## How the credentials are handled

`vite.config.js` contains a small dev middleware. The browser calls
`/ps/leads`, Node does the OAuth2 client-credentials exchange, caches the
token, and forwards the request with the Bearer header attached.

Two consequences worth knowing:

- No CORS, because the browser only ever talks to localhost.
- The client secret stays in Node and never enters the bundle.

For production, move that same logic into a Cloudflare Worker. The front end
doesn't change, only the base URL.

## The Brokers tab

One profile per broker: billings, viewings, current listings and lead statuses.
Two of those four come straight off the API. The other two do not, and the tab
is built around that rather than hiding it.

**Listings and lead statuses are live.** The current book comes from
`/listings?status=published` attributed on `agent`, and the status breakdown is
the same sub-status taxonomy the Insights tab uses. Leads carry first names only
("Dennis") while listings carry the full name ("Dennis Manalo"); both carry the
same numeric agent id, so the roster joins on id and displays the longer name.
The roster is the union of both sources, so a broker with listings but no leads
this month still appears.

**Viewings have no endpoint.** `/viewings`, `/appointments`, `/activities`,
`/calendar`, `/events` and `/tasks` are all 403 — the WAF's generic answer for
any path not on this key, the same one `/docs` and `/options/*` give while
`/leads` and `/listings` return 200 on the same token. So viewings are read out
of the notes, in four tiers by strength of evidence:

- **Logged in the CRM** — the viewing module writes a parseable system note
  carrying client, lead ref, scheduled time and feedback. Exact, and almost
  unused: 20 across 3,000 leads and four months, 14 of them one broker.
- **Happened** / **Booked** — past tense, or a named commitment, in prose.
- **Discussed only** and **Unclear** — shown but excluded from the headline.

The first three make the number on the roster. This matters because the naive
match on the word "viewing" is badly wrong: it scores "refuse to view",
"waiting for viewing request" and "Viewing to schedule" as viewings. Bare
"view" is deliberately not matched at all — half the notes in a Dubai book say
"sea view".

Two limits worth knowing. The sub-status "Viewing arranged" is a *snapshot*, so
a lead that was viewed and has since moved to Offer Made no longer says so —
that is why it is reported alongside the derived figure, not as it. And viewings
are counted against leads that *arrived* in the selected range, because there is
no server-side date filter; a viewing logged this week against an older lead is
not in the figure.

**Billings have no endpoint either.** `/deals`, `/transactions`, `/commissions`,
`/invoices`, `/payments`, `/offers`, `/contracts`, `/sales` and `/lettings` are
all 403. So they are maintained by hand in `src/billings.json`, the same
arrangement as `assets-register.json` behind the Equipment tab:

```json
{ "currency": "AED", "asOf": "2026-07-31", "brokers": [
  { "name": "Dennis Manalo", "agentId": 1505580,
    "target": 500000, "billed": 412000, "actual": 388000, "deals": 6 }
] }
```

`billed` is billings to date (invoiced), `actual` is what was collected.
`agentId` is optional but makes the join exact; without it the name is matched
exactly, then by a unique first name. Anything matching nothing or two brokers
is reported at the top of the tab rather than silently zeroing someone.

Until the sheet arrives the numbers can be keyed in per broker from the profile
panel. That writes to localStorage, so — exactly like the Equipment
bookings — it is per-browser and per-device, and it says so on screen.

## The Property Finder tab

A second API, on the same pattern. `PROPERTYFINDER_API_KEY` and
`PROPERTYFINDER_API_SECRET` come from PF Expert → Developer Resources → API
Credentials; the secret is shown once, at creation, and cannot be read back.
The browser calls `/pf/v1/...`, Node exchanges the pair for a JWT at
`auth.propertyfinder.com` (HTTP Basic, ~30-minute tokens) and forwards to
`atlas.propertyfinder.com`.

It reports on our own PF account — listings, leads, SuperAgent scoring, quality
and credits — not the wider market. Three things the API will not do, which the
tab is built around rather than hiding:

- **Leads stop at three months.** Older ranges are a 422, so 90 days is the
  ceiling on the range picker.
- **Location ids cannot be resolved.** Listings carry `location.id` and nothing
  else, and every documented `filter[...]` on `/v1/locations` 404s upstream —
  only `search` works. Area names are learned from searches and cached, so the
  lookup box at the foot of the tab fills them in as you use it.
- **Agent scoring covers SuperAgent enrolment only** — ten profiles, not all
  134 logins. Anyone outside it shows listing and lead counts but no response
  rate or quality score.

## The metric that matters

Every lead sits in exactly one of three buckets, defined in `propspace.js`:

| | Meaning | Counts as worked? |
|---|---|---|
| **Cold** | Status still a default *and* no note | **No** |
| **Worked, no note** | Status moved off a default, nothing written | **Yes** |
| **Worked, noted** | A human logged a note | **Yes** |

**Moving a status is work.** A broker who rings a client, gets "not
interested" and sets the lead to *Unsuccessful* has done the job, whether or
not they typed anything afterwards. Requiring a note before crediting any of
that put leads at *In progress* and *Unsuccessful* in the same bucket as ones
nobody had opened — the change is worth about +16 points on the company-wide
worked rate, and considerably more for individuals who update diligently but
write little.

So **cold is the only bucket that counts against anybody**: nothing moved and
nothing written.

"Default" is the `NOT_CONTACTED` set — the arrival state, the three "…to
Agent" values, and `Not Specified`. The "…to Agent" ones are set by the CRM
itself when it routes a lead, so they record the handover rather than the
broker acting. `Not Specified` is what `statusOf` falls back to when there is
no sub-status at all, and an absent status was never moved off anything —
counting it would credit somebody for a blank field.

**Worked, no note** is still reported, but as a record-keeping figure rather
than a performance one. The detail matters when a lead is handed over or
chased months later; its absence is not the same as ignoring the lead.

**First touch** comes from the `notes` array, which carries `date` and
`user_name` — deliberately not `last_updated`, which bumps on any field edit
or automation. A status change has no timestamp of its own on this API, so
latency can only be measured on leads that carry a note. That is a subset of
what counts as worked, and the UI says so where the number appears.

## Before you trust the live numbers

1. **Check the response envelope.** The spec defines `LeadListResponse` but
   not the exact key names. `unwrap()` in `propspace.js` handles
   `data` / `leads` / bare arrays. Log one raw response and tighten it.
2. **Check the pagination params.** `page` / `per_page` are assumed. Confirm
   against your account.
3. **Pull the real statuses.** `fetchLeadStatuses()` is wired up but the UI
   currently uses the demo list. Swap it in and update `CLAIMS_CONTACT` to
   match the statuses that actually imply contact happened.

## Baseline first

Before changing anything operationally, export a snapshot of today's numbers.
In six months that snapshot is the difference between "things feel better"
and "median first touch went from 14 hours to 90 minutes."
