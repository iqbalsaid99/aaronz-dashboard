import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NORMALISE, PULLS, RANGE_BOUND, withinRange, parseAt, latestDelivery,
  fmtDuration, telHref, timestampFor,
} from '../src/bayutParse.js';

/**
 * Bayut parsing, against rows captured from the live API on 2026-08-21.
 *
 * The rows below are real responses with the personal details replaced. They
 * are kept verbatim in shape — including the several ways this API says
 * "nothing" — because that is what the tests are for: the sample documents the
 * client was written from do not mention that a missing recording is the string
 * "None", or that a call log with no listing carries "" rather than null.
 */

const pullFor = (id) => PULLS.find((p) => p.id === id);
const norm = (id, row) => {
  const p = pullFor(id);
  return NORMALISE[p.kind](row, p);
};

/* --------------------------------- dates -------------------------------- */

test('a bare stamp is read as Dubai time, not UTC and not the machine zone', () => {
  const d = parseAt('2026-08-21 09:01:07');
  // 09:01:07 +04:00 is 05:01:07Z. Read as UTC it would be 09:01:07Z, which is
  // how an overnight lead lands on the wrong day — see time.js.
  assert.equal(d.toISOString(), '2026-08-21T05:01:07.000Z');
});

test('a stamp that already carries a zone keeps it', () => {
  assert.equal(parseAt('2026-08-21T09:01:07Z').toISOString(), '2026-08-21T09:01:07.000Z');
});

test('missing and unparseable stamps are null, not Invalid Date', () => {
  for (const v of [null, undefined, '', '   ', 'not a date']) {
    assert.equal(parseAt(v), null, `expected null for ${JSON.stringify(v)}`);
  }
});

test('timestampFor builds the since parameter at midnight', () => {
  assert.equal(timestampFor('2026-07-22'), '2026-07-22 00:00:00');
});

/* --------------------------------- leads -------------------------------- */

const EMAIL_LEAD = {
  lead_id: 'email|olx|mea|ae|email|7f2838a3',
  source: 'bayut',
  lead_target: 'listing',
  date_time: '2026-08-21 09:01:07',
  listing_details: { listing_id: 17789336, listing_reference: 'ARZ-S-5846', current_type: 'Apartment' },
  inquirer_details: {
    name: 'Anna',
    cell: '+971500000000',
    email: 'anna@example.com',
    message: 'I would like to inquire about your property.',
  },
};

const WHATSAPP_LEAD = {
  lead_id: 'whatsapp|9cd341bc',
  source: 'bayut',
  lead_target: 'listing',
  date_time: '2026-08-21 12:40:51',
  listing_details: { listing_id: 16246398, listing_reference: 'ARZ-R-7794', current_type: 'Apartment' },
  interested_in_tern: null,
  // Note the empty-string email. Real, and it must not render as "".
  inquirer_details: { name: 'B', cell: '+971560000000', email: '', message: 'Hi, I am interested.' },
  delivery_notifications: [
    { status: 'sent', created_at: '2026-08-21 12:40:54' },
    { status: 'delivered', created_at: '2026-08-21 12:40:54' },
  ],
};

test('an email lead normalises to the fields the table shows', () => {
  const l = norm('lead:email:listing', EMAIL_LEAD);
  assert.equal(l.channel, 'email');
  assert.equal(l.target, 'listing');
  assert.equal(l.name, 'Anna');
  assert.equal(l.cell, '+971500000000');
  assert.equal(l.entity.label, 'ARZ-S-5846');
  assert.equal(l.entity.propertyType, 'Apartment');
  assert.equal(l.delivery, null, 'email leads have no delivery notifications');
});

test('an empty-string email becomes null so the cell shows a dash', () => {
  assert.equal(norm('lead:whatsapp:listing', WHATSAPP_LEAD).email, null);
});

test('delivery status is the furthest one reached, not the first in the array', () => {
  // Both notifications share a created_at to the second, which is what the API
  // actually sends — so ordering has to fall back to the progression.
  assert.equal(norm('lead:whatsapp:listing', WHATSAPP_LEAD).delivery.status, 'delivered');
});

