import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import { setGenerateForTests } from '../../src/engine/llm';
import { runVisionFallback } from '../../src/engine/visionFallback';
import type { TargetSpec } from '../../src/engine/target';

// Vision fallback orchestration (Task 5): a minimal fake `page` stub — no real
// Playwright — plus the setGenerateForTests LLM seam, mirroring the fake-deps
// convention used throughout tests/unit/hunt.test.ts.

afterEach(() => setGenerateForTests(null));

const target: TargetSpec = { description: 'widget 3000', constraints: {} };
const fixedScreenshot = Buffer.from('fixed-screenshot-bytes');
const fixedAnchors = [
  { href: 'https://example.com/item/1', text: 'Widget A' },
  { href: 'https://example.com/item/2', text: 'Widget B' },
];

function fakePage(): { page: Page; screenshot: ReturnType<typeof vi.fn>; evalFn: ReturnType<typeof vi.fn> } {
  const screenshot = vi.fn().mockResolvedValue(fixedScreenshot);
  const evalFn = vi.fn().mockResolvedValue(fixedAnchors);
  const page = {
    screenshot,
    $$eval: evalFn,
  } as unknown as Page;
  return { page, screenshot, evalFn };
}

describe('runVisionFallback', () => {
  it('screenshots the page, collects anchors, and returns the parsed listings', async () => {
    const { page, screenshot, evalFn } = fakePage();

    setGenerateForTests(() => ({
      object: {
        listings: [
          {
            title: 'Widget A',
            priceCents: 1000,
            shippingCents: null,
            condition: null,
            url: 'https://example.com/item/1',
            sellerRating: null,
            location: null,
          },
        ],
      },
    }));

    const rows = await runVisionFallback(page, 'ebay', target);

    expect(rows).toEqual([
      {
        title: 'Widget A',
        priceCents: 1000,
        shippingCents: null,
        condition: null,
        url: 'https://example.com/item/1',
        sellerRating: null,
        location: null,
      },
    ]);

    expect(screenshot).toHaveBeenCalledWith({ type: 'jpeg', quality: 70 });
    expect(evalFn).toHaveBeenCalledWith('a[href]', expect.any(Function));
  });

  it('passes anchor hrefs through to the LLM prompt', async () => {
    const { page } = fakePage();
    let seenPrompt: string | undefined;
    setGenerateForTests((call) => {
      seenPrompt = call.prompt;
      return { object: { listings: [] } };
    });

    await runVisionFallback(page, 'craigslist', target);

    expect(seenPrompt).toContain('https://example.com/item/1');
    expect(seenPrompt).toContain('https://example.com/item/2');
  });
});
