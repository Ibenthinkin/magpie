// Throwaway end-to-end spike through ranking: query → TargetSpec → eBay search →
// extract → landed-cost sort + LLM verdicts. One browser session + LLM calls.
import { getContext, closeContext } from '../src/browser/session';
import { parseTarget } from '../src/engine/target';
import { fetchResultsText } from '../src/sources/ebay';
import { extractListings } from '../src/engine/extract';
import { rankListings } from '../src/engine/rank';
import { tokenTotals } from '../src/engine/llm';

const query = process.argv.slice(2).join(' ') || 'logitech mx master 3s wireless mouse';

const t0 = Date.now();
const target = await parseTarget(query);

const context = await getContext();
const page = context.pages()[0] ?? (await context.newPage());
const text = await fetchResultsText(page, target);
const listings = await extractListings(text, target);
const ranked = await rankListings(listings, target);
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

console.log(`\nTarget: ${target.description}`);
console.log(`Ranked top ${ranked.length} of ${listings.length} extracted:\n`);
for (const l of ranked) {
  console.log(`$${(l.landedCents / 100).toFixed(2)} landed | ${l.condition ?? '?'} | ${l.title}`);
  console.log(`    → ${l.verdict}`);
}
console.log(`\nElapsed: ${elapsed}s | Tokens:`, tokenTotals());
await closeContext();