test('delivery ordering follows created_at when the array is out of order', () => {
  const d = latestDelivery([
    { status: 'read', created_at: '2026-08-21 12:41:30' },
    { status: 'sent', created_at: '2026-08-21 12:40:54' },
  ]);
  assert.equal(d.status, 'read');
});

test('no delivery notifications at all is null, not a crash', () => {
  for (const v of [undefined, null, [], [{}], 'nonsense']) {
    assert.equal(latestDelivery(v), null);
  }
});

test('a lead with no inquirer_details is a lead with no name, not a throw', () => {
  const l = norm('lead:email:listing', { lead_id: 'x', date_time: '2026-08-21 09:00:00' });
  assert.equal(l.name, null);
  assert.equal(l.cell, null);
  assert.equal(l.entity.label, null);
  // Falls back to the target the pull asked for when the row carries none.
  assert.equal(l.target, 'listing');
});

test('an agent-target lead reads the agent, not the listing', () => {
  const l = norm('lead:email:agent', {
    lead_id: 'email|y',
    date_time: '2026-08-19 14:44:15',
    agent_details: { url: 'https://www.bayut.com/brokers/x.html', name: 'Dennis Manalo', email: 'd@example.com' },
    inquirer_details: { name: 'Sam' },
  });
  assert.equal(l.entity.target, 'agent');
  assert.equal(l.entity.label, 'Dennis Manalo');
});

/* --------------------------------- views -------------------------------- */

const VIEW_ROW = {
  lead_id: 'whatsapp|4ccb601b',
  date_time: '2025-09-30 21:00:14',
  listing_details: { listing_id: 12878382, listing_reference: 'ARZ-R-6222', current_type: 'Apartment' },
  whatsapp_views: 943,
};

test('a view row carries its channel count', () => {
  const v = norm('view:whatsapp:listing', VIEW_ROW);
  assert.equal(v.count, 943);
  assert.equal(v.channel, 'whatsapp');
  assert.equal(v.entity.label, 'ARZ-R-6222');
});

test('the count field is read per channel, and a missing one is 0 not NaN', () => {
  assert.equal(norm('view:sms:agent', { lead_id: 'a', sms_views: 12 }).count, 12);
  assert.equal(norm('view:phone:agent', { lead_id: 'a', phone_views: '7' }).count, 7);
  assert.equal(norm('view:phone:agent', { lead_id: 'a' }).count, 0);
  assert.equal(norm('view:sms:listing', { lead_id: 'a', sms_views: null }).count, 0);
});

test('views are NOT range-bound — the whole reason they are labelled lifetime', () => {
  // Measured: asked for views since yesterday, the API returns rows dated a
  // year earlier, because a view row is a running total and date_time is the
  // most recent one. Range-filtering them would report a confident near-zero.
  assert.equal(RANGE_BOUND.has('view'), false);
  for (const kind of ['lead', 'call', 'story']) {
    assert.equal(RANGE_BOUND.has(kind), true, `${kind} should be range-bound`);
  }
});

/* ------------------------------- call logs ------------------------------ */

const CALL_ROW = {
  call_log_id: 'phone|06af3568',
  listing_reference: '',
  lead_id: 'phone|06af3568',
  date: '2026-08-20',
  time: '19:29:27',
  caller_number: '+971500000000',
  proxy_number: '+97144376916',
  receiver_number: '+971550000000',
  call_status: 'missed',
  call_total_duration: '00:00:40',
  call_connected_duration: '00:00:00',
  call_time: null,
  call_pickup_time: null,
  call_recordingurl: 'None',
  caller_location: null,
  call_type: null,
};

test('a call log joins its split date and time into one stamp', () => {
  const c = norm('call_logs', CALL_ROW);
  assert.equal(c.at.toISOString(), '2026-08-20T15:29:27.000Z');   // 19:29:27 +04:00
});

test('the string "None" is not a recording URL', () => {
  // Left alone this renders as a link to a page called None.
  assert.equal(norm('call_logs', CALL_ROW).recording, null);
});

