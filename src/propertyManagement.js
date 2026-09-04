/**
 * Property Management — the people whose leads are shown but not counted.
 *
 * WHY THEY ARE SEPARATED. Property Management handle tenancy and landlord work,
 * not sales enquiries. Their leads arrive in the same CRM and land in the same
 * pipeline, so leaving them in the headline meant "leads received" and every
 * ratio built on it were describing two different jobs at once — and the cold
 * rate in particular, since a PM lead is worked to a different rhythm than a
 * sales lead and looks neglected against a sales yardstick.
 *
 * They are NOT hidden. Every one of their rows stays in the by-agent table with
 * their real figures, greyed and badged, because the work is real and the
 * numbers are theirs. What changes is only that the headline stops treating it
 * as sales activity.
 *
 * MATCHED ON FIRST NAME, WHICH IS A COMPROMISE. Leads carry a first name only
 * ("Mera"), while listings carry the full one ("Mera Paquibot") — see the note
 * in crmAgents.js. So this tab has nothing else to match on. Verified against
 * the live roster on 2026-08-23: each of the four first names below resolves to
 * exactly one person, and no other agent shares one. That is true today and is
 * not guaranteed forever, which is why NAMES lists the full names alongside —
 * a new "Mera" joining would need this revisited, and the full names are what
 * makes that discoverable.
 *
 * The right home for this is crm_agents.agent_type, which already carries the
 * ranking exclusions and is joined on a numeric id rather than a name. Moving
 * it there is a data change plus deleting this file, and should happen when
 * somebody can write to that table.
 */

/**
 * Full name is documentation; `first` is what actually matches on this tab.
 * Both are kept so the list can be checked against a roster by a human.
 */
export const PROPERTY_MANAGEMENT = [
  { first: 'Mera', full: 'Mera Paquibot' },
  { first: 'Kristina', full: 'Kristina Lanto' },
  { first: 'Kamille', full: 'Kamille Ampong' },
  { first: 'Miraflor', full: 'Miraflor Aro' },
];

export const PM_LABEL = 'Property Management';

const FIRST = new Set(PROPERTY_MANAGEMENT.map((p) => p.first.toLowerCase()));
const FULL = new Set(PROPERTY_MANAGEMENT.map((p) => p.full.toLowerCase()));

/**
 * Is this agent name one of them?
 *
 * Accepts either form, because the same set is used on tabs that carry full
 * names. A first-name match is deliberately exact rather than a prefix test:
 * "Mira" must not match "Miraflor", and "Kamille" must not match a future
 * "Kamillea".
 */
export function isPropertyManagement(name) {
  const n = String(name ?? '').trim().toLowerCase();
  if (!n) return false;

  // The full name, as listings carry it, or the bare first name, as leads do.
  // A full name NOT on the list does not match even if its first word is —
  // "Mera Smith" would be a different person, and guessing is how the wrong
  // agent gets greyed out of the headline.
  return FULL.has(n) || FIRST.has(n);
}

/** Split leads into the headline set and the Property Management set. */
export function splitPropertyManagement(leads, agentOf) {
  const headline = [];
  const pm = [];
  for (const l of leads ?? []) {
    (isPropertyManagement(agentOf(l)) ? pm : headline).push(l);
  }
  return { headline, pm };
}
