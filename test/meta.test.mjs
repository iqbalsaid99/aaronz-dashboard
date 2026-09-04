import test from 'node:test';
import assert from 'node:assert/strict';
import {
  num, conversionsOf, describeConversion, parseInsights, parseAds, metaTotals,
  bySpend, reconcile, withVat, VAT_RATE, costOf, CONVERSION_ACTIONS,
  CONVERSATION_ACTION, parseCampaignObjects, createdIndex, fmtCreated,
} from '../src/metaParse.js';

/** A realistic row: every metric quoted, exactly as Meta sends it. */
const row = (over = {}) => ({
  campaign_id: '120210000000000001',
  campaign_name: 'Aaronz valuation whatsapp',
  objective: 'OUTCOME_LEADS',
  spend: '157.03',
  impressions: '5216',
  clicks: '58',
  inline_link_clicks: '21',
  actions: [
    { action_type: 'post_engagement', value: '400' },
    { action_type: 'link_click', value: '58' },
    { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '12' },
    { action_type: 'onsite_conversion.messaging_user_depth_2_message_send', value: '9' },
    { action_type: 'video_view', value: '900' },
  ],
  ...over,
});

test('every metric arrives as a string and must be cast', () => {
  assert.equal(typeof row().spend, 'string', 'the fixture must reflect reality');
  const [p] = parseInsights([row()]);
  assert.equal(typeof p.spend, 'number');
  assert.equal(p.spend, 157.03);
});

test('string concatenation is what happens without casting', () => {
  assert.equal(row().spend + '100', '157.03100');
  assert.equal(num(row().spend) + 100, 257.03);
});

/* ---------------------- conversions come from actions ---------------------- */

test('objective is never used to decide conversions', () => {
  // The live campaign: OUTCOME_LEADS, converting entirely through WhatsApp,
  // with no lead action at all. Inferring from the objective produced a
  // confident 0 for a campaign that was working.
  const [p] = parseInsights([row()]);
  assert.equal(p.objective, 'OUTCOME_LEADS');
  assert.ok(!row().actions.some((a) => a.action_type === 'lead'));
  assert.deepEqual(p.conversions.map((c) => c.label), ['WhatsApp conversations']);
  assert.equal(p.conversions[0].value, 12);
});

test('engagement actions are never counted', () => {
  for (const t of ['post_engagement', 'page_engagement', 'video_view', 'post_reaction',
                   'link_click', 'post_interaction_gross',
                   'onsite_conversion.messaging_user_depth_2_message_send',
                   'onsite_conversion.messaging_first_reply']) {
    assert.equal(CONVERSION_ACTIONS.has(t), false, `${t} must not count`);
    assert.deepEqual(conversionsOf({ actions: [{ action_type: t, value: '99' }] }), []);
  }
});

test('the four conversion actions are counted', () => {
  for (const t of ['lead', 'onsite_conversion.lead_grouped',
                   'offsite_conversion.fb_pixel_lead', CONVERSATION_ACTION]) {
    assert.equal(CONVERSION_ACTIONS.has(t), true, t);
  }
});

test('several conversion kinds are shown separately, never merged', () => {
  const [p] = parseInsights([row({ actions: [
    { action_type: CONVERSATION_ACTION, value: '12' },
    { action_type: 'lead', value: '3' },
  ] })]);
  assert.deepEqual(p.conversions.map(describeConversion),
    ['12 WhatsApp conversations', '3 form leads']);
});

test('lead and lead_grouped are the same submissions, so they are not summed', () => {
  const c = conversionsOf({ actions: [
    { action_type: 'lead', value: '3' },
    { action_type: 'onsite_conversion.lead_grouped', value: '3' },
  ] });
  assert.equal(c.length, 1);
  assert.equal(c[0].value, 3, 'the larger, not 6');
});

test('singular labels read correctly', () => {
  const [p] = parseInsights([row({ actions: [{ action_type: 'lead', value: '1' }] })]);
  assert.equal(describeConversion(p.conversions[0]), '1 form lead');
});

test('no qualifying action gives null, not zero', () => {
  const [p] = parseInsights([row({ actions: [{ action_type: 'video_view', value: '900' }] })]);
  assert.deepEqual(p.conversions, []);
  assert.equal(p.totalConversions, null,
    'zero would claim the metric was measured and came back empty');
  assert.equal(p.spend, 157.03, 'the spend is real and must still show');
});

