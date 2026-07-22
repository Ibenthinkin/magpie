# Magpie — Technical Specification

> Build-ready spec for Magpie. Distilled from the shaped Idea-Forge idea + project plan via the Idea Forge "Spec" stage. This is the foundation a coding agent uses to scaffold and build v1. Living doc — update as decisions land.

## 1. Overview

**Magpie** is a **personal, homelab-hosted AI shopping agent**: a Playwright-driven browser agent that hunts the best price on a specific item, translates a fuzzy need into the right product, and watches standing wishlists across retail and local marketplaces — factoring in the owner's memberships, coupons, and recurring specs. It is talked to through a **Discord bot** that is the first tenant of a reusable multi-agent hub.

**Problem.** Finding the genuine best price on a thing means manually checking many sites (retail, eBay, local marketplaces) and remembering discount memberships and coupons — tedious. Often the harder problem is figuring out *which specific product* even meets a fuzzy need ("a cheap used workstation that accepts my server RAM").

**The core insight.** Three user-facing modes are **three modes of one engine**, not three products:

- **A — one-shot deal hunt:** "find the best price on *this* exact item right now."
- **B — always-on watchlist:** the same engine on a schedule against saved targets, notifying only on genuinely new hits.
- **C — product-discovery advisor:** a reasoning step *before* the engine that turns a described need into a concrete target spec.

**What makes it feasible.** The agent drives a **real Chrome with a persistent, logged-in profile on the owner's own machine** — automating a legitimate session rather than scraping as a hostile bot. That is what makes login-walled, anti-bot sources possible at all (approached carefully; see §15).

**Scale & posture.** Strictly **single-user, personal**. Never a product. No auth system, no multi-tenancy, no web UI in v1. Runs as one long-lived service on the homelab.

### Core features

- `/hunt` — one-shot best-deal hunt for a specific item across enabled sources, results as rich Discord embeds ranked by **total landed cost** (price + shipping − applicable discounts, adjusted for condition/seller).
- `/advise` — conversational need→product advisor; ends by offering to hunt or watch the concretized target.
- `/watch` — standing watchlists (dozens to hundreds) run by a scheduler → queue → worker pipeline with dedup; notifies only on new matches.
- `/profile` — persistent facts the agent consults on every hunt: memberships (e.g. warehouse club, employer discount portal), coupon/loyalty sources, recurring specs (e.g. "server HDDs ≥ 10 TB, CMR not SMR", bike-fit measurements).
- Discord **multi-agent hub** conventions (channel-per-agent, embed vocabulary) built to be reused by future agents.

### Tech

- **TypeScript** on **Bun** (runtime + package manager). Headless service — no Next.js/tRPC/web frontend in v1.
- **discord.js v14** — bot gateway, slash commands, embeds, buttons.
- **Playwright** (`chromium`, persistent context over a dedicated logged-in profile) — the browsing engine. Vision/screenshot reasoning only as a fallback.
- **LLM via OpenRouter** (Vercel AI SDK + `@openrouter/ai-sdk-provider`; default model an Anthropic Claude, id configurable via `MAGPIE_MODEL`) — target parsing, page extraction, ranking verdicts, advisor conversations.
- **Drizzle ORM** over **SQLite** (`drizzle-orm/bun-sqlite`; single file DB, zero-ops).
- **Vitest** (unit) + **Playwright Test** (integration/e2e against fixtures).

## 2. Architecture

### 2.1 High-level

- **One long-lived Bun process** (`src/index.ts`) hosts three concerns: the Discord gateway, the hunt worker, and the watch scheduler. No external queue/broker — the queue is a table.
- **Discord gateway** receives commands, writes `hunt`/`watch` rows, and renders results/notifications as embeds.
- **Hunt worker** claims pending hunts from SQLite one at a time, drives the browser through source adapters, extracts and ranks listings, writes results, reports back to the originating channel.
- **Watch scheduler** ticks every minute, marks due watches, and enqueues hunts for them (mode B is literally mode A on a timer + dedup).
- **Datastore:** one SQLite file (`data/magpie.db`) — profile, hunts, listings, watches, seen-history.
- **Browser:** a persistent Chromium context over `browser-profile/` where the owner has logged into sources once (headed, via a login script). Cookies/sessions persist across runs.

