import type { Page } from 'playwright';
import type { TargetSpec } from '../engine/target';
import type { NormalizedListing, RawListing, SourceAdapter } from './types';

// The fixture source: a local static site with a stable, hand-authored markup
// contract (tests/fixtures/fixture/). Fully deterministic — no LLM, no network —
// so the whole engine can run end-to-end offline and free. Opt-in only; never
// part of the default source set.

const ITEM_PATH = /\/item\/([\w-]+)\.html$/;

function parseCents(text: string | null): number | null {
  const m = text?.match(/\$([\d,]+(?:\.\d{1,2})?)/);
  return m?.[1] ? Math.round(Number(m[1].replace(/,/g, '')) * 100) : null;
}

export function makeFixtureAdapter(baseUrl?: string): SourceAdapter {
  return {
    source: 'fixture',
    rateLimit: { minDelayMs: 0, maxPerHour: 100_000 },

    async search(page: Page, _target: TargetSpec): Promise<RawListing[]> {
      const base = baseUrl ?? process.env.FIXTURE_BASE_URL;
      if (!base) throw new Error('fixture adapter needs a base URL (FIXTURE_BASE_URL)');
      await page.goto(`${base}/results.html`, { waitUntil: 'domcontentloaded' });

      const cards = await page.$$eval('li.listing', (lis) =>
        lis.map((li) => ({
          title: li.querySelector('.title')?.textContent?.trim() ?? null,
          url: li.querySelector<HTMLAnchorElement>('a.title')?.href ?? null,
          price: li.querySelector('.price')?.textContent ?? null,
          shipping: li.querySelector('.shipping')?.textContent ?? null,
          condition: li.querySelector('.condition')?.textContent?.trim() ?? null,
        })),
      );

      const rows: RawListing[] = [];
      for (const card of cards) {
        const priceCents = parseCents(card.price);
        if (!card.title || !card.url || priceCents === null) {
          console.warn(`[fixture] skipped unusable card: ${JSON.stringify(card)}`);
          continue;
        }
        rows.push({
          title: card.title,
          priceCents,
          shippingCents: parseCents(card.shipping),
          condition: card.condition,
          url: card.url,
        });
      }
      return rows;
    },

    toListing(raw: RawListing): NormalizedListing | null {
      const id = raw.url?.match(ITEM_PATH)?.[1];
      if (!id || !raw.url) return null;
      return {
        source: 'fixture',
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

export const fixtureAdapter = makeFixtureAdapter();
