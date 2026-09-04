import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
// One config map for the portal proxies, shared with the Pages Function that
// serves the same route in production. See functions/_lib/portalLeads.js.
// Aliased: the owner-search proxy below already has a local PORTALS, and two
// unrelated things under one name in one file is how the wrong one gets used.
import { PORTALS as LEAD_PORTALS, upstreamUrl } from "./functions/_lib/portalLeads.js";
// Same idea for Reelly: the route allowlist, the parameter whitelist and the
// defaults are the Function's, imported rather than restated.
import {
  API as REELLY_API, FORWARDED as REELLY_FORWARDED,
  DEFAULTS as REELLY_DEFAULTS, upstreamPath as reellyPath,
} from "./functions/api/reelly/[[path]].js";

/**
 * Stamped once per build, and read two ways from this one constant.
 *
 * `__BUILD_ID__` is compiled into the bundle, so a running tab knows which
 * build it is. `version.json` is emitted alongside it, so that tab can ask the
 * server which build is current. They must come from the same value or the
 * comparison is meaningless — a tab would either nag forever or never notice.
 *
 * Evaluated at config load, which is once per `vite build`. Do not move it
 * inside the plugin: generateBundle can run more than once in a watch build,
 * and a fresh timestamp each time would make every rebuild look like an update
 * to itself.
 */
const BUILD_ID = new Date().toISOString();

/** Emits version.json next to the bundle. Build-only — generateBundle never
 *  runs under `vite dev`, so the dev server simply 404s it, which the banner
 *  treats as "no information" rather than as an update. */
function versionAsset() {
  return {
    name: "emit-version-json",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source: JSON.stringify({ buildId: BUILD_ID }),
      });
    },
  };
}

/**
 * Dev-only PropSpace proxy.
 *
 * The browser calls /ps/... on localhost. This middleware does the OAuth2
 * token exchange in Node, caches the token, and forwards the request with the
 * Bearer header attached. Two things that buys you:
 *   1. No CORS, because the browser only ever talks to localhost.
 *   2. The client secret never reaches the browser bundle.
 *
 * In production this same logic belongs in a Cloudflare Worker.
 */
