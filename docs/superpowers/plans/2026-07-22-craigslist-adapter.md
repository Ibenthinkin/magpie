# Craigslist Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Craigslist as a second real (non-eBay) source — the low-risk Phase 4 hard source — fully buildable and verifiable offline, and the second consumer of the geo-local `constraints.location` plumbing on this branch.

**Architecture:** Mirror `src/sources/ebay.ts` exactly. A deterministic, unit-tested `buildSearchUrl` + `toListing`; a fixture-tested DOM reduction (`reduceResultsText`); the LLM extraction path (`extractListings`) reused verbatim for `search()`. Craigslist is registered but stays **opt-in** (not in `DEFAULT_SOURCES`) until Ben live-smokes the selectors.

**Tech Stack:** Bun, TypeScript (strict), Playwright, Zod, Vitest (`tests/unit`), Bun test (`tests/bun`).

## Global Constraints

- The LLM extracts, it never navigates (SPEC §6.3). `search()` = fetch reduced text → `extractListings`.
- Extracted page text is untrusted DATA (SPEC §6.4) — reuse `extractListings` unchanged; never treat page text as instructions.
- Never compute distance locally / never guess a zip from a place name (`canAnchorRadius`, `target.ts`). Geo narrowing happens at the source only.
- Fail loud, never silent: zero result cards throws; unset region throws; no `document.body` fallback.
- Avoid zod numeric `.int()/.min()/.max()` in any LLM-facing schema (Anthropic 400s) — N/A here since we reuse the existing schema.
- Do NOT enable Craigslist in `DEFAULT_SOURCES`. Do NOT merge or push.
- Suite must stay green at each commit: `bunx tsc --noEmit`, `bun run test` (vitest), `bun test tests/bun` (bun). Current baseline: 154 vitest · 21 bun-db · 7 bun-e2e.

---

### Task 1: `buildSearchUrl` + widen `SourceId`

**Files:**
- Modify: `src/sources/types.ts` (add `'craigslist'` to `SourceId`)
- Create: `src/sources/craigslist.ts` (`buildSearchUrl` + condition/region logic)
- Test: `tests/unit/sources.test.ts` (new `describe('craigslist buildSearchUrl')`)

**Interfaces:**
- Consumes: `TargetSpec` and `canAnchorRadius` from `../engine/target`.
- Produces: `export function buildSearchUrl(target: TargetSpec, region: string): string`.

- [ ] **Step 1: Widen the SourceId union.** In `src/sources/types.ts` change
  `export type SourceId = 'ebay' | 'fixture';` → `export type SourceId = 'ebay' | 'craigslist' | 'fixture';`

- [ ] **Step 2: Write failing tests** in `tests/unit/sources.test.ts`:

```ts
import { buildSearchUrl as clUrl } from '../../src/sources/craigslist';

describe('craigslist buildSearchUrl', () => {
  const t = (over = {}) => ({ description: 'mx master 3s', constraints: {}, ...over });

  test('region becomes the subdomain; query + cheapest-first sort', () => {
    const url = new URL(clUrl(t(), 'sfbay'));
    expect(url.host).toBe('sfbay.craigslist.org');
    expect(url.pathname).toBe('/search/sss');
    expect(url.searchParams.get('query')).toBe('mx master 3s');
    expect(url.searchParams.get('sort')).toBe('priceasc');
  });

  test('a US zip becomes postal + an EXACT search_distance (no ladder snapping)', () => {
    const url = new URL(clUrl(t({ constraints: { location: { near: '94601', maxMiles: 23 } } }), 'sfbay'));
    expect(url.searchParams.get('postal')).toBe('94601');
    expect(url.searchParams.get('search_distance')).toBe('23'); // eBay would snap to 25; CL takes exact
  });

  test('a zip with no radius still anchors postal; a place name sets neither', () => {
    const anchored = new URL(clUrl(t({ constraints: { location: { near: '94601' } } }), 'sfbay'));
    expect(anchored.searchParams.get('postal')).toBe('94601');
    expect(anchored.searchParams.get('search_distance')).toBeNull();
    const place = new URL(clUrl(t({ constraints: { location: { near: 'Oakland, CA', maxMiles: 20 } } }), 'sfbay'));
    expect(place.searchParams.get('postal')).toBeNull();
    expect(place.searchParams.get('search_distance')).toBeNull();
  });

  test('max price as whole dollars; condition only for new', () => {
    const url = new URL(clUrl(t({ constraints: { maxPriceCents: 6050, conditions: ['new'] } }), 'sfbay'));
    expect(url.searchParams.get('max_price')).toBe('61');
    expect(url.searchParams.get('condition')).toBe('10');
    const used = new URL(clUrl(t({ constraints: { conditions: ['used'] } }), 'sfbay'));
    expect(used.searchParams.get('condition')).toBeNull();
  });

  test('no region throws — we never guess a zip into a region', () => {
    expect(() => clUrl(t(), '')).toThrow(/CRAIGSLIST_REGION/);
  });
});
```

