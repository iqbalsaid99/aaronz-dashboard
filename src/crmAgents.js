import { supabase } from './lib/supabase.js';
import { agentOf, isCold, isStatusOnly, hoursToFirstTouch, median } from './propspace.js';

/**
 * crm_agents — who belongs in the broker ranking, and what everyone else is.
 *
 * The CRM assigns leads to more people than the word "broker" covers:
 * coordinators, marketing, admin, house accounts. Ranking them against
 * salespeople on worked-rate compares things that are not alike, but dropping
 * their leads outright would make the table stop adding up to the headline
 * count. So the split is presentational: every lead still counts towards the
 * totals and the KPI cards, and only the per-agent table narrows to the people
 * a broker ranking is actually about. The remainder is then shown as one
 * reconciliation row so the column still sums to the total.
 *
 * ABSENCE MEANS BROKER. An agent id with no row here is ranked. The table is a
 * list of corrections, not a roster, so a new joiner who has not been
 * classified yet appears in the ranking rather than silently vanishing from it
 * — the safer direction to fail, because a missing broker is much harder to
 * notice than an unexpected one.
 *
 * Joined on the numeric agent id, never the name: leads carry first names only
 * ("Dennis") while listings carry the full name ("Dennis Manalo"), and with 26
 * brokers on the roster a first-name match risks classifying the wrong person.
 */

/** Column names accepted for the agent id, most specific first. */
const ID_KEYS = ['agent_id', 'crm_agent_id', 'propspace_agent_id', 'id'];

const firstKey = (row, keys) => keys.find((k) => row[k] !== undefined && row[k] !== null);

/**
 * Map of agent id -> { inRanking, type }.
 *
 * Throws rather than resolving empty. An empty map is indistinguishable from
 * "everybody is a broker", which would put admin and house accounts back into
 * the ranking while looking perfectly normal.
 */
export async function fetchCrmAgents() {
  const { data, error } = await supabase.from('crm_agents').select('*');

  if (error) throw new Error(`crm_agents: ${error.message}`);

  const rows = data ?? [];
  const map = new Map();

  for (const row of rows) {
    const idKey = firstKey(row, ID_KEYS);
    if (!idKey) continue;
    map.set(String(row[idKey]), {
      // Only an explicit false demotes someone. A null or missing flag on an
      // otherwise-present row is not a decision, and absence means broker.
      inRanking: row.in_broker_ranking !== false,
      type: row.agent_type ?? null,
    });
  }

  if (rows.length && !map.size) {
    throw new Error(
      `crm_agents returned ${rows.length} row(s) but none carry a recognised agent ` +
        `id column. Saw: ${Object.keys(rows[0]).join(', ')}. ` +
        `Expected one of ${ID_KEYS.join(', ')}.`
    );
  }

  return map;
}

/** Everyone is ranked until crm_agents says otherwise. */
export function isRankedLead(lead, crmAgents) {
  if (!crmAgents) return true;
  const id = lead.agents?.[0]?.id;
  if (id == null) return true;
  return crmAgents.get(String(id))?.inRanking ?? true;
}

/**
 * Same rule for listings. The Brokers roster is the union of leads and
 * listings, so filtering one without the other leaves an unranked agent on the
 * roster carrying a listing count and no leads.
 */
export function isRankedListing(listing, crmAgents) {
  if (!crmAgents) return true;
  const id = listing.agent?.id ?? listing.marketing_agent?.id;
  if (id == null) return true;
  return crmAgents.get(String(id))?.inRanking ?? true;
}

export const agentTypeOfLead = (lead, crmAgents) => {
  const id = lead.agents?.[0]?.id;
  return id == null ? null : crmAgents?.get(String(id))?.type ?? null;
};

/**
 * Aggregate the un-ranked leads into one row shaped like a summarise() row, so
 * the reconciliation line can reuse the table's own cells.
 *
 * Labelled by the agent_type values present. Several types collapse into one
 * row on purpose — the point of the line is that the column adds up, not that
 * it breaks the remainder down. Types are listed so the label says what is in
 * there rather than a shrug like "Other".
 */
export function reconciliationRow(leads, crmAgents) {
  if (!leads.length) return null;

  let cold = 0;
  let statusOnly = 0;
  let noted = 0;
  const touchTimes = [];

  for (const lead of leads) {
    if (isCold(lead)) cold++;
    else if (isStatusOnly(lead)) statusOnly++;
    else {
      noted++;
      touchTimes.push(hoursToFirstTouch(lead));
    }
  }

  const types = [...new Set(leads.map((l) => agentTypeOfLead(l, crmAgents)).filter(Boolean))].sort();
  const agents = new Set(leads.map(agentOf)).size;

  return {
    name: types.length ? types.join(' · ') : 'Not in broker ranking',
    types,
    agents,
    total: leads.length,
    cold,
    statusOnly,
    noted,
    median: median(touchTimes),
    rate: leads.length ? (statusOnly + noted) / leads.length : 0,
  };
}
