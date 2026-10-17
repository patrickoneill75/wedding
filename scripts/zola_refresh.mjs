// Copies the Zola wedding website onto the home page. Run by GitHub Actions
// (.github/workflows/zola-refresh.yml): Zola refuses requests from Cloudflare's servers,
// so GitHub does the fetching and cleaning, and the Worker only stores the result.
//
//   SITE_URL             the site, e.g. https://wedding.example.workers.dev
//   ZOLA_INGEST_SECRET   the same value the Worker has
//
// Run: node scripts/zola_refresh.mjs
import { buildSite } from "../src/site.js";

const site = String(process.env.SITE_URL || "").replace(/\/+$/, "");
const secret = process.env.ZOLA_INGEST_SECRET || "";
if (!site || !secret) {
  console.error("Set SITE_URL and ZOLA_INGEST_SECRET (see SETUP.md).");
  process.exit(1);
}
const headers = { authorization: `Bearer ${secret}` };

async function call(path, init = {}) {
  const response = await fetch(`${site}${path}`, { ...init, headers: { ...headers, ...(init.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${body.error || "no details"}`);
  return body;
}
const send = (payload) => call("/api/site/ingest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });

const config = await call("/api/site/config");
let built;
try {
  built = await buildSite({ zolaUrl: config.zola_url, rsvpColor: config.rsvp_button_color });
} catch (error) {
  // Tell the site, so Settings shows why, then fail the run.
  await send({ error: error.message }).catch(() => {});
  console.error(`Couldn't copy the Zola site: ${error.message}`);
  process.exit(1);
}
const { status } = await send(built);
console.log(`Copied ${built.pages.length} page(s): ${built.pages.map((p) => p.path).join(", ")}`);
console.log(status.changed ? "Something changed on Zola; the website is updated." : "Nothing changed on Zola since the last copy.");
for (const w of built.warnings) console.log(`::warning::${w}`);
