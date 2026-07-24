# Magpie — Development Checklist

Derived from `SPEC.md` §14 build order. Check off as you go; each phase has an explicit exit criterion. Phases 0–2 deliver the working MVP; 3–5 add depth. Keep this file honest — it's the session-to-session source of progress truth. Update `SPEC.md` when decisions drift.

## Phase 0 — Engine spike (throwaway allowed)

> Goal: mode A against **eBay only**, end to end, posting result embeds to a Discord channel. Validates the core loop, extraction quality, and Discord plumbing before any breadth. **Throwaway code is acceptable here** — the point is learning, not architecture.

### Setup & secrets
- [x] Create a Discord application + bot; enable the necessary gateway intents; generate the bot token.
- [x] Invite the bot to the personal guild; create/choose Magpie's channel; collect guild id, channel id, own user id. — guild + channel ids in `.env`, both verified by a live post. `DISCORD_ALLOWED_USER_IDS` still empty; only needed by the Phase 1 receive path.
- [x] Create an OpenRouter account + API key; pick a default model id for `MAGPIE_MODEL` (an Anthropic Claude). — verified via live LLM calls in Phase 0.
- [x] Populate `.env` from `.env.example` (all vars in SPEC §10); confirm `.env` is gitignored. — `.env` populated (443 B) and gitignored.
- [x] `bunx playwright install chromium` (and confirm it runs on this Mac). — `chromium-1228` installed; smoke-verified against live eBay.

### Browser + login
- [x] Minimal persistent-context launch (`chromium.launchPersistentContext(BROWSER_PROFILE_DIR)`), real-Chrome UA, headed toggle via `HEADLESS`. — `src/browser/session.ts`; smoke-verified against real eBay, UA carries no Headless tell.
- [x] `scripts/login.ts` — headed session to log into eBay manually once; confirm the session persists across a restart (cookies in `browser-profile/`). — logged in; session persists across restart.
- [x] `chmod 700 browser-profile/`; confirm it's gitignored.

### LLM + extraction
- [x] OpenRouter LLM wrapper (Vercel AI SDK + `@openrouter/ai-sdk-provider`); one call path; log token usage to console. — `src/engine/llm.ts` (`genObject`), logs in/out tokens + running tally.
- [x] Parse a raw query → rough `TargetSpec` via `generateObject` (zod schema, even if minimal). — `src/engine/target.ts`; smoke-verified, correctly extracted price/condition/must-haves.
- [x] eBay: build search URL from target, navigate, grab reduced page text (innerText / a11y snapshot, trimmed to a token budget). — `src/sources/ebay.ts` (`buildSearchUrl` + `fetchResultsText`, 12k-char budget).
- [x] `extractListings(pageText, target)` → structured rows via `generateObject`; drop invalid rows with a warning (never crash). — `src/engine/extract.ts`; lenient LLM schema + per-row strict validation; smoke got 40/40 valid rows off live eBay.

### Rank + report
- [x] Deterministic `landedCost` (price + shipping) sort; two-pass LLM ranking. — `src/engine/rank.ts`: pure `landedCost` + **pass 1** cheap `matchesTarget` triage (bool only) over *all* extracted rows → sort `matchesTarget` desc → `landedCost` asc → top 5 → **pass 2** prose verdict per finalist. Smoke: top-5 are all genuine MX Master 3S units, accessories/parts fully excluded. ~11.3k in / 6.6k out tokens/run.
- [x] Post top-N results as Discord embeds (listing card: title link, landed cost, condition, source, thumbnail, verdict) to the channel. — `src/discord/embeds.ts` (pure builders) + `scripts/smoke-discord.ts` (send-only gateway login). Thumbnail deferred: extraction captures no image URL yet (Phase 1).
- [x] Console-log per-step timings + token cost for the run. — `scripts/smoke-rank.ts` logs elapsed + token totals.

### Exit criteria
- [x] **A real `/hunt` (or hardcoded query) for a known item returns sanely-ranked real eBay listings as embeds.** Extraction quality judged good enough to proceed. Note observed per-hunt token cost. — MX Master 3S: 60/60 rows extracted, top-5 all genuine units with resolving `/itm/` links. ~14.0k in / 12.7k out tokens, ~104s.

## Phase 1 — One-shot (A) + advisor (C): real scaffold

> Goal: production scaffold replacing the spike — schema, repositories, queue/worker, `/hunt` + `/advise` complete, 2–3 well-behaved sources, fixture adapter + test suite.

### Project structure
- [x] `tsconfig.json` (strict), `src/` layout per SPEC §2.2, `src/index.ts` process entry.
- [x] `src/config.ts` (or `env.ts`) — typed env loader validating all SPEC §10 vars at boot.
- [x] Structured console logger (one line per hunt step; status/timings/cost fields).

