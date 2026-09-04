/**
 * Turning a Meta insights row into figures.
 *
 * TWO THINGS ABOUT THIS DATA THAT WILL CATCH YOU OUT.
 *
 * Everything is a string. spend, impressions, clicks, action values — all of
 * them arrive quoted, so "1200" + "300" is "1200300" and a sort puts "9" above
 * "1000". Every number here goes through num() before it is used.
 *
 * There is no lead action. Aaronz runs click-to-WhatsApp campaigns, so nobody
 * ever fills in a form: the conversion is a person opening a chat. Meta reports
 * that inside the actions array under
 * onsite_conversion.messaging_conversation_started_7d, and there is no
 * "leads" action_type to be found. Calling it Leads on screen would invite a
 * comparison against the PropSpace lead count that can never reconcile — these
 * conversations do not become CRM leads unless somebody enters them.
 */

export const CONVERSATION_ACTION = 'onsite_conversion.messaging_conversation_started_7d';

/** Meta sends numbers as strings; anything unparseable is 0, not NaN. */
export const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/* --------------------------- what counts --------------------------- */

/**
 * Conversions are read from the actions array. NEVER inferred from the
 * objective.
 *
 * The live account proves why: "Aaronz valuation whatsapp" carries objective
 * OUTCOME_LEADS and converts entirely through WhatsApp, with no lead-form
 * action on it at all. Mapping objective to an expected action produced a
 * confident 0 for a campaign that was working — a false zero, which is worse
 * than a blank, because it looks measured.
 *
 * Only these four count. Everything else in the array is engagement:
 * post_engagement, page_engagement, video_view, post_reaction, link_click,
 * post_interaction_*, and the messaging_user_depth_* series, which counts how
 * chatty a thread got rather than whether one started.
 */
export const CONVERSION_KINDS = [
  {
    key: 'whatsapp',
    label: 'WhatsApp conversations',
    one: 'WhatsApp conversation',
    actions: ['onsite_conversion.messaging_conversation_started_7d'],
    // Distinct action, safe to add up across a campaign's rows.
    combine: (values) => values.reduce((a, b) => a + b, 0),
  },
  {
    key: 'form',
    label: 'form leads',
    one: 'form lead',
    actions: ['lead', 'onsite_conversion.lead_grouped'],
    // lead and lead_grouped describe the SAME submissions at different
    // granularities and usually both appear. Summing them would report double
    // the leads, so the larger is taken rather than the total.
    combine: (values) => Math.max(...values),
  },
  {
    key: 'pixel',
    label: 'pixel leads',
    one: 'pixel lead',
    actions: ['offsite_conversion.fb_pixel_lead'],
    combine: (values) => values.reduce((a, b) => a + b, 0),
  },
];

export const CONVERSION_ACTIONS = new Set(CONVERSION_KINDS.flatMap((k) => k.actions));

/** Every conversion a row actually recorded, as [{ key, label, value }]. */
export function conversionsOf(row) {
  const actions = Array.isArray(row?.actions) ? row.actions : [];
  const out = [];

  for (const kind of CONVERSION_KINDS) {
    const found = kind.actions
      .map((t) => actions.find((a) => a?.action_type === t))
      .filter(Boolean)
      .map((a) => num(a.value));
    if (!found.length) continue;
    const value = kind.combine(found);
    if (value > 0) out.push({ key: kind.key, label: kind.label, one: kind.one, value });
  }

  return out;
}

/** "12 WhatsApp conversations", "1 form lead". */
export const describeConversion = (c) =>
  `${fmtNum(c.value)} ${c.value === 1 ? c.one : c.label}`;

export function parseInsights(rows = []) {
  return rows.map((r) => {
    const spend = num(r.spend);
    const conversions = conversionsOf(r);

    return {
      id: r.campaign_id ?? r.campaign_name ?? Math.random().toString(36),
      campaignId: r.campaign_id ?? null,
      name: r.campaign_name ?? 'Unnamed campaign',
      objective: r.objective ?? null,
      spend,
      impressions: num(r.impressions),
      // inline_link_clicks, not clicks. On the live account clicks reads 58
      // against 21 link clicks for the same campaign — it counts reactions,
      // profile taps and expansions, so as a measure of intent it inflates by
      // nearly three times.
      linkClicks: num(r.inline_link_clicks),
      conversions,
      // Null, not zero. A campaign with spend and none of the four actions has
      // nothing recorded; 0 would claim the metric was measured and came back
      // empty, which is a different and stronger statement.
      totalConversions: conversions.length
        ? conversions.reduce((n, c) => n + c.value, 0)
        : null,
      actions: Array.isArray(r.actions) ? r.actions : [],
      dateStart: r.date_start ?? null,
      dateStop: r.date_stop ?? null,
    };
  });
}

/** Cost for one conversion kind, or null where there were none. */
export const costOf = (spend, value) => (value > 0 ? spend / value : null);