- [ ] **Step 3: Run — expect FAIL** (`buildSearchUrl` not defined): `bun run test -- tests/unit/sources.test.ts -t "craigslist buildSearchUrl"`

- [ ] **Step 4: Implement** the top of `src/sources/craigslist.ts`:

```ts
import type { Page } from 'playwright';
import { extractListings } from '../engine/extract';
import { canAnchorRadius, type TargetSpec } from '../engine/target';
import type { NormalizedListing, RawListing, SourceAdapter } from './types';

// Guided Craigslist search: deterministic URL from the target, then reduced page
// text for LLM extraction (LLM extracts, never navigates). SPEC §6.3. Mirrors ebay.ts.
//
// Craigslist has no national search — it's sharded into ~400 regional subdomains, so
// the region subdomain IS the geography and must be configured (CRAIGSLIST_REGION).

export function buildSearchUrl(target: TargetSpec, region: string): string {
  if (!region) {
    throw new Error(
      'craigslist adapter needs a region subdomain (CRAIGSLIST_REGION), e.g. "sfbay" — ' +
        'we never guess a zip into a region.',
    );
  }
  const p = new URLSearchParams();
  p.set('query', target.description);
  p.set('sort', 'priceasc'); // cheapest first, matching eBay's _sop=15

  const max = target.constraints.maxPriceCents;
  if (max != null) p.set('max_price', String(Math.ceil(max / 100))); // CL wants whole dollars

  // Craigslist's condition taxonomy is six levels and doesn't map onto our three-value
  // enum; only "new" (code 10) is unambiguous. Filtering the rest would silently hide
  // real listings, so we leave them as a safe superset — same instinct as eBay snapping
  // a radius UP and the filter keeping ties.
  if (target.constraints.conditions?.[0] === 'new') p.set('condition', '10');

  // Geo narrowing at the source. Unlike eBay's fixed ladder, Craigslist takes an EXACT
  // integer radius, so no snapping. Anchored on a zip only, never a guessed centroid.
  const loc = target.constraints.location;
  if (canAnchorRadius(loc)) {
    p.set('postal', loc!.near!.trim());
    if (loc!.maxMiles != null && loc!.maxMiles > 0) p.set('search_distance', String(Math.ceil(loc!.maxMiles)));
  } else if (loc?.near) {
    console.warn(
      `[craigslist] location "${loc.near}" is not a US zip — searching without a radius. ` +
        'Item locations still reach the ranking step and the cards.',
    );
  }

  return `https://${region}.craigslist.org/search/sss?${p.toString()}`;
}
```

- [ ] **Step 5: Run — expect PASS.** Same command as Step 3.

- [ ] **Step 6: Commit** `git add -A && git commit -m "Craigslist buildSearchUrl: deterministic geo-aware search URL"`

---

### Task 2: `toListing`, adapter object, registry + config

**Files:**
- Modify: `src/sources/craigslist.ts` (append `toListing`, `makeCraigslistAdapter`, `craigslistAdapter`)
- Modify: `src/sources/registry.ts` (register + label)
- Modify: `.env.example` (add `CRAIGSLIST_REGION=`)
- Test: `tests/unit/sources.test.ts` (`describe('craigslist toListing')`; extend `describe('registry')`)

**Interfaces:**
- Consumes: `buildSearchUrl` (Task 1); `SourceAdapter`, `RawListing`, `NormalizedListing` from `./types`.
- Produces: `export function makeCraigslistAdapter(region?: string): SourceAdapter`; `export const craigslistAdapter: SourceAdapter`.

- [ ] **Step 1: Write failing tests** in `tests/unit/sources.test.ts`:

```ts
import { craigslistAdapter } from '../../src/sources/craigslist';

