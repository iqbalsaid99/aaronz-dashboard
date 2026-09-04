/**
 * Normalising a portal listing scrape into something displayable.
 *
 * Every Apify actor names its fields differently, and this one's exact output
 * could not be confirmed — there is no APIFY_TOKEN on this machine yet, so no
 * run has been read. `pick()` therefore tries a spread of plausible names and
 * hides anything it cannot find rather than rendering blank rows.
 *
 * To pin it down properly once the token is in place: run `npm run inspect`
 * inside the realsearch folder. It reads the existing completed dataset (no
 * new credits) and prints every field path in the first record. Add the real
 * names to the arrays below and drop the guesses.
 */

/** First non-empty value among several candidate paths. Supports "a.b.c". */
export function pick(obj, ...keys) {
  for (const k of keys) {
    const v = k.split(".").reduce((o, part) => (o == null ? o : o[part]), obj);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}

/** Anything that looks like a phone number, from wherever it is hiding. */
function phonesOf(r) {
  const found = new Set();
  const candidates = [
    pick(r, "contact.phone", "phone", "phoneNumber", "mobile", "contactPhone"),
    pick(r, "contact.mobile", "agent.phone", "agent.mobile", "owner.phone", "owner.mobile"),
    pick(r, "contactDetails.phone", "contactDetails.mobile", "contacts.phone"),
    pick(r, "whatsapp", "contact.whatsapp", "agent.whatsapp"),
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) found.add(c.trim());
    if (Array.isArray(c)) c.filter(Boolean).forEach((x) => found.add(String(x).trim()));
  }
  return [...found];
}

export function normalise(r) {
  if (!r) return null;
  return {
    // Who to call — the point of this screen.
    contactName: pick(r, "contact.name", "agent.name", "owner.name", "contactName", "agentName"),
    contactPhones: phonesOf(r),
    contactEmail: pick(r, "contact.email", "agent.email", "owner.email", "contactEmail", "email"),
    brokerage: pick(r, "agencyName", "agency.name", "brokerage", "company.name", "agent.agency"),
    isOwner: pick(r, "isOwner", "byOwner", "listedByOwner"),

    // The property itself.
    title: pick(r, "title", "name", "propertyTitle"),
    price: pick(r, "price", "priceValue", "price.value"),
    currency: pick(r, "currency", "price.currency") ?? "AED",
    purpose: pick(r, "purpose", "listingType", "category"),
    type: pick(r, "propertyType", "type", "category.name"),
    beds: pick(r, "bedrooms", "beds", "rooms"),
    baths: pick(r, "bathrooms", "baths"),
    area: pick(r, "area", "size", "builtUpArea", "area.builtUp"),
    areaUnit: pick(r, "areaUnit", "sizeUnit") ?? "sqft",
    community: pick(r, "community", "location", "locationName", "address"),
    tower: pick(r, "building", "tower", "subCommunity"),
    completion: pick(r, "completionStatus", "completion", "projectStatus"),
    handover: pick(r, "handoverDate", "completionDate"),
    developer: pick(r, "developer", "developerName"),
    permitNumber: pick(r, "permitNumber", "trakheesi", "reraPermit", "permit"),
    referenceNo: pick(r, "referenceNumber", "reference", "listingReference"),
    listedAt: pick(r, "createdAt", "listedDate", "datePosted", "publishedAt"),
    images: normaliseImages(pick(r, "images", "photos", "media.images")),
    url: pick(r, "url", "link", "sourceUrl"),
  };
}

function normaliseImages(v) {
  if (!Array.isArray(v)) return [];
  return v
    .map((i) => (typeof i === "string" ? i : i?.url ?? i?.src ?? i?.href))
    .filter(Boolean)
    .slice(0, 8);
}

export const fmtNumber = (n) => {
  const num = Number(String(n).replace(/[^\d.]/g, ""));
  return Number.isFinite(num) ? num.toLocaleString("en-AE") : n;
};

export const portalOf = (url) => {
  try {
    const h = new URL(url).hostname;
    if (h.endsWith("bayut.com")) return "Bayut";
    if (h.endsWith("propertyfinder.ae")) return "Property Finder";
    if (h.endsWith("dubizzle.com")) return "Dubizzle";
  } catch { /* not a URL */ }
  return null;
};

/** Digits only, for tel: and wa.me links. */
export const dialable = (phone) => String(phone ?? "").replace(/[^\d+]/g, "");