### Database (Drizzle + bun-sqlite)
> `bun:sqlite` cannot be imported inside a vitest test file — confirmed, not a config
> issue (see log.md 07-10). `src/db/client.ts` stays on `bun:sqlite`; everything above
> it (`hunts.ts`, `listings.ts`, etc.) is exercised in vitest through a repository
> interface / mocks, not a live db. A small set of real-sqlite integration tests run
> separately via `bun test` (Bun's native runner), not `bun run test`.
- [x] `src/db/schema.ts` — all tables from SPEC §5 (`profile_fact`, `watch`, `hunt`, `listing`, `hunt_result`, `watch_hit`) + indexes §5.7. (Define all now even though watch/profile land later — one migration baseline.)
- [x] `drizzle.config.ts`; `bun run db:generate` → migration; `bun run db:migrate` creates `data/magpie.db`.
- [x] `src/db/client.ts` — bun-sqlite singleton, WAL mode, `MAGPIE_DB_PATH`.
- [x] `src/db/hunts.ts` — `enqueueHunt`, `claimNextHunt()` (atomic `UPDATE…SET status='running' WHERE id=(SELECT…LIMIT 1)`), `completeHunt`, `failHunt`, `resetStaleRunning()`.
- [x] `src/db/listings.ts` — `upsertListing` keyed on `(source, source_id)`, refreshes `last_seen_at`.

### Browser layer
- [x] `src/browser/session.ts` — `getContext()` / `closeContext()`, one persistent context, serialized use.
- [x] `src/browser/pacing.ts` — human-like randomized delays + per-source `minDelayMs` / `maxPerHour` enforcement (exists from Phase 0 for etiquette even before hard sources).

### Sources
- [x] `src/sources/types.ts` — `SourceAdapter` interface (SPEC §6.3), `SourceId`, `RawListing`, `NormalizedListing`.
- [x] `src/sources/registry.ts` — enabled-adapter registry; `spec.sources ∩ registry` resolution.
- [x] `src/sources/ebay.ts` — real adapter (guided search-URL + result-page walk; LLM only for extraction). Pure `toListing`.
- [x] `src/sources/fixture.ts` — adapter over a local static test site.
- [ ] Add 1–2 more well-behaved sources (Google Shopping/SERP + one retailer). *Deferred — eBay + fixture carried Phases 1–3; the registry and `sourceLabel` are ready for a second live source whenever it's wanted.*

### Engine
- [x] `src/engine/llm.ts` — promote the wrapper; accumulate token usage → `hunt.cost_cents`; `generateObject` for structured, `generateText`/`streamText` for advisor.
- [x] `src/engine/target.ts` — `parseTarget(query)` → zod-validated `TargetSpec` (SPEC §6.2).
- [x] `src/engine/extract.ts` — `extractListings` hardened; token-budget trimming; treat page text as untrusted data (schema-constrained, never instructions).
- [x] `src/engine/rank.ts` — `landedCost(l, facts)` (pure, deterministic) + `rankListings` (sort + LLM verdict pass → `hunt_result`).
- [x] `src/engine/hunt.ts` — orchestrate the 7-step flow (SPEC §8): target → plan → search (per adapter, paced, `upsertListing`, adapter failure logs + continues) → filter (hard constraints, pre-LLM) → rank → dedup (skip for one-shots) → report.

### Discord surface
- [x] `src/discord/hub.ts` — channel binding to `DISCORD_CHANNEL_ID`, allowlist guard (`DISCORD_ALLOWED_USER_IDS`), agent identity. One file, no framework.
- [x] `src/discord/gateway.ts` — client, guild-scoped command registration, allowlist wiring.
- [x] `src/discord/embeds.ts` — listing card + status/error/"nothing found" embeds; color-coded by rank.
- [x] `src/discord/commands/hunt.ts` — parse options, confirm parsed target in one line, defer + follow-up (3s interaction window), enqueue hunt.
- [x] `src/discord/commands/advise.ts` — open a thread, clarifying Q&A loop, propose 2–4 candidates w/ pros/cons, end with **Hunt this** / **Watch this** buttons carrying the concretized `TargetSpec`.
- [x] Wire the hunt worker loop (claim → run §8 → report → repeat; idle-sleep 5s empty) into `src/index.ts`; call `resetStaleRunning()` on boot.

### Tests (production-grade from the start — SPEC §12)
- [x] Vitest: `landedCost` math, constraint filtering, `TargetSpec` zod edge cases, each adapter's `toListing`, `claimNextHunt` atomicity (concurrent claims on one DB).
- [x] Fixture integration: saved-HTML fixtures `tests/fixtures/<source>/*.html` served by a local static server; adapter `search()` runs real Playwright against them. Extraction tested on recorded page-text fixtures; LLM mocked by default, `LIVE_LLM=1` opt-in live pass.
- [x] Playwright e2e: full hunt through the `fixture` adapter — enqueue → engine → ranked results in DB. Discord tested at handler level with mocked interactions.

### Exit criteria
- [x] `/hunt` and `/advise` work end-to-end across the multiple sources; the test suite is green; a real eBay smoke hunt succeeds. *Met against eBay alone (60/60 rows, 16¢) — "multiple sources" was descoped with the item above.*

## Phase 2 — Watchlists (B)

> Goal: standing watches on a scheduler → queue → worker pipeline with dedup; notifies only on genuinely new hits. Mode B is mode A on a timer + dedup.

- [x] `src/db/watches.ts` — `dueWatches(now)`, `bumpNextRun(cadence + jitter)`, CRUD; `watch`/`watch_hit` live (schema from Phase 1).
- [x] ~~`src/watch/dedup.ts`~~ — keep only listings with no `watch_hit` for this watch; insert `watch_hit` for new ones (notify at most once, ever). *Landed as `unseenListingIds`/`insertHits` in `src/db/watches.ts` + engine step 6, not its own file — the logic is two queries and belongs with the repo.*
- [x] `src/watch/scheduler.ts` — croner tick every 60s: `dueWatches(now)` → `enqueueHunt(mode:'watch_run')` + `bumpNextRun` with ±10% jitter.
- [x] `src/watch/worker.ts` — extend the worker to handle `watch_run` mode (§8 step 6 dedup active).
- [x] Batched watch-hit embeds — one message per run, up to 5 cards, prefixed with the watch name (avoid ping spam).
- [x] `src/discord/commands/watch.ts` — `add` (confirm parsed target, default cadence 24h), `list` (table: id, name, cadence, status, last-run, hit count), `pause`/`resume`/`remove` (soft state, never deletes listings).
- [x] Wire the scheduler into `src/index.ts` alongside gateway + worker.
- [x] Tests: scheduler due-selection + jitter bounds; dedup semantics (`watch_hit`); watch-lifecycle e2e (second run notifies nothing new).

### Exit criteria
- [x] A watch created via `/watch add` runs on cadence, notifies on first hit, and stays silent on an unchanged second run. Hundreds of watches don't thundering-herd (jitter + rate limits hold).

## Phase 3 — Profile depth + best-deal logic

> Goal: memberships/coupons/specs consulted on every hunt; landed-cost refinements.

- [x] `src/db/profile.ts` — `activeFacts()` + CRUD over `profile_fact`.
- [x] `src/discord/commands/profile.ts` — `add` (`category` ∈ membership|coupon_source|spec, `label`, `value`), `list`, `remove`.
- [x] Feed all active facts into `rankListings`; verdict must mention when a membership/coupon changed the ranking.
- [x] `landedCost` refinements — deterministic membership/coupon discounts, condition + seller-rating adjustment, price-after-coupons. *Condition and seller rating are verdict-layer judgment, not cost math (SPEC §6.5); seller rating is now extracted and shown.*
- [x] Scope "best deal" depth (SPEC §15 open question): how far coupon/promo hunting goes beyond stored memberships — decide and document in SPEC. *Answer: stored source-scoped facts only, no coupon hunting — rule in SPEC §6.5, bullet resolved in §15.*
- [x] Tests: `landedCost` membership/coupon cases; verdict mentions discount impact.

### Exit criteria
- [x] A hunt with an active membership fact ranks a discounted listing correctly and the verdict cites the membership. *Live-smoked 2026-07-23: coupon fact active → discount line + ~10%-below-sticker landed price + verdict cites it + footer `eBay · #1`; removed the fact → same listings, no discount. Proven both directions against real eBay/Discord.*

## Phase 4 — Hard sources (carefully)

> Goal: Facebook Marketplace / Craigslist with account-ban risk respected. The big risk — proceed deliberately.

- [ ] Harden `pacing.ts` — strict per-source rate caps, conservative human-like delays for marketplaces.
- [x] Geo-local constraint handling — `TargetSpec.constraints.location` (`near` / `maxMiles`) end-to-end. *Narrowed at the source (eBay), radius snapped up to eBay's ladder; location extracted, ranked and shown. We deliberately never compute distance ourselves — no geocoder, so no fake math. Zip-anchored only; `/hunt` warns on a place name. **Live-smoked 2026-07-23 — and caught a real bug**: `_stpos`/`_sadis` alone are a silent no-op (byte-identical result set with/without them). eBay's only radius filter is local-pickup, so an anchored radius now also sets `LH_LPickup=1` + `LH_PrefLoc=99` + `_fspt=1` — narrows for real (3,700+ → 59) and eBay renders per-item "N mi from <zip>". Trade-off Ben chose: honoring "within N miles" = local-pickup only (no ship-only listings). Then two deeper extraction bugs, both fixed: (A) we dropped eBay's own per-card "N mi from <zip>" distance (extraction now prefers it — eBay's number, not a geocode); (B) we ingested eBay's out-of-radius padding ("Results matching fewer words" / "N items found from eBay international sellers", cards to 4,885 mi) — DOM reduction extracted into `reduceResultsText` and trimmed at those section headings. Pinned by `tests/bun/e2e/ebay-fetch.test.ts` from the real page. Re-confirmed live on the restarted signed-in process: cards show "N mi from <zip>", no cross-country items.*
- [~] `src/sources/craigslist.ts` and/or `src/sources/facebook.ts` — guided adapters; consider a dedicated account for Marketplace. *Craigslist done (mirrors `ebay.ts`): geo-aware `buildSearchUrl` (`postal` + **exact** `search_distance`, no ladder), LLM extraction via the shared path, `toListing` guarded on a craigslist.org post id, conservative pacing. **Live-verified 2026-07-24 against philadelphia CL — the verification caught four real bugs, three of which made the adapter unusable and one silent:** (1) the gallery card is a `DIV`, so `li.cl-search-result` matched 0 of 24 — selectors are tag-agnostic now; (2) post URLs are `/view/d/<slug>/<token>`, not `<pid>.html`, so `toListing` would have dropped **every** row while extraction looked fine — both shapes accepted, token confirmed stable 24/24 across loads; (3) `waitForSelector('attached')` resolved on a pre-hydration skeleton at ~200ms that the app then destroyed (~700ms, zero cards) before mounting real results at ~1200ms — now waits on a card with a link *and* text; (4) `sort=priceasc`, copied from eBay's `_sop=15`, gave 4/10 relevant vs 10/10 on CL's default relevance sort (CL matches body text loosely) — dropped, since we re-rank by landed cost anyway. Full live path proven: 12/12 rows extracted, 12 kept / 0 dropped, real locations, $0.033 extraction. **Still opt-in** (`sources:craigslist`) pending Ben setting `CRAIGSLIST_REGION` and choosing to promote. No login/account → no ban risk. Facebook Marketplace still open — deferred to a session Ben runs (account-ban risk, needs live testing).*
- [ ] Vision/screenshot fallback path wired for what the guided path can't reach (fallback only, not happy path).
- [ ] Detection mitigations as needed — `channel:'chrome'` real install and/or headed-in-xvfb (decided empirically; see SPEC §15).
- [x] Fixtures + tests for the new adapters' `toListing`. *Craigslist: unit tests for `buildSearchUrl` + `toListing`, plus a bun e2e reducing a hand-authored Craigslist-shaped fixture through real Playwright (`reduceResultsText`), no LLM. Suite: 163 vitest · 21 bun-db · 9 bun-e2e.*

