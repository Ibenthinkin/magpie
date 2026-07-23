import type { Page } from 'playwright';
import { extractListings } from '../engine/extract';
import { canAnchorRadius, type TargetSpec } from '../engine/target';
import type { NormalizedListing, RawListing, SourceAdapter } from './types';

// Guided Craigslist search: deterministic URL from the target, then reduced page
// text for LLM extraction (LLM extracts, never navigates). SPEC §6.3. Mirrors ebay.ts.
//
// Craigslist has no national search — it's sharded into ~400 regional subdomains, so
// the region subdomain IS the geography and must be configured (CRAIGSLIST_REGION).

export function buildSearchUrl(target: TargetSpec, region: string): string {
  if (!region) {
    throw new Error(
      'craigslist adapter needs a region subdomain (CRAIGSLIST_REGION), e.g. "sfbay" — ' +
        'we never guess a zip into a region.',
    );
  }
  const p = new URLSearchParams();
  p.set('query', target.description);
  p.set('sort', 'priceasc'); // cheapest first, matching eBay's _sop=15

  const max = target.constraints.maxPriceCents;
  if (max != null) p.set('max_price', String(Math.ceil(max / 100))); // CL wants whole dollars

  // Craigslist's condition taxonomy is six levels and doesn't map onto our three-value
  // enum; only "new" (code 10) is unambiguous. Filtering the rest would silently hide
  // real listings, so we leave them as a safe superset — same instinct as eBay snapping
  // a radius UP and the filter keeping ties.
  if (target.constraints.conditions?.[0] === 'new') p.set('condition', '10');

  // Geo narrowing at the source. Unlike eBay's fixed ladder, Craigslist takes an EXACT
  // integer radius, so no snapping. Anchored on a zip only, never a guessed centroid.
  const loc = target.constraints.location;
  if (canAnchorRadius(loc)) {
    p.set('postal', loc!.near!.trim());
    if (loc!.maxMiles != null && loc!.maxMiles > 0) p.set('search_distance', String(Math.ceil(loc!.maxMiles)));
  } else if (loc?.near) {
    console.warn(
      `[craigslist] location "${loc.near}" is not a US zip — searching without a radius. ` +
        'Item locations still reach the ranking step and the cards.',
    );
  }

  return `https://${region}.craigslist.org/search/sss?${p.toString()}`;
}

const MAX_TEXT_CHARS = 16_000; // matches ebay.ts extraction budget

// Selector best-guess for Craigslist's gallery results. LIVE-UNVERIFIED — pinned by the
// fixture, confirmed for real only when a Craigslist hunt runs. Anchored on the card, and
// the posting anchor carries the canonical /<id>.html URL innerText would otherwise drop.
const CARD_SELECTOR = 'li.cl-search-result, li.cl-static-search-result';
const POST_ANCHOR = 'a.posting-title, a.cl-app-anchor';

const LOAD_ATTEMPTS = 2;

async function loadResults(page: Page, url: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector(CARD_SELECTOR, { state: 'attached', timeout: 20_000 });
      return;
    } catch (err) {
      if (attempt >= LOAD_ATTEMPTS) throw err;
      console.warn(`[craigslist] results did not settle (attempt ${attempt}/${LOAD_ATTEMPTS}), retrying: ${url}`);
    }
  }
}

/** Pure DOM → reduced text, one block per linked card: card text + a `URL:` line. */
export async function reduceResultsText(page: Page): Promise<string> {
  const rows = await page.evaluate(
    ({ cardSelector, anchorSelector }) =>
      Array.from(document.querySelectorAll(cardSelector))
        .map((li) => {
          const a = li.querySelector<HTMLAnchorElement>(anchorSelector);
          return {
            href: a ? a.href.split('?')[0] : null,
            text: ((li as HTMLElement).innerText ?? '').trim().replace(/\s*\n+\s*/g, ' | '),
          };
        })
        .filter((row) => row.href && row.text), // cards with no posting link are chrome
    { cardSelector: CARD_SELECTOR, anchorSelector: POST_ANCHOR },
  );

  if (rows.length === 0) {
    throw new Error(`craigslist: no result cards found (${CARD_SELECTOR}) — site drift or interstitial?`);
  }

  const blocks: string[] = [];
  let chars = 0;
  for (const row of rows) {
    const block = `${row.text}\nURL: ${row.href}`;
    if (chars + block.length > MAX_TEXT_CHARS) break;
    blocks.push(block);
    chars += block.length + 2;
  }
  return blocks.join('\n\n');
}

export async function fetchResultsText(page: Page, target: TargetSpec, region: string): Promise<string> {
  const url = buildSearchUrl(target, region);
  console.log(`[craigslist] search ${url}`); // the adapter's whole contract — log it, like eBay
  await loadResults(page, url);
  return reduceResultsText(page);
}

// Craigslist post URL: https://<region>.craigslist.org/<area>/<cat>/d/<slug>/<id>.html
// Require a craigslist.org host and a numeric post id at the tail — reject foreign hosts
// and index/listing pages, same guard shape as eBay's /itm/\d{9,}.
const POST_URL = /^https?:\/\/[a-z0-9-]+\.craigslist\.org\/\S*\/(\d{6,})\.html(?:$|[?#])/;

export function makeCraigslistAdapter(region?: string): SourceAdapter {
  return {
    source: 'craigslist',
    // No login, but Craigslist is scraping-sensitive — gentle from day one (Phase 4).
    rateLimit: { minDelayMs: 15_000, maxPerHour: 20 },

    async search(page: Page, target: TargetSpec): Promise<RawListing[]> {
      const text = await fetchResultsText(page, target, region ?? process.env.CRAIGSLIST_REGION ?? '');
      return extractListings(text, target);
    },

    toListing(raw: RawListing): NormalizedListing | null {
      const id = raw.url?.match(POST_URL)?.[1];
      if (!id || !raw.url) return null; // no verifiable post URL → unusable row
      return {
        source: 'craigslist',
        sourceId: id,
        url: raw.url,
        title: raw.title,
        priceCents: raw.priceCents,
        shippingCents: raw.shippingCents,
        currency: 'USD',
        condition: raw.condition,
        sellerRating: raw.sellerRating ?? null,
        location: raw.location ?? null,
        imageUrl: null,
        rawJson: JSON.stringify(raw),
      };
    },
  };
}

export const craigslistAdapter = makeCraigslistAdapter();
