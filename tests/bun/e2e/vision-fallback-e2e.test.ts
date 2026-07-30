import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { chromium, type Browser, type Page } from 'playwright';
import { fileURLToPath } from 'node:url';
import { setGenerateForTests } from '../../../src/engine/llm';
import type { TargetSpec } from '../../../src/engine/target';
import { runVisionFallback } from '../../../src/engine/visionFallback';
import { serveStatic, type StaticServer } from '../../helpers/static-server';

// Vision fallback e2e (Task 8): a real Playwright `page`, navigated to the same
// local fixture site hunt-e2e.test.ts uses, screenshots itself and collects its
// own real <a href> anchors — proving the browser-level mechanics (screenshot
// capture, anchor collection, absolute href resolution) work end to end. The
// LLM call itself is mocked via setGenerateForTests, mirroring hunt-e2e's
// convention: this pins the plumbing around vision extraction, not vision
// quality (see scripts/smoke-vision.ts for a real, manually-run vision call).

const FIXTURES = fileURLToPath(new URL('../../fixtures/fixture', import.meta.url));

let server: StaticServer;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  server = await serveStatic(FIXTURES);
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

afterEach(() => setGenerateForTests(null));

const target: TargetSpec = { description: 'widget pro 3000', constraints: {} };

describe('runVisionFallback e2e (real page + browser, mocked LLM)', () => {
  test('screenshots the real page, collects real anchors, and returns only the validated rows', async () => {
    await page.goto(`${server.baseUrl}/results.html`, { waitUntil: 'domcontentloaded' });

    let seenPrompt: string | undefined;
    setGenerateForTests(({ prompt }) => {
      seenPrompt = prompt;
      return {
        object: {
          listings: [
            {
              title: 'Widget Pro 3000 (2024 model)',
              priceCents: 5999,
              shippingCents: 499,
              condition: 'new',
              url: `${server.baseUrl}/item/fx-001.html`,
              sellerRating: null,
              location: null,
            },
            // Missing required "title" — proves the returned rows are
            // keepValidRows' validated output, not the raw LLM object echoed
            // back verbatim.
            { priceCents: 100, shippingCents: null, condition: null, url: null, sellerRating: null, location: null },
          ],
        },
        usage: { inputTokens: 500, outputTokens: 50 },
        costUsd: 0.002,
      };
    });

    const rows = await runVisionFallback(page, 'fixture-source', target);

    expect(rows).toEqual([
      {
        title: 'Widget Pro 3000 (2024 model)',
        priceCents: 5999,
        shippingCents: 499,
        condition: 'new',
        url: `${server.baseUrl}/item/fx-001.html`,
        sellerRating: null,
        location: null,
      },
    ]);

    // Anchors handed to the LLM prompt are real hrefs a real Playwright page
    // resolved against the fixture site, not stubbed data.
    expect(seenPrompt).toContain(`${server.baseUrl}/item/fx-001.html`);
    expect(seenPrompt).toContain(`${server.baseUrl}/item/fx-007.html`);
  });
});
