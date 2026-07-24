import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chromium, type Browser, type Page } from 'playwright';
import { fileURLToPath } from 'node:url';
import { reduceResultsText } from '../../../src/sources/craigslist';
import { serveStatic, type StaticServer } from '../../helpers/static-server';

// Real Playwright over a local Craigslist-shaped fixture — no LLM, deterministic.
// The full search() LLM path is verified live by Ben (like eBay); this pins the DOM
// reduction against the selector best-guess.

const FIXTURES = fileURLToPath(new URL('../../fixtures/craigslist', import.meta.url));

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

describe('craigslist reduceResultsText', () => {
  test('one block per linked card, each with its URL line; linkless card dropped', async () => {
    await page.goto(`${server.baseUrl}/results.html`, { waitUntil: 'domcontentloaded' });
    const text = await reduceResultsText(page);
    const blocks = text.split('\n\n');
    expect(blocks).toHaveLength(3); // the no-link card is chrome, dropped
    expect(text).toContain('Logitech MX Master 3S');
    expect(text).toContain('Oakland');
    expect(text).toContain(`URL: ${server.baseUrl}/eby/ele/d/oakland-logitech-mx-master-3s/7712345678.html`);
    expect(text).not.toContain('Sponsored placeholder');
  });

  test('an empty results page fails loud, not a body fallback', async () => {
    await page.goto(`${server.baseUrl}/empty/results.html`, { waitUntil: 'domcontentloaded' });
    await expect(reduceResultsText(page)).rejects.toThrow(/no result cards/);
  });
});
