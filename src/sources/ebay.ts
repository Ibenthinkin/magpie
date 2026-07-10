import type { Page } from 'playwright';
import type { TargetSpec } from '../engine/target';

// Guided eBay search: deterministic URL from the target, then grab reduced page
// text for LLM extraction (LLM is used for extraction, not navigation). SPEC §6.3.

// eBay condition filter codes (LH_ItemCondition).
const CONDITION_CODE: Record<string, string> = {
  new: '1000',
  refurbished: '2500',
  used: '3000',
};

export function buildSearchUrl(target: TargetSpec): string {
  const p = new URLSearchParams();
  p.set('_nkw', target.description);
  p.set('_sop', '15'); // sort: price + shipping, lowest first

  const max = target.constraints.maxPriceCents;
  if (max != null) p.set('_udhi', String(Math.ceil(max / 100))); // eBay wants dollars

  const cond = target.constraints.conditions?.[0];
  const code = cond ? CONDITION_CODE[cond] : undefined;
  if (code) p.set('LH_ItemCondition', code);

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
        throw new Error(`eBay served a bot challenge at ${page.url()} — back off and retry later.`);
      }
      if (attempt >= LOAD_ATTEMPTS) throw err;
      console.warn(`[ebay] results did not settle (attempt ${attempt}/${LOAD_ATTEMPTS}), retrying: ${url}`);
    }
  }
}

/**
 * Navigate to the search URL and return reduced results text, one block per card:
 * the card's visible text followed by its canonical `URL: https://www.ebay.com/itm/<id>`.
 *
 * innerText alone drops hrefs, which left every extracted listing unlinkable — the
 * URL has to be pulled from the anchor and reunited with the row text here.
 */
export async function fetchResultsText(page: Page, target: TargetSpec): Promise<string> {
  const url = buildSearchUrl(target);
  await loadResults(page, url);

  const rows = await page.evaluate(
    ({ cardSelector, itemHrefSource }) => {
      const itemHref = new RegExp(itemHrefSource);
      return Array.from(document.querySelectorAll(cardSelector))
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
    { cardSelector: CARD_SELECTOR, itemHrefSource: ITEM_HREF.source },
  );

  // Fail loud on site drift rather than silently extracting from a page that has no
  // results on it (an interstitial, a captcha, a renamed card class).
  if (rows.length === 0) {
    throw new Error(`eBay: no result cards found (${CARD_SELECTOR}) at ${url} — site drift or interstitial?`);
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