/* ------------------------------ link clicks ------------------------------ */

test('link clicks come from inline_link_clicks, not clicks', () => {
  const [p] = parseInsights([row()]);
  assert.equal(p.linkClicks, 21);
  assert.notEqual(p.linkClicks, 58, 'clicks counts reactions and profile taps too');
});

/* -------------------------------- totals -------------------------------- */

test('totals keep conversion kinds separate', () => {
  const rows = parseInsights([
    row({ campaign_id: 'a', spend: '100', actions: [{ action_type: CONVERSATION_ACTION, value: '10' }] }),
    row({ campaign_id: 'b', spend: '50', actions: [{ action_type: 'lead', value: '4' }] }),
  ]);
  const t = metaTotals(rows);
  assert.equal(t.spend, 150);
  assert.deepEqual(t.conversions.map(describeConversion),
    ['10 WhatsApp conversations', '4 form leads']);
});

test('cost is per kind, never across kinds', () => {
  assert.equal(costOf(120, 10), 12);
  assert.equal(costOf(120, 0), null);
});

test('biggest spend first', () => {
  const rows = parseInsights([
    row({ campaign_id: 'a', campaign_name: 'Small', spend: '50' }),
    row({ campaign_id: 'b', campaign_name: 'Big', spend: '500' }),
  ]);
  assert.deepEqual(bySpend(rows).map((r) => r.name), ['Big', 'Small']);
});

/* ------------------------------- creatives ------------------------------- */

test('ad rows parse with the same conversion rules', () => {
  const [a] = parseAds([{
    ad_id: '1', ad_name: 'Video A', campaign_id: 'c1', spend: '80',
    impressions: '2000', inline_link_clicks: '11',
    actions: [{ action_type: CONVERSATION_ACTION, value: '6' },
              { action_type: 'video_view', value: '700' }],
  }]);
  assert.equal(a.campaignId, 'c1');
  assert.equal(a.linkClicks, 11);
  assert.deepEqual(a.conversions.map(describeConversion), ['6 WhatsApp conversations']);
});

/* ---------------------------- reconciliation ---------------------------- */

test('campaign rows against the account total', () => {
  const rows = parseInsights([row({ spend: '100' }), row({ campaign_id: 'b', spend: '75' })]);
  const r = reconcile(rows, '175');
  assert.equal(r.parts, 175);
  assert.equal(r.ties, true);
});

test('a gap is surfaced, not hidden', () => {
  const r = reconcile(parseInsights([row({ spend: '100' })]), '160');
  assert.equal(r.ties, false);
  assert.equal(r.difference, 60);
});

test('sub-fils floating point is not a gap', () => {
  const rows = parseInsights([
    row({ campaign_id: 'a', spend: '33.33' }),
    row({ campaign_id: 'b', spend: '33.33' }),
    row({ campaign_id: 'c', spend: '33.34' }),
  ]);
  assert.equal(reconcile(rows, '100').ties, true);
});

test('an unreadable account total cannot be checked', () => {
  assert.equal(reconcile(parseInsights([]), null).ties, null);
});

test('VAT is added for the invoice comparison', () => {
  assert.equal(VAT_RATE, 0.05);
  assert.equal(withVat(1000), 1050);
  assert.equal(withVat(null), null);
});

/* ------------------------- creatives and delivery ------------------------- */

const { creativeImage, creativeThumb, deliveryOf, parseAdObjects, creativesFor } =
  await import('../src/metaParse.js');

test('the image never comes from thumbnail_url', () => {
  // thumbnail_url is a downscaled crop. It is a fallback the caller opts into
  // via creativeThumb, never a silent substitute — see the shape tests below,
  // which cover the five places Meta actually puts the image.
  assert.equal(creativeImage({ thumbnail_url: 'https://cdn/thumb.jpg', object_story_spec: {} }), null);
  assert.equal(creativeImage({ object_story_spec: { video_data: { image_url: 'V' } } }), 'V');
  assert.equal(creativeImage({ object_story_spec: { link_data: { image_url: 'L' } } }), 'L');
  assert.equal(creativeImage(undefined), null);
});

