// Throwaway end-to-end spike: query → TargetSpec → eBay search → reduced page
// text → extracted structured listings. One real browser session + LLM calls.
import { getContext, closeContext } from '../src/browser/session';
import { parseTarget } from '../src/engine/target';
import { buildSearchUrl, fetchResultsText } from '../src/sources/ebay';
import { extractListings } from '../src/engine/extract';
import { tokenTotals } from '../src/engine/llm';

const query = process.argv.slice(2).join(' ') || 'logitech mx master 3s wireless mouse';

const target = await parseTarget(query);
console.log('Target:', JSON.stringify(target.constraints), '→', JSON.stringify(target.description));
console.log('URL:   ', buildSearchUrl(target));

const context = await getContext();
const page = context.pages()[0] ?? (await context.newPage());
const text = await fetchResultsText(page, target);
console.log(`Grabbed ${text.length} chars of results text\n`);

const listings = await extractListings(text, target);
console.log(`\nTop extracted listings:`);
for (const l of listings.slice(0, 10)) {
  const ship = l.shippingCents != null ? ` +$${(l.shippingCents / 100).toFixed(2)} ship` : '';
  console.log(`- $${(l.priceCents / 100).toFixed(2)}${ship} | ${l.condition ?? '?'} | ${l.title}`);
}

console.log('\nTokens:', tokenTotals());
await closeContext();
