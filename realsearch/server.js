import "dotenv/config";
import express from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8787;
const TOKEN = process.env.APIFY_TOKEN;
const ACTOR_ID = process.env.APIFY_ACTOR_ID;

if (!TOKEN || !ACTOR_ID) {
  console.error("Missing APIFY_TOKEN or APIFY_ACTOR_ID. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const PORTALS = ["bayut.com", "propertyfinder.ae", "dubizzle.com"];

app.post("/api/lookup", async (req, res) => {
  const { url } = req.body ?? {};

  if (typeof url !== "string" || !url.trim()) {
    return res.status(400).json({ error: "Paste a listing URL first." });
  }

  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    return res.status(400).json({ error: "That is not a valid URL. Include https://" });
  }

  if (!PORTALS.some((d) => parsed.hostname.endsWith(d))) {
    return res.status(400).json({
      error: `Unsupported site. Use a link from ${PORTALS.join(", ")}.`,
    });
  }

  // Mirrors the actor input from the Apify console, with the token stripped out.
  const input = {
    propertyUrls: [{ url: parsed.toString() }],
    proxy: {
      useApifyProxy: true,
      apifyProxyGroups: ["RESIDENTIAL"],
      apifyProxyCountry: "AE",
    },
    retrieveContactDetails: false,
    email: "",
  };

  const endpoint =
    `https://api.apify.com/v2/acts/${ACTOR_ID}` +
    `/run-sync-get-dataset-items?token=${TOKEN}&timeout=120`;

  try {
    const apify = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });

    if (!apify.ok) {
      const detail = await apify.text();
      return res.status(apify.status).json({
        error: `Apify returned ${apify.status}.`,
        detail: detail.slice(0, 400),
      });
    }

    const items = await apify.json();

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(404).json({
        error: "The run finished but returned nothing. The listing may be delisted or the page layout changed.",
      });
    }

    res.json({ raw: items[0], normalised: normalise(items[0]) });
  } catch (err) {
    res.status(502).json({ error: "Could not reach Apify.", detail: String(err) });
  }
});

// Actors name their fields differently. Check the first result against your
// actor's own output and add its field names to the arrays below.
function pick(obj, ...keys) {
  for (const k of keys) {
    const v = k.split(".").reduce((o, part) => (o == null ? o : o[part]), obj);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}

function normalise(r) {
  return {
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
    brokerage: pick(r, "agencyName", "agency.name", "brokerage", "company.name"),
    referenceNo: pick(r, "referenceNumber", "reference", "listingReference"),
    listedAt: pick(r, "createdAt", "listedDate", "datePosted", "publishedAt"),
    images: pick(r, "images", "photos", "media.images") ?? [],
    url: pick(r, "url", "link", "sourceUrl"),
  };
}

app.listen(PORT, () => console.log(`API ready on http://localhost:${PORT}`));
