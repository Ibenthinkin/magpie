import type { Page } from 'playwright';
import { ChallengeDetectedError } from '../browser/pacing';
import { extractListings } from '../engine/extract';
import { canAnchorRadius, type TargetSpec } from '../engine/target';
import type { NormalizedListing, RawListing, SourceAdapter } from './types';

// Guided eBay search: deterministic URL from the target, then grab reduced page
// text for LLM extraction (LLM is used for extraction, not navigation). SPEC §6.3.

// eBay condition filter codes (LH_ItemCondition).
const CONDITION_CODE: Record<string, string> = {
  new: '1000',
  refurbished: '2500',
  used: '3000',
};

// `_sadis` only honours this fixed ladder of radii. We snap UP to the next rung
// so the result set is a superset of what was asked — narrowing tighter than
// requested would hide real matches, and the listing's own location is shown on
// every card for the reader to judge.
const EBAY_RADII = [10, 25, 50, 100, 200, 500, 1000];

function snapRadius(miles: number): number {
  return EBAY_RADII.find((r) => r >= miles) ?? EBAY_RADII[EBAY_RADII.length - 1]!;
}

export function buildSearchUrl(target: TargetSpec): string {
  const p = new URLSearchParams();
  p.set('_nkw', target.description);
  p.set('_sop', '15'); // sort: price + shipping, lowest first

  const max = target.constraints.maxPriceCents;
  if (max != null) p.set('_udhi', String(Math.ceil(max / 100))); // eBay wants dollars

  const cond = target.constraints.conditions?.[0];
  const code = cond ? CONDITION_CODE[cond] : undefined;
  if (code) p.set('LH_ItemCondition', code);

  // Geo narrowing happens HERE, at the source, where eBay computes real
  // distances server-side. See applyConstraints for why we don't filter on
  // distance ourselves afterwards.
  const loc = target.constraints.location;
  if (canAnchorRadius(loc)) {
    p.set('_stpos', loc!.near!.trim());
    if (loc!.maxMiles != null && loc!.maxMiles > 0) {
      p.set('_sadis', String(snapRadius(loc!.maxMiles)));
      // _stpos + _sadis alone are a silent no-op — they only PRE-FILL eBay's
      // location option (verified live 2026-07-23: identical result set with and
      // without them). eBay's only radius filter is local-pickup: LH_LPickup=1
      // is what actually narrows to items within _sadis of _stpos, and it makes
      // eBay render per-item "N mi from <zip>" distances. LH_PrefLoc/_fspt are
      // the supporting facet params eBay's own UI emits alongside it. Honoring
      // "within N miles" therefore means local-pickup only — no ship-only listings
      // (a deliberate reading of "near me"; see log 07-23-26).
      p.set('LH_LPickup', '1');
      p.set('LH_PrefLoc', '99');
      p.set('_fspt', '1');
    }
  } else if (loc?.near) {
    console.warn(
      `[ebay] location "${loc.near}" is not a US zip — searching without a radius. ` +
        'Item locations still reach the ranking step and the cards.',
    );
  }

  return `https://www.ebay.com/sch/i.html?${p.toString()}`;
}

const MAX_TEXT_CHARS = 16_000; // rough token budget for the extraction prompt

// eBay serves two different result DOMs: `li.s-card` when signed out, `li.su-grid__item`
// when signed in. The persistent profile is normally signed in, but the signed-out layout
// still shows up (expired session, challenge bounce), so match either. Anchoring on the
// card rather than the enclosing list keeps one selector working across both.
const CARD_SELECTOR = 'li.su-grid__item, li.s-card';

// A real item link. The signed-in page ships a template anchor pointing at the placeholder
// `ebay.com/itm/123456`, so require a full-length item id rather than taking the first match.
const ITEM_HREF = /\/itm\/\d{9,}/;

// Row chrome eBay bakes into innerText. "derosnopS" is "Sponsored" reversed —
// the badge is rendered with a CSS direction flip to defeat scrapers.
const NOISE = [/\s*\|\s*Opens in a new window or tab/g, /\s*\|\s*derosnopS\s*/g];

// Section headings that mark the END of the genuinely-filtered results. eBay stacks
// the in-radius local-pickup results first, then pads the page with "Results matching
// fewer words" (looser keyword matches) and "<N> items found from eBay international
// sellers" — whose cards are OUT of the requested radius (seen up to 4,885 mi from the
// zip in the live smoke). Everything from the first such heading onward is dropped so
// only the truly-narrowed results reach extraction. Verified against a real page
// 2026-07-23; pinned by tests/fixtures/ebay.
const RESULT_BOUNDARIES = [/matching fewer words/i, /items? found from ebay international sellers/i];

const LOAD_ATTEMPTS = 2;

/**
 * Navigate until result cards are attached. eBay keeps navigating past domcontentloaded —
 * it may bounce through `/splashui/challenge` (bot check) before landing on results — so a
 * load that never settles is retried once before failing. Cards are never "visible" to
 * Playwright, so wait on attachment, not visibility.
 */