/** One row per creative, for the expansion under a campaign. */
export function parseAds(rows = []) {
  return rows.map((r) => ({
    id: r.ad_id ?? Math.random().toString(36),
    campaignId: r.campaign_id ?? null,
    name: r.ad_name ?? 'Unnamed ad',
    spend: num(r.spend),
    impressions: num(r.impressions),
    linkClicks: num(r.inline_link_clicks),
    conversions: conversionsOf(r),
    actions: Array.isArray(r.actions) ? r.actions : [],
  }));
}

/* ---------------------------- when it was made ---------------------------- */

/**
 * The campaign objects — id, name and created_time. No spend here.
 *
 * created_time is when the campaign was BUILT, which is the date Ads Manager
 * shows in its Created column. It is not necessarily the day delivery started:
 * a campaign made on a Friday and switched on the following Monday reads
 * Friday. The first day it actually delivered would mean a lifetime day-by-day
 * insights pull, which this deliberately does not do.
 */
export function parseCampaignObjects(rows = []) {
  return rows.map((c) => ({
    id: String(c.id),
    name: c.name ?? 'Unnamed campaign',
    createdAt: c.created_time ?? null,
  }));
}

/** created_time by campaign id, for joining onto insights rows. */
export const createdIndex = (objects = []) =>
  new Map(objects.filter((o) => o.createdAt).map((o) => [String(o.id), o.createdAt]));

/**
 * "3 Feb 2026", in Dubai.
 *
 * Meta stamps created_time in the ad account's own timezone and writes the
 * offset without a colon — "2026-02-03T09:12:44+0400" — which is outside what
 * Date is required to parse, so the colon goes back in first. Anything that
 * still will not parse returns null rather than "Invalid Date" on a row.
 */
const CREATED_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Dubai', day: 'numeric', month: 'short', year: 'numeric',
});

