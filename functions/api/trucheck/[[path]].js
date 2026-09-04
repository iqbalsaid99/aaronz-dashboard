/**
 * TruCheck crawl proxy — starts and polls the Apify run behind the TruCheck tab.
 *
 * THERE IS NO API FOR TRUCHECK. Bayut publishes the badge on the public
 * listing page and nowhere else: it is absent from the Pull API we hold
 * credentials for, and absent from PropSpace. The only source is the page, and
 * the only sanctioned way to read it is a commercial Apify actor — Bayut gates
 * every page behind a captchaChallenge redirect, so nothing here fetches
 * bayut.com directly and nothing should be added that does.
 *
 * WHAT THIS PROXY IS FOR. The Apify token is an account-wide credential, and
 * a run costs money. Exposing it, or letting a caller choose the actor and its
 * input, would let anyone with a dashboard login spend the account's balance on
 * anything in the Apify store. So the actor and its input are fixed here and
 * the caller may only say "start the configured crawl" or "how is run X doing".
 *
 * Run ids are echoed back to the caller and then accepted again on poll. They
 * are validated against Apify's id format rather than trusted, because they
 * land in a URL path.
 */

const APIFY = 'https://api.apify.com/v2';

/**
 * The crawl, in one place.
 *
 * `enumerate` returns every listing the agency has on Bayut with its reference,
 * URL and isVerified flag — measured on 2026-08-21: 10/10 references matched
 * PropSpace exactly, and isVerified came back a real mix rather than a constant.
 *
 * `detail` is the second stage and is optional. The enumerate actor gives the
 * badge as a boolean; only the detail record carries verification.trucheckedAt,
 * i.e. the DATE it was TruChecked. It is a separate actor and a separate cost
 * per listing, so the tab can run stage one alone and still answer the question
 * management actually asks — which listings are not TruChecked.
 *
 * AGENCY_NAME is the filter the enumerate actor scopes on, and BAYUT_COMPANY_URL
 * is the agency's public page, kept here because it is the thing to check first
 * if a crawl ever comes back with somebody else's stock.
 */
const CONFIG = {
  agencyName: 'Aaronz & Co Real Estate',
  bayutCompanyUrl: 'https://www.bayut.com/companies/aaronz-co-real-estate-10500/',
  bayutAgencyExternalId: '10500',
  country: 'ae',
  location: 'Dubai',
  enumerateActor: 'coding-doctor-omar~Bayutrix',
  detailActor: 'memo23~apify-bayut-scraper',

  /**
   * How hard the detail pass hits bayut.com.
   *
   * Deliberately modest. This is ~242 sequential page reads against a site we
   * do not own, on behalf of an agency that has a commercial relationship with
   * it; there is no deadline on this crawl and no reason to make it look like
   * an attack. Retries are on because a single 429 in the middle should cost
   * one listing's detail, not the run.
   */
  detailConcurrency: 4,
  detailRetries: 3,
};

/** Apify ids are short base62 strings. Anything else is not an id. */
const isRunId = (s) => typeof s === 'string' && /^[A-Za-z0-9]{6,32}$/.test(s);

const json = (body, status) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const notConfigured = () =>
  json(
    {
      error: 'The TruCheck crawl is not configured on this deployment.',
      detail:
        'Set APIFY_TOKEN on the Pages project — wrangler pages secret put ' +
        'APIFY_TOKEN — then redeploy. Refusing to start a run without it.',
    },
    503
  );

/** Apify errors are JSON when the platform answers and HTML when it does not. */
async function readApify(res, what) {
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    return {
      ok: false,
      status: res.ok ? 502 : res.status,
      payload: {
        error: `Apify returned a non-JSON response ${what}.`,
        detail: text.slice(0, 300),
      },
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      payload: {
        error: `Apify returned ${res.status} ${what}.`,
        detail: String(body?.error?.message ?? body?.message ?? text.slice(0, 300)),
      },
    };
  }
  return { ok: true, body };
}

