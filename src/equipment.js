/**
 * Equipment register + book-out state.
 *
 * Source data is transcribed from Asset_Register.xlsx (27 items). To refresh
 * it, re-run the extraction against a new copy of the sheet and overwrite
 * src/assets-register.json — the columns are Asset Code, Serial Number, Asset
 * Name, Asset Type, Notes.
 *
 * TWO THINGS THIS CANNOT DO, both because the dashboard has no server:
 *
 *   1. There is no login, so no account to read a name from. Instead the user
 *      picks themselves once from the PropSpace agent roster and that choice is
 *      remembered. It identifies whoever is at this browser, not an
 *      authenticated user — nothing stops someone selecting another name.
 *
 *   2. Bookings live in localStorage, which is per-browser and per-device. A
 *      camera booked out on one laptop is still "In Office" on everyone
 *      else's. That makes this a personal record, not a shared register. It
 *      needs a backend before it can be trusted by more than one person.
 */

import register from "./assets-register.json";
import { apiFetch } from "./apiFetch.js";

const BOOKINGS_KEY = "aaronz.equipment.bookings.v1";
const USER_KEY = "aaronz.equipment.user.v1";

/** Asset codes are not unique (ARZ-CE-62 covers a Macbook, its charger and its
 *  cable) and two items have none at all, so identity is code + name. */
export const assetId = (a) => `${a.code ?? "NOCODE"}|${a.name}`;

export const ASSETS = register.map((a) => ({ ...a, id: assetId(a) }));

export const STATUS = { IN: "In Office", OUT: "Booked out" };

/* ------------------------------ Dubai time ------------------------------ */

const DUBAI = "Asia/Dubai";

/**
 * Always Dubai time regardless of where the browser is. Stored as an ISO
 * instant; only the display is localised, so a laptop set to another timezone
 * still records and shows the same moment.
 */
export function dubaiStamp(iso = new Date().toISOString()) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: DUBAI,
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(iso)).replace(",", "");
}

export function dubaiRelative(iso) {
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/* ------------------------------ storage ------------------------------ */

const read = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;   // private mode, quota, or corrupted value
  }
};

const write = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch { return false; }
};

/** { [assetId]: { by, details, at } } — presence means booked out. */
export const loadBookings = () => read(BOOKINGS_KEY, {});
export const saveBookings = (b) => write(BOOKINGS_KEY, b);

export const loadUser = () => read(USER_KEY, null);
export const saveUser = (name) => write(USER_KEY, name);

export function bookOut(bookings, id, { by, details }) {
  return { ...bookings, [id]: { by, details, at: new Date().toISOString() } };
}

export function bookIn(bookings, id) {
  const next = { ...bookings };
  delete next[id];
  return next;
}

export const statusOfAsset = (bookings, id) => (bookings[id] ? STATUS.OUT : STATUS.IN);

/** Roster for the "who are you" picker. Falls back to a free-text entry if the
 *  API is unreachable, so the tab still works offline. */
export async function fetchRoster() {
  const res = await apiFetch("/ps/options/agents");
  if (!res.ok) throw new Error(`roster ${res.status}`);
  const json = await res.json();
  const list = Array.isArray(json) ? json : json.data ?? [];
  return list
    .map((a) => a.name)
    .filter(Boolean)
    .filter((n) => !/aaronz and co|^marketing|^training/i.test(n))
    .sort();
}