async function loadResults(page: Page, url: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector(CARD_SELECTOR, { state: 'attached', timeout: 20_000 });
      return;
    } catch (err) {
      if (page.url().includes('/splashui/challenge')) {
        throw new ChallengeDetectedError(`eBay served a bot challenge at ${page.url()} — back off and retry later.`);
      }
      if (attempt >= LOAD_ATTEMPTS) throw err;
      console.warn(`[ebay] results did not settle (attempt ${attempt}/${LOAD_ATTEMPTS}), retrying: ${url}`);
    }
  }
}

/**
 * Pure DOM → reduced results text, one block per card: the card's visible text
 * followed by its canonical `URL: https://www.ebay.com/itm/<id>`. Out-of-radius
 * padding sections (see RESULT_BOUNDARIES) are dropped.
 *
 * innerText alone drops hrefs, which left every extracted listing unlinkable — the
 * URL has to be pulled from the anchor and reunited with the row text here.
 */
export async function reduceResultsText(page: Page): Promise<string> {
  const rows = await page.evaluate(
    ({ cardSelector, itemHrefSource, boundarySources }) => {
      const itemHref = new RegExp(itemHrefSource);
      const boundaries = boundarySources.map((s) => new RegExp(s, 'i'));

      // Find the first padding-section heading. Guard on short text so we match the
      // heading itself, not an ancestor container whose textContent swallows the page.
      let boundary: Element | null = null;
      for (const el of Array.from(document.querySelectorAll('h1, h2, h3, h4, span, div'))) {
        const t = (el.textContent ?? '').trim();
        if (t.length > 120) continue;
        if (boundaries.some((re) => re.test(t))) {
          boundary = el;
          break;
        }
      }
      // Keep only cards that precede the boundary in document order (all of them if
      // there is no padding section on the page).
      const inRadius = (li: Element) =>
        !boundary || Boolean(boundary.compareDocumentPosition(li) & Node.DOCUMENT_POSITION_PRECEDING);

      return Array.from(document.querySelectorAll(cardSelector))
        .filter(inRadius)
        .map((li) => {
          const anchor = Array.from(li.querySelectorAll<HTMLAnchorElement>('a[href*="/itm/"]')).find((a) =>
            itemHref.test(a.href),
          );
          return {
            // Strip tracking/query params down to the canonical item URL.
            href: anchor ? anchor.href.split('?')[0] : null,
            text: ((li as HTMLElement).innerText ?? '').trim().replace(/\s*\n+\s*/g, ' | '),
          };
        })
        // Cards without an item link are carousels and promos, not listings.
        .filter((row) => row.href && row.text);
    },
    { cardSelector: CARD_SELECTOR, itemHrefSource: ITEM_HREF.source, boundarySources: RESULT_BOUNDARIES.map((r) => r.source) },
  );

  // Fail loud on site drift rather than silently extracting from a page that has no
  // results on it (an interstitial, a captcha, a renamed card class).
  if (rows.length === 0) {
    throw new Error(`eBay: no result cards found (${CARD_SELECTOR}) — site drift or interstitial?`);
  }

  // Budget whole rows, never a partial one: a row truncated mid-URL yields a
  // plausible-looking listing pointing at the wrong item.
  const blocks: string[] = [];
  let chars = 0;
  for (const row of rows) {
    let text = row.text;
    for (const pattern of NOISE) text = text.replace(pattern, '');
    const block = `${text}\nURL: ${row.href}`;
    if (chars + block.length > MAX_TEXT_CHARS) break;
    blocks.push(block);
    chars += block.length + 2;
  }

  return blocks.join('\n\n');
}

/** Navigate to the deterministic search URL, then reduce the results DOM to text. */
export async function fetchResultsText(page: Page, target: TargetSpec): Promise<string> {
  const url = buildSearchUrl(target);
  // The exact URL is the adapter's whole contract with eBay — log it so a
  // filter that didn't apply (or a param eBay stopped honouring) is visible
  // without a debugger.
  console.log(`[ebay] search ${url}`);
  await loadResults(page, url);
  return reduceResultsText(page);
}

// The canonical URL fetchResultsText emits: tracking params already stripped.
const CANONICAL_ITEM = /^https:\/\/www\.ebay\.com\/itm\/(\d{9,})$/;

export const ebayAdapter: SourceAdapter = {
  source: 'ebay',
  // Conservative: eBay is the crown-jewel logged-in session, don't hammer it.
  rateLimit: { minDelayMs: 20_000, maxPerHour: 30 },

  async search(page: Page, target: TargetSpec): Promise<RawListing[]> {
    const text = await fetchResultsText(page, target);
    return extractListings(text, target);
  },

  toListing(raw: RawListing): NormalizedListing | null {
    const id = raw.url?.match(CANONICAL_ITEM)?.[1];
    if (!id || !raw.url) return null; // no verifiable item URL → unusable row
    return {
      source: 'ebay',
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
