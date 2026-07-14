import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chromium, type Browser, type Page } from 'playwright';
import { fileURLToPath } from 'node:url';
import { makeFixtureAdapter } from '../../../src/sources/fixture';
import { serveStatic, type StaticServer } from '../../helpers/static-server';

// Real Playwright against the local static fixture site. Always a fresh
// throwaway browser — never the persistent logged-in profile.

const FIXTURES = fileURLToPath(new URL('../../fixtures/fixture', import.meta.url));
const target = { description: 'widget pro 3000', constraints: {} };

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

describe('fixture adapter search', () => {
  test('parses listing cards deterministically, skipping unusable ones', async () => {
    const adapter = makeFixtureAdapter(server.baseUrl);
    const rows = await adapter.search(page, target);

    // 7 cards on the page: one has no price, one has no link — both skipped.
    expect(rows).toHaveLength(5);
    expect(rows[0]).toEqual({
      title: 'Widget Pro 3000 (2024 model)',
      priceCents: 5999,
      shippingCents: 499,
      condition: 'new',
      url: `${server.baseUrl}/item/fx-001.html`,
    });
    const noShipping = rows.find((r) => r.url?.includes('fx-002'));
    expect(noShipping?.shippingCents).toBeNull();
    expect(rows.every((r) => r.url && r.priceCents > 0)).toBe(true);
  });

  test('an empty results page yields [], not an error', async () => {
    const adapter = makeFixtureAdapter(`${server.baseUrl}/empty`);
    expect(await adapter.search(page, target)).toEqual([]);
  });

  test('search → toListing round-trips into the §5.4 shape', async () => {
    const adapter = makeFixtureAdapter(server.baseUrl);
    const rows = await adapter.search(page, target);
    const listings = rows.map((r) => adapter.toListing(r));
    expect(listings.every((l) => l !== null)).toBe(true);
    expect(listings[0]).toMatchObject({ source: 'fixture', sourceId: 'fx-001', currency: 'USD' });
  });
});
