# Craigslist adapter — design

*2026-07-22. Written in an autonomous overnight session (Ben asleep) after Ben asked to
"start on the next work item without me doing those tests." The live smoke that blocks
Phases 3 and the geo work is unrelated to this — this is new, offline-buildable Phase 4
progress. **Read this and the plan before implementing; the open questions at the bottom
are Ben's to confirm.**

## Why this, and why not the other Phase 4 items

Phase 4 ("hard sources — carefully") has three open work items:

- **Facebook Marketplace** — the "big risk" item. Needs a logged-in (possibly burner)
  account and *live* detection-mitigation testing. That is exactly the work that must
  happen with Ben present and watching; doing it autonomously overnight either produces
  nothing verifiable or risks an account ban. CLAUDE.md's mandate is "account-ban risk
  respected." → **deferred to a session Ben runs.**
- **Dockerfile / compose** — can't be built or tested on this machine (no Docker; noted
  in `log.md`). → deferred.
- **Craigslist** — no login, no account, therefore **no ban risk to respect**. Fully
  buildable and verifiable offline against a fixture, exactly the way eBay and the
  fixture source were. It's also the **second consumer of the geo-local plumbing** shipped
  on this branch (`constraints.location`), which so far only eBay reads. → **this.**

## Architecture — mirror the eBay adapter exactly

`src/sources/craigslist.ts`, same shape as `src/sources/ebay.ts`. The LLM extracts, it
never navigates (SPEC §6.3). The deterministic, unit-testable surface is `buildSearchUrl`
+ `toListing`; the live DOM reduction was a documented best-guess, **live-verified on
2026-07-24** — and, like eBay's `_stpos`/`_sadis`, the verification is what found the bugs.
Four corrections are folded in below, each marked **[live 07-24]**.

### `buildSearchUrl(target, region): string`

Craigslist has **no national search** — it's sharded into ~400 regional subdomains
(`sfbay.craigslist.org`, …). The subdomain *is* the geography. So the search URL is
`https://<region>.craigslist.org/search/sss?…` (`sss` = all "for sale").

- `query` = `target.description`
- **[live 07-24] no `sort` at all** — reversing this design's original `sort=priceasc`.
  Craigslist's `query` matches post *body* text loosely, so cheapest-first floats free junk
  that merely mentions the words: measured on "standing desk" near 19147, `priceasc` gave
  **4/10 relevant** in the top ten ("Curb alert!", a patriotic shadow box, three duplicate
  elliptical pedals) against **10/10** real desks on the default relevance sort. Since
  `rankListings` re-sorts by landed cost anyway, the source-side sort only decides which
  candidates we spend extraction on — and there, relevance is the whole point. eBay's
  `_sop=15` is safe because eBay's query matching is tight; copying it here was the error.
- `max_price` = `ceil(maxPriceCents/100)` (Craigslist wants whole dollars)
- `condition` = `10` **only when** `conditions[0] === 'new'`. Otherwise omitted.
  Craigslist's condition taxonomy is six levels (new/like-new/excellent/good/fair/salvage)
  and does not map cleanly onto our three-value enum (`new`/`used`/`refurbished`). A wrong
  code silently hides real listings, so we filter only the one value that maps
  unambiguously and leave the rest as a safe superset — the same fail-safe instinct as
  eBay's "snap the radius *up*" and the filter's "ties go to keeping the listing."
- **Geo** (the payoff): when `canAnchorRadius(location)` (shared helper in `target.ts` —
  a US zip, never a guessed centroid), set `postal=<zip>` and, if a radius was asked,
  `search_distance=<miles>`. **Unlike eBay, Craigslist takes an exact integer radius —
  no ladder, no snapping.** A non-zip place name warns and is omitted, identical to eBay.
- **Region** comes from `CRAIGSLIST_REGION`. If unset, `buildSearchUrl` **throws loud** —
  we will not guess a zip into a region (that's the geocoding we've deliberately refused).
  Mirrors the fixture adapter throwing when its base URL is unset.

### `reduceResultsText(page)` + `fetchResultsText(page, target, region)`

Split so the DOM reduction is testable against a fixture page without hitting live
Craigslist (an improvement over eBay, whose reduction is untested):

- `reduceResultsText(page)` — pure DOM → reduced text, one block per card: visible card
  text + a `URL: <post url>` line (innerText drops hrefs, same lesson as eBay). Cards with
  no posting link are dropped as chrome. **Fails loud on zero cards** (site drift /
  interstitial), never falls back to `document.body`.
