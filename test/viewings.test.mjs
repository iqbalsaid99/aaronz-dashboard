import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unlinkSync } from 'node:fs';

/**
 * Viewings.
 *
 * There is no viewings endpoint on this key, so the figure is inferred from two
 * independent sources: what the broker wrote in the notes, and where the broker
 * put the lead. It used to read the notes alone, which lost 23 of the 57 leads
 * that were sitting at a viewing sub-status over a seven-week live sample —
 * brokers who moved the status and wrote nothing, or wrote "Set for next week",
 * which names no viewing and never could be matched.
 *
 * These pin both halves and, as much as anything, the precedence between them.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

// brokers.js imports billings.json, which Node will not load without an import
// attribute, and propspace.js reads import.meta.env. Both are Vite's job in the
// app, so the module is bundled here and tested exactly as it ships.
const esbuild = (await import('esbuild')).default ?? (await import('esbuild'));
const bundle = join(here, '.viewings-under-test.mjs');
await esbuild.build({
  entryPoints: [join(root, 'src', 'brokers.js')],
  bundle: true, format: 'esm', platform: 'node', outfile: bundle, logLevel: 'error',
  loader: { '.json': 'json' },
  define: { 'import.meta.env': '{"VITE_SUPABASE_URL":"http://x","VITE_SUPABASE_ANON_KEY":"x"}' },
});
const { viewingEvidence, statusViewingTier, buildRoster, summariseViewings } = await import(bundle);
process.on('exit', () => { try { unlinkSync(bundle); } catch {} });

/**
 * A lead as /leads actually returns it. The status is nested —
 * { status: "Open", sub_status: "Viewing arranged" } — and `status` at the top
 * level is only Open/Closed, too coarse to say anything. Getting this shape
 * wrong is how a status check silently reads "Not Specified" for every lead.
 */
const lead = (subStatus, ...noteTexts) => ({
  id: 1,
  status: { status: 'Open', sub_status: subStatus },
  notes: noteTexts.map((notes, i) => ({
    notes, user_name: 'Dennis', date: `0${i + 1}-08-2026 10:00`,
  })),
});

const tierOf = (l) => viewingEvidence(l).tier;

/* ------------------------- the status as evidence ------------------------- */

test('a viewing sub-status counts even when nobody wrote a note', () => {
  // Six leads in the live sample looked exactly like this and were counted as
  // nothing at all.
  assert.equal(tierOf(lead('Viewing arranged')), 'booked');
  assert.equal(tierOf(lead('Viewing Done')), 'done');
});

test('a note that names no viewing does not stop the status counting', () => {
  // Verbatim from the live data — the whole note, on a "Viewing arranged" lead.
  assert.equal(tierOf(lead('Viewing arranged', 'Set for next week')), 'booked');
  assert.equal(tierOf(lead('Viewing arranged', 'Waiting for confirmat')), 'booked');
  assert.equal(tierOf(lead('Viewing Done', 'ASKED TO CHECK MORE OPTIONS')), 'done');
});

test('"Viewing Done" outranks "Viewing arranged"', () => {
  assert.equal(statusViewingTier(lead('Viewing Done')), 'done');
  assert.equal(statusViewingTier(lead('Viewing arranged')), 'booked');
});

test('an unknown status beginning "Viewing" is treated as booked, not dropped', () => {
  // The taxonomy is editable in the CRM. A new "Viewing rescheduled" must not
  // silently stop counting.
  assert.equal(statusViewingTier(lead('Viewing rescheduled')), 'booked');
});

test('no other status is a viewing', () => {
  for (const s of ['In progress', 'Offer Made', 'Not yet contacted', 'Successful',
                   'Unsuccessful', 'Look-see', 'Interested to Meet', 'Not Specified']) {
    assert.equal(statusViewingTier(lead(s)), null, s);
    assert.equal(tierOf(lead(s)), null, s);
  }
});

/* ----------------------------- precedence ----------------------------- */

test('a note saying it happened outranks a status saying it is only arranged', () => {
  assert.equal(tierOf(lead('Viewing arranged', 'did a viewing yesterday')), 'done');
});

test('the status promotes a lead the notes could only call vague', () => {
  // Live lead 20595310: the word appears, the sentence commits to nothing, but
  // the broker had moved it to "Viewing arranged".
  const vague = 'he initially said he can move anytime on viewing he said he can\'t move in before 1st Sep';
  assert.equal(tierOf(lead('In progress', vague)), 'mentioned');
  assert.equal(tierOf(lead('Viewing arranged', vague)), 'booked');
});

test('a cancellation on a lead that has left the viewing statuses stays discussed-only', () => {
  assert.equal(tierOf(lead('Unsuccessful', 'client cancelled the viewing')), 'intent');
});