function propspace(env) {
  let token = null;
  let expiresAt = 0;
  let inFlight = null;

  /**
   * Single-flight: concurrent callers share one token exchange.
   *
   * The front end now fetches four pages at a time, so on a cold load four
   * requests arrive together, all see no cached token, and all four
   * independently hit /auth/token — six exchanges observed on one page load
   * where one would do. Harmless in isolation, but hammering an auth endpoint
   * with identical concurrent requests is exactly what a WAF throttles, and
   * this account already sits behind one.
   *
   * Holding the promise rather than the token means late arrivals await the
   * exchange already running instead of starting another.
   */
  function getToken() {
    if (token && Date.now() < expiresAt - 60_000) return Promise.resolve(token);
    if (inFlight) return inFlight;
    inFlight = exchange().finally(() => { inFlight = null; });
    return inFlight;
  }

  async function exchange() {
    const res = await fetch("https://api.propspace.com/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: env.PROPSPACE_CLIENT_ID,
        client_secret: env.PROPSPACE_CLIENT_SECRET,
      }),
    });

    if (!res.ok) {
      throw new Error(`auth failed ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    token = data.access_token;
    expiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
    console.log("[propspace] token refreshed");
    return token;
  }

  return {
    name: "propspace-dev-proxy",
    configureServer(server) {
      server.middlewares.use("/ps", async (req, res) => {
        try {
          const t = await getToken();
          const upstream = await fetch("https://api.propspace.com" + req.url, {
            headers: { Authorization: `Bearer ${t}`, Accept: "application/json" },
          });
          const body = await upstream.text();
          res.statusCode = upstream.status;
          res.setHeader("Content-Type", "application/json");
          res.end(body);
        } catch (err) {
          console.error("[propspace]", err);
          res.statusCode = 502;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
    },
  };
}

/**
 * Owner search — portal listing lookup via Apify.
 *
 * Ported from realsearch/server.js so the dashboard needs one process instead
 * of two. Same contract: POST /api/lookup { url } -> { raw, normalised }.
 *
 * The Apify token stays in Node. Moving this fetch into the browser would
 * inline the token into the bundle, where anyone with the URL can read it out
 * of devtools.
 */
function ownerSearch(env) {
  const PORTALS = ["bayut.com", "propertyfinder.ae", "dubizzle.com"];

  const readJson = (req) =>
    new Promise((resolve) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        try { resolve(JSON.parse(body || "{}")); } catch { resolve({}); }
      });
    });

  const send = (res, code, payload) => {
    res.statusCode = code;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(payload));
  };

  return {
    name: "owner-search-proxy",
    configureServer(server) {
      server.middlewares.use("/api/lookup", async (req, res) => {
        if (req.method !== "POST") return send(res, 405, { error: "POST only." });

        const token = env.APIFY_TOKEN;
        const actor = env.APIFY_ACTOR_ID;
        if (!token || !actor) {
          return send(res, 503, {
            error: "Owner search is not configured yet.",
            detail:
              "Add APIFY_TOKEN and APIFY_ACTOR_ID to .env, then restart the dev server. " +
              "Run `npm run discover` inside the realsearch folder to find the actor id.",
          });
        }

        const { url } = await readJson(req);
        if (typeof url !== "string" || !url.trim()) {
          return send(res, 400, { error: "Paste a listing URL first." });
        }

        let parsed;
        try { parsed = new URL(url.trim()); }
        catch { return send(res, 400, { error: "That is not a valid URL — include https://" }); }

        if (!PORTALS.some((d) => parsed.hostname.endsWith(d))) {
          return send(res, 400, {
            error: `Unsupported site. Use a link from ${PORTALS.join(", ")}.`,
          });
        }

        // Proxy is opt-in via APIFY_PROXY_GROUP. This account (FREE plan) has
        // no proxy groups at all — GET /v2/users/me/proxy returns none — so
        // sending apifyProxyGroups: ["RESIDENTIAL"] fails outright. Set the env
        // var once a paid plan makes a group available.
        const proxyGroup = env.APIFY_PROXY_GROUP;

        // Contact retrieval is a SEPARATE paid actor. The input schema says so:
        // "If you have already subscribed UAE Dubai Property Owner Finder
        // actor, this feature will enable you to find contact...". That actor
        // is not on this account, so asking for contacts silently returns
        // nothing. Flip APIFY_CONTACT_DETAILS=true once it is subscribed.
        const wantContacts = String(env.APIFY_CONTACT_DETAILS ?? "").toLowerCase() === "true";

        const input = {
          propertyUrls: [{ url: parsed.toString() }],
          retrieveContactDetails: wantContacts,
          email: "",
          ...(proxyGroup
            ? { proxy: { useApifyProxy: true, apifyProxyGroups: [proxyGroup], apifyProxyCountry: "AE" } }
            : {}),
        };

        try {
          const upstream = await fetch(
            `https://api.apify.com/v2/acts/${actor}` +
              `/run-sync-get-dataset-items?token=${token}&timeout=180`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(input),
            }
          );

          if (!upstream.ok) {
            const detail = await upstream.text();
            return send(res, upstream.status, {
              error: `Apify returned ${upstream.status}.`,
              detail: detail.slice(0, 400),
            });
          }

          const items = await upstream.json();
          if (!Array.isArray(items) || !items.length) {
            return send(res, 404, {
              error: "The run finished but returned nothing.",
              detail: "The listing may be delisted, or the page layout changed.",
            });
          }

          // The actor reports its own failures INSIDE a 2xx response — a
          // dataset item that is just { error, suggestion }. Treated as a
          // result these render as a blank card, so surface them as errors.
          const failure = items.find((i) => i && typeof i === "object" && i.error && !i.url);
          if (failure) {
            return send(res, 502, {
              error: String(failure.error),
              detail: [failure.suggestion, items.find((i) => i?.suggestion && i !== failure)?.suggestion]
                .filter(Boolean).join(" "),
              fromActor: true,
            });
          }

          send(res, 200, { raw: items[0] });
        } catch (err) {
          send(res, 502, { error: "Could not reach Apify.", detail: String(err) });
        }
      });
    },
  };
}

/**
 * Property Finder Enterprise API proxy.
 *
 * Two hosts, not one. Credentials are exchanged for a JWT at
 * auth.propertyfinder.com — HTTP Basic, base64("key:secret") — and the token is
 * then presented as a Bearer to atlas.propertyfinder.com, which is where every
 * resource lives. Tokens last ~30 minutes (expires_in 1784s), so the same
 * cache-and-single-flight arrangement as the PropSpace proxy applies, for the
 * same two reasons: no CORS, and the secret never enters the browser bundle.
 *
 * Everything under /pf/* is forwarded verbatim, so the front end can reach any
 * endpoint in the spec without a change here.
 */
