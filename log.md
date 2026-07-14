# Magpie — Project Log

Narrative record of decisions, findings, and dead-ends that don't live in commit
messages. `/brief` reads this. Newest on top.

## 2026-07

### [[07-14-26 Tue]] — Phase 1 scaffold begins: config, DB/queue, sources layer

**Shipped** (overnight autonomous session, branch `phase-1-scaffold`, milestones M0–M2 of the approved plan):
- **M0 — real project scaffold.** `tsconfig.json` (strict), `src/config.ts` (typed loader for all SPEC §10 vars, empty-string-as-unset, allowlist csv → array), `src/log.ts`, and the test-runner split: vitest owns `tests/unit/**`, `bun test` owns `tests/bun/**` (via `bunfig.toml` `[test] root`) so the 07-10 bun:sqlite/vitest finding is solved structurally, not by convention.
- **M1 — DB layer.** Full six-table SPEC §5 schema in one baseline Drizzle migration (watch/profile tables land now, logic later). drizzle-kit is codegen-only; migrations apply at runtime via the bun-sqlite migrator, so drizzle-kit never needs a driver. `claimNextHunt()` is a single atomic `UPDATE … RETURNING` with a rowid FIFO tie-break. Repos are factories over an injected db + clock, coded against `HuntsRepo`/`ListingsRepo` interfaces so everything above the DB stays vitest-testable.
- **M2 — sources layer.** `SourceAdapter` interface (`search()` returns `RawListing[]`; pure `toListing()` → §5.4 shape, `null` = unusable row), registry with `resolveAdapters` (unknown ids skipped loudly; fixture source opt-in only, never default), eBay promoted into the adapter shape, and a **deterministic fixture adapter** over a hand-authored local static site — the engine's offline/free e2e path. `pacing.ts` landed (per-source min-gap + hourly sliding window, injectable clock). 22 vitest + 13 bun tests green, incl. real-Playwright fixture-adapter tests on a throwaway browser.

