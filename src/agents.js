/**
 * Agent directory — photos, full names, job titles.
 *
 * None of this is on the lead payload. A lead's `agents[0]` carries only
 * { id, name, email, mobile, whatsapp }, and /options/agents is the same five
 * fields. The photo lives on the LISTING agent object, which additionally has
 * `photo_url`, `photo_url_original` and `job_title`.
 *
 * So the directory is built from live listings and joined to leads on agent
 * id. Two things that makes possible:
 *
 *   1. Photos. 19 of the 23 agents appearing on leads in the last 30 days
 *      have one; the rest fall back to initials.
 *   2. Full names. Leads carry first names only — "Lyba", "Dennis" — while
 *      listings carry "Lyba Waqar", "Dennis Manalo". Same id, fuller name.
 *
 * Use `photo_url` (130x130, ~5KB). `photo_url_original` returns 403.
 */

import { fetchLiveListings } from "./listings.js";

let cache = null;

/** Map of agent id -> { id, name, photo, jobTitle }. Fetched once per session. */
export async function fetchAgentDirectory() {
  if (cache) return cache;
  const dir = new Map();
  try {
    for (const l of await fetchLiveListings({})) {
      for (const a of [l.agent, l.marketing_agent]) {
        if (!a?.id) continue;
        const existing = dir.get(a.id);
        // Prefer whichever record actually carries a photo.
        if (!existing || (!existing.photo && a.photo_url)) {
          dir.set(a.id, {
            id: a.id,
            name: a.name ?? existing?.name,
            photo: a.photo_url ?? existing?.photo ?? null,
            jobTitle: a.job_title ?? existing?.jobTitle ?? null,
          });
        }
      }
    }
  } catch {
    // Leave the directory empty — every consumer falls back to initials.
  }
  cache = dir;
  return dir;
}

/**
 * Resolve the agent display info for each lead, keyed by the *lead's* agent
 * name — which is what the rest of the dashboard groups on. Returns
 * Map<leadAgentName, { photo, fullName, jobTitle }>.
 */
export function agentLookupFromLeads(leads, directory) {
  const out = new Map();
  for (const lead of leads) {
    const a = (lead.agents ?? [])[0];
    if (!a?.name || out.has(a.name)) continue;
    const d = a.id ? directory.get(a.id) : null;
    out.set(a.name, {
      photo: d?.photo ?? null,
      // Only upgrade to the fuller name — never replace with something shorter.
      fullName: d?.name && d.name.length > a.name.length ? d.name : a.name,
      jobTitle: d?.jobTitle ?? null,
    });
  }
  return out;
}

/**
 * Per-agent crop adjustment for the avatar circle.
 *
 * `object-cover` centres the crop, which works for most of the CRM headshots
 * but cuts the face on ones where the subject sits high in the frame. The
 * value is a CSS object-position: the Y percentage is which part of the SOURCE
 * image lands in the middle of the circle, so a LOWER number pulls the picture
 * down and brings the head into view.
 *
 * Keys are matched case-insensitively against any part of the agent's name, so
 * "May" and "May Clares" both hit the same entry.
 */
const PHOTO_FOCUS = [
  // Leads carry first names only ("May", "Billie"); listings carry the full
  // name. Match either, since the directory join can miss for an agent with no
  // live listing.
  [/^may\b|clares/i, "50% 22%"],
  [/^billie\b|holcroft/i, "50% 22%"],
];

export function photoFocus(name) {
  const hit = PHOTO_FOCUS.find(([re]) => re.test(name ?? ""));
  return hit ? hit[1] : "50% 50%";
}

export function initialsOf(name) {
  return String(name ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase() || "?";
}