/* ------------------------------ evidence ------------------------------ */

test('a lead counted on its status alone still shows why', () => {
  // Otherwise the profile lists a viewing with nothing at all beneath it.
  const { evidence } = viewingEvidence(lead('Viewing arranged'));
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].kind, 'status');
  assert.match(evidence[0].text, /Viewing arranged/);
});

test('the status is listed alongside the notes that agree with it', () => {
  const { evidence } = viewingEvidence(lead('Viewing arranged', 'viewing booked for Tuesday'));
  assert.equal(evidence.length, 2);
  assert.equal(evidence[0].kind, 'status', 'the status leads');
  assert.equal(evidence[1].kind, 'note');
});

test('every counted lead carries at least one piece of evidence', () => {
  for (const l of [
    lead('Viewing arranged'), lead('Viewing Done'),
    lead('Viewing arranged', 'Set for next week'),
    lead('In progress', 'did a viewing'), lead('In progress', 'viewing scheduled tomorrow'),
  ]) {
    const { tier, evidence } = viewingEvidence(l);
    assert.ok(tier, 'should count');
    assert.ok(evidence.length, `${tier} counted with nothing to show`);
  }
});

/* ------------------------ the notes still work ------------------------ */

test('the prose tiers are unchanged', () => {
  assert.equal(tierOf(lead('In progress', 'viewing is done')), 'done');
  assert.equal(tierOf(lead('In progress', 'showed him the unit')), 'done');
  assert.equal(tierOf(lead('In progress', 'viewing arranged for Sunday')), 'booked');
  assert.equal(tierOf(lead('In progress', 'wants to view')), 'intent');
  assert.equal(tierOf(lead('In progress', 'refuse to view')), 'intent');
});

test('a sea view is a vista, not a viewing', () => {
  assert.equal(tierOf(lead('In progress', 'looking for a unit with a sea view')), null);
  assert.equal(tierOf(lead('In progress', 'wants pool view, budget 90k')), null);
});

test('the CRM viewing module still wins outright', () => {
  const l = lead('Viewing arranged');
  l.notes = [{
    notes: 'New system note: Dennis has a viewing Scheduled with Hendrien Hodson, ' +
      'Lead ref: ARZ-L-46150, at 2026-07-27 16:15:48, feedback: Did viewing',
    user_name: 'System', date: '27-07-2026 16:15',
  }];
  const { tier, evidence } = viewingEvidence(l);
  assert.equal(tier, 'confirmed');
  assert.equal(evidence[0].kind, 'system');
  assert.equal(evidence[0].client, 'Hendrien Hodson');
});

/* ------------------------------- dating ------------------------------- */

/**
 * A viewing is dated on itself, not on when the lead arrived. Getting this
 * wrong is what made a broker's viewings vanish: they book against leads they
 * have been working for weeks, so filtering on lead arrival answers a different
 * question. Over 30 days of the live book it moved the count from 39 to 51.
 */

const withUpdated = (l, when) => ({ ...l, last_updated: when });

test('a CRM appointment time wins over everything else', () => {
  const l = withUpdated(lead('Viewing arranged'), '09-08-2026 09:00');
  l.notes = [{
    notes: 'New system note: Dennis has a viewing Scheduled with A B, ' +
      'Lead ref: ARZ-L-1, at 2026-07-27 16:15:48, feedback: Did viewing',
    user_name: 'System', date: '01-08-2026 10:00',
  }];
  const { at, dateFrom } = viewingEvidence(l);
  assert.equal(dateFrom, 'appointment');
  assert.equal(at.toISOString().slice(0, 10), '2026-07-27');
});

test('otherwise the note that evidences it dates it', () => {
  const l = withUpdated(lead('In progress', 'viewing done'), '09-08-2026 09:00');
  const { at, dateFrom } = viewingEvidence(l);
  assert.equal(dateFrom, 'note');
  assert.equal(at.toISOString().slice(0, 10), '2026-08-01');
});

test('the most recent supporting note dates it, not the first', () => {
  const l = lead('In progress', 'viewing done', 'viewing done again');
  assert.equal(viewingEvidence(l).at.toISOString().slice(0, 10), '2026-08-02');
});

test('a status-only viewing falls back to last_updated, and says so', () => {
  const { at, dateFrom } = viewingEvidence(withUpdated(lead('Viewing arranged'), '09-08-2026 09:00'));
  assert.equal(dateFrom, 'last-updated');
  assert.equal(at.toISOString().slice(0, 10), '2026-08-09');
});

test('a viewing that cannot be dated is not silently given today', () => {
  // Otherwise every undateable viewing piles into whatever range is on screen.
  const { at, dateFrom } = viewingEvidence(lead('Viewing arranged'));
  assert.equal(at, null);
  assert.equal(dateFrom, null);
});