### 2.2 Application layers

**Interface** — `src/discord/`: `gateway.ts` (client, command registration, allowlist guard), `commands/` (`hunt.ts`, `advise.ts`, `watch.ts`, `profile.ts`), `embeds.ts` (listing card + watch-hit embed builders), `hub.ts` (multi-agent conventions: channel binding, agent identity — kept factored for future extraction, §14 Phase 5).

**Engine (domain)** — `src/engine/`: `hunt.ts` (orchestrates one hunt end-to-end), `advisor.ts` (mode C conversation → `TargetSpec`), `target.ts` (query → `TargetSpec` parsing), `extract.ts` (page content → structured listings), `rank.ts` (landed-cost math + LLM verdict), `llm.ts` (OpenRouter client wrapper).

**Browser** — `src/browser/`: `session.ts` (persistent context lifecycle), `pacing.ts` (human-like delays, per-source rate limits).

**Sources** — `src/sources/`: `types.ts` (`SourceAdapter` interface), one adapter per source (`ebay.ts` first; `fixture.ts` for tests), `registry.ts`.

**Watch pipeline** — `src/watch/`: `scheduler.ts` (due-marking tick), `worker.ts` (claim → run → report loop), `dedup.ts`.

**Data access** — `src/db/`: `schema.ts` (Drizzle), `client.ts`, repositories (`hunts.ts`, `listings.ts`, `watches.ts`, `profile.ts`).

## 3. Functional requirements

