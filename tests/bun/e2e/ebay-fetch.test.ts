import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chromium, type Browser, type Page } from 'playwright';
import { fileURLToPath } from 'node:url';
import { reduceResultsText } from '../../../src/sources/ebay';
import { serveStatic, type StaticServer } from '../../helpers/static-server';

// Real Playwright over a local eBay-shaped fixture — no LLM, deterministic. The full
// search() LLM path is verified live by Ben; this pins the DOM reduction, and in
// particular the out-of-radius padding trim discovered in the 2026-07-23 live smoke.

const FIXTURES = fileURLToPath(new URL('../../fixtures/ebay', import.meta.url));

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

describe('ebay reduceResultsText', () => {
  test('keeps only genuine in-radius cards, dropping padding sections and linkless chrome', async () => {
    await page.goto(`${server.baseUrl}/results.html`, { waitUntil: 'domcontentloaded' });
    const text = await reduceResultsText(page);
    const blocks = text.split('\n\n');

    // 3 genuine cards; the linkless promo, the "fewer words" card, and both
    // "international sellers" cards are all excluded.
    expect(blocks).toHaveLength(3);
    expect(text).toContain('Rolling Faux Wooden Desk');
    expect(text).toContain('Standing Desk Set');
    expect(text).toContain('Under Desk Printer Stand');
  });

  test('preserves the per-card distance signal for the ranker', async () => {
    await page.goto(`${server.baseUrl}/results.html`, { waitUntil: 'domcontentloaded' });
    const text = await reduceResultsText(page);
    // eBay's own "N mi from <zip>" is the location signal the ranking pass judges on.
    expect(text).toContain('25 mi from 19147');
    expect(text).toContain('3 mi from 19147');
  });

  test('does NOT ingest out-of-radius padding (the Santa Clarita failure)', async () => {
    await page.goto(`${server.baseUrl}/results.html`, { waitUntil: 'domcontentloaded' });
    const text = await reduceResultsText(page);
    expect(text).not.toContain('Santa Clarita');
    expect(text).not.toContain('2,390 mi');
    expect(text).not.toContain('4,885 mi');
    expect(text).not.toContain('Office Desk With Storage'); // the "fewer words" card
  });

  test('an empty results page fails loud, not a body fallback', async () => {
    await page.goto(`${server.baseUrl}/empty/results.html`, { waitUntil: 'domcontentloaded' });
    await expect(reduceResultsText(page)).rejects.toThrow(/no result cards/);
  });
});
