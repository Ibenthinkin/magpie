# Magpie — Development Checklist

Derived from `SPEC.md` §14 build order. Check off as you go; each phase has an explicit exit criterion. Phases 0–2 deliver the working MVP; 3–5 add depth. Keep this file honest — it's the session-to-session source of progress truth. Update `SPEC.md` when decisions drift.

## Phase 0 — Engine spike (throwaway allowed)

> Goal: mode A against **eBay only**, end to end, posting result embeds to a Discord channel. Validates the core loop, extraction quality, and Discord plumbing before any breadth. **Throwaway code is acceptable here** — the point is learning, not architecture.

### Setup & secrets
- [ ] Create a Discord application + bot; enable the necessary gateway intents; generate the bot token.
- [ ] Invite the bot to the personal guild; create/choose Magpie's channel; collect guild id, channel id, own user id.
- [ ] Create an OpenRouter account + API key; pick a default model id for `MAGPIE_MODEL` (an Anthropic Claude).
- [ ] Populate `.env` from `.env.example` (all vars in SPEC §10); confirm `.env` is gitignored.
- [ ] `bunx playwright install chromium` (and confirm it runs on this Mac).

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
- [ ] Deterministic `landedCost` (price + shipping) sort; one-line LLM verdict per top listing.
- [ ] Post top-N results as Discord embeds (listing card: title link, landed cost, condition, source, thumbnail, verdict) to the channel.
- [ ] Console-log per-step timings + token cost for the run.

### Exit criteria
- [ ] **A real `/hunt` (or hardcoded query) for a known item returns sanely-ranked real eBay listings as embeds.** Extraction quality judged good enough to proceed. Note observed per-hunt token cost.

## Phase 1 — One-shot (A) + advisor (C): real scaffold

> Goal: production scaffold replacing the spike — schema, repositories, queue/worker, `/hunt` + `/advise` complete, 2–3 well-behaved sources, fixture adapter + test suite.

### Project structure
- [ ] `tsconfig.json` (strict), `src/` layout per SPEC §2.2, `src/index.ts` process entry.
- [ ] `src/config.ts` (or `env.ts`) — typed env loader validating all SPEC §10 vars at boot.
- [ ] Structured console logger (one line per hunt step; status/timings/cost fields).

### Database (Drizzle + bun-sqlite)
- [ ] `src/db/schema.ts` — all tables from SPEC §5 (`profile_fact`, `watch`, `hunt`, `listing`, `hunt_result`, `watch_hit`) + indexes §5.7. (Define all now even though watch/profile land later — one migration baseline.)
- [ ] `drizzle.config.ts`; `bun run db:generate` → migration; `bun run db:migrate` creates `data/magpie.db`.
- [ ] `src/db/client.ts` — bun-sqlite singleton, WAL mode, `MAGPIE_DB_PATH`.
- [ ] `src/db/hunts.ts` — `enqueueHunt`, `claimNextHunt()` (atomic `UPDATE…SET status='running' WHERE id=(SELECT…LIMIT 1)`), `completeHunt`, `failHunt`, `resetStaleRunning()`.
- [ ] `src/db/listings.ts` — `upsertListing` keyed on `(source, source_id)`, refreshes `last_seen_at`.

### Browser layer
- [ ] `src/browser/session.ts` — `getContext()` / `closeContext()`, one persistent context, serialized use.
- [ ] `src/browser/pacing.ts` — human-like randomized delays + per-source `minDelayMs` / `maxPerHour` enforcement (exists from Phase 0 for etiquette even before hard sources).

### Sources
- [ ] `src/sources/types.ts` — `SourceAdapter` interface (SPEC §6.3), `SourceId`, `RawListing`, `NormalizedListing`.
- [ ] `src/sources/registry.ts` — enabled-adapter registry; `spec.sources ∩ registry` resolution.
- [ ] `src/sources/ebay.ts` — real adapter (guided search-URL + result-page walk; LLM only for extraction). Pure `toListing`.
- [ ] `src/sources/fixture.ts` — adapter over a local static test site.
- [ ] Add 1–2 more well-behaved sources (Google Shopping/SERP + one retailer).

### Engine
- [ ] `src/engine/llm.ts` — promote the wrapper; accumulate token usage → `hunt.cost_cents`; `generateObject` for structured, `generateText`/`streamText` for advisor.
- [ ] `src/engine/target.ts` — `parseTarget(query)` → zod-validated `TargetSpec` (SPEC §6.2).
- [ ] `src/engine/extract.ts` — `extractListings` hardened; token-budget trimming; treat page text as untrusted data (schema-constrained, never instructions).
- [ ] `src/engine/rank.ts` — `landedCost(l, facts)` (pure, deterministic) + `rankListings` (sort + LLM verdict pass → `hunt_result`).
- [ ] `src/engine/hunt.ts` — orchestrate the 7-step flow (SPEC §8): target → plan → search (per adapter, paced, `upsertListing`, adapter failure logs + continues) → filter (hard constraints, pre-LLM) → rank → dedup (skip for one-shots) → report.