export async function onRequest(context) {
  const { request, env, data } = context;
  const url = new URL(request.url);

  // functions/_middleware.js already rejected anything without a live Supabase
  // session. This keeps that true if the route is ever moved off /api/.
  if (!data?.user) return json({ error: 'Not signed in.' }, 401);

  const token = env.APIFY_TOKEN;
  if (!token) return notConfigured();

  const rest = url.pathname.replace(/^\/api\/trucheck/, '').replace(/\/+$/, '') || '/';

  /* ------------------------------ start a run ----------------------------- */

  if (rest === '/run' && request.method === 'POST') {
    // The input is built here and never taken from the caller. A crawl the
    // caller can shape is a crawl the caller can point anywhere.
    const input = {
      scraperModel: 'propertyLocator',
      agencyName: CONFIG.agencyName,
      country: CONFIG.country,
      location: CONFIG.location,
      // 0 means unlimited in this actor. The agency has ~242 listings; a cap
      // below that would silently under-report and read as listings vanishing
      // from Bayut, which is the one conclusion this tab must not invite.
      maxResults: 0,
    };

    const res = await fetch(
      `${APIFY}/acts/${CONFIG.enumerateActor}/runs?token=${encodeURIComponent(token)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }
    ).catch((err) => err);

    if (res instanceof Error) {
      return json({ error: 'Could not reach Apify.', detail: String(res.message) }, 502);
    }

    const out = await readApify(res, 'starting the run');
    if (!out.ok) return json(out.payload, out.status);

    const run = out.body?.data ?? {};
    return json(
      {
        runId: run.id ?? null,
        status: run.status ?? 'READY',
        datasetId: run.defaultDatasetId ?? null,
        startedAt: run.startedAt ?? null,
        agency: CONFIG.agencyName,
      },
      202
    );
  }

  /* ------------------------------- poll a run ----------------------------- */

  const runMatch = rest.match(/^\/run\/([^/]+)$/);
  if (runMatch && request.method === 'GET') {
    const runId = runMatch[1];
    if (!isRunId(runId)) return json({ error: 'Not a run id.' }, 400);

    const res = await fetch(
      `${APIFY}/actor-runs/${runId}?token=${encodeURIComponent(token)}`
    ).catch((err) => err);
    if (res instanceof Error) {
      return json({ error: 'Could not reach Apify.', detail: String(res.message) }, 502);
    }

    const out = await readApify(res, 'polling the run');
    if (!out.ok) return json(out.payload, out.status);

    const run = out.body?.data ?? {};
    return json({
      runId: run.id ?? runId,
      // READY / RUNNING / SUCCEEDED / FAILED / ABORTED / TIMED-OUT
      status: run.status ?? null,
      datasetId: run.defaultDatasetId ?? null,
      startedAt: run.startedAt ?? null,
      finishedAt: run.finishedAt ?? null,
      itemCount: run.stats?.outputItemCount ?? null,
      // Surfaced so a run that burns the account's balance is visible rather
      // than showing up as a mysteriously failed refresh next month.
      usageUsd: run.usageTotalUsd ?? null,
    });
  }

  /* ---------------------------- start the detail pass ---------------------- */

  /**
   * Stage two: read the enumerate run's listings and fetch each one's page.
   *
   * The URLs are taken from the enumerate run's OWN dataset, server-side, and
   * never from the caller. A caller who could post a URL list would have a
   * general-purpose crawler pointed at anything, paid for by this account.
   * They are also filtered to bayut.com for the same reason — the enumerate
   * actor is trusted, but not blindly.
   */
  if (rest === '/details' && request.method === 'POST') {
    let body = {};
    try {
      body = await request.json();
    } catch {
      /* handled by the id check below */
    }

    const from = body?.runId;
    if (!isRunId(from)) return json({ error: 'Not a run id.' }, 400);

    const listRes = await fetch(
      `${APIFY}/actor-runs/${from}/dataset/items?token=${encodeURIComponent(token)}&clean=true&format=json`
    ).catch((err) => err);
    if (listRes instanceof Error) {
      return json({ error: 'Could not reach Apify.', detail: String(listRes.message) }, 502);
    }

    const listOut = await readApify(listRes, 'reading the listing index');
    if (!listOut.ok) return json(listOut.payload, listOut.status);

    const urls = (Array.isArray(listOut.body) ? listOut.body : [])
      .map((r) => r?.url)
      .filter((u) => typeof u === 'string' && /^https:\/\/www\.bayut\.com\//.test(u));

    if (!urls.length) {
      return json(
        {
          error: 'That run produced no listing URLs to fetch.',
          detail: 'Nothing was started. Re-run the listing pass first.',
        },
        409
      );
    }

    const res = await fetch(
      `${APIFY}/acts/${CONFIG.detailActor}/runs?token=${encodeURIComponent(token)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startUrls: urls.map((url) => ({ url })),
          fullDetails: true,
          maxItems: urls.length,
          maxConcurrency: CONFIG.detailConcurrency,
          maxRequestRetries: CONFIG.detailRetries,
        }),
      }
    ).catch((err) => err);

    if (res instanceof Error) {
      return json({ error: 'Could not reach Apify.', detail: String(res.message) }, 502);
    }

    const out = await readApify(res, 'starting the detail pass');
    if (!out.ok) return json(out.payload, out.status);

    const run = out.body?.data ?? {};
    return json(
      {
        runId: run.id ?? null,
        status: run.status ?? 'READY',
        // What stage two was asked to fetch, so the tab can report how many of
        // them came back rather than only how many succeeded.
        requested: urls.length,
        fromRunId: from,
      },
      202
    );
  }

  /* ------------------------------ fetch results --------------------------- */

  const itemsMatch = rest.match(/^\/run\/([^/]+)\/items$/);
  if (itemsMatch && request.method === 'GET') {
    const runId = itemsMatch[1];
    if (!isRunId(runId)) return json({ error: 'Not a run id.' }, 400);

    const res = await fetch(
      `${APIFY}/actor-runs/${runId}/dataset/items?token=${encodeURIComponent(token)}&clean=true&format=json`
    ).catch((err) => err);
    if (res instanceof Error) {
      return json({ error: 'Could not reach Apify.', detail: String(res.message) }, 502);
    }

    const out = await readApify(res, 'reading the results');
    if (!out.ok) return json(out.payload, out.status);

    const items = Array.isArray(out.body) ? out.body : [];
    return json({ runId, count: items.length, items });
  }

  /* --------------------------------- config -------------------------------- */

  // What the crawl is pointed at, so the tab can say whose listings these are
  // without the agency name being restated in the bundle.
  if (rest === '/config' && request.method === 'GET') {
    return json({
      agency: CONFIG.agencyName,
      companyUrl: CONFIG.bayutCompanyUrl,
      agencyExternalId: CONFIG.bayutAgencyExternalId,
    });
  }

  return json(
    {
      error: 'Unknown TruCheck route.',
      detail: 'Served: POST /run, POST /details, GET /run/:id, GET /run/:id/items, GET /config.',
    },
    404
  );
}

export { CONFIG, isRunId };