test('an empty listing_reference is an absence, not a blank cell', () => {
  assert.equal(norm('call_logs', CALL_ROW).reference, null);
});

test('a real recording URL survives', () => {
  const c = norm('call_logs', { ...CALL_ROW, call_recordingurl: 'https://cdn.example.com/r.mp3' });
  assert.equal(c.recording, 'https://cdn.example.com/r.mp3');
});

test('durations arrive pre-formatted and are shown as sent, not guessed at', () => {
  assert.equal(fmtDuration('00:01:24'), '00:01:24');
  assert.equal(fmtDuration(null), '—');
  assert.equal(fmtDuration(''), '—');
  // A plain number is the documented-but-unseen case: read as seconds.
  assert.equal(fmtDuration(45), '45s');
  assert.equal(fmtDuration(95), '1m 35s');
});

/* ------------------------------ story leads ----------------------------- */

test('a story lead reaches through story_details to the project', () => {
  const s = norm('story_leads', {
    lead_id: 'story|1',
    date_time: '2026-08-18 10:00:00',
    inquirer_details: { name: 'Rita', cell: '+971500000000' },
    story_details: {
      story_id: 4412,
      listing_details: {
        listing_reference: 'ARZ-S-1234',
        current_type: 'Villa',
        listing_url: 'https://www.bayut.com/property/details-1.html',
      },
      project_details: {
        project_name_en: 'Tilal Al Ghaf',
        developer_name_en: 'Majid Al Futtaim',
        project_image_path: '/img/p.jpg',
      },
    },
  });
  assert.equal(s.reference, 'ARZ-S-1234');
  assert.equal(s.project, 'Tilal Al Ghaf');
  assert.equal(s.developer, 'Majid Al Futtaim');
  assert.equal(s.url, 'https://www.bayut.com/property/details-1.html');
  assert.equal(s.name, 'Rita');
});

test('a story lead with no story_details is empty, not a throw', () => {
  const s = norm('story_leads', { lead_id: 'story|2', date_time: '2026-08-18 10:00:00' });
  assert.equal(s.project, null);
  assert.equal(s.url, null);
});

/* -------------------------------- windowing ----------------------------- */

const at = (s) => ({ at: parseAt(s) });

test('an end date drops rows past it, in Dubai days', () => {
  const rows = [at('2026-07-21 23:00:00'), at('2026-07-22 00:30:00'), at('2026-08-20 23:59:00'), at('2026-08-21 09:00:00')];
  const kept = withinRange(rows, '2026-07-22', '2026-08-20');
  assert.equal(kept.length, 2);
});

test('with no end date nothing is dropped — timestamp already bounded it', () => {
  const rows = [at('2020-01-01 00:00:00'), at('2026-08-21 09:00:00')];
  assert.equal(withinRange(rows, '2026-07-22', null).length, 2);
});

test('a row with no parseable date is kept, never silently dropped', () => {
  // A missing field must not remove a real lead from the count.
  const kept = withinRange([{ at: null }, at('2026-08-01 12:00:00')], '2026-07-22', '2026-08-20');
  assert.equal(kept.length, 2);
});

/* --------------------------------- misc --------------------------------- */

test('tel: links strip everything that is not dialable', () => {
  assert.equal(telHref('+971 50 (000) 0000'), 'tel:+971500000000');
  assert.equal(telHref(''), null);
  assert.equal(telHref(null), null);
});

test('the pull list is exactly the fourteen valid combinations', () => {
  assert.equal(PULLS.length, 14);
  assert.equal(PULLS.filter((p) => p.kind === 'lead').length, 5);
  assert.equal(PULLS.filter((p) => p.kind === 'view').length, 7);
  // The two that take neither a target nor is_trulead.
  for (const id of ['call_logs', 'story_leads']) {
    const p = pullFor(id);
    assert.equal(p.target, undefined);
    assert.equal(p.is_trulead, undefined);
  }
  // No email view: revealing an email address is not something Bayut counts.
  assert.equal(PULLS.some((p) => p.kind === 'view' && p.type === 'email'), false);
});