**Decisions:**
- `@playwright/test` dropped for Phase 1: the SPEC §13 `test:e2e` script would run under Node where `bun:sqlite` doesn't exist; the e2e uses the playwright *library* under `bun test` instead (`test:e2e` = `bun test tests/bun/e2e`). SPEC needs a one-line amendment.
- `llm.ts` model init went lazy (was module-top-level env reads) so adapters/extract stay importable under vitest with the LLM mocked.
- Fixture HTML is hand-authored (a stable fake-market markup contract with deliberate edge-case cards), not captured eBay HTML — we control the edge cases and dodge markup churn.
- Empty `DISCORD_ALLOWED_USER_IDS` will mean *warn loudly at boot, deny all interactions* (it's still empty in `.env`) — so overnight live verification is send-only; the receive path gets exercised once the allowlist is filled.

**Open / next:** M3 engine orchestrator (`hunt.ts`, per-hunt cost accounting in `llm.ts`, deterministic pre-filter) → M4 worker + `index.ts` → M5 gateway + `/hunt` → M6 `/advise` → M7 offline e2e → M8 live gates → stretch Phase 2 groundwork → PR.

### [[07-11-26 Sat]] — System map artifact

**Shipped:**
- Published a one-page architecture/system-design artifact for Magpie — physical topology, layered service architecture, the three engine-mode data flows, and the load-bearing invariants: https://claude.ai/code/artifact/2d576775-2542-4021-b5d4-cf9e1a7d4955. Styled as a sibling of the Sibyl system map (same editorial layout, magpie-teal palette instead of Sibyl gold).
- The live-vs-planned split reflects the *repo's* actual state, not the spec's aspiration: Phase 0 pieces (`session.ts`, `ebay.ts`, `target/extract/rank/llm`, `embeds.ts`) marked built; everything Phase 1+ dashed with its phase tag, including the pulled-forward `pacing.ts` and the `bun:sqlite`/vitest test split from the 07-10 finding. Worth re-publishing at phase boundaries so it stays honest.

### [[07-10-26 Fri]] — bun:sqlite doesn't work under vitest

**Findings / gotchas:**
- **`bun:sqlite` cannot be imported inside a vitest test file, full stop.** Confirmed with a throwaway probe (`tests/probe-bun-sqlite.test.ts`): `vitest run` (invoked via `bun run test`) fails with `Cannot find package 'bun:sqlite'`. Tried the two standard workarounds — `test.server.deps.external: [/^bun:/]` and `pool: 'threads'`, together and separately — neither works. With externalization on, the error changes to Node's ESM loader rejecting the `bun:` scheme outright (`Only URLs with a scheme in: file, data, and node are supported`), which means vitest/vite-node's module runner falls back to a Node-based loader for native-protocol imports regardless of which runtime (`bun run`) invoked vitest. This looks like a real vitest/vite-node limitation, not a config mistake on our end.
- This matters immediately: CLAUDE.md commits to `bun run test = vitest run`, and the next unchecked Phase 1 item is `src/db/client.ts` on `bun:sqlite`.

**Decisions:**
- Keep `bun:sqlite` as the Phase 1 db driver (not switching to `better-sqlite3`). `src/db/client.ts` stays a thin `bun:sqlite` singleton; everything built on top of it (`hunts.ts`, `listings.ts`, repositories) is unit-tested in vitest via mocks/fakes, never a live db. A small number of true integration tests exercise the real sqlite path via `bun test` (Bun's native runner) instead of `vitest run`. Recorded in `CHECKLIST.md` under Phase 1 Database.

### [[07-09-26 Thu]] — Discord embeds land; eBay adapter was scraping the wrong DOM

**Shipped:**
- `src/discord/embeds.ts` — pure embed builders (listing card, nothing-found card, results header), no client/IO, ready for Phase 1 to promote.
- `scripts/smoke-discord.ts` — send-only gateway login (real `Client`, not a webhook, so Phase 1 reuses the same plumbing) posting the ranked top-5 as one message.
- **Phase 0 closed.** MX Master 3S: 60/60 rows extracted, top-5 all genuine units, every card links to a resolving `/itm/` listing. ~14.0k in / 12.7k out tokens, ~104s per hunt.

**Findings / gotchas:**
- **The eBay adapter had been scraping the wrong DOM the whole time, silently.** `fetchResultsText` did `querySelector('ul.srp-results') ?? document.body` — and eBay serves *two different result layouts*: `li.s-card` under `ul.srp-results` when **signed out**, `li.su-grid__item` under `ul.su-grid` when **signed in**. Since the persistent profile is signed in, the selector missed, the `?? document.body` fallback swallowed it, and extraction ran over whole-page innerText. It *looked* fine (41 rows, sane verdicts) because the listing text is in the body either way. The tell was every `url` coming back `null`. Adapter now matches either card class, and throws when zero cards match rather than falling back.
- **That silent fallback was also the "intermittent empty-extraction flake"** logged 07-08 (838-token page text, 0 rows) — not a settle race. Same root cause, different symptom.
- `innerText` drops hrefs, so the extractor never had a URL to extract; no amount of prompt work would have fixed it. Reduced text is now one block per card: card text + `URL: <canonical /itm/ url>` (query params stripped).
- The signed-in SRP ships a **template anchor** pointing at the placeholder `ebay.com/itm/123456`. Taking the first `a[href*="/itm/"]` per card would have emitted a fake link that still renders as a valid card. Item links now require `/itm/\d{9,}`.
- eBay bounced us through `https://www.ebay.com/splashui/challenge` (bot check) after ~8 rapid headless loads. It auto-redirected back and results rendered, but this is the first real sighting of eBay's bot detection — `loadResults` now detects the challenge URL and fails with a clear message instead of blindly retrying (retrying a bot check makes it worse). Argues for landing `src/browser/pacing.ts` sooner than Phase 1 nominally requires.
- Sponsored badges arrive in innerText as `derosnopS` — "Sponsored" reversed via a CSS direction flip, an anti-scraper trick. Stripped as noise.

**Decisions:**
- Embed titles use `setTitle` + `setURL`, not the design spec's masked `[title](url)` — Discord doesn't render markdown in embed titles, so the masked form would show literally. Same clickable result.
- `buildResultsHeader` takes an explicit `shownCount` rather than hardcoding "top 5", so a 2-result hunt doesn't claim 5.
- Extraction budget raised 12k → 16k chars: the per-card URL line costs ~40 chars/row, and whole rows are budgeted (never a partial row — a row truncated mid-URL yields a plausible card pointing at the wrong item).

**Open / next:**
- Phase 1 scaffold: `tsconfig.json`, `src/config.ts` typed env loader, `src/index.ts`, Drizzle schema + queue.
- `DISCORD_ALLOWED_USER_IDS` is still empty — needed before any receive path exists.
- Thumbnail on the card is deferred: extraction captures no image URL yet. Location and seller rating *are* present in the card text (`Located in United States`, `seller 99.2% positive (11.8K)`) and would be cheap to add to the extraction schema.
- Consider running extraction on Haiku: it dominates cost (9.6k output tokens of the run's 12.7k).

### [[07-08-26 Wed]] — Phase 0 engine spike + in-repo log
**Shipped:**
- Browser layer: persistent-context Chromium (`src/browser/session.ts`) with a real-Chrome UA and `HEADLESS` toggle; `scripts/login.ts` for the one-time manual eBay login (session persists across restarts, profile mode 700).
- LLM wrapper (`src/engine/llm.ts`) over OpenRouter / Claude Sonnet 5 — single call path with token accounting.
- Target parser (`src/engine/target.ts`) and eBay guided search + extraction (`src/sources/ebay.ts`, `src/engine/extract.ts`). End-to-end smoke: freeform query → 40/40 valid structured listings off live eBay.
- Ranking (`src/engine/rank.ts`): pure `landedCost` (price + shipping) sort + a single batched LLM verdict pass. Verdicts are sharp — correctly flag accessories/parts and a suspiciously-cheap "mouse".
- This in-repo `log.md` convention + `/brief` integration.

**Decisions:**
- Keep the main eBay account for Phase 0 — read-only, human-paced browsing is low-risk, and a fresh account is *more* likely to get flagged. Reserve a dedicated/burner account for Facebook Marketplace in Phase 4.
- Extraction/target schemas avoid zod `.int()/.positive()/.min()/.max()` — Anthropic structured output rejects numeric min/max keywords (fails loud with a 400). Encode such intent in `.describe()` text instead. See memory `anthropic-structured-output-schema-limits`.
- Project log lives in-repo (`log.md` at root) and complements commits; retired the dead `VAULT_LOG_PATH` vault rollup.

**Findings / gotchas:**
- Empty-string env vars copied from `.env.example` (`BROWSER_PROFILE_DIR=`) silently override `??` fallbacks — the persistent profile was landing in an ephemeral dir and logins wouldn't have survived. Fixed by treating `""` as unset.
- OpenRouter is prepaid; the first real LLM call 402'd until credits were added.
- Per-hunt token cost is dominated by extraction *output* tokens (~5.6k out for 40 rows). Levers if it bites: cap extracted rows, or run extraction on Haiku while keeping verdicts on Sonnet.

**Relevance-aware ranking — built (two-pass).** First tried a single verdict pass over the cheapest 15 that also returned `matchesTarget`; it correctly re-sorted real units above accessories, but the cheapest-15 *pool* biased toward junk — the only real units it saw were suspiciously cheap ($17–20 vs ~$60–70 retail) and fairly-priced units above slot 15 never got judged. Fixed by splitting into two passes (`src/engine/rank.ts`): **pass 1** a cheap `matchesTarget` triage (bool only, no prose) over *all* extracted rows; sort `matchesTarget` desc → `landedCost` asc → top 5; **pass 2** prose verdicts for just those finalists. Smoke (MX Master 3S): top-5 are now *all* genuine units ($17.76 → $33.24, incl. a brand-new one), zero accessories/button-boards/scroll-wheels. Cost stayed modest — pass 1 in=2850/out=650, pass 2 in=762/out=321, run ~11.3k in / 6.6k out, ~54s. Ranking exit criterion met.
- Ticked all Phase-0 **Setup & secrets** boxes. Machine-verified: playwright `chromium-1228` installed, `.env` populated (443 B) + gitignored, OpenRouter working (live calls). Discord app/token/ids on owner's word (`.env` is shell-read-guarded; Discord not yet wired).

**Open / next (pick up here):**
- Post top-N as Discord embeds (first gateway wiring) — the one remaining Phase 0 checklist item; closes Phase 0.
- Watch for the intermittent empty-extraction flake: one smoke run got ~838-token page text (0 rows) before a clean retry — eBay interstitial or page not settled. If it recurs, harden `fetchResultsText` (wait-for results selector / retry).