describe('craigslist toListing', () => {
  const clRaw = (over = {}) => raw({
    url: 'https://sfbay.craigslist.org/eby/ele/d/oakland-logitech-mx-master/7712345678.html',
    ...over,
  });

  test('derives source_id from the numeric post id', () => {
    const l = craigslistAdapter.toListing(clRaw());
    expect(l).toMatchObject({ source: 'craigslist', sourceId: '7712345678', currency: 'USD' });
  });

  test('rejects a foreign host or a URL with no post id', () => {
    expect(craigslistAdapter.toListing(clRaw({ url: null }))).toBeNull();
    expect(craigslistAdapter.toListing(clRaw({ url: 'https://evil.example/d/x/7712345678.html' }))).toBeNull();
    expect(craigslistAdapter.toListing(clRaw({ url: 'https://sfbay.craigslist.org/eby/ele/d/x/index.html' }))).toBeNull();
  });

  test('carries item location and seller rating through', () => {
    expect(craigslistAdapter.toListing(clRaw({ location: 'Oakland' }))!.location).toBe('Oakland');
    expect(craigslistAdapter.toListing(clRaw({ sellerRating: null }))!.sellerRating).toBeNull();
  });
});
```

  And extend the existing `describe('registry')` block:

```ts
  test('craigslist is resolvable when named but never a default', () => {
    expect(resolveAdapters(undefined).map((a) => a.source)).toEqual(['ebay']);
    expect(resolveAdapters(['craigslist']).map((a) => a.source)).toEqual(['craigslist']);
  });
```

  Add the import `import { craigslistAdapter } from '../../src/sources/craigslist';` (or reuse if already added).

- [ ] **Step 2: Run — expect FAIL:** `bun run test -- tests/unit/sources.test.ts -t "craigslist toListing"`

- [ ] **Step 3: Append implementation** to `src/sources/craigslist.ts`:

```ts
const MAX_TEXT_CHARS = 16_000; // matches ebay.ts extraction budget

