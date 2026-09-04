import { apiFetch } from './apiFetch.js';
import { parseInsights, parseAds, parseAdObjects, parseCampaignObjects } from './metaParse.js';
import { CONVERSATION_ACTION } from './metaParse.js';

/**
 * Meta ad insights, through the /meta proxy.
 *
 * The proxy builds the account into the URL itself, so this only ever asks for
 * /meta/insights — it cannot address another account even by mistake.
 */

const FIELDS = [
  'campaign_id', 'campaign_name', 'objective', 'spend', 'impressions',
  // inline_link_clicks, not clicks — see the note in metaParse.js. `clicks` is
  // still requested so the difference can be shown when it matters.
  'clicks', 'inline_link_clicks', 'actions', 'date_start', 'date_stop',
].join(',');

const AD_FIELDS = [
  'ad_id', 'ad_name', 'campaign_id', 'spend', 'impressions',
  'inline_link_clicks', 'actions',
].join(',');

/**
 * NOT CACHED, deliberately.
 *
 * Meta keeps revising attribution for weeks after the fact: a conversation
 * started today can be credited to an impression from several days ago, so
 * yesterday's figures are still moving. Anything held from an earlier load
 * would quietly disagree with Ads Manager, and the whole point of
 * use_unified_attribution_setting is that the two agree — that flag makes the
 * API apply the same attribution windows the Ads Manager UI shows, instead of
 * the API default, which reports differently and looks like a bug in this
 * dashboard.
 */
export async function fetchMetaInsights({ from, to, level = 'campaign' }) {
  const params = new URLSearchParams({
    level,
    fields: FIELDS,
    time_range: JSON.stringify({ since: from, until: to }),
    use_unified_attribution_setting: 'true',
    time_increment: 'all_days',
    limit: '200',
  });

  const res = await apiFetch(`/meta/insights?${params.toString()}`);
  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    // Graph errors carry { error: { message, type, code } }; the message is
    // the useful part and says things like "Error validating access token".
    const msg = body?.error?.message ?? body?.error ?? body?.detail ?? `Meta API ${res.status}`;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  return parseInsights(body.data ?? []);
}

/**
 * Account-level spend for the range.
 *
 * Pulled separately at level=account rather than summed from the campaign
 * rows, which is the entire point: summing campaigns and comparing to that sum
 * would agree with itself no matter what was missing. Meta omits campaigns from
 * campaign-level reports in several situations, and the gap between this figure
 * and the campaign rows is precisely what someone checking against an invoice
 * needs to see.
 */
export async function fetchAccountSpend({ from, to }) {
  const params = new URLSearchParams({
    level: 'account',
    fields: 'spend',
    time_range: JSON.stringify({ since: from, until: to }),
    use_unified_attribution_setting: 'true',
    time_increment: 'all_days',
  });

  const res = await apiFetch(`/meta/insights?${params.toString()}`);
  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg = body?.error?.message ?? body?.detail ?? `Meta API ${res.status}`;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  // An account that spent nothing in the range returns an empty data array
  // rather than a zero, which is not the same as "we could not tell".
  const row = (body.data ?? [])[0];
  return row ? Number(row.spend) || 0 : 0;
}

/**
 * Ad-level insights, for the per-campaign expansion.
 *
 * Fetched once for the whole range and grouped by campaign_id rather than
 * per-row on expand: one request beats one per campaign someone happens to
 * click, and the account is small enough that the whole set is a single page.
 */
