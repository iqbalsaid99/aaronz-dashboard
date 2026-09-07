/**
 * Row-level scoping for the PropSpace proxy.
 *
 * RLS cannot help here. The CRM data never touches Postgres — it is proxied
 * live from PropSpace — so no policy can reach it. Authorisation has to happen
 * in the request path, which is this file.
 *
 * THE FILTER IS APPLIED TWICE, ON PURPOSE.
 *
 * Upstream, `assigned_to` narrows the query so we are not paging the whole
 * account to throw most of it away. Downstream, filterPayload strips anything
 * that came back anyway. The second pass is not belt-and-braces pedantry: this
 * API is *known* to accept parameters and silently ignore them — date_of_enquiry
 * is documented in propspace.js as returning all 41k leads whatever value you
 * give it. A filter that looks like it worked and did not is exactly how one
 * broker ends up reading another's pipeline, so the response is always filtered
 * regardless of what the request asked for.
 *
 * WHAT IS NOT SCOPED YET. Only leads are filtered — items carrying an `agents`
 * array. Listings pass through untouched, because the agent directory that
 * supplies every photo and full name in the UI is built from live listings, and
 * scoping those would leave a broker looking at a roster of initials. Worth
 * doing, but it is a separate change with its own blast radius.
 */

import { getSupabaseConfig } from './env.js';

const PROFILE_COLUMNS =
  'id,role,propspace_agent_id,propspace_agent_name,manager_id,is_active';

/**
 * The caller's profile row, read AS the caller so their own RLS applies.
 *
 * Returns null when there is no row or the account is deactivated. Both are
 * refusals, not errors: a Supabase user with no profile has never been given
 * access to this data, and is_active = false is how access is taken away.
 */