test('delivery reads effective_status, not status', () => {
  // Every ad in the live account is status=ACTIVE, effective_status=CAMPAIGN_PAUSED.
  const [ad] = parseAdObjects([{
    id: '1', name: 'New Leads ad', campaign_id: 'c1',
    status: 'ACTIVE', effective_status: 'CAMPAIGN_PAUSED',
    creative: { title: 'Get Your Property Valuation Today' },
  }]);
  assert.equal(ad.delivery.label, 'Campaign paused');
  assert.equal(ad.delivery.live, false, 'status=ACTIVE must not make this read as delivering');
  assert.equal(ad.headline, 'Get Your Property Valuation Today');
});

test('an unknown effective_status is shown, not swallowed', () => {
  assert.equal(deliveryOf('SOME_NEW_STATE').label, 'SOME_NEW_STATE');
  assert.equal(deliveryOf('SOME_NEW_STATE').live, false, 'unknown must not imply delivering');
});

test('creatives join on ad id and carry share of campaign spend', () => {
  const insights = parseAds([
    { ad_id: '1', ad_name: 'New Leads ad', campaign_id: 'c1', spend: '75',
      impressions: '1000', inline_link_clicks: '10',
      actions: [{ action_type: CONVERSATION_ACTION, value: '5' }] },
    { ad_id: '2', ad_name: 'New Leads ad', campaign_id: 'c1', spend: '25',
      impressions: '500', inline_link_clicks: '4', actions: [] },
    { ad_id: '3', ad_name: 'Other campaign', campaign_id: 'c2', spend: '999', actions: [] },
  ]);
  const objects = parseAdObjects([
    { id: '1', name: 'New Leads ad', campaign_id: 'c1', effective_status: 'ADSET_PAUSED',
      creative: { title: 'Valuation', object_story_spec: { video_data: { image_url: 'IMG' } } } },
  ]);

  const out = creativesFor('c1', insights, objects, 100);
  assert.equal(out.length, 2, 'only this campaign');
  assert.deepEqual(out.map((a) => a.id), ['1', '2'], 'biggest spend first');
  assert.equal(out[0].share, 0.75);
  assert.equal(out[0].image, 'IMG');
  assert.equal(out[0].headline, 'Valuation');
  assert.equal(out[0].delivery.label, 'Ad set paused');
});

test('an ad with spend but no creative record still appears', () => {
  // Driven by insights, not by the ad objects: otherwise money vanishes from
  // the drill-down whenever a creative record is missing.
  const insights = parseAds([
    { ad_id: '9', ad_name: 'Orphan', campaign_id: 'c1', spend: '40', actions: [] },
  ]);
  const out = creativesFor('c1', insights, [], 40);
  assert.equal(out.length, 1);
  assert.equal(out[0].spend, 40);
  assert.equal(out[0].image, null, 'renders as a text-only card');
  assert.equal(out[0].headline, null);
});

test('share is null rather than NaN when campaign spend is zero', () => {
  const insights = parseAds([{ ad_id: '1', campaign_id: 'c1', spend: '0', actions: [] }]);
  assert.equal(creativesFor('c1', insights, [], 0)[0].share, null);
});

/* --------------------------- created dates --------------------------- */

test('created_time is read from the campaign object and keyed by id', () => {
  // Quoted, as Meta sends it — a Meta campaign id is 18 digits and would lose
  // its last digit to floating point the moment anything treated it as a
  // number. The String() on both sides of the join is what keeps that true.
  const objects = parseCampaignObjects([
    { id: '120210000000000001', name: 'Aaronz valuation whatsapp', created_time: '2026-02-03T09:12:44+0400' },
  ]);
  assert.equal(objects[0].id, '120210000000000001');
  const index = createdIndex(objects);
  assert.equal(index.get('120210000000000001'), '2026-02-03T09:12:44+0400');
});

test("Meta's offset without a colon still parses", () => {
  // "+0400" is outside what Date is required to accept; the raw string went
  // through as "Invalid Date" before it was normalised.
  assert.equal(fmtCreated('2026-02-03T09:12:44+0400'), '3 Feb 2026');
});

test('a created date is shown as the Dubai day, not the browser day', () => {
  // 22:30 UTC on the 2nd is already the 3rd in Dubai. Anyone in the office
  // reading this row is on Dubai time.
  assert.equal(fmtCreated('2026-02-02T22:30:00+0000'), '3 Feb 2026');
});

test('an unusable created_time gives null rather than "Invalid Date"', () => {
  assert.equal(fmtCreated(null), null);
  assert.equal(fmtCreated(undefined), null);
  assert.equal(fmtCreated('not a date'), null);
});

