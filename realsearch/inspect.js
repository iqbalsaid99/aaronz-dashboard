import "dotenv/config";

const TOKEN = process.env.APIFY_TOKEN;
const DATASET = process.argv[2] || process.env.APIFY_DATASET_ID;

if (!TOKEN || !DATASET) {
  console.error("Usage: node inspect.js <datasetId>   (or set APIFY_DATASET_ID in .env)");
  process.exit(1);
}

const res = await fetch(
  `https://api.apify.com/v2/datasets/${DATASET}/items?token=${TOKEN}&limit=1`
);

if (!res.ok) {
  console.error(`${res.status} ${await res.text()}`);
  process.exit(1);
}

const [item] = await res.json();

if (!item) {
  console.log("That dataset is empty.");
  process.exit(0);
}

console.log("\nField paths in the first record\n");

const walk = (obj, prefix = "") => {
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      walk(v, path);
    } else {
      const preview = Array.isArray(v)
        ? `[${v.length} items]`
        : String(v).slice(0, 60);
      console.log(`  ${path.padEnd(34)} ${preview}`);
    }
  }
};

walk(item);
console.log("\nCopy the paths you want into the pick() calls in server.js.\n");