export async function requireProfile(user, token, env) {
  const { url, anonKey } = getSupabaseConfig(env);
  const profileUrl =
    `${url}/rest/v1/profiles` +
    `?select=${PROFILE_COLUMNS}&id=eq.${encodeURIComponent(user.id)}&limit=1`;

  const res = await fetch(profileUrl, {
    headers: { Authorization: `Bearer ${token}`, apikey: anonKey },
  });

  if (!res.ok) {
    throw new Error(`profiles lookup failed ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  const rows = await res.json().catch(() => []);
  const profile = Array.isArray(rows) ? rows[0] : null;

  if (!profile) return null;
  if (profile.is_active === false) return null;

  return profile;
}

/** PostgREST calls functions by named argument; team_agent_ids(for_user uuid). */
async function callTeamAgentIds(uid, token, env) {
  const { url, anonKey } = getSupabaseConfig(env);
  const res = await fetch(`${url}/rest/v1/rpc/team_agent_ids`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: anonKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ for_user: uid }),
  });

  if (!res.ok) {
    throw new Error(`team_agent_ids ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  return res.json().catch(() => []);
}

/** Rows may come back as bare scalars or as single-key objects. */
const asId = (row) =>
  row != null && typeof row === 'object' ? Object.values(row)[0] : row;

/**
 * The set of PropSpace agent ids this profile may see, as strings.
 *
 * Returns null for an unrestricted caller — null means "no filter", which is
 * deliberately distinct from an empty set, which means "may see nothing".
 * Conflating the two is the classic way an authorisation check inverts itself.
 */
export async function allowedAgentIds(profile, token, env) {
  if (profile.role === 'super_admin') return null;

  const rows = await callTeamAgentIds(profile.id, token, env);
  const ids = new Set(
    (Array.isArray(rows) ? rows : [rows]).map(asId).filter((v) => v != null).map(String)
  );

  // A broker whose own id is not in the function's result would otherwise see
  // nothing at all. Their own leads are theirs by definition.
  if (profile.propspace_agent_id != null) ids.add(String(profile.propspace_agent_id));

  return ids;
}

/**
 * Profile + allowed ids, cached per token.
 *
 * Establishing scope costs two Supabase requests — the profiles row and the
 * team_agent_ids RPC — and without this they were paid on EVERY proxied
 * request. One dashboard load is dozens of them, so a single page view was
 * firing sixty-odd requests at Supabase and tripping its rate limits, which
 * then surfaced to the user as "session expired". The session cache alone did
 * not help: it only covered the third call.
 *
 * Same shape as the session cache, and for the same reason — the entry holds
 * the in-flight promise so a burst arriving on a cold isolate collapses to one
 * lookup rather than one per request.
 */
const scopes = new Map();
const SCOPE_TTL_MS = 60_000;
const MAX_SCOPES = 200;

export function resolveScope(user, token, env) {
  const hit = scopes.get(token);
  if (hit) {
    if (hit.promise) return hit.promise;
    if (Date.now() < hit.until) return Promise.resolve(hit.value);
    scopes.delete(token);
  }

  const promise = (async () => {
    const profile = await requireProfile(user, token, env);
    if (!profile) return { profile: null, allowed: null };
    return { profile, allowed: await allowedAgentIds(profile, token, env) };
  })()
    .then((value) => {
      // A missing profile is a refusal, not a result worth remembering — an
      // admin adding the row should take effect on the next request, not in a
      // minute's time.
      if (value.profile) {
        if (scopes.size > MAX_SCOPES) scopes.clear();
        scopes.set(token, { until: Date.now() + SCOPE_TTL_MS, value });
      } else {
        scopes.delete(token);
      }
      return value;
    })
    .catch((err) => {
      scopes.delete(token);
      throw err;
    });

  scopes.set(token, { promise });
  return promise;
}

/**
 * Narrow the upstream query. Best-effort by design — see the note at the top
 * about this API accepting filters it then ignores. Only ever applied to lead
 * paths, since assigned_to means nothing elsewhere.
 *
 * ONE VALUE ONLY. Probed against the live API: assigned_to=<id> works and a
 * nonsense id correctly returns nothing, but every multi-value form —
 * comma-joined, repeated, and bracketed — is rejected with a 400. Sending a
 * list therefore did not widen the filter, it broke the request outright, so
 * any manager with more than one person reporting to them could not load leads
 * at all.
 *
 * With several ids we simply omit the parameter and page more of the account
 * than we strictly need. Nothing leaks by doing that: filterPayload runs on
 * every response regardless of what the request asked for, which is exactly
 * the case it was written for.
 */
export function applyAgentScope(pathname, searchParams, allowed) {
  if (!allowed) return searchParams;
  if (!/^\/leads(\/|$)/.test(pathname)) return searchParams;

  const params = new URLSearchParams(searchParams);
  if (allowed.size === 1) params.set('assigned_to', [...allowed][0]);
  return params;
}

/** Every agent id a lead-shaped record is attributable to. */
function agentIdsOf(item) {
  if (!item || typeof item !== 'object') return null;
  if (!Array.isArray(item.agents)) return null;          // not a lead; leave alone
  return item.agents.map((a) => a?.id).filter((v) => v != null).map(String);
}

/**
 * Strip records belonging to agents outside the allowed set.
 *
 * Runs on every response, whatever the upstream filter did. Payloads with no
 * agent attribution — status and source taxonomies, option lists — pass
 * through untouched rather than being emptied.
 *
 * `meta.total` IS REMOVED FOR SCOPED CALLERS. It is the size of the result set
 * upstream, before any of this ran, so it survives filtering intact and
 * describes rows the caller may not see. One request —
 * /leads?assigned_to=<someone else>&per_page=1 — would hand a broker another
 * broker's exact lead count without a single row crossing the boundary.
 * Deleting it is right rather than rewriting it to the kept count: what came
 * back on this page is not the scoped total, and a plausible wrong number is
 * worse than an absent one. Unscoped callers keep it.
 *
 * Returns the original count alongside the filtered body. The client pages
 * until a short page tells it there is no more, and a page of 100 cut to 12
 * would read as the end of the data — so the untouched count travels back with
 * the response and the client uses that instead. Without it, scoping would
 * silently truncate a broker's own history.
 */
/**
 * The envelope's own meta, minus the count that describes the unscoped set.
 *
 * Returns an empty object when there is no meta at all, so the spread that uses
 * it adds nothing rather than inventing a meta key that was never there.
 */
function scopedMeta(meta) {
  if (!meta || typeof meta !== 'object') return {};
  const { total, ...rest } = meta;
  return { meta: rest };
}

export function filterPayload(json, allowed) {
  if (!allowed) return { json, total: null, kept: null };

  const keep = (item) => {
    const ids = agentIdsOf(item);
    if (ids === null) return true;                       // not attributable
    return ids.some((id) => allowed.has(id));
  };

  if (Array.isArray(json)) {
    const kept = json.filter(keep);
    return { json: kept, total: json.length, kept: kept.length };
  }

  if (json && typeof json === 'object') {
    for (const key of ['data', 'leads', 'items']) {
      if (Array.isArray(json[key])) {
        const kept = json[key].filter(keep);
        return {
          json: { ...json, [key]: kept, ...scopedMeta(json.meta) },
          total: json[key].length,
          kept: kept.length,
        };
      }
    }
    // A single record, e.g. /leads/{id}. Denying it outright is right: it is
    // somebody else's lead.
    if (Array.isArray(json.agents)) {
      const ok = keep(json);
      return { json: ok ? json : null, total: 1, kept: ok ? 1 : 0 };
    }
  }

  return { json, total: null, kept: null };
}

/* --------------------------- what may be proxied --------------------------- */

/**
 * An allowlist, not a denylist, because /ps/* forwards verbatim: anything
 * PropSpace exposes on this key was reachable through the proxy the moment it
 * existed. Probed against the live account on 2026-08-09:
 *
 *   /leads       200  scoped below by agent
 *   /listings    200  owner contact details redacted below
 *   /options/*   200  taxonomy — statuses, sub_statuses, sources, agents
 *   /contacts    200  THE WHOLE CONTACT BOOK. first/last name, email, email_2,
 *                     email_3, phone, phone_2, phone_3, mobile, mobile_2,
 *                     mobile_3, job_title. No agent attribution to scope on,
 *                     and nothing in the app calls it. Blocked.
 *
 *   403 on this key: /clients /owners /properties /projects /users /agents
 *   /enquiries /notes /companies /teams /me /account /reports — and, per
 *   propspace.js, every viewing, deal and transaction path.
 *
 * A path the app does not call is not a path worth forwarding. Anything new
 * that PropSpace exposes later is refused until somebody decides how it should
 * be scoped, rather than being quietly readable by everyone the day it ships.
 */
const FORWARDABLE = [
  /^\/leads(\/[^/]+)?$/,
  /^\/listings(\/[^/]+)?$/,
  /^\/options\/[a-z_]+$/,
];

export const isForwardable = (pathname) => FORWARDABLE.some((re) => re.test(pathname));

/* ------------------------------ owner PII ------------------------------ */

/** Only these roles see who owns a property. */
const OWNER_CONTACT_ROLES = new Set(['admin', 'super_admin']);

export const canSeeOwnerContacts = (profile) => OWNER_CONTACT_ROLES.has(profile.role);

/**
 * Contact fields stripped from an owner record. `id` is kept: it is not
 * personal information and grouping a portfolio by owner is legitimate without
 * knowing who they are.
 */
const OWNER_PII = [
  'name', 'first_name', 'last_name', 'full_name',
  'email', 'email_2', 'email_3',
  'phone', 'phone_2', 'phone_3',
  'mobile', 'mobile_2', 'mobile_3',
  'whatsapp', 'address',
];

/**
 * Remove owner contact details from anywhere in a listing payload.
 *
 * Walks the whole structure rather than reaching for a known path, because the
 * shape differs between the list and single-listing responses and there is no
 * guarantee an owner only ever appears at the top level. Live listings carry
 * owner: { id, name, email, mobile }.
 *
 * Deliberately NOT applied to /api/lookup. Owner search exists precisely to
 * find owner contacts, and gutting it here would break the feature it is.
 *
 * The agent and marketing_agent objects are left alone. They carry email and
 * mobile too, but those are colleagues, and the UI reads name, job title and
 * photo off them on every screen.
 */
export function redactOwnerContacts(value) {
  if (Array.isArray(value)) return value.map(redactOwnerContacts);
  if (!value || typeof value !== 'object') return value;

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (key === 'owner' || key === 'owners') {
      const strip = (o) => {
        if (!o || typeof o !== 'object') return o;
        const clean = { ...o };
        for (const f of OWNER_PII) delete clean[f];
        clean.redacted = true;            // so the UI can say so rather than show a blank
        return clean;
      };
      out[key] = Array.isArray(val) ? val.map(strip) : strip(val);
    } else {
      out[key] = redactOwnerContacts(val);
    }
  }
  return out;
}
