/**
 * Owner search — portal listing lookup via Apify. Edge version of the dev
 * middleware. Same contract: POST { url } -> { raw }.
 *
 * The Apify token stays server-side. Moving this fetch into the browser would
 * inline the token into the bundle, where anyone can read it out of devtools —
 * and on a public deployment that means anyone at all, not just someone at
 * this laptop.
 *
 * One thing to watch that the Node version did not have to: Workers cap how
 * long a request may run. run-sync-get-dataset-items with timeout=180 asks
 * Apify to hold the connection open for up to three minutes, which is longer
 * than a Worker will wait. If lookups start failing with the run apparently
 * incomplete, this needs splitting into start-run + poll rather than a longer
 * timeout.
 */

const PORTALS = ['bayut.com', 'propertyfinder.ae', 'dubizzle.com'];

const send = (payload, status) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return send({ error: 'POST only.' }, 405);

  const token = env.APIFY_TOKEN;
  const actor = env.APIFY_ACTOR_ID;
  if (!token || !actor) {
    return send(
      {
        error: 'Owner search is not configured yet.',
        detail:
          'Add APIFY_TOKEN and APIFY_ACTOR_ID to the Pages project, then redeploy. ' +
          'Run `npm run discover` inside the realsearch folder to find the actor id.',
      },
      503
    );
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    /* fall through to the empty-url message below */
  }

  const { url } = body;
  if (typeof url !== 'string' || !url.trim()) {
    return send({ error: 'Paste a listing URL first.' }, 400);
  }

  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    return send({ error: 'That is not a valid URL — include https://' }, 400);
  }

  if (!PORTALS.some((d) => parsed.hostname.endsWith(d))) {
    return send({ error: `Unsupported site. Use a link from ${PORTALS.join(', ')}.` }, 400);
  }

  // Proxy is opt-in via APIFY_PROXY_GROUP. A FREE plan has no proxy groups at
  // all, and sending apifyProxyGroups: ["RESIDENTIAL"] against one fails
  // outright. Set the variable once a paid plan makes a group available.
  const proxyGroup = env.APIFY_PROXY_GROUP;

  // Contact retrieval is a SEPARATE paid actor. Asking for contacts without it
  // subscribed returns nothing rather than erroring, so this stays off until
  // APIFY_CONTACT_DETAILS is explicitly set to "true".
  const wantContacts = String(env.APIFY_CONTACT_DETAILS ?? '').toLowerCase() === 'true';

  const input = {
    propertyUrls: [{ url: parsed.toString() }],
    retrieveContactDetails: wantContacts,
    email: '',
    ...(proxyGroup
      ? {
          proxy: {
            useApifyProxy: true,
            apifyProxyGroups: [proxyGroup],
            apifyProxyCountry: 'AE',
          },
        }
      : {}),
  };

  try {
    const upstream = await fetch(
      `https://api.apify.com/v2/acts/${actor}` +
        `/run-sync-get-dataset-items?token=${token}&timeout=180`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }
    );

    if (!upstream.ok) {
      const detail = await upstream.text();
      return send(
        { error: `Apify returned ${upstream.status}.`, detail: detail.slice(0, 400) },
        upstream.status
      );
    }

    const items = await upstream.json();
    if (!Array.isArray(items) || !items.length) {
      return send(
        {
          error: 'The run finished but returned nothing.',
          detail: 'The listing may be delisted, or the page layout changed.',
        },
        404
      );
    }

    // The actor reports its own failures INSIDE a 2xx response — a dataset
    // item that is just { error, suggestion }. Treated as a result these
    // render as a blank card, so surface them as errors.
    const failure = items.find((i) => i && typeof i === 'object' && i.error && !i.url);
    if (failure) {
      return send(
        {
          error: String(failure.error),
          detail: [
            failure.suggestion,
            items.find((i) => i?.suggestion && i !== failure)?.suggestion,
          ]
            .filter(Boolean)
            .join(' '),
          fromActor: true,
        },
        502
      );
    }

    return send({ raw: items[0] }, 200);
  } catch (err) {
    return send({ error: 'Could not reach Apify.', detail: String(err.message ?? err) }, 502);
  }
}
