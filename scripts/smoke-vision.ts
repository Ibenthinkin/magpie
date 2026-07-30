// Manual smoke check for the vision fallback path (Task 5): navigates to a
// real page, screenshots it, and runs runVisionFallback against a REAL vision
// call (no LLM mock — unlike tests/bun/e2e/vision-fallback-e2e.test.ts, which
// only proves the browser-level plumbing). Not part of the automated suite:
// Ben runs this by hand to review vision extraction quality and cost before
// setting MAGPIE_VISION_FALLBACK_ENABLED=true for real. Requires
// MAGPIE_VISION_MODEL (or the MAGPIE_MODEL fallback) to be a real, working
// multimodal model — per-call cost/usage is printed automatically by
// src/engine/llm.ts's genObject wrapper, not reinvented here.
import { closeContext, getContext } from '../src/browser/session';
import { tokenTotals } from '../src/engine/llm';
import type { TargetSpec } from '../src/engine/target';
import { runVisionFallback } from '../src/engine/visionFallback';

const url = process.argv[2] || 'https://www.ebay.com/sch/i.html?_nkw=logitech+mx+master+3s+wireless+mouse';
const description = process.argv.slice(3).join(' ') || 'logitech mx master 3s wireless mouse';

const target: TargetSpec = { description, constraints: {} };

const context = await getContext();
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(url, { waitUntil: 'domcontentloaded' });

const listings = await runVisionFallback(page, 'smoke-vision', target);

console.log(`\nVision-extracted ${listings.length} listings from ${url}:\n`);
for (const l of listings) {
  const ship = l.shippingCents != null ? ` +$${(l.shippingCents / 100).toFixed(2)} ship` : '';
  console.log(`- $${(l.priceCents / 100).toFixed(2)}${ship} | ${l.condition ?? '?'} | ${l.title}`);
  console.log(`    ${l.url ?? '(no url)'}`);
}

console.log('\nRun token totals:', tokenTotals());
await closeContext();