### Discord surface
- [ ] `src/discord/hub.ts` — channel binding to `DISCORD_CHANNEL_ID`, allowlist guard (`DISCORD_ALLOWED_USER_IDS`), agent identity. One file, no framework.
- [ ] `src/discord/gateway.ts` — client, guild-scoped command registration, allowlist wiring.
- [ ] `src/discord/embeds.ts` — listing card + status/error/"nothing found" embeds; color-coded by rank.
- [ ] `src/discord/commands/hunt.ts` — parse options, confirm parsed target in one line, defer + follow-up (3s interaction window), enqueue hunt.
- [ ] `src/discord/commands/advise.ts` — open a thread, clarifying Q&A loop, propose 2–4 candidates w/ pros/cons, end with **Hunt this** / **Watch this** buttons carrying the concretized `TargetSpec`.
- [ ] Wire the hunt worker loop (claim → run §8 → report → repeat; idle-sleep 5s empty) into `src/index.ts`; call `resetStaleRunning()` on boot.

### Tests (production-grade from the start — SPEC §12)
- [ ] Vitest: `landedCost` math, constraint filtering, `TargetSpec` zod edge cases, each adapter's `toListing`, `claimNextHunt` atomicity (concurrent claims on one DB).
- [ ] Fixture integration: saved-HTML fixtures `tests/fixtures/<source>/*.html` served by a local static server; adapter `search()` runs real Playwright against them. Extraction tested on recorded page-text fixtures; LLM mocked by default, `LIVE_LLM=1` opt-in live pass.
- [ ] Playwright e2e: full hunt through the `fixture` adapter — enqueue → engine → ranked results in DB. Discord tested at handler level with mocked interactions.

### Exit criteria
- [ ] `/hunt` and `/advise` work end-to-end across the multiple sources; the test suite is green; a real eBay smoke hunt succeeds.

## Phase 2 — Watchlists (B)

> Goal: standing watches on a scheduler → queue → worker pipeline with dedup; notifies only on genuinely new hits. Mode B is mode A on a timer + dedup.

- [ ] `src/db/watches.ts` — `dueWatches(now)`, `bumpNextRun(cadence + jitter)`, CRUD; `watch`/`watch_hit` live (schema from Phase 1).
- [ ] `src/watch/dedup.ts` — keep only listings with no `watch_hit` for this watch; insert `watch_hit` for new ones (notify at most once, ever).
- [ ] `src/watch/scheduler.ts` — croner tick every 60s: `dueWatches(now)` → `enqueueHunt(mode:'watch_run')` + `bumpNextRun` with ±10% jitter.
- [ ] `src/watch/worker.ts` — extend the worker to handle `watch_run` mode (§8 step 6 dedup active).
- [ ] Batched watch-hit embeds — one message per run, up to 5 cards, prefixed with the watch name (avoid ping spam).
- [ ] `src/discord/commands/watch.ts` — `add` (confirm parsed target, default cadence 24h), `list` (table: id, name, cadence, status, last-run, hit count), `pause`/`resume`/`remove` (soft state, never deletes listings).
- [ ] Wire the scheduler into `src/index.ts` alongside gateway + worker.
- [ ] Tests: scheduler due-selection + jitter bounds; dedup semantics (`watch_hit`); watch-lifecycle e2e (second run notifies nothing new).

### Exit criteria
- [ ] A watch created via `/watch add` runs on cadence, notifies on first hit, and stays silent on an unchanged second run. Hundreds of watches don't thundering-herd (jitter + rate limits hold).

## Phase 3 — Profile depth + best-deal logic

> Goal: memberships/coupons/specs consulted on every hunt; landed-cost refinements.

- [ ] `src/db/profile.ts` — `activeFacts()` + CRUD over `profile_fact`.
- [ ] `src/discord/commands/profile.ts` — `add` (`category` ∈ membership|coupon_source|spec, `label`, `value`), `list`, `remove`.
- [ ] Feed all active facts into `rankListings`; verdict must mention when a membership/coupon changed the ranking.
- [ ] `landedCost` refinements — deterministic membership/coupon discounts, condition + seller-rating adjustment, price-after-coupons.
- [ ] Scope "best deal" depth (SPEC §15 open question): how far coupon/promo hunting goes beyond stored memberships — decide and document in SPEC.
- [ ] Tests: `landedCost` membership/coupon cases; verdict mentions discount impact.

### Exit criteria
- [ ] A hunt with an active membership fact ranks a discounted listing correctly and the verdict cites the membership.

## Phase 4 — Hard sources (carefully)

> Goal: Facebook Marketplace / Craigslist with account-ban risk respected. The big risk — proceed deliberately.

- [ ] Harden `pacing.ts` — strict per-source rate caps, conservative human-like delays for marketplaces.
- [ ] Geo-local constraint handling — `TargetSpec.constraints.location` (`near` / `maxMiles`) end-to-end.
- [ ] `src/sources/craigslist.ts` and/or `src/sources/facebook.ts` — guided adapters; consider a dedicated account for Marketplace.
- [ ] Vision/screenshot fallback path wired for what the guided path can't reach (fallback only, not happy path).
- [ ] Detection mitigations as needed — `channel:'chrome'` real install and/or headed-in-xvfb (decided empirically; see SPEC §15).
- [ ] Fixtures + tests for the new adapters' `toListing`.

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
