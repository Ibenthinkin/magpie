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
  // NO source-side price sort, deliberately — the opposite of ebay.ts's _sop=15.
  // Craigslist's `query` matches post body text loosely, so sort=priceasc floats free
  // junk that merely mentions the words: measured live 2026-07-24 on "standing desk",
  // priceasc gave 4/10 relevant in the top ten ("Curb alert!", a shadow box, three
  // duplicate elliptical pedals) where the default relevance sort gave 10/10 real desks.
  // We re-sort by landed cost in rankListings regardless, so sorting at the source can
  // only decide WHICH candidates we spend extraction on — and relevance is what matters
  // there. The max_price ceiling below still bounds the price side.

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

// Verified live 2026-07-24 (philadelphia). The pre-live guess said `li.cl-search-result`;
// the real gallery card is a DIV, and naming the tag matched 0 of 24 cards. Deliberately
// tag-agnostic now — the class is the contract, the element type is craigslist's business.
// `.cl-static-search-result` covers the legacy static fallback craigslist still serves.
const CARD_SELECTOR = '.cl-search-result, .cl-static-search-result';
// `a.main` is the gallery image link, carrying the same permalink as the title anchor —
// kept as a fallback so a card whose title anchor is missing is still usable.
const POST_ANCHOR = 'a.posting-title, a.main, a.cl-app-anchor';

const LOAD_ATTEMPTS = 2;

async function loadResults(page: Page, url: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      // Waiting for the cards merely to be ATTACHED is a trap, measured live 2026-07-24:
      // craigslist ships a pre-hydration skeleton whose cards carry no anchors and no
      // text, `attached` resolves on it at ~200ms, the app then tears the skeleton down
      // (~700ms, zero cards on the page) and mounts the real list at ~1200ms. So the
      // adapter was reading the page a full second before the results existed and
      // failing loud on an empty extract. Wait for what reduceResultsText actually
      // needs instead — a card with a posting link AND rendered text. That is also
      // self-correcting if craigslist retimes its hydration.
      await page.waitForFunction(
        ({ cardSelector, anchorSelector }) =>
          Array.from(document.querySelectorAll(cardSelector)).some(
            (c) =>
              c.querySelector<HTMLAnchorElement>(anchorSelector)?.href && ((c as HTMLElement).innerText ?? '').trim(),
          ),
        { cardSelector: CARD_SELECTOR, anchorSelector: POST_ANCHOR },
        { timeout: 20_000 },
      );
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
          const text = ((li as HTMLElement).innerText ?? '')
            // The gallery's swipe dots render as a run of bare bullets at the head of
            // every card's innerText (14 of them on a live card). They carry no meaning
            // and would be ~24 cards' worth of junk tokens in the extraction prompt.
            .replace(/^[\s•·]+/, '')
            .split(/\n+/)
            .map((line) => line.trim())
            .filter((line) => line && !/^[•·]+$/.test(line))
            .join(' | ');
          return { href: a ? a.href.split('?')[0] : null, text };
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

// Craigslist serves two permalink shapes, and as of the live check on 2026-07-24 the
// gallery emits only the second — the pre-live guess accepted just the first, so every
// extracted row would have been dropped as unusable:
//   legacy: https://<region>.craigslist.org/<area>/<cat>/d/<slug>/<pid>.html
//   modern: https://www.craigslist.org/view/d/<slug>/<token>
// Both are accepted; whichever id matched becomes sourceId. The modern token is stable
// (verified: 24/24 identical across two loads, and the post page's own "post id" matched
// the card's data-pid), which is what watch dedup needs. Foreign hosts and index pages
// still fail the guard — same shape as eBay's /itm/\d{9,}.
const POST_URL_LEGACY = /^https?:\/\/[a-z0-9-]+\.craigslist\.org\/\S*\/(\d{6,})\.html(?:$|[?#])/;
const POST_URL_MODERN = /^https?:\/\/[a-z0-9-]+\.craigslist\.org\/view\/d\/[^/]+\/([A-Za-z0-9]{8,})(?:$|[?#/])/;

/** The craigslist post id in a result URL, or null if it isn't a post permalink at all. */
export function postIdFromUrl(url: string): string | null {
  return url.match(POST_URL_LEGACY)?.[1] ?? url.match(POST_URL_MODERN)?.[1] ?? null;
}

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
      const id = raw.url ? postIdFromUrl(raw.url) : null;
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