### Exit criteria
- [ ] At least one hard source returns listings on the owner's logged-in account without triggering a block during measured, rate-capped use.

## Phase 5 — Generalize the hub

> Goal: only when a **second agent actually needs it** (no premature framework).

- [ ] Extract `src/discord/hub.ts` conventions (channel binding, allowlist, command registration, agent identity) into reusable multi-agent infrastructure.
- [ ] Migrate Magpie onto the extracted shell as its first tenant; prove a second agent can reuse it.

## Cross-cutting (do alongside, not last)

### Deployment (SPEC §13)
- [ ] `Dockerfile` — `FROM mcr.microsoft.com/playwright:<pinned>-jammy` + Bun installed.
- [ ] `docker-compose.yml` — volumes for `data/` + `browser-profile/`, `restart: unless-stopped`, headless Chromium, env from `.env`. No reverse proxy (outbound-only).
- [ ] Verify the persistent profile + SQLite volumes survive container restarts on the homelab.

### Observability & cost
- [ ] Every `hunt` row keeps `status`, `error`, timings, `cost_cents`. Watch `cost_cents` from Phase 0 onward against the $10–50/mo ceiling.

### Security (SPEC §11)
- [ ] `browser-profile/` mode 700, gitignored, never leaves host; no logged-in-page screenshots persisted or posted.
- [ ] Allowlist + guild-scoped commands enforced; embeds carry only queries + public listing data.
- [ ] Extraction prompts treat page text as data, never instructions; verdicts cite only structured fields.

### Project log (SPEC §16 / CLAUDE.md)
- [ ] Keep `log.md` at repo root current — append a dated `### [[MM-DD-YY ddd]]` entry (decisions/findings/next) on real progress: on-demand, at commit checkpoints, and as an end-of-session backstop. `/brief` reads it.