test('a lead with no viewing gets no date', () => {
  assert.equal(viewingEvidence(lead('In progress', 'sea view')).at, null);
});

/* --------------------- the wider pool on the roster --------------------- */

const agented = (l) => ({ ...l, agents: [{ id: 7, name: 'Dennis' }] });

test('a viewing on an older lead reaches the broker it belongs to', () => {
  const arrived = agented({ ...lead('In progress'), id: 1, created_at: '2026-08-08T10:00:00Z' });
  // Arrived in May, viewing booked in August — the case that used to vanish.
  const older = agented(withUpdated(
    { ...lead('Viewing arranged'), id: 2, created_at: '2026-05-01T10:00:00Z' }, '08-08-2026 12:00'));

  const narrow = buildRoster({ leads: [arrived], listings: [] });
  assert.equal(narrow[0].viewingsReal, 0, 'the old behaviour misses it');

  const wide = buildRoster({
    leads: [arrived], listings: [], viewingLeads: [arrived, older],
    viewingInRange: (at) => at >= new Date('2026-08-01') && at <= new Date('2026-08-31'),
  });
  assert.equal(wide[0].viewingsReal, 1);
  assert.equal(wide[0].viewings[0].lead.id, 2);
});

test('a viewing outside the range is dropped even though its lead was pulled', () => {
  const arrived = agented({ ...lead('In progress'), id: 1, created_at: '2026-08-08T10:00:00Z' });
  const old = agented(withUpdated(
    { ...lead('Viewing arranged'), id: 2, created_at: '2026-05-01T10:00:00Z' }, '02-05-2026 12:00'));
  const r = buildRoster({
    leads: [arrived], listings: [], viewingLeads: [arrived, old],
    viewingInRange: (at) => at >= new Date('2026-08-01') && at <= new Date('2026-08-31'),
  });
  assert.equal(r[0].viewingsReal, 0, 'widening the pull must not widen the range');
});

test('the wider pool does not add leads, only viewings', () => {
  const arrived = agented({ ...lead('In progress'), id: 1, created_at: '2026-08-08T10:00:00Z' });
  const older = agented(withUpdated(
    { ...lead('Viewing arranged'), id: 2, created_at: '2026-05-01T10:00:00Z' }, '08-08-2026 12:00'));
  const r = buildRoster({
    leads: [arrived], listings: [], viewingLeads: [arrived, older],
    viewingInRange: () => true,
  });
  assert.equal(r[0].total, 1, 'lead count is still the selected range');
});

test('the wider pool never mints a roster row on its own', () => {
  // A broker who has since left must not reappear with zero of everything.
  // directory: [] isolates the pool — the CRM user list is the ONE source
  // allowed to add a row for somebody with nothing assigned.
  const gone = { ...lead('Viewing arranged'), id: 9, agents: [{ id: 99, name: 'Departed' }] };
  const r = buildRoster({
    leads: [], listings: [], viewingLeads: [gone], viewingInRange: () => true, directory: [],
  });
  assert.equal(r.length, 0);
});

/* ------------------------- the CRM user list ------------------------- */

test('a broker with no leads and no listings still gets a row', () => {
  // The reason this exists: PropSpace has no agent directory on this key, so
  // before the list a new joiner was indistinguishable from somebody who was
  // never on the system.
  const r = buildRoster({
    leads: [], listings: [],
    directory: [{ name: 'Harry Jones', email: 'harry.j@aaronz.co', jobTitle: 'Property Advisor' }],
  });
  assert.equal(r.length, 1);
  assert.equal(r[0].name, 'Harry Jones');
  assert.equal(r[0].total, 0, 'and reads as zero, not as missing');
  assert.equal(r[0].onCrm, true);
});

test('the directory joins on email rather than minting a duplicate', () => {
  // Leads carry a first name only. Matching on that against a 45-person
  // directory is how one broker's leads end up under another broker's name.
  const l = agented({ ...lead('Viewing arranged'), id: 1, created_at: '2026-08-08T10:00:00Z' });
  l.agents = [{ id: 7, name: 'Dennis', email: 'dennis.m@aaronz.co' }];
  const r = buildRoster({
    leads: [l], listings: [],
    directory: [{ name: 'Dennis Manalo', email: 'DENNIS.M@aaronz.co', jobTitle: 'Sales Manager' }],
  });
  assert.equal(r.length, 1, 'one person, one row');
  assert.equal(r[0].total, 1, 'the lead stayed with them');
  assert.equal(r[0].name, 'Dennis Manalo', 'and the full name wins over the first name');
  assert.equal(r[0].jobTitle, 'Sales Manager');
});

