import "dotenv/config";

const TOKEN = process.env.APIFY_TOKEN;
const RUN_ID = process.argv[2] || process.env.APIFY_RUN_ID;

if (!TOKEN) {
  console.error("Set APIFY_TOKEN in .env first.");
  process.exit(1);
}

const api = async (path) => {
  const res = await fetch(`https://api.apify.com/v2/${path}${path.includes("?") ? "&" : "?"}token=${TOKEN}`);
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  return res.json();
};

// 1. The run you already did knows which actor produced it.
if (RUN_ID) {
  try {
    const { data } = await api(`actor-runs/${RUN_ID}`);
    console.log("\nFrom your existing run");
    console.log("  actId          ", data.actId);
    console.log("  status         ", data.status);
    console.log("  defaultDataset ", data.defaultDatasetId);
    console.log("\n  Put this in .env:");
    console.log(`  APIFY_ACTOR_ID=${data.actId}\n`);
  } catch (e) {
    console.error("Could not read that run:", e.message);
  }
}

// 2. Everything on the account, so you can pick by name.
const { data } = await api("actors?limit=100");
console.log("Actors on your account");
for (const a of data.items) {
  console.log(`  ${String(a.id).padEnd(20)} ${a.username}~${a.name}`);
}
console.log("\nEither the raw id or the username~name form works as APIFY_ACTOR_ID.\n");