function propertyfinder(env) {
  const AUTH = "https://auth.propertyfinder.com/auth/oauth/v1/token";
  const API = "https://atlas.propertyfinder.com";

  let token = null;
  let expiresAt = 0;
  let inFlight = null;

  function getToken() {
    if (token && Date.now() < expiresAt - 60_000) return Promise.resolve(token);
    if (inFlight) return inFlight;
    inFlight = exchange().finally(() => { inFlight = null; });
    return inFlight;
  }

  async function exchange() {
    const key = env.PROPERTYFINDER_API_KEY;
    const secret = env.PROPERTYFINDER_API_SECRET;
    if (!key || !secret) {
      throw new Error(
        "PROPERTYFINDER_API_KEY / PROPERTYFINDER_API_SECRET missing from .env. " +
        "Generate a pair in PF Expert under Developer Resources → API Credentials."
      );
    }

    const res = await fetch(AUTH, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${key}:${secret}`).toString("base64"),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ grant_type: "client_credentials", scope: "openid" }),
    });

    if (!res.ok) {
      throw new Error(`propertyfinder auth failed ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    token = data.access_token;
    expiresAt = Date.now() + (data.expires_in ?? 1800) * 1000;
    console.log("[propertyfinder] token refreshed");
    return token;
  }

  return {
    name: "propertyfinder-dev-proxy",
    configureServer(server) {
      server.middlewares.use("/pf", async (req, res) => {
        try {
          const t = await getToken();
          const upstream = await fetch(API + req.url, {
            headers: { Authorization: `Bearer ${t}`, Accept: "application/json" },
          });
          const body = await upstream.text();
          res.statusCode = upstream.status;
          res.setHeader("Content-Type", "application/json");
          res.end(body);
        } catch (err) {
          console.error("[propertyfinder]", err);
          res.statusCode = 502;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ title: "Proxy error", detail: String(err.message ?? err) }));
        }
      });
    },
  };
}

/**
 * Bayut lead-stats proxy, dev-server half.
 *
 * `wrangler pages dev` runs functions/api/bayut.js for real; `npm run dev`
 * does not run Functions at all, so this stands in for it on localhost. Both
 * halves import PORTALS and upstreamUrl from the Function's own module, so the
 * upstream host and the forwarded-parameter whitelist are defined once and
 * cannot drift between the two the way the PropSpace and PF proxies have.
 *
 * The auth check has no counterpart here on purpose. The dev server listens on
 * localhost only, and it has no Supabase session to verify against; the edge
 * middleware is what guards this route once it is on the public internet.
 */
function bayut(env) {
  return {
    name: "bayut-dev-proxy",
    configureServer(server) {
      server.middlewares.use("/api/bayut", async (req, res) => {
        const send = (status, body) => {
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json");
          res.end(typeof body === "string" ? body : JSON.stringify(body));
        };

        const cfg = LEAD_PORTALS.bayut;
        const key = env[cfg.keyVar];
        if (!key) {
          return send(503, {
            error: "Bayut is not configured.",
            detail: `Add ${cfg.keyVar} to .env (and .dev.vars for wrangler), then restart.`,
          });
        }

        // Connect strips the mount path, so req.url is "/?type=..." — the base
        // is only there to make it parseable and is never used.
        const params = new URL(req.url, "http://localhost").searchParams;

        try {
          const upstream = await fetch(upstreamUrl(cfg, (n) => params.get(n)), {
            headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
          });
          const text = await upstream.text();

          let body;
          try {
            body = JSON.parse(text);
          } catch {
            return send(upstream.ok ? 502 : upstream.status, {
              error: `Bayut returned ${upstream.status} with a non-JSON body.`,
              detail: text.slice(0, 300),
            });
          }

          // Failures are re-shaped to { error, detail } exactly as the Pages
          // Function does. Passing Bayut's own { message, errors } through
          // instead would mean the useful sentence — "the timestamp must be a
          // date after or equal to ..." — reads correctly deployed and shows
          // as a bare status code locally, which is the wrong way round for
          // the environment you debug in.
          if (!upstream.ok) {
            return send(upstream.status, {
              error: `Bayut returned ${upstream.status}.`,
              detail: String(body?.message ?? body?.error ?? text.slice(0, 300)),
            });
          }

          send(200, text);
        } catch (err) {
          console.error("[bayut]", err);
          send(502, { error: "Could not reach Bayut.", detail: String(err.message ?? err) });
        }
      });
    },
  };
}