test('someone carrying leads but absent from the list reads as off the CRM', () => {
  // They have left. The leads are real and must stay counted, but the row
  // should not look like an active broker doing nothing.
  const l = agented({ ...lead('In progress'), id: 1, created_at: '2026-08-08T10:00:00Z' });
  const r = buildRoster({ leads: [l], listings: [], directory: [] });
  assert.equal(r[0].onCrm, false);
  assert.equal(r[0].total, 1);
});

test('without the wider pool the roster behaves exactly as before', () => {
  const l = agented({ ...lead('Viewing arranged'), id: 1, created_at: '2026-08-08T10:00:00Z' });
  assert.equal(buildRoster({ leads: [l], listings: [] })[0].viewingsReal, 1);
});

test('viewings are listed newest first', () => {
  const mk = (id, when) => agented(withUpdated(
    { ...lead('Viewing arranged'), id, created_at: '2026-08-01T10:00:00Z' }, when));
  const r = buildRoster({
    leads: [mk(1, '03-08-2026 10:00'), mk(2, '08-08-2026 10:00'), mk(3, '05-08-2026 10:00')],
    listings: [],
  });
  assert.deepEqual(r[0].viewings.map((v) => v.lead.id), [2, 3, 1]);
});

/* --------------------- counted once, never twice --------------------- */

test('a lead with BOTH a sub-status and a matching note counts once', () => {
  // The explicit requirement. Belt and braces: the tier, the roster count, and
  // the number of rows in the list all have to agree.
  const l = agented({ ...lead('Viewing arranged', 'viewing scheduled for Tuesday'),
    id: 1, created_at: '2026-08-08T10:00:00Z' });
  const r = buildRoster({ leads: [l], listings: [] });
  assert.equal(r[0].viewingsReal, 1);
  assert.equal(r[0].viewings.length, 1);
  assert.equal(r[0].tierCounts.booked, 1);
  assert.equal(r[0].tierCounts.done + r[0].tierCounts.confirmed, 0);
});

test('a done note plus an arranged status counts once, at the higher tier', () => {
  const l = agented({ ...lead('Viewing arranged', 'did a viewing yesterday'),
    id: 1, created_at: '2026-08-08T10:00:00Z' });
  const r = buildRoster({ leads: [l], listings: [] });
  assert.equal(r[0].viewingsReal, 1);
  assert.equal(r[0].tierCounts.done, 1);
  assert.equal(r[0].tierCounts.booked, 0);
});

test('several supporting notes on one lead are still one viewing', () => {
  const l = agented({ ...lead('Viewing arranged', 'viewing booked', 'viewing scheduled'),
    id: 1, created_at: '2026-08-08T10:00:00Z' });
  assert.equal(buildRoster({ leads: [l], listings: [] })[0].viewingsReal, 1);
});

/* ------------------ the two figures, and the caveat ------------------ */

test('the all-time pass applies no date filter', () => {
  const leads = [
    withUpdated({ ...lead('Viewing arranged'), id: 1 }, '01-01-2026 10:00'),
    withUpdated({ ...lead('Viewing arranged'), id: 2 }, '01-08-2026 10:00'),
  ];
  assert.equal(summariseViewings(leads).real, 2, 'no filter means no filter');
  assert.equal(
    summariseViewings(leads, (at) => at >= new Date('2026-07-01')).real, 1,
    'and the windowed pass still filters'
  );
});

test('the approximated count is exactly the viewings resting on last_updated', () => {
  const leads = [
    withUpdated({ ...lead('Viewing arranged'), id: 1 }, '01-08-2026 10:00'),   // status only
    withUpdated({ ...lead('Viewing arranged'), id: 2 }, '01-08-2026 10:00'),   // status only
    withUpdated({ ...lead('In progress', 'did a viewing'), id: 3 }, '01-08-2026 10:00'), // note
  ];
  const r = summariseViewings(leads);
  assert.equal(r.real, 3);
  assert.equal(r.approximated, 2, 'the note-dated one is not approximate');
});

test('discussed-only and unclear never count as approximated', () => {
  // They are not viewings, so they must not inflate the caveat either.
  const leads = [withUpdated({ ...lead('In progress', 'wants to view'), id: 1 }, '01-08-2026 10:00')];
  const r = summariseViewings(leads);
  assert.equal(r.real, 0);
  assert.equal(r.approximated, 0);
});

test('the roster exposes the approximated count for the card to state', () => {
  const l = agented(withUpdated(
    { ...lead('Viewing arranged'), id: 1, created_at: '2026-08-08T10:00:00Z' }, '09-08-2026 10:00'));
  const r = buildRoster({ leads: [l], listings: [] });
  assert.equal(r[0].viewingsReal, 1);
  assert.equal(r[0].viewingsApprox, 1);
});