- `fetchResultsText` = `buildSearchUrl` → log the URL (`[craigslist] search <url>`, the
  adapter's whole contract, same as eBay) → `goto` → `loadResults` → `reduceResultsText`.

**[live 07-24] Selectors — the guess named the wrong element.** The real gallery card is a
**`DIV`**, so `li.cl-search-result` matched **0 of 24** cards. Now tag-agnostic:
`.cl-search-result, .cl-static-search-result`, anchor `a.posting-title, a.main,
a.cl-app-anchor` (`a.main` is the gallery image link carrying the same permalink). The
lesson generalises: name the class, not the tag — the tag is the site's business.

**[live 07-24] `loadResults` must wait for hydration, not attachment.** Craigslist ships a
pre-hydration skeleton whose cards have no anchors and no text. `waitForSelector(…,
'attached')` resolved on it at **~200ms**; the app then tore the skeleton down (**~700ms,
zero cards**) and mounted the real list at **~1200ms** — so the adapter read the page a full
second early and failed loud on an empty extract. It now `waitForFunction`s on the actual
precondition: a card that has both a posting link and rendered text. Self-correcting if
craigslist retimes hydration, and it depends on no craigslist-internal class name.

**[live 07-24] Swipe dots pollute innerText.** Each gallery card's innerText opens with a
run of bare `•` bullets (14 on a live card) from the image carousel. They're stripped —
otherwise they'd be ~24 cards' worth of meaningless tokens in every extraction prompt.

### `search()` and `toListing()`

- `search()` = `fetchResultsText` → `extractListings` (reuse the prompt-injection-safe LLM
  extraction path verbatim, like eBay).
- `toListing(raw)` — `sourceId` from the post id in a Craigslist post URL on a
  `*.craigslist.org` host; reject anything else (foreign host, no id), same guard as eBay's
  `/itm/\d{9,}`. Carries `location`/`sellerRating`/`condition` through unchanged.
  **[live 07-24] Two permalink shapes, and the gallery emits only the second:**
  legacy `…/<slug>/<pid>.html` and modern `https://www.craigslist.org/view/d/<slug>/<token>`.
  The original guess accepted only the legacy form, which would have dropped **every** live
  row — extraction succeeding and the hunt returning nothing, the quiet failure this repo
  exists to avoid. Both are accepted now. The modern token is safe as a dedup key: verified
  **24/24 identical across two loads**, and the post page's own "post id" matches the card's
  `data-pid`, so it is a real permalink and not a per-session handle.
- `makeCraigslistAdapter(region?)` factory reading `process.env.CRAIGSLIST_REGION` (mirrors
  `makeFixtureAdapter`); `export const craigslistAdapter = makeCraigslistAdapter()`.
- `rateLimit`: conservative — `{ minDelayMs: 15_000, maxPerHour: 20 }`. No login, but
  Craigslist is scraping-sensitive; be gentle from day one (Phase 4 pacing mandate).

## Registry / config

- `src/sources/types.ts`: add `'craigslist'` to `SourceId`.
- `src/sources/registry.ts`: register the adapter; add `craigslist: 'Craigslist'` to
  `LABELS` (TS forces this). **`DEFAULT_SOURCES` stays `['ebay']`** — Craigslist is opt-in
  via `/hunt … sources:craigslist` until a live smoke confirms the selectors, exactly the
  "don't silently enable an unverified path" posture that keeps the fixture opt-in and
  `MAGPIE_EXTRACT_MODEL` off by default.
- `CRAIGSLIST_REGION` added to `.env.example` (adapter-owned env, like `FIXTURE_BASE_URL`;
  not added to `config.ts`'s required-to-boot core). SPEC §10 env table gets the one-line
  addition.

## Testing (all offline)

- **Unit** (`tests/unit/sources.test.ts`): `buildSearchUrl` (query/sort/max_price; geo
  `postal` + **exact** `search_distance` with no snapping; non-zip place name omitted;
  `condition` only for `new`; throws with no region); `toListing` (id from post URL,
  rejects foreign host / no id, carries location & seller rating); registry (resolvable
  when named, **absent from defaults**).
- **Bun e2e** (`tests/bun/e2e/craigslist-fetch.test.ts` + a hand-authored
  `tests/fixtures/craigslist/results.html`): real Playwright over a local Craigslist-shaped
  page → `reduceResultsText` yields one block per linked card with its `URL:` line and
  location text; a linkless card is dropped; an empty page fails loud. No LLM, so it stays
  free and deterministic (the full `search()` LLM path is verified live by Ben, like eBay).

## Out of scope tonight (Ben-gated / irreversible)

- Enabling Craigslist in `DEFAULT_SOURCES` (needs the live-selector smoke).
- Facebook Marketplace, vision fallback, detection mitigations, Docker.
- Merge to main / push (classifier-blocked for Claude anyway).

## Open questions for Ben

1. **Region strategy.** Default is a single `CRAIGSLIST_REGION` env (this is a
   *personal, single-user* agent — Ben lives in one place). Acceptable, or do you want
   per-hunt region override on `/hunt`? (Easy to add later; the URL builder already takes
   region as a parameter.)
2. **Is Craigslist the right next source at all,** or would you rather I'd held for
   Marketplace? (Everything here is additive + opt-in + unmerged, so redirecting costs
   nothing.)