test('a campaign with no object is simply undated, never a broken row', () => {
  // Deleted campaigns keep their spend on insights but disappear from the
  // campaigns edge, so the lookup must miss quietly.
  const index = createdIndex(parseCampaignObjects([{ id: 'c1', created_time: null }]));
  assert.equal(index.has('c1'), false, 'a null date is not indexed as one');
  assert.equal(fmtCreated(index.get('c-deleted')), null);
});

/* ---------------------------- creative images ---------------------------- */

/**
 * Where Meta puts the creative image depends on how the ad was built, and
 * getting this wrong is invisible: the ad delivers normally and only the
 * dashboard's drill-down looks broken. That is exactly what happened —
 * "SYM-Comm-UK-Statics" ran 1,439 impressions while the panel said "No image
 * on this creative", because the parser knew two shapes and the request asked
 * for the fields of only those two.
 */

test('video ads: the still frame from video_data', () => {
  assert.equal(
    creativeImage({ object_story_spec: { video_data: { image_url: 'https://x/still.jpg' } } }),
    'https://x/still.jpg'
  );
});

test('link ads: image_url from link_data', () => {
  assert.equal(
    creativeImage({ object_story_spec: { link_data: { image_url: 'https://x/link.jpg' } } }),
    'https://x/link.jpg'
  );
});

test('carousels: the first child attachment carrying an image', () => {
  // link_data itself has no image on a carousel; the images hang off the cards.
  assert.equal(
    creativeImage({
      object_story_spec: {
        link_data: { child_attachments: [{}, { image_url: 'https://x/card2.jpg' }] },
      },
    }),
    'https://x/card2.jpg'
  );
});

test('Advantage+ / dynamic creative: asset_feed_spec, which has no object_story_spec', () => {
  assert.equal(
    creativeImage({ asset_feed_spec: { images: [{ url: 'https://x/feed.jpg' }] } }),
    'https://x/feed.jpg'
  );
});

test('static image ads: the top-level image_url Graph resolves from image_hash', () => {
  // The shape that was missing. A creative built in Ads Manager from an
  // uploaded image carries image_hash, and Graph exposes image_url for it.
  assert.equal(creativeImage({ image_url: 'https://x/static.jpg' }), 'https://x/static.jpg');
});

test('the preference order holds when several shapes are present at once', () => {
  const all = {
    object_story_spec: {
      video_data: { image_url: 'https://x/1-still.jpg' },
      link_data: { image_url: 'https://x/2-link.jpg' },
    },
    asset_feed_spec: { images: [{ url: 'https://x/4-feed.jpg' }] },
    image_url: 'https://x/5-static.jpg',
    thumbnail_url: 'https://x/6-thumb.jpg',
  };
  assert.equal(creativeImage(all), 'https://x/1-still.jpg');
  delete all.object_story_spec.video_data;
  assert.equal(creativeImage(all), 'https://x/2-link.jpg');
  delete all.object_story_spec;
  assert.equal(creativeImage(all), 'https://x/4-feed.jpg');
  delete all.asset_feed_spec;
  assert.equal(creativeImage(all), 'https://x/5-static.jpg');
});

test('thumbnail_url is never returned by creativeImage — it is a separate answer', () => {
  // A downscaled crop is a fallback the caller opts into, not a silent
  // substitute for the full-size image.
  assert.equal(creativeImage({ thumbnail_url: 'https://x/thumb.jpg' }), null);
  assert.equal(creativeThumb({ thumbnail_url: 'https://x/thumb.jpg' }), 'https://x/thumb.jpg');
});

test('a creative with nothing at all is null, not a crash', () => {
  for (const c of [null, undefined, {}, { object_story_spec: {} }, { asset_feed_spec: { images: [] } }]) {
    assert.equal(creativeImage(c), null);
    assert.equal(creativeThumb(c ?? {}), null);
  }
});

test('parseAdObjects carries both the image and the thumbnail fallback', () => {
  const [ad] = parseAdObjects([{
    id: '1', name: 'SYM-Comm-UK-Statics', effective_status: 'ACTIVE', campaign_id: 'c1',
    creative: { id: 'cr1', title: 'Grade A offices', image_url: 'https://x/static.jpg',
                thumbnail_url: 'https://x/thumb.jpg' },
  }]);
  assert.equal(ad.image, 'https://x/static.jpg');
  assert.equal(ad.thumb, 'https://x/thumb.jpg');
});
