import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isPropertyManagement, splitPropertyManagement, PROPERTY_MANAGEMENT, PM_LABEL,
} from '../src/propertyManagement.js';

/**
 * Property Management: shown in full, excluded from the headline.
 *
 * The risk this guards is a near-miss on a first name. The Insights tab has
 * only first names to match on — leads carry "Mera" where listings carry "Mera
 * Paquibot" — and the live roster contains Maricar, Marimar and Michelle
 * alongside Mera and Miraflor. Greying the wrong person out of the headline
 * would be quiet and wrong.
 */

test('the four are matched on the first name the leads feed carries', () => {
  for (const n of ['Mera', 'Kristina', 'Kamille', 'Miraflor']) {
    assert.equal(isPropertyManagement(n), true, n);
  }
});

test('the full names listings carry match too', () => {
  for (const { full } of PROPERTY_MANAGEMENT) {
    assert.equal(isPropertyManagement(full), true, full);
  }
});

test('near-miss names on the live roster are NOT matched', () => {
  // All real agents on the account as of 2026-08-23.
  for (const n of ['Maricar', 'Maricar Padilla', 'Marimar Pacursa', 'Michelle Tabuñar',
                   'May Clares', 'Myka Eisma', 'Dennis', 'Kashif']) {
    assert.equal(isPropertyManagement(n), false, n);
  }
});

test('a prefix is not a match in either direction', () => {
  assert.equal(isPropertyManagement('Mira'), false, 'shorter must not match Miraflor');
  assert.equal(isPropertyManagement('Miraflora'), false, 'longer must not match Miraflor');
  assert.equal(isPropertyManagement('Kamil'), false);
});

test('a different person sharing a first name is not matched', () => {
  // The compromise this list documents: "Mera" alone is theirs today, but a
  // full name that is not on the list is somebody else.
  assert.equal(isPropertyManagement('Mera Smith'), false);
  assert.equal(isPropertyManagement('Kristina Novak'), false);
});

test('matching ignores case and surrounding whitespace', () => {
  assert.equal(isPropertyManagement('  mera  '), true);
  assert.equal(isPropertyManagement('KAMILLE'), true);
});

test('empty and missing names are not matched', () => {
  for (const n of ['', '   ', null, undefined]) assert.equal(isPropertyManagement(n), false);
});

/* ------------------------------- the split -------------------------------- */

const lead = (name) => ({ agents: [{ name }] });
const agentOf = (l) => l.agents?.[0]?.name ?? 'Unassigned';

test('the split keeps every lead — none are dropped', () => {
  const leads = ['Dennis', 'Mera', 'Lyba', 'Kamille', 'Unassigned'].map(lead);
  const { headline, pm } = splitPropertyManagement(leads, agentOf);
  assert.equal(headline.length + pm.length, leads.length);
  assert.equal(pm.length, 2);
  assert.equal(headline.length, 3);
});

test('the headline set contains no Property Management lead', () => {
  const leads = ['Dennis', 'Mera', 'Kristina', 'Miraflor', 'Sofia'].map(lead);
  const { headline } = splitPropertyManagement(leads, agentOf);
  assert.equal(headline.every((l) => !isPropertyManagement(agentOf(l))), true);
  assert.equal(headline.length, 2);
});

test('with nobody from PM the headline is untouched', () => {
  const leads = ['Dennis', 'Lyba'].map(lead);
  const { headline, pm } = splitPropertyManagement(leads, agentOf);
  assert.equal(headline.length, 2);
  assert.equal(pm.length, 0);
});

test('the label is fixed in one place', () => {
  assert.equal(PM_LABEL, 'Property Management');
  assert.equal(PROPERTY_MANAGEMENT.length, 4);
});
