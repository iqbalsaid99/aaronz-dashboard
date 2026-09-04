# Listing lookup

Paste a Bayut, Property Finder or Dubizzle URL, get the listing data back as a structured card.

## 1. Install

```bash
npm install
cp .env.example .env
```

Put your token in `.env`. Apify console > Settings > API & Integrations > Personal API tokens. Copy the token itself, not the whole URL with `?token=` on the end.

The run ID and dataset ID from your console are already filled in.

## 2. Find the actor ID

The API dialog in the console shows run endpoints, not the actor. Two ways to get it, both free:

```bash
npm run discover
```

This reads `GET /v2/actor-runs/{runId}` and prints the `actId` that produced your run, then lists every actor on your account via `GET /v2/actors`. Paste the result into `APIFY_ACTOR_ID`.

Either form works: a raw ID like `zM4dJRucFTVpLZC5U`, or `username~actor-name`.

Manual alternative: open the actor's page in the console and read the URL. `apify.com/curious_coder/bayut-scraper` becomes `curious_coder~bayut-scraper`. Tilde, not slash.

## 3. Fix the field mapping without burning credits

You already have a completed run sitting in a dataset. Read that instead of paying for a new one:

```bash
npm run inspect
```

It prints every field path in the first record with a value preview. Take the paths you want and drop them into the `pick()` calls at the bottom of `server.js`:

```js
price: pick(r, "listing.priceAED", "price", "priceValue"),
```

`normalise()` currently guesses at common field names. Anything it can't find is hidden from the card rather than rendered blank, so a half-mapped actor still looks clean.

## 4. Run it

Two terminals:

```bash
npm run server   # 8787
npm run dev      # 5173
```

http://localhost:5173

## Notes

- The token lives in `.env` and stays on the server. Don't move the fetch into `App.jsx`. Vite inlines everything into the bundle and the token becomes readable in devtools by anyone with the URL.
- `run-sync-get-dataset-items` blocks until the run finishes, ceiling 300s. Cold starts are 20 to 60 seconds. If you batch URLs later, switch to the async pattern: `POST /v2/acts/{id}/runs`, then poll `GET /v2/actor-runs/{runId}` until `status` is `SUCCEEDED`, then read the dataset. Those are the endpoints in your screenshots.
- Residential proxy is the expensive line on the bill. Watch the usage meter while you are on the trial.
- `retrieveContactDetails` is `false` in `server.js`.