export async function fetchAdInsights({ from, to }) {
  const params = new URLSearchParams({
    level: 'ad',
    fields: AD_FIELDS,
    time_range: JSON.stringify({ since: from, until: to }),
    use_unified_attribution_setting: 'true',
    time_increment: 'all_days',
    limit: '500',
  });

  const res = await apiFetch(`/meta/insights?${params.toString()}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.message ?? body?.detail ?? `Meta API ${res.status}`;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return parseAds(body.data ?? []);
}

/**
 * The ad objects, for creative images, headlines and real delivery status.
 *
 * A separate call from ad-level insights because Graph will not return creative
 * fields on an insights edge — insights carries spend, /ads carries what the ad
 * actually is. They join on ad id.
 */
/**
 * The creative fields, and why the list is shaped the way it is.
 *
 * asset_feed_spec is requested as `asset_feed_spec{images}` rather than whole.
 * The full object carries every body, title, link, call-to-action and video
 * variant an Advantage+ ad can rotate, and asking for all of it across the
 * account's ads is enough data that Graph refuses the request outright with
 * "Please reduce the amount of data you're asking for" — which takes down the
 * entire Campaigns tab, not just the image. Only `images` is ever read.
 *
 * See creativeImage in metaParse.js for the five shapes and their order.
 */
const CREATIVE_FIELDS =
  'creative{id,title,body,object_story_spec,asset_feed_spec{images},' +
  'image_url,thumbnail_url,call_to_action_type}';

/**
 * How many ads per page.
 *
 * Was 500 in one shot, which worked while the creative fields were small. With
 * object_story_spec AND asset_feed_spec on every row it is far past what Graph
 * will assemble in one response. 50 is comfortably under the limit and the
 * account runs ~125 ads, so this is three requests rather than one.
 */
const AD_PAGE = 50;

export async function fetchAdObjects() {
  const rows = [];
  let after = null;

  // maxPages is a stop, not an expectation: a paging bug must not spin
  // forever, and 20 pages is 1,000 ads on an account that runs about 125.
  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams({
      fields: `name,effective_status,campaign_id,${CREATIVE_FIELDS}`,
      // Meta's default thumbnail is 64x64, which is why thumbnail_url was
      // previously dismissed as unusable. Asked for at card size it is a
      // reasonable fallback for creatives that expose nothing else.
      thumbnail_width: '600',
      thumbnail_height: '600',
      limit: String(AD_PAGE),
    });
    if (after) params.set('after', after);

    const res = await apiFetch(`/meta/ads?${params.toString()}`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = body?.error?.message ?? body?.detail ?? `Meta API ${res.status}`;
      throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    }

    const batch = body.data ?? [];
    rows.push(...batch);

    // The cursor, not paging.next — that is an absolute graph.facebook.com URL
    // carrying an access_token, which the browser can neither use nor be shown.
    after = body.paging?.cursors?.after ?? null;
    if (!after || batch.length < AD_PAGE) break;
  }

  return parseAdObjects(rows);
}

/**
 * The campaign objects, for the date each campaign was created.
 *
 * Insights carries no such field — a report row knows the window it covers and
 * nothing about when the campaign came into existence — so the object has to be
 * read separately and joined on campaign id.
 *
 * effective_status is sent because the campaigns edge otherwise leaves archived
 * campaigns out, and an old window in this dashboard will happily show spend on
 * one. If Graph rejects the filter the request is retried without it: a missing
 * date on an archived campaign is a far smaller loss than no dates at all.
 */
const CAMPAIGN_STATUSES = ['ACTIVE', 'PAUSED', 'ARCHIVED', 'IN_PROCESS', 'WITH_ISSUES'];

export async function fetchCampaignObjects() {
  const base = { fields: 'id,name,created_time', limit: '500' };

  const attempt = async (params) => {
    const res = await apiFetch(`/meta/campaigns?${new URLSearchParams(params).toString()}`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = body?.error?.message ?? body?.detail ?? `Meta API ${res.status}`;
      throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    }
    return parseCampaignObjects(body.data ?? []);
  };

  try {
    return await attempt({ ...base, effective_status: JSON.stringify(CAMPAIGN_STATUSES) });
  } catch {
    return attempt(base);
  }
}

/**
 * The playable source for one video, fetched when a lightbox opens.
 *
 * Never at page load, and never cached: these CDN URLs carry a signed expiry
 * and stop working within hours, so a tab left open overnight would offer a
 * play button that does nothing. Fetching at the moment of opening is the only
 * way the link is reliably still alive.
 *
 * The proxy checks the id belongs to this ad account before forwarding.
 */
export async function fetchVideoSource(videoId) {
  const res = await apiFetch(`/meta/video/${encodeURIComponent(videoId)}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.message ?? body?.error ?? body?.detail ?? `Meta API ${res.status}`;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return { source: body.source ?? null, picture: body.picture ?? null, length: body.length ?? null };
}

export { CONVERSATION_ACTION };