/**
 * Reelly proxy, dev-server half.
 *
 * Stands in for functions/api/reelly/[[path]].js under `npm run dev`, which
 * does not run Functions. The route allowlist, parameter whitelist and
 * defaults are imported from the Function itself so the two cannot disagree.
 *
 * No edge cache here. The Cache API does not exist in Node, and an hour-long
 * cache is the last thing you want while working on the thing being cached.
 */
function reelly(env) {
  return {
    name: "reelly-dev-proxy",
    configureServer(server) {
      server.middlewares.use("/api/reelly", async (req, res) => {
        const send = (status, body) => {
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json");
          res.end(typeof body === "string" ? body : JSON.stringify(body));
        };

        const key = env.REELLY_API_KEY;
        if (!key) {
          return send(503, {
            error: "Reelly is not configured.",
            detail: "Add REELLY_API_KEY to .env (and .dev.vars for wrangler), then restart.",
          });
        }

        // Connect strips the mount path, so rebuild the full pathname the
        // Function's matcher expects.
        const incoming = new URL(req.url, "http://localhost");
        const path = reellyPath("/api/reelly" + incoming.pathname);
        if (!path) return send(404, { error: "Unknown Reelly route." });

        const params = new URLSearchParams();
        for (const name of REELLY_FORWARDED) {
          const v = incoming.searchParams.get(name);
          if (v !== null && v !== "") params.set(name, v);
        }
        for (const [k, v] of Object.entries(REELLY_DEFAULTS)) if (!params.has(k)) params.set(k, v);
        params.sort();

        const qs = params.toString();
        try {
          const upstream = await fetch(`${REELLY_API}${path}${qs ? `?${qs}` : ""}`, {
            headers: { "X-API-Key": key, Accept: "application/json" },
          });
          const text = await upstream.text();

          let body;
          try {
            body = JSON.parse(text);
          } catch {
            return send(upstream.ok ? 502 : upstream.status, {
              error: `Reelly returned ${upstream.status} with a non-JSON body.`,
              detail: text.slice(0, 300),
            });
          }

          if (!upstream.ok) {
            return send(upstream.status, {
              error: `Reelly returned ${upstream.status}.`,
              detail: String(body?.detail ?? body?.message ?? body?.error ?? text.slice(0, 300)),
            });
          }

          send(200, text);
        } catch (err) {
          console.error("[reelly]", err);
          send(502, { error: "Could not reach Reelly.", detail: String(err.message ?? err) });
        }
      });
    },
  };
}

/**
 * TruCheck crawl proxy, dev-server half.
 *
 * Mirrors functions/api/trucheck/[[path]].js under `npm run dev`. The actor and
 * its input stay server-side here too: a dev server that let the browser choose
 * the actor would be a habit that survives into the Function.
 */
