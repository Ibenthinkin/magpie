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

const MAX_TEXT_CHARS = 12_000; // rough token budget for the extraction prompt

/** Navigate to the search URL and return trimmed results-list text. */
export async function fetchResultsText(page: Page, target: TargetSpec): Promise<string> {
  const url = buildSearchUrl(target);
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  const text = await page.evaluate(() => {
    const el = document.querySelector('ul.srp-results') ?? document.body;
    return (el as HTMLElement).innerText;
  });

  return text.slice(0, MAX_TEXT_CHARS);
}