### 3.1 `/hunt` (mode A)
- `/hunt query:<text> [max_price:<number>] [sources:<csv>]` in the agent's channel starts a hunt.
- The query is parsed into a `TargetSpec` (LLM), confirmed back in one line ("Hunting: *Casio A168WG-9VT, used or new, ≤ $60* across eBay…"), then executed.
- Results: top N (default 5) listings as embeds, ranked by landed cost, each with a one-line verdict and a link. Zero results is an explicit "nothing found" reply, not silence.
- A hunt that fails mid-run reports the error to the channel and marks the `hunt` row `failed` (never silently dies).
- Long hunts post a "working…" acknowledgment immediately (Discord's 3-second interaction window → defer + follow-up).

### 3.2 `/advise` (mode C)
- `/advise need:<text>` opens a thread; the agent asks clarifying questions and proposes 2–4 concrete candidate products with pros/cons.
- The thread ends with buttons: **Hunt this** (starts a mode-A hunt for the chosen candidate) and **Watch this** (creates a watch). Both carry the concretized `TargetSpec` — no re-typing.

### 3.3 `/watch` (mode B)
- `/watch add query:<text> [cadence:<hours>] [max_price:<number>]` creates an active watch (default cadence 24 h).
- `/watch list` shows all watches with id, name, cadence, status, last-run, hit count.
- `/watch pause|resume|remove id:<id>` manage lifecycle. Removing keeps history (soft state change), never deletes listings.
- A due watch runs like a hunt, but only listings **never seen before by that watch** produce a notification embed. Re-listed/price-changed items update `last_seen_at` silently in v1.
- Watch runs are rate-limited and staggered (§9); hundreds of watches must not thundering-herd sources.

### 3.4 `/profile`
- `/profile add category:<membership|coupon_source|spec> label:<text> value:<text>` — e.g. `membership / warehouse club / active`, `spec / server HDDs / ≥10TB, CMR only`.
- `/profile list` and `/profile remove id:<id>`.
- Every hunt's ranking step receives all active profile facts; the verdict must mention when a membership/coupon changed the ranking.

### 3.5 Hub behavior
- The bot only responds in its bound channel(s) and only to allowlisted Discord user ids (`DISCORD_ALLOWED_USER_IDS`). All other messages/commands are ignored.
- All slash commands are guild-scoped (instant registration, single-guild personal server).

## 4. Non-functional requirements

- **Cost** — target **$10–50/mo LLM spend ceiling**. Playwright-first (text/DOM extraction, no screenshots on the happy path); per-hunt token accounting persisted to `hunt.cost_cents`; watch cadence defaults conservative (daily).
- **Politeness / self-preservation** — per-source rate limits and human-like pacing (randomized delays) in `pacing.ts`; worker concurrency 1; hard per-source floor between visits. This is both etiquette and account-ban protection.
- **Reliability** — the service survives restarts: queue state lives in SQLite, a crashed hunt is re-claimable (stale `running` hunts reset on boot); a broken source adapter fails that source only, not the whole hunt.
- **Maintainability** — adapters isolated and independently testable against saved-HTML fixtures; site drift breaks one file, and the failure is loud (error embed) not silent.
- **Observability** — structured console logs (one line per hunt step); every hunt row keeps `status`, `error`, timings, token cost.
- **Single-user posture** — no public network surface at all: outbound-only (Discord gateway websocket + sites). Nothing to reverse-proxy.

## 5. Data model & database schema (SQLite, via Drizzle)

All timestamps are ISO-8601 TEXT (UTC). Ids are nanoids. `target_json` columns hold a serialized `TargetSpec` (§6.2).

### 5.1 `profile_fact`
```sql
CREATE TABLE profile_fact (
  id         TEXT PRIMARY KEY,
  category   TEXT NOT NULL,               -- 'membership' | 'coupon_source' | 'spec'
  label      TEXT NOT NULL,
  value      TEXT NOT NULL,               -- freeform detail the ranking prompt consumes
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### 5.2 `watch`
```sql
CREATE TABLE watch (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,           -- short human label, shown in /watch list
  target_json     TEXT NOT NULL,
  cadence_minutes INTEGER NOT NULL DEFAULT 1440,
  next_run_at     TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'paused' | 'removed'
  channel_id      TEXT NOT NULL,           -- where hits get posted
  last_run_at     TEXT,
  created_at      TEXT NOT NULL
);
```

### 5.3 `hunt`
One row per engine run — one-shot, watch-triggered, or advisor-spawned.
```sql
CREATE TABLE hunt (
  id          TEXT PRIMARY KEY,
  mode        TEXT NOT NULL,               -- 'oneshot' | 'watch_run'
  query       TEXT NOT NULL,               -- raw user text (or watch name)
  target_json TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending', -- 'pending'|'running'|'done'|'failed'
  watch_id    TEXT REFERENCES watch(id),   -- null for one-shots
  channel_id  TEXT NOT NULL,
  error       TEXT,
  cost_cents  INTEGER,                     -- LLM spend for this run
  started_at  TEXT,
  finished_at TEXT,
  created_at  TEXT NOT NULL
);
```

### 5.4 `listing`
Normalized listing identity + dedup anchor. `UNIQUE(source, source_id)` → re-encounters upsert.
```sql
CREATE TABLE listing (
  id             TEXT PRIMARY KEY,
  source         TEXT NOT NULL,            -- 'ebay' | ...
  source_id      TEXT NOT NULL,            -- id within that source
  url            TEXT NOT NULL,
  title          TEXT NOT NULL,
  price_cents    INTEGER,
  shipping_cents INTEGER,
  currency       TEXT NOT NULL DEFAULT 'USD',
  condition      TEXT,                     -- 'new' | 'used' | 'refurbished' | raw
  seller_rating  REAL,
  location       TEXT,
  image_url      TEXT,
  raw_json       TEXT NOT NULL,            -- full extracted payload, for reprocessing
  first_seen_at  TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL,
  UNIQUE (source, source_id)
);
```

### 5.5 `hunt_result`
```sql
CREATE TABLE hunt_result (
  hunt_id           TEXT NOT NULL REFERENCES hunt(id),
  listing_id        TEXT NOT NULL REFERENCES listing(id),
  rank              INTEGER NOT NULL,
  landed_cost_cents INTEGER,
  verdict           TEXT,                  -- one-line LLM reasoning shown in the embed
  PRIMARY KEY (hunt_id, listing_id)
);
```

### 5.6 `watch_hit`
The dedup ledger: a watch notifies on a listing at most once, ever.
```sql
CREATE TABLE watch_hit (
  watch_id    TEXT NOT NULL REFERENCES watch(id),
  listing_id  TEXT NOT NULL REFERENCES listing(id),
  notified_at TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (watch_id, listing_id)
);
```

### 5.7 Indexes
```sql
CREATE INDEX idx_watch_due       ON watch(status, next_run_at);
CREATE INDEX idx_hunt_claimable  ON hunt(status, created_at);
CREATE INDEX idx_listing_source  ON listing(source);
```

## 6. Backend — engine, adapters & services

### 6.1 Browser session — `src/browser/session.ts`
```typescript
export async function getContext(): Promise<BrowserContext>;
// chromium.launchPersistentContext(env.BROWSER_PROFILE_DIR, {
//   headless: env.HEADLESS !== 'false', viewport, userAgent: real-Chrome UA
// })
export async function closeContext(): Promise<void>;
```
- One persistent context, serialized use (worker concurrency 1 makes this safe).
- `scripts/login.ts` — headed one-time setup: opens the persistent context so the owner can log in to each source manually; sessions persist in `browser-profile/` (gitignored, mode 700).

### 6.2 Target spec — `src/engine/target.ts`
```typescript
export interface TargetSpec {
  description: string;                       // canonical item description
  constraints: {
    maxPriceCents?: number;
    conditions?: ('new' | 'used' | 'refurbished')[];
    mustHave?: string[];                     // e.g. ["≥ 10 TB", "CMR not SMR"]
    niceToHave?: string[];
    location?: { near?: string; maxMiles?: number };
  };
  sources?: SourceId[];                      // default: all enabled adapters
}
export function parseTarget(query: string): Promise<TargetSpec>;  // LLM, zod-validated
```

### 6.3 Source adapters — `src/sources/`
```typescript
export interface SourceAdapter {
  source: SourceId;                                        // 'ebay' | 'fixture' | ...
  rateLimit: { minDelayMs: number; maxPerHour: number };
  search(page: Page, target: TargetSpec): Promise<RawListing[]>;
  toListing(raw: RawListing): NormalizedListing;           // → §5.4 shape (pure, testable)
}
```
- Adapters are **guided, not free-form**: each knows its source's search-URL pattern and how to walk result pages; the LLM is used for *extraction* (messy page → structured listings, §6.4), not navigation, on the happy path.
- Free-form LLM-driven navigation (and vision/screenshots) is the **fallback path only**, for sources where the guided path breaks.
- v1 ships `ebay.ts` + `fixture.ts` (a local static site for tests). Additional adapters phase in per §14.

### 6.4 Extraction — `src/engine/extract.ts`
```typescript
export function extractListings(pageText: string, target: TargetSpec): Promise<RawListing[]>;
```
- Input is reduced page content (innerText / accessibility-snapshot, trimmed to a token budget), not raw HTML. Output zod-validated; invalid rows dropped with a logged warning, never a crash.

### 6.5 Ranking — `src/engine/rank.ts`
```typescript
export function discountCents(l: CostableListing, facts: ProfileFactRow[]): number;
export function landedCost(l: CostableListing, facts?: ProfileFactRow[]): number;
// price + shipping − deterministic membership/coupon discounts (cents), clamped ≥ 0
export function rankListings(
  listings: (RawListing & { source?: string })[], target: TargetSpec, facts?: ProfileFactRow[]
): Promise<RankedListing[]>;  // landed-cost sort + LLM verdict/adjustment pass
```
- Deterministic math first (unit-testable), LLM verdict second (condition/seller-rating/fit judgment, one line per listing).
- **The deterministic discount rule (Phase 3 — resolves the §15 "best deal" open question).** A `membership` or `coupon_source` fact is machine-applied **only when its text names the listing's source** — `"10% off ebay"` discounts eBay rows and nothing else. `N% off` comes off the item price; `$N off` comes off the landed total; percent wins when a fact contains both; applicable facts stack; landed cost clamps at ≥ 0. Matching is case-insensitive across the fact's label *and* value.
- **Everything fuzzier is verdict context, not math.** Facts that don't parse or don't name a source still reach both LLM passes as a profile block, so the model can narrate a deal it recognizes — but it never invents the number. The sort, the price ceiling (`applyConstraints`), and the stored `hunt_result.landed_cost_cents` all use the discounted figure, so "cheapest" always means price-after-coupons.
- Seller rating and condition are **verdict-layer inputs only** — they are shown on the listing line and the card, and the model is licensed to judge them, but they never adjust landed cost. Deterministic money math stays limited to figures we can defend arithmetically.

### 6.6 LLM client — `src/engine/llm.ts`
- Vercel AI SDK over `@openrouter/ai-sdk-provider`; model id from `MAGPIE_MODEL`. All calls flow through one wrapper that accumulates token usage → `hunt.cost_cents`. `generateObject` for structured outputs (target parsing, extraction), `generateText`/`streamText` for advisor conversation.

### 6.7 Repositories — `src/db/`
- `schema.ts`, `client.ts` (bun-sqlite singleton, WAL mode).
- `hunts.ts` — `enqueueHunt`, `claimNextHunt()` (atomic `UPDATE … SET status='running' WHERE id = (SELECT … LIMIT 1)`), `completeHunt`, `failHunt`, `resetStaleRunning()` (boot recovery).
- `listings.ts` — `upsertListing` (by `(source, source_id)`; refreshes `last_seen_at`).
- `watches.ts` — `dueWatches(now)`, `bumpNextRun`, CRUD.
- `profile.ts` — `activeFacts()`, CRUD.

## 7. Discord surface — commands, embeds, hub

### 7.1 Commands (guild-scoped slash commands)

| Command | Options | Effect |
|---|---|---|
| `/hunt` | `query` (req), `max_price`, `sources` | enqueue one-shot hunt; defer + follow-up embeds |
| `/advise` | `need` (req) | open advisor thread; ends in Hunt/Watch buttons |
| `/watch add` | `query` (req), `cadence`, `max_price` | create watch (confirms parsed target) |
| `/watch list` | — | table embed of all watches |
| `/watch pause` / `resume` / `remove` | `id` (req) | lifecycle |
| `/profile add` | `category`, `label`, `value` (all req) | add fact |
| `/profile list` / `remove` | — / `id` | inspect / remove facts |

### 7.2 Embeds — `src/discord/embeds.ts`
- **Listing card:** title (link), landed cost (bold) vs. raw price, condition, source, location, seller rating, thumbnail, one-line verdict. Color-coded by rank.
- **Watch hit:** same card prefixed with the watch name; batched (one message per run, up to 5 cards) to avoid ping spam.
- **Status/error embeds:** hunt started / failed (with reason) / nothing found.

### 7.3 Hub conventions — `src/discord/hub.ts`
- One channel per agent; Magpie binds to `DISCORD_CHANNEL_ID` and identifies as "Magpie". Command registration, allowlist guard, and channel binding are factored into `hub.ts` so a second agent later reuses the shell (§14 Phase 5) — but **no premature framework**: it's one file, not a package, until a second tenant exists.

## 8. The hunt engine (core flow)

One hunt, end to end (`src/engine/hunt.ts`):

1. **Target.** Parse/receive `TargetSpec` (from command text, watch row, or advisor thread).
2. **Plan.** Resolve enabled adapters (spec's `sources` ∩ registry).
3. **Search.** For each adapter, sequentially: open page in the persistent context → `adapter.search(page, target)` with pacing between navigations → `toListing` → `upsertListing`. Adapter failure logs + continues with remaining sources.
4. **Filter.** Drop listings violating hard constraints (`maxPriceCents`, `mustHave`, condition) — cheap deterministic pass before spending LLM tokens.
5. **Rank.** `landedCost` math with profile facts → LLM verdict pass → `hunt_result` rows.
6. **Dedup (watch runs only).** Keep only listings with no `watch_hit` row for this watch; insert `watch_hit` for the new ones.
7. **Report.** Top-N embeds to `hunt.channel_id`; mark `done` with timings + cost.

## 9. Watchlist pipeline (scheduler → queue → worker)

- **Scheduler tick** (croner, every 60 s): `dueWatches(now)` → for each, `enqueueHunt(mode: 'watch_run')` + `bumpNextRun(cadence + jitter ±10%)`. Jitter prevents watches synchronizing into bursts.
- **Queue = the `hunt` table.** No broker; `claimNextHunt()` is an atomic SQLite update. Ordering FIFO by `created_at`; one-shots and watch runs share the queue (one-shots naturally jump ahead of the daily watch pile only by arrival time — acceptable at personal scale).
- **Worker** (single loop, concurrency 1): claim → run §8 → report → claim again; idle-sleeps 5 s when the queue is empty. Per-source rate limits enforced inside the run via `pacing.ts` regardless of queue pressure.
- **Boot recovery:** `resetStaleRunning()` returns orphaned `running` hunts to `pending`.

## 10. Configuration & secrets

`.env` (gitignored; `.env.example` committed with empty values):

| Var | Purpose |
|---|---|
| `DISCORD_TOKEN` | bot token |
| `DISCORD_GUILD_ID` | personal server id (guild-scoped commands) |
| `DISCORD_CHANNEL_ID` | Magpie's bound channel |
| `DISCORD_ALLOWED_USER_IDS` | csv allowlist |
| `OPENROUTER_API_KEY` | LLM access |
| `MAGPIE_MODEL` | OpenRouter model id (default: an Anthropic Claude) |
| `MAGPIE_EXTRACT_MODEL` | *optional* — cheaper model for the extraction pass only; unset means every call uses `MAGPIE_MODEL` |
| `MAGPIE_DB_PATH` | SQLite file (default `data/magpie.db`) |
| `BROWSER_PROFILE_DIR` | persistent Chromium profile (default `browser-profile/`) |
| `HEADLESS` | `false` for login/debug sessions |

## 11. Security considerations

- **The browser profile is the crown jewel** — it holds live logged-in sessions. `browser-profile/` is gitignored, never leaves the host, directory mode 700. No screenshots of logged-in pages are persisted or posted to Discord.
- **Discord surface** — allowlisted user ids only; guild-scoped commands; the bot token grants no more than the one guild. Sensitive data (profile facts) lives in SQLite on the homelab, not in Discord history — embeds carry queries + public listing data only.
- **No inbound surface** — the service makes outbound connections only.
- **Secrets** — all in `.env`; nothing personal (paths, memberships, measurements) in this repo or spec; profile facts are runtime data, not code.
- **Prompt-injection posture** — extracted page text is untrusted input: extraction prompts treat it as data-to-parse (schema-constrained `generateObject`), never as instructions; verdicts cite only structured fields.

## 12. Testing strategy

Production-grade from the start (portfolio / work-transferable practice — non-negotiable).

- **Vitest (unit):** `landedCost` math incl. membership/coupon cases · constraint filtering (§8 step 4) · dedup logic (`watch_hit` semantics) · scheduler due-selection + jitter bounds · `claimNextHunt` atomicity (concurrent claims on one DB) · each adapter's `toListing` normalization · `TargetSpec` zod validation edge cases.
- **Fixture integration:** saved-HTML fixtures per source (`tests/fixtures/<source>/*.html`) served by a local static server; adapter `search()` runs real Playwright against them. Extraction tested with recorded page-text fixtures; LLM calls mocked by default, with an opt-in live pass (`LIVE_LLM=1`) using a cheap model.
- **Playwright e2e:** full hunt through the `fixture` adapter — enqueue → engine → ranked results in DB; watch lifecycle → scheduler tick → dedup (second run notifies nothing new). Discord layer tested at the handler level with mocked interactions.
- **Manual live smoke** (not CI): one real eBay hunt, run deliberately.

## 13. Deployment (homelab)

- **Dev:** runs on the Mac (`bun run dev`), headed browser available for login/debug.
- **Prod:** Docker Compose on the homelab — image `FROM mcr.microsoft.com/playwright:<pinned>-jammy` with Bun installed; volumes for `data/` (SQLite) and `browser-profile/`; `restart: unless-stopped`. Headless Chromium; if a future source demands headed mode, add `xvfb` in-container (Phase 4 concern).
- No reverse proxy / Caddy entry needed — outbound-only.
- Scripts:
  ```json
  "scripts": {
    "dev":        "bun run --watch src/index.ts",
    "start":      "bun run src/index.ts",
    "login":      "HEADLESS=false bun run scripts/login.ts",
    "db:generate":"drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "test":       "vitest run",
    "test:db":    "bun test tests/bun/db",
    "test:e2e":   "bun test tests/bun/e2e"
  }
  ```
  > **Amended in Phase 1.** `@playwright/test` was dropped: it runs under Node, where `bun:sqlite` does not exist, so an e2e touching the real queue could never run there. The e2e uses the Playwright *library* under Bun's own runner instead. That also splits the suite by runtime — vitest owns `tests/unit/**`, `bun test` owns `tests/bun/**` (see §12).

## 14. Development workflow (build order)

0. **Phase 0 — engine spike (throwaway allowed).** Playwright + persistent logged-in profile + LLM extraction running **mode A against eBay only**, end to end, posting result embeds to a Discord channel. Validates the core loop, extraction quality, and Discord plumbing cheaply before any breadth. *Exit criteria: a real `/hunt` for a known item returns sanely-ranked real listings.*
1. **Phase 1 — one-shot (A) + advisor (C).** Real scaffold: schema + migrations, repositories, hunt queue/worker, `/hunt` + `/advise` complete, 2–3 well-behaved sources (eBay + Google Shopping/SERP + one retailer), fixture adapter + test suite.
2. **Phase 2 — watchlists (B).** `watch`/`watch_hit` tables live, scheduler + jitter, dedup, batched hit embeds, `/watch` command set. Modest cadences first.
3. **Phase 3 — profile depth + best-deal logic.** `/profile` command set; memberships/coupons/specs consulted per hunt; landed-cost refinements (condition, seller rating, price-after-coupons).
4. **Phase 4 — hard sources (carefully).** Facebook Marketplace / Craigslist with account-ban risk respected: human-like pacing, strict rate caps, possibly a dedicated account; geo-local constraint handling. Vision fallback wired for what the guided path can't reach.
5. **Phase 5 — generalize the hub.** Extract `hub.ts` into reusable multi-agent Discord infrastructure once a second agent actually needs it.

## 15. Open questions / risks

- **Account-ban risk (the big one).** Marketplaces can flag automation even on the owner's own logged-in account. Mitigation: hard sources deferred to Phase 4, human pacing + rate caps from day one (`pacing.ts` exists in Phase 0), possibly a dedicated account for Marketplace. *Accepted residual risk, revisited at Phase 4.*
- **Site drift.** Adapters silently break as sites change. Mitigation: loud failure embeds, adapters isolated per file, fixture tests catch regressions in extraction logic. Ongoing tending is the cost of the product.
- **LLM cost scaling.** Browser-agent loops × hundreds of watch runs add up. Mitigation: guided (non-LLM) navigation, trimmed extraction inputs, per-hunt cost accounting, conservative default cadence. *Watch `hunt.cost_cents` from Phase 0.*
- **Extraction reliability.** Messy listing pages → clean comparable data is the quality bottleneck. *Validated in Phase 0 against eBay; fixture corpus grows with each adapter.*
- **Chrome profile vs. detection.** Persistent-context headless Chromium may still be fingerprinted by hard sources; headed-in-xvfb or a real `channel: 'chrome'` install are the fallbacks. *Decided empirically in Phase 4 — not an MVP concern.*
- ~~**"Best deal" definition depth**~~ (deferred from refine): how far coupon/promo hunting goes beyond stored memberships (e.g. actively searching coupon sites). **Resolved in Phase 3** — the answer is "not at all, by design". Magpie applies discounts only from facts the owner stored, and only when the fact names the source (rule in §6.5); it does not go looking for coupons. Anything the owner can't state as a source-scoped fact stays LLM narration on top of honest arithmetic. Revisit only if stored facts prove too blunt in practice.

## 16. Project log — rollup to planning vault

This project rolls progress back to Ben's Daily Brief via an **in-repo narrative log**: `log.md` at the repo root, append-only, newest on top. It complements commits (which record *what changed in code*) by capturing decisions, findings, and dead-ends. The vault's `/brief` skill reads `log.md` directly at brief-time (resolving this repo's path from the vault project note's `repo:` field), so no vault-side var or path is needed. See `CLAUDE.md` → "Project log (`log.md`)" for the format and write triggers.

Format: `## YYYY-MM` month groupers → `### [[MM-DD-YY ddd]] — <title>` day entries with `**Shipped:** / **Decisions:** / **Open / next:**` sub-bullets (flexible; one entry per day, extended rather than duplicated). Written on-demand, at commit checkpoints, and as an end-of-session backstop.