// Craigslist post URL: https://<region>.craigslist.org/<area>/<cat>/d/<slug>/<id>.html
// Require a craigslist.org host and a numeric post id at the tail — reject foreign hosts
// and index/listing pages, same guard shape as eBay's /itm/\d{9,}.
const POST_URL = /^https?:\/\/[a-z0-9-]+\.craigslist\.org\/\S*\/(\d{6,})\.html(?:$|[?#])/;

export function makeCraigslistAdapter(region?: string): SourceAdapter {
  return {
    source: 'craigslist',
    // No login, but Craigslist is scraping-sensitive — gentle from day one (Phase 4).
    rateLimit: { minDelayMs: 15_000, maxPerHour: 20 },

    async search(page: Page, target: TargetSpec): Promise<RawListing[]> {
      const text = await fetchResultsText(page, target, region ?? process.env.CRAIGSLIST_REGION ?? '');
      return extractListings(text, target);
    },

    toListing(raw: RawListing): NormalizedListing | null {
      const id = raw.url?.match(POST_URL)?.[1];
      if (!id || !raw.url) return null; // no verifiable post URL → unusable row
      return {
        source: 'craigslist',
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

export const craigslistAdapter = makeCraigslistAdapter();
```

  (`fetchResultsText` is added in Task 3; TS is fine with the forward reference to a
  hoisted function declaration in the same module. If executing strictly task-by-task and
  wanting green between tasks, add a temporary `fetchResultsText` stub — but Tasks 2 and 3
  are committed together in practice; a `tsc` run happens after Task 3.)

- [ ] **Step 4: Register** in `src/sources/registry.ts`:
  - Add import: `import { craigslistAdapter } from './craigslist';`
  - Add to `registry`: `craigslist: craigslistAdapter,`
  - Add to `LABELS`: `craigslist: 'Craigslist',`
  - Leave `DEFAULT_SOURCES` unchanged (`['ebay']`).

- [ ] **Step 5: Add to `.env.example`** (adapter-owned env, near the other source config):

```
# Craigslist region subdomain (e.g. sfbay) — required to use the opt-in craigslist source.
CRAIGSLIST_REGION=
```

- [ ] **Step 6: Run — expect PASS** once Task 3 lands (`fetchResultsText` defined). Command: `bun run test -- tests/unit/sources.test.ts`. (`toListing`/registry tests don't call `fetchResultsText`, so they pass immediately; full-file `tsc` waits for Task 3.)

- [ ] **Step 7: Commit** (with Task 3, or standalone if stubbed) — see Task 3 commit.

---

### Task 3: `reduceResultsText` / `fetchResultsText` + fixture + bun e2e

**Files:**
- Modify: `src/sources/craigslist.ts` (add `reduceResultsText`, `loadResults`, `fetchResultsText`)
- Create: `tests/fixtures/craigslist/results.html` (Craigslist-shaped markup)
- Create: `tests/fixtures/craigslist/empty/results.html` (no cards)
- Create: `tests/bun/e2e/craigslist-fetch.test.ts`

**Interfaces:**
- Consumes: `buildSearchUrl` (Task 1).
- Produces: `export async function reduceResultsText(page: Page): Promise<string>`;
  `export async function fetchResultsText(page: Page, target: TargetSpec, region: string): Promise<string>`.

- [ ] **Step 1: Author the fixture** `tests/fixtures/craigslist/results.html` — 4 cards: 3 linked (one with a location, one without), 1 with NO posting link (must be dropped):

```html
<!doctype html>
<html><body>
<ol class="cl-search-results">
  <li class="cl-search-result cl-search-view-mode-gallery">
    <a class="posting-title" href="/eby/ele/d/oakland-logitech-mx-master-3s/7712345678.html">
      <span class="label">Logitech MX Master 3S</span></a>
    <span class="priceinfo">$45</span>
    <div class="meta"><span class="location">Oakland</span></div>
  </li>
  <li class="cl-search-result cl-search-view-mode-gallery">
    <a class="posting-title" href="/sfc/ele/d/sf-mx-master-3s-new/7712345679.html">
      <span class="label">MX Master 3S (new, sealed)</span></a>
    <span class="priceinfo">$60</span>
    <div class="meta"></div>
  </li>
  <li class="cl-search-result cl-search-view-mode-gallery">
    <a class="posting-title" href="/eby/ele/d/berkeley-mx-master/7712345680.html">
      <span class="label">Used MX Master mouse</span></a>
    <span class="priceinfo">$30</span>
    <div class="meta"><span class="location">Berkeley</span></div>
  </li>
  <li class="cl-search-result">
    <span class="label">Sponsored placeholder (no link)</span>
    <span class="priceinfo">$99</span>
  </li>
</ol>
</body></html>
```

  And `tests/fixtures/craigslist/empty/results.html`:

```html
<!doctype html><html><body><ol class="cl-search-results"></ol><p>no results</p></body></html>
```

- [ ] **Step 2: Write the failing bun test** `tests/bun/e2e/craigslist-fetch.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chromium, type Browser, type Page } from 'playwright';
import { fileURLToPath } from 'node:url';
import { reduceResultsText } from '../../../src/sources/craigslist';
import { serveStatic, type StaticServer } from '../../helpers/static-server';

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
```

- [ ] **Step 3: Run — expect FAIL** (`reduceResultsText` not exported): `bun test tests/bun/e2e/craigslist-fetch.test.ts`

- [ ] **Step 4: Implement** in `src/sources/craigslist.ts` (after `buildSearchUrl`):

```ts
// Selector best-guess for Craigslist's gallery results. LIVE-UNVERIFIED — pinned by the
// fixture, confirmed for real only when a Craigslist hunt runs. Anchored on the card, and
// the posting anchor carries the canonical /<id>.html URL innerText would otherwise drop.
const CARD_SELECTOR = 'li.cl-search-result, li.cl-static-search-result';
const POST_ANCHOR = 'a.posting-title, a.cl-app-anchor';

const LOAD_ATTEMPTS = 2;

async function loadResults(page: Page, url: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector(CARD_SELECTOR, { state: 'attached', timeout: 20_000 });
      return;
    } catch (err) {
      if (attempt >= LOAD_ATTEMPTS) throw err;
      console.warn(`[craigslist] results did not settle (attempt ${attempt}/${LOAD_ATTEMPTS}), retrying: ${url}`);
    }
  }
}

/** Pure DOM → reduced text, one block per linked card: card text + a `URL:` line. */
export async function reduceResultsText(page: Page): Promise<string> {
  const rows = await page.evaluate(
    ({ cardSelector, anchorSelector }) =>
      Array.from(document.querySelectorAll(cardSelector))
        .map((li) => {
          const a = li.querySelector<HTMLAnchorElement>(anchorSelector);
          return {
            href: a ? a.href.split('?')[0] : null,
            text: ((li as HTMLElement).innerText ?? '').trim().replace(/\s*\n+\s*/g, ' | '),
          };
        })
        .filter((row) => row.href && row.text), // cards with no posting link are chrome
    { cardSelector: CARD_SELECTOR, anchorSelector: POST_ANCHOR },
  );

  if (rows.length === 0) {
    throw new Error(`craigslist: no result cards found (${CARD_SELECTOR}) — site drift or interstitial?`);
  }

  const blocks: string[] = [];
  let chars = 0;
  for (const row of rows) {
    const block = `${row.text}\nURL: ${row.href}`;
    if (chars + block.length > MAX_TEXT_CHARS) break;
    blocks.push(block);
    chars += block.length + 2;
  }
  return blocks.join('\n\n');
}

export async function fetchResultsText(page: Page, target: TargetSpec, region: string): Promise<string> {
  const url = buildSearchUrl(target, region);
  console.log(`[craigslist] search ${url}`); // the adapter's whole contract — log it, like eBay
  await loadResults(page, url);
  return reduceResultsText(page);
}
```

  Note: `reduceResultsText` uses `a.href` which the browser resolves to an absolute URL
  against the served page's origin, so the fixture's relative `/eby/...` hrefs come back as
  `${server.baseUrl}/eby/...` — matching the test assertion.

- [ ] **Step 5: Run — expect PASS:** `bun test tests/bun/e2e/craigslist-fetch.test.ts`

- [ ] **Step 6: Full suite + typecheck:**
  - `bunx tsc --noEmit` → clean
  - `bun run test` → vitest all green (154 + new craigslist unit tests)
  - `bun test tests/bun` → bun all green (21 db + 7 + 2 new e2e)

- [ ] **Step 7: Commit** `git add -A && git commit -m "Craigslist adapter: fetch/reduce, toListing, registry (opt-in); fixture + tests"`

---

### Task 4: CHECKLIST + log + SPEC env note

**Files:**
- Modify: `CHECKLIST.md` (Phase 4 craigslist item, fixtures/tests item)
- Modify: `log.md` (extend today's entry)
- Modify: `SPEC.md` (§10 env table: add `CRAIGSLIST_REGION`)

- [ ] **Step 1:** In `CHECKLIST.md` Phase 4, tick the craigslist half of the adapters item and the fixtures/tests item, annotating that Craigslist is opt-in and selectors are live-unverified; Facebook still open.
- [ ] **Step 2:** Extend the `[[07-22-26 Wed]]` log entry (do not add a second heading) with a Craigslist section: what shipped, the eBay-ladder vs CL-exact-radius contrast, opt-in posture, live-unverified selectors, and the open questions for Ben.
- [ ] **Step 3:** Add `CRAIGSLIST_REGION` to SPEC §10's env var table with a one-line description (optional; only for the opt-in craigslist source).
- [ ] **Step 4: Commit** `git add -A && git commit -m "Log + checklist + SPEC env: Craigslist adapter (opt-in, Phase 4)"`

---

## Self-Review

- **Spec coverage:** buildSearchUrl (T1), toListing/adapter/registry/config (T2), reduce/fetch + fixture + tests (T3), docs (T4). Geo exact-radius, condition-only-new, region-throws, opt-in-not-default, fail-loud — all have tasks. ✓
- **Placeholders:** none — every code step shows full code. ✓
- **Type consistency:** `buildSearchUrl(target, region)`, `reduceResultsText(page)`, `fetchResultsText(page, target, region)`, `makeCraigslistAdapter(region?)`, `craigslistAdapter` — names consistent across tasks and the design doc. `SourceId` widened before use. ✓
- **Out of scope confirmed:** DEFAULT_SOURCES untouched; no Marketplace; no merge/push. ✓
