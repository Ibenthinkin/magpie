import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chromium, type Browser, type Page } from 'playwright';
import { fileURLToPath } from 'node:url';
import { reduceResultsText } from '../../../src/sources/craigslist';
import { serveStatic, type StaticServer } from '../../helpers/static-server';

// Real Playwright over a local Craigslist-shaped fixture — no LLM, deterministic.
// The fixture mirrors the LIVE 2026-07-24 gallery shape (see the file's header), so
// this now pins verified selectors rather than the pre-live best-guess.

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
    expect(text).toContain('NEW - UPLIFT Standing Desk V2');
    expect(text).toContain('Broomall');
    expect(text).toContain('$280');
    expect(text).toContain(
      'URL: https://www.craigslist.org/view/d/broomall-new-uplift-standing-desk/8EhtzWDrDcXbcQiWBpsYRA',
    );
    expect(text).not.toContain('Sponsored placeholder');
  });

  test('the gallery card is a DIV — the live shape, not the li we first guessed', async () => {
    await page.goto(`${server.baseUrl}/results.html`, { waitUntil: 'domcontentloaded' });
    expect(await page.locator('div.cl-search-result').count()).toBeGreaterThan(0);
    expect(await page.locator('li.cl-search-result').count()).toBe(0);
    // ...and we still read it, because the selector no longer names a tag.
    expect(await reduceResultsText(page)).toContain('UPLIFT');
  });

  test('the legacy static-fallback card is still read', async () => {
    await page.goto(`${server.baseUrl}/results.html`, { waitUntil: 'domcontentloaded' });
    const text = await reduceResultsText(page);
    expect(text).toContain('Jarvis Bamboo Standing Desk');
    expect(text).toContain('7943875580.html');
  });

  test('gallery swipe dots are stripped, not fed to the LLM as tokens', async () => {
    await page.goto(`${server.baseUrl}/results.html`, { waitUntil: 'domcontentloaded' });
    const text = await reduceResultsText(page);
    expect(text).not.toContain('•');
    // The dots must not survive as empty separators either.
    expect(text).not.toMatch(/\|\s*\|/);
    expect(text).toContain('Lots of Free Items in Bryn Mawr');
  });

  test('an empty results page fails loud, not a body fallback', async () => {
    await page.goto(`${server.baseUrl}/empty/results.html`, { waitUntil: 'domcontentloaded' });
    await expect(reduceResultsText(page)).rejects.toThrow(/no result cards/);
  });
});