function trucheck(env) {
  const APIFY = "https://api.apify.com/v2";
  const CONFIG = {
    agencyName: "Aaronz & Co Real Estate",
    bayutCompanyUrl: "https://www.bayut.com/companies/aaronz-co-real-estate-10500/",
    bayutAgencyExternalId: "10500",
    country: "ae",
    location: "Dubai",
    enumerateActor: "coding-doctor-omar~Bayutrix",
    detailActor: "memo23~apify-bayut-scraper",
    detailConcurrency: 4,
    detailRetries: 3,
  };
  const isRunId = (s) => typeof s === "string" && /^[A-Za-z0-9]{6,32}$/.test(s);

  return {
    name: "trucheck-dev-proxy",
    configureServer(server) {
      server.middlewares.use("/api/trucheck", async (req, res) => {
        const send = (status, body) => {
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json");
          res.end(typeof body === "string" ? body : JSON.stringify(body));
        };
        const token = env.APIFY_TOKEN;
        if (!token) return send(503, { error: "APIFY_TOKEN is not set in .env." });

        const rest = new URL(req.url, "http://localhost").pathname.replace(/\/+$/, "") || "/";

        try {
          if (rest === "/config") {
            return send(200, {
              agency: CONFIG.agencyName,
              companyUrl: CONFIG.bayutCompanyUrl,
              agencyExternalId: CONFIG.bayutAgencyExternalId,
            });
          }

          if (rest === "/run" && req.method === "POST") {
            const r = await fetch(`${APIFY}/acts/${CONFIG.enumerateActor}/runs?token=${token}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                scraperModel: "propertyLocator",
                agencyName: CONFIG.agencyName,
                country: CONFIG.country,
                location: CONFIG.location,
                maxResults: 0,
              }),
            });
            const j = await r.json();
            if (!r.ok) return send(r.status, { error: `Apify returned ${r.status}.`, detail: JSON.stringify(j).slice(0, 300) });
            const run = j.data ?? {};
            return send(202, { runId: run.id, status: run.status, datasetId: run.defaultDatasetId, agency: CONFIG.agencyName });
          }

          if (rest === "/details" && req.method === "POST") {
            const body = await new Promise((resolve) => {
              let raw = "";
              req.on("data", (c) => { raw += c; });
              req.on("end", () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
            });
            if (!isRunId(body?.runId)) return send(400, { error: "Not a run id." });

            const lr = await fetch(`${APIFY}/actor-runs/${body.runId}/dataset/items?token=${token}&clean=true&format=json`);
            const items = await lr.json();
            const urls = (Array.isArray(items) ? items : [])
              .map((r) => r?.url)
              .filter((u) => typeof u === "string" && /^https:\/\/www\.bayut\.com\//.test(u));
            if (!urls.length) return send(409, { error: "That run produced no listing URLs to fetch." });

            const r = await fetch(`${APIFY}/acts/${CONFIG.detailActor}/runs?token=${token}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                startUrls: urls.map((url) => ({ url })),
                fullDetails: true,
                maxItems: urls.length,
                maxConcurrency: CONFIG.detailConcurrency,
                maxRequestRetries: CONFIG.detailRetries,
              }),
            });
            const j = await r.json();
            if (!r.ok) return send(r.status, { error: `Apify returned ${r.status}.` });
            const run = j.data ?? {};
            return send(202, { runId: run.id, status: run.status, requested: urls.length, fromRunId: body.runId });
          }

          const poll = rest.match(/^\/run\/([^/]+)$/);
          if (poll && req.method === "GET") {
            if (!isRunId(poll[1])) return send(400, { error: "Not a run id." });
            const r = await fetch(`${APIFY}/actor-runs/${poll[1]}?token=${token}`);
            const j = await r.json();
            if (!r.ok) return send(r.status, { error: `Apify returned ${r.status}.` });
            const run = j.data ?? {};
            return send(200, {
              runId: run.id, status: run.status, datasetId: run.defaultDatasetId,
              startedAt: run.startedAt, finishedAt: run.finishedAt,
              itemCount: run.stats?.outputItemCount ?? null, usageUsd: run.usageTotalUsd ?? null,
            });
          }

          const items = rest.match(/^\/run\/([^/]+)\/items$/);
          if (items && req.method === "GET") {
            if (!isRunId(items[1])) return send(400, { error: "Not a run id." });
            const r = await fetch(`${APIFY}/actor-runs/${items[1]}/dataset/items?token=${token}&clean=true&format=json`);
            const j = await r.json();
            if (!r.ok) return send(r.status, { error: `Apify returned ${r.status}.` });
            return send(200, { runId: items[1], count: Array.isArray(j) ? j.length : 0, items: Array.isArray(j) ? j : [] });
          }

          send(404, { error: "Unknown TruCheck route." });
        } catch (err) {
          console.error("[trucheck]", err);
          send(502, { error: "Could not reach Apify.", detail: String(err.message ?? err) });
        }
      });
    },
  };
}

/**
 * Apollo, dev-server half — deliberately a refusal.
 *
 * `npm run dev` does not run Pages Functions, so /api/apollo would 404 here.
 * The tempting fix is a small local proxy that forwards to Apollo. It is the
 * wrong fix: the real proxy checks apollo_leads before every reveal so a
 * contact is never bought twice, and a local shortcut that skipped that check
 * would spend real credits on contacts the company already owns — quietly, and
 * only while developing.
 *
 * So local development says what it is instead of half-doing it.
 */
function apolloDev() {
  return {
    name: "apollo-dev-refusal",
    configureServer(server) {
      server.middlewares.use("/api/apollo", (req, res) => {
        res.statusCode = 501;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          error: "Apollo runs in the Pages Function, which `npm run dev` does not execute.",
          detail:
            "Use `npx wrangler pages dev dist` to exercise it locally, or the deployed site. " +
            "A dev shortcut is not provided on purpose: it would bypass the apollo_leads " +
            "check that stops a contact being paid for twice.",
        }));
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [react(), versionAsset(), propspace(env), ownerSearch(env), propertyfinder(env), bayut(env), reelly(env), trucheck(env), apolloDev()],
    define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
    server: { port: 5173 },
  };
});
