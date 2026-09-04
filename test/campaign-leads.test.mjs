import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unlinkSync } from 'node:fs';

/**
 * Campaign leads.
 *
 * The join is on a human-typed ad name pulled out of prose, and the score
 * decides whether a broker rings somebody. Both deserve pinning, and the
 * fixtures here are the real shapes seen in this account on 29 Aug 2026.
 */
const here = dirname(fileURLToPath(import.meta.url));
const esbuild = (await import('esbuild')).default ?? (await import('esbuild'));
const bundle = join(here, '.campaign-leads-under-test.mjs');
await esbuild.build({
  entryPoints: [join(here, '..', 'src', 'campaignLeads.js')],
  bundle: true, format: 'esm', platform: 'node', outfile: bundle, logLevel: 'error',
  loader: { '.json': 'json' },
  define: { 'import.meta.env': '{"VITE_SUPABASE_URL":"https://x.supabase.co","VITE_SUPABASE_ANON_KEY":"x"}' },
});
const {
  isMetaLead, adTagOf, formAnswersOf, authenticity, displayName,
  leadsForCampaign, unmatchedMetaLeads, summariseCampaignLeads,
} = await import(bundle);
process.on('exit', () => { try { unlinkSync(bundle); } catch {} });

const NOTE =
  'Hi, I found your property on Facebook. Please contact me. Thank you.<br /><br />' +
  'Additional Data: investment budget? - aed_2.8m_–_5m, timeline? - within_3_months ' +
  '(Ad Set: UK-Broad-30to65-Manual) (Ad: SYM-Comm-UK-Statics)';

const lead = ({ id = 1, first = 'Matthew White', email = 'matwhite75@outlook.com',
                mobile = '7770772078', note = NOTE, source = 'Facebook',
                sub = 'Not yet contacted', agent = 'Henna', notes = [] } = {}) => ({
  id, source, reference: 'ARZ-L-1', created_at: '2026-08-20T10:00:00.000Z',
  status: { status: 'Open', sub_status: sub },
  agents: [{ id: 9, name: agent }],
  // The CRM writes last_name as "<first> undefined" on these.
  contact: { first_name: first, last_name: `${first} undefined`, email, mobile },
  notes: [{ user_name: 'Auto Import', notes: note, date: '20-08-2026 10:00' }, ...notes],
});

test('a Meta lead is recognised by source or by its own note', () => {
  assert.equal(isMetaLead(lead()), true);
  assert.equal(isMetaLead(lead({ source: 'Bayut.com' })), true, 'the note still says Facebook');
  assert.equal(isMetaLead(lead({ source: 'Bayut.com', note: 'Auto imported from Bayut.com' })), false);
});

test('the ad and ad set come out of the prose', () => {
  assert.deepEqual(adTagOf(lead()), { ad: 'SYM-Comm-UK-Statics', adSet: 'UK-Broad-30to65-Manual' });
  assert.deepEqual(adTagOf(lead({ note: 'no tags here' })), { ad: null, adSet: null });
});

test('the lead-form answers survive their underscores', () => {
  assert.deepEqual(formAnswersOf(lead()), [
    { q: 'investment budget', a: 'aed 2.8m – 5m' },
    { q: 'timeline', a: 'within 3 months' },
  ]);
});

test('a free-text answer containing commas is not split on them', () => {
  const note = NOTE.replace('timeline? - within_3_months',
    'what are you looking for? - a villa, a view, and parking');
  const answers = formAnswersOf(lead({ note }));
  assert.equal(answers.at(-1).a, 'a villa, a view, and parking');
});

test('last_name is ignored — the CRM fills it with the first name plus "undefined"', () => {
  assert.equal(displayName(lead({ first: 'Dean Carlin' })), 'Dean Carlin');
});

test('the junk this account actually received scores as junk', () => {
  for (const first of ['1 billion dollars into my mouth right now.',
                       'G g. G g g g. Gg g g. G g g g g g g g gg.',
                       '+447427276507']) {
    const a = authenticity(lead({ first, email: 'dieofaids@gmail.com' }));
    assert.equal(a.band, 'junk', `${first} should be junk, scored ${a.score}`);
    assert.ok(a.bad.length, 'and it says why');
  }
});

test('a name of short words is not gibberish', () => {
  // The first cut flagged tokens of two characters or fewer, which reads a
  // great many Korean, Chinese and Vietnamese names as fake.
  const a = authenticity(lead({ first: 'Ji su shy', email: 'Ji.su1980@yahoo.com' }));
  assert.notEqual(a.band, 'junk');
  assert.ok(!a.bad.some((r) => /gibberish|single letters/.test(r)));
});

test('a matching email lifts the score, a mismatched one lowers it', () => {
  const match = authenticity(lead({ first: 'Matthew White', email: 'matwhite75@outlook.com' }));
  const miss  = authenticity(lead({ first: 'Carla Futai', email: 'keishahumba@haren.uk' }));
  assert.ok(match.score > miss.score);
  assert.equal(match.band, 'real');
  assert.ok(match.good.includes('email matches the name'));
});

test('a disposable inbox is a strong signal', () => {
  const a = authenticity(lead({ first: 'Real Person', email: 'real.person@mailinator.com' }));
  assert.ok(a.bad.includes('disposable email domain'));
  assert.ok(a.score < 60);
});

test('a missing or impossible number is called out', () => {
  assert.ok(authenticity(lead({ mobile: '' })).bad.includes('no number given'));
  assert.ok(authenticity(lead({ mobile: '1111111111' })).bad.includes('number is one repeated digit'));
});

test('leads join to a campaign through the ad name, loosely', () => {
  const ads = [{ name: 'sym comm uk statics', campaignId: 77 }];   // spacing differs in Ads Manager
  const rows = leadsForCampaign([lead(), lead({ id: 2 })], '77', ads);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].status, 'Not yet contacted');
  assert.equal(rows[0].agent, 'Henna');
});

test('a lead whose ad Meta no longer returns is reported, not dropped', () => {
  const orphan = lead({ id: 3, note: NOTE.replace('SYM-Comm-UK-Statics', 'SYM-Deleted-Ad') });
  const ads = [{ name: 'SYM-Comm-UK-Statics', campaignId: 77 }];
  assert.equal(leadsForCampaign([orphan], '77', ads).length, 0);
  assert.equal(unmatchedMetaLeads([orphan], ads).length, 1);
});

test('the summary counts what the CRM has done, not what Meta charged for', () => {
  const worked = lead({ id: 4, sub: 'Called no reply', agent: 'Kashif',
    notes: [{ user_name: 'Kashif', notes: 'rang, no answer', date: '21-08-2026 09:00' }] });
  const s = summariseCampaignLeads(
    leadsForCampaign([lead(), worked], '77', [{ name: 'SYM-Comm-UK-Statics', campaignId: 77 }]));
  assert.equal(s.total, 2);
  assert.equal(s.untouched, 1, 'an Auto Import note is not somebody working the lead');
  assert.equal(s.worked, 1);
  assert.deepEqual(s.agents.map((a) => a.key).sort(), ['Henna', 'Kashif']);
});