export function fmtCreated(iso) {
  if (!iso) return null;
  const d = new Date(String(iso).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isNaN(d.getTime()) ? null : CREATED_FMT.format(d);
}

/* ------------------------------- creatives ------------------------------- */

/**
 * The creative image.
 *
 * WHERE META PUTS IT DEPENDS ON HOW THE AD WAS BUILT, and there are five
 * places, not two. This used to read object_story_spec only, which was right
 * for an account running video and wrong the moment a static image campaign
 * appeared: "SYM-Comm-UK-Statics" delivered 1,439 impressions while the
 * drill-down said "No image on this creative".
 *
 * In descending order of quality:
 *
 *   1  object_story_spec.video_data.image_url   video ads — the still frame
 *   2  object_story_spec.link_data.image_url    link ads with an explicit URL
 *   3  link_data.child_attachments[].image_url  carousels, where the top-level
 *                                               link_data carries no image at all
 *   4  asset_feed_spec.images[].url             Advantage+ and dynamic creative,
 *                                               which do not use object_story_spec
 *   5  image_url                                Graph's own resolution of
 *                                               image_hash on an image creative
 *
 * thumbnail_url is the last resort and is handled separately by `creativeThumb`
 * rather than folded in here, because it is a different KIND of answer: a
 * downscaled crop that is fine as a fallback and wrong as a first choice. The
 * caller decides whether a blurry image beats no image.
 */
export function creativeImage(creative) {
  const oss = creative?.object_story_spec ?? {};

  const carousel = (oss.link_data?.child_attachments ?? [])
    .map((c) => c?.image_url)
    .find(Boolean);

  const feed = (creative?.asset_feed_spec?.images ?? [])
    .map((i) => i?.url ?? i?.permalink_url)
    .find(Boolean);

  return (
    oss.video_data?.image_url ??
    oss.link_data?.image_url ??
    carousel ??
    feed ??
    creative?.image_url ??
    null
  );
}

/**
 * The downscaled fallback, when nothing better exists.
 *
 * Requested at a usable size rather than accepted at Meta's 64x64 default —
 * see fetchAdObjects, which asks for thumbnail_width/height. Still a crop, so
 * it is offered only when creativeImage comes back empty.
 */
export const creativeThumb = (creative) => creative?.thumbnail_url ?? null;

/** The video behind a creative, where there is one. */
export const creativeVideoId = (creative) => {
  const id = creative?.object_story_spec?.video_data?.video_id;
  return id ? String(id) : null;
};

/**
 * Delivery, from effective_status.
 *
 * Never `status`. Every ad in this account reads status=ACTIVE while its
 * effective_status is CAMPAIGN_PAUSED or ADSET_PAUSED — status describes the
 * ad object's own switch, not whether anything is being delivered. Reporting
 * the first would show fifty live ads on an account running none.
 */
export const DELIVERY = {
  ACTIVE: { label: 'Active', live: true },
  PAUSED: { label: 'Paused', live: false },
  CAMPAIGN_PAUSED: { label: 'Campaign paused', live: false },
  ADSET_PAUSED: { label: 'Ad set paused', live: false },
  ARCHIVED: { label: 'Archived', live: false },
  DELETED: { label: 'Deleted', live: false },
  DISAPPROVED: { label: 'Disapproved', live: false },
  PENDING_REVIEW: { label: 'In review', live: false },
  IN_PROCESS: { label: 'In process', live: false },
  WITH_ISSUES: { label: 'With issues', live: false },
};

export const deliveryOf = (effectiveStatus) =>
  DELIVERY[effectiveStatus] ?? { label: effectiveStatus ?? 'Unknown', live: false };

/** The ad objects — creative, headline, delivery. No spend here. */
export function parseAdObjects(rows = []) {
  return rows.map((a) => ({
    id: String(a.id),
    name: a.name ?? 'Unnamed ad',
    campaignId: a.campaign_id ? String(a.campaign_id) : null,
    delivery: deliveryOf(a.effective_status),
    // Every ad in this account is called "New Leads ad", so the headline is
    // what actually distinguishes one from another and leads the row.
    headline: a.creative?.title ?? null,
    body: a.creative?.body ?? null,
    cta: a.creative?.call_to_action_type ?? null,
    image: creativeImage(a.creative),
    thumb: creativeThumb(a.creative),
    videoId: creativeVideoId(a.creative),
  }));
}

/**
 * Spend rows joined to creative on ad id, for one campaign.
 *
 * Driven by the INSIGHTS rows, not the ad objects: an ad with spend but no
 * matching creative record still has to appear, or money disappears from the
 * drill-down. A missing creative costs the image and the headline, nothing
 * else.
 */
export function creativesFor(campaignId, adInsights, adObjects, campaignSpend) {
  const byId = new Map(adObjects.map((o) => [o.id, o]));

  return adInsights
    .filter((a) => a.campaignId && String(a.campaignId) === String(campaignId))
    .map((a) => {
      const o = byId.get(String(a.id));
      return {
        id: a.id,
        name: o?.name ?? a.name,
        headline: o?.headline ?? null,
        body: o?.body ?? null,
        image: o?.image ?? null,
        thumb: o?.thumb ?? null,
        videoId: o?.videoId ?? null,
        cta: o?.cta ?? null,
        delivery: o?.delivery ?? null,
        spend: a.spend,
        impressions: a.impressions,
        linkClicks: a.linkClicks,
        conversions: a.conversions,
        share: campaignSpend > 0 ? a.spend / campaignSpend : null,
      };
    })
    .sort((x, y) => y.spend - x.spend);
}

/**
 * Company totals. Conversions stay separated by kind — a single number adding
 * WhatsApp conversations to form leads would be two different events reported
 * as one, which is exactly what the labels exist to prevent.
 */
export function metaTotals(rows) {
  const byKind = new Map();
  for (const r of rows) {
    for (const c of r.conversions) {
      const hit = byKind.get(c.key);
      byKind.set(c.key, hit
        ? { ...hit, value: hit.value + c.value }
        : { key: c.key, label: c.label, one: c.one, value: c.value });
    }
  }
  return {
    spend: rows.reduce((n, r) => n + r.spend, 0),
    impressions: rows.reduce((n, r) => n + r.impressions, 0),
    linkClicks: rows.reduce((n, r) => n + r.linkClicks, 0),
    conversions: [...byKind.values()],
  };
}

/**
 * Biggest spend first.
 *
 * Not cheapest-per-conversion: with several conversion kinds in one table there
 * is no single cost to rank on, and inventing one would merge WhatsApp
 * conversations with form leads. Money descending is the order someone
 * auditing a bill reads in anyway.
 */
export const bySpend = (rows) => [...rows].sort((a, b) => b.spend - a.spend);

/**
 * Campaign rows against the account total.
 *
 * Account spend is pulled at level=account, so this is a real check: summing
 * the campaigns and comparing to that sum would agree with itself no matter
 * which campaigns were missing, and Meta omits deleted ones from campaign-level
 * reports.
 */
export function reconcile(rows, accountSpend) {
  const parts = rows.reduce((n, r) => n + r.spend, 0);
  const account = accountSpend == null ? null : num(accountSpend);
  const difference = account == null ? null : account - parts;
  return {
    parts, account, difference,
    // Sub-fils differences are floating point, not a real gap.
    ties: difference == null ? null : Math.abs(difference) < 0.01,
  };
}

export const fmtMoney = (n) => (n == null ? '—' : `AED ${Math.round(n).toLocaleString()}`);
export const fmtCost = (n) =>
  n == null ? null : `AED ${n < 100 ? n.toFixed(1) : Math.round(n).toLocaleString()}`;
export const fmtNum = (n) => (n == null ? '—' : Math.round(n).toLocaleString());

/* ------------------------------- VAT ------------------------------- */

/** Meta reports spend excluding VAT; the invoice will carry it. */
export const VAT_RATE = 0.05;
export const withVat = (n) => (n == null ? null : n * (1 + VAT_RATE));
