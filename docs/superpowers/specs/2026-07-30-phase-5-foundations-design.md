# Phase 5 — Foundations: price history + budget guard

**Status:** implementation spec.
**Date:** 2026-07-30
**Parent:** [Magpie Vision](./2026-07-30-magpie-vision-design.md) §6, Phase 5.

Two small subsystems that instrument everything after them. Price history makes "cheap" defensible and is a hard prerequisite for the `best_value` objective (Phase 10). The budget guard is insurance that must be in place **before** broad source routing (Phase 7) and vision scoring (Phase 9) start spending.

---

## 1. Why this is urgent, not housekeeping

`src/engine/llm.ts` records a real measurement: a 60-row eBay hunt cost **$0.157**, of which **$0.118 was extraction**. At that rate:

| Ceiling | Hunts/month | Daily watches supported |
|---|---|---|
| $10 | ~64 | ~2 |
| $25 | ~160 | ~5 |
| $50 | ~318 | ~10 |

`SPEC.md` §1 promises watchlists scaling to **"dozens to hundreds."** Thirty daily watches is ~900 hunts/month ≈ **$141/mo** — roughly triple the top of the stated $10–50 ceiling, before Phase 7 widens the source set and Phase 9 adds vision.

**This is a live contradiction in the existing spec, and it is what Phase 5 exists to expose.** Two consequences follow:

- The cheap extraction model stops being an optional lever and becomes the operating mode under pressure.
- The **Haiku A/B test**, currently parked in Phase 4, is now a blocker rather than a nice-to-have: the degradation path is worthless if nobody has measured what a cheap model does to extraction quality.

The chosen default ceiling is **$25/mo** — deliberately tight, so the guard degrades often and cost stays visible as breadth grows.

---

## 2. Existing plumbing this builds on

Already present and unchanged:

- `llm.ts` obtains **real USD per response** from OpenRouter (`usage.include`), with a deliberately pessimistic fallback (`FALLBACK_USD_PER_MTOK`) for when the provider doesn't report — its comment already reads *"undercounting defeats the budget ceiling."*
- `account()` is the single chokepoint every LLM call passes through.
- `withUsage()` brackets spend by `AsyncLocalStorage`, so concurrent command-side and worker-side calls don't contaminate each other.
- `/hunt` and `/watch add` bill parse cost onto the enqueued hunt via `initialCostCents`.

The one gap: **spend only becomes durable when it lands on a `hunt` row.** An abandoned `/advise` thread bills nothing (`advise.ts:165` defers advisor spend to the first hunt). That is small today and structural at Phase 8, where the intent router fires a call on every message, most of which never become hunts.

---

## 3. Schema

### 3.1 `spend`

```sql
CREATE TABLE spend (
  id            TEXT PRIMARY KEY,
  at            TEXT NOT NULL,              -- ISO-8601 UTC
  label         TEXT NOT NULL,              -- llm.ts call-site label
  model         TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micros   INTEGER NOT NULL,           -- millionths of a USD
  estimated     INTEGER NOT NULL DEFAULT 0, -- 1 when the provider reported no cost
  hunt_id       TEXT REFERENCES hunt(id)    -- null for command-side and advisor calls
);
CREATE INDEX idx_spend_at ON spend(at);
```

**`cost_micros`, not cents.** `withUsage()` does `Math.ceil(costUsd * 100)` once per *bracket*, which is correct. Rounding up per *call* would turn four 0.3¢ calls into 4¢ instead of 2¢ — a ~2× overcount that trips the guard early and makes the ceiling meaningless. Integer millionths of a USD avoids both float drift and rounding bias.

**`estimated`** records how much of the month's bill is inferred from `FALLBACK_USD_PER_MTOK` rather than reported. A month that is largely estimated is a signal to distrust the number.

### 3.2 `price_point`

```sql
CREATE TABLE price_point (
  id             TEXT PRIMARY KEY,
  listing_id     TEXT NOT NULL REFERENCES listing(id),
  price_cents    INTEGER,
  shipping_cents INTEGER,
  currency       TEXT NOT NULL DEFAULT 'USD',
  provider       TEXT NOT NULL DEFAULT 'observed',
  observed_at    TEXT NOT NULL
);
CREATE INDEX idx_price_point_listing ON price_point(listing_id, observed_at);
```

**Raw price and shipping, never landed cost.** Discounts and profile facts change over time; storing a landed figure would freeze whatever coupon logic was true that day. Landed is computed at read time from current facts, consistent with `rank.ts`.

**`provider`** is `observed` for Magpie's own hunts. It exists now so third-party backfill (Keepa, vision doc §3.2) is a data question later rather than a migration.

---

## 4. Modules

### 4.1 `llm.ts` — spend sink

```typescript
export interface SpendRecord {
  at: string;
  label: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  estimated: boolean;
  huntId?: string;
}
export type SpendSink = (record: SpendRecord) => void;

/** Default no-op. index.ts wires the real repo; tests leave it unset. */
export function setSpendSink(fn: SpendSink | null): void;
```

`account()` calls the sink on every call, including the estimated path. Mirrors the existing `setGenerateForTests` seam so `llm.ts` acquires no database import and stays loadable without env vars.

The repo behind the sink, in `src/db/spend.ts`, following the existing repository shape:

```typescript
export interface SpendRepo {
  recordSpend(record: SpendRecord): void;
  monthTotals(monthStart: string): { costMicros: number; estimatedMicros: number };
  topLabels(monthStart: string, limit: number): { label: string; costMicros: number }[];
}
```

`withUsage()` gains an optional second argument so the worker can attribute calls:

```typescript
export function withUsage<T>(
  fn: (usage: () => UsageTotals) => Promise<T>,
  opts?: { huntId?: string },
): Promise<T>;
```

The `huntId` lives on the `AsyncLocalStorage` bucket and is copied onto each `SpendRecord`. Command-side `parseTarget` brackets run before a hunt row exists and therefore record `hunt_id = NULL` — correct, since that spend reaches `hunt.cost_cents` separately via `initialCostCents`. The ledger counts it exactly once.

### 4.2 `src/engine/budget.ts`

```typescript
export type BudgetState = 'ok' | 'soft' | 'hard';

export interface BudgetStatus {
  state: BudgetState;
  spentMicros: number;
  softMicros: number;
  ceilingMicros: number;
  monthStart: string;       // ISO-8601 UTC, first instant of the calendar month
  estimatedShare: number;   // 0..1 — fraction of spend from the fallback estimator
}

export function budgetStatus(deps: { spend: SpendRepo }, now?: Date): BudgetStatus;

/** What the run is allowed to do at this state. */
export interface Degradation {
  forceCheapExtraction: boolean;
  disableVision: boolean;
}
export function degradationFor(state: BudgetState): Degradation;
```

Calendar month, UTC — it matches how a monthly bill is read, and a rolling window makes "how much is left" unanswerable.

### 4.3 Degradation wiring

Budget status is computed **once per hunt, at run start** in `engine/hunt.ts`, and the resulting `Degradation` is threaded explicitly through the run to the extraction and vision decisions.

Explicit threading rather than a module-level flag: worker concurrency is 1, but command-side `parseTarget` runs concurrently with a hunt, so global mutable state would leak across brackets. Threading also keeps the degradation path directly unit-testable without a database.

| State | Effect |
|---|---|
| `ok` | Nothing changes. |
| `soft` (≥80% of ceiling) | Extraction forced to `MAGPIE_EXTRACT_MODEL`; vision fallback forced off. Both already have env-driven seams, so this is a consult, not new plumbing. |
| `hard` (≥100%) | Everything in `soft`, plus the scheduler stops enqueueing watch runs. |

**A `/hunt` you typed always runs**, at every state, carrying a warning line when degraded. Automatic work yields; explicit requests are never refused.

**When `MAGPIE_EXTRACT_MODEL` is unset, soft degradation has no extraction lever** — it can only disable vision, which on the happy path costs nothing anyway. Since extraction is ~75% of hunt cost, that makes `soft` nearly inert in the default configuration. Entering `soft` with no cheap model configured must therefore log a warning naming the unset variable, so the guard cannot appear to be protecting spend it has no way to reduce.

### 4.4 `watch/scheduler.ts`

The tick consults `budgetStatus()` before marking watches due. At `hard`, it enqueues nothing and posts **one** message to the bound channel on the transition into `hard` (not every 60-second tick). Watches are not paused as rows — `next_run_at` still advances, so the backlog does not stampede when the month rolls.

### 4.5 `listings.ts` — price point capture

`upsertListing` becomes: read the existing row by `(source, source_id)` → upsert as today → append a `price_point` when there was no prior row, or when `price_cents` or `shipping_cents` differs from it. All three statements in one transaction.

One extra SELECT per listing, ~60 per hunt — negligible in SQLite, and it keeps the write policy in one place rather than in every adapter.

### 4.6 Surfacing

**Listing card** gains one line, only when the listing has ≥2 price points and the current price is the minimum:

> *lowest of 7 observations since Jun 12*

Silent otherwise. The feature earns the right to speak by having data; it never announces that it knows nothing.

**`/spend`** — month-to-date against the ceiling, current state, and the top call labels by cost. This is how extraction being 75% of the bill becomes visible without reading logs.

---

## 5. Configuration

| Var | Purpose | Default |
|---|---|---|
| `MAGPIE_BUDGET_CENTS_PER_MONTH` | Monthly ceiling | `2500` |
| `MAGPIE_BUDGET_SOFT_PCT` | Soft-degradation threshold, percent of ceiling | `80` |

Both optional. Setting the ceiling to `0` disables the guard entirely (state is always `ok`) — an explicit escape hatch rather than a magic sentinel scattered through call sites.

---

## 6. Testing

**Unit (vitest):**
- `budgetStatus` at exact boundaries: 0, soft−1, soft, hard−1, hard, and above hard.
- Ceiling `0` disables the guard.
- **Micro-precision regression:** 100 calls of 0.3¢ each sum to 30¢, not 100¢. This is the rounding bug §3.1 exists to prevent; it must fail if someone switches the ledger to cents.
- `estimatedShare` computed correctly across mixed reported/estimated rows.
- `degradationFor` mapping for all three states.
- Price point written on: first observation, price change, shipping change. **Not** written on: unchanged price, unchanged shipping.
- Month boundary: spend in the previous calendar month does not count toward this month.

**Integration (`bun test`):**
- A full fixture hunt writes one `spend` row per LLM call with the correct `hunt_id`.
- A command-side `parseTarget` writes a `spend` row with `hunt_id = NULL`, and the same spend still reaches `hunt.cost_cents` via `initialCostCents` — asserting no double-count in the ledger.
- Scheduler at `hard` enqueues nothing; at `soft` enqueues normally.
- Two hunts over one fixture listing at different prices produce two price points; a third at an unchanged price produces none.

---

## 7. Decisions and rejected alternatives

- **Dedicated ledger over `SUM(hunt.cost_cents)`.** Summing hunt rows is simpler and accurate for hunts today, but structurally blind to spend that never becomes a hunt — abandoned advisor threads now, Phase 8's routed messages later. Undercounting is the one failure mode a ceiling cannot tolerate.
- **`hunt.cost_cents` is kept unchanged.** The ledger is truth for budgeting; the column stays a cached per-hunt convenience so embeds and existing tests are untouched. The redundancy is accepted and the drift is bounded to per-bracket rounding.
- **Tiered degradation over a hard stop.** Halting everything at 100% guarantees the number but can refuse Ben for weeks at the moment he wants help. Warn-only was rejected as no protection at all.
- **Explicit `Degradation` threading over a global flag.** Concurrent command-side brackets make module-level mutable state unsafe, and threading is directly testable.
- **Append-on-change over append-always.** `listing.last_seen_at` already records "we looked and it was still there," so on-change loses nothing for the questions asked while avoiding a row per listing per hunt.

---

## 8. Open questions

- **Does the cheap extraction model actually work?** The entire soft-degradation path assumes `MAGPIE_EXTRACT_MODEL` produces acceptable listings. The Phase 4 Haiku A/B test must land before `soft` can be trusted; until then, soft degradation should be considered unvalidated.
- **What happens at a month boundary mid-hunt?** A hunt starting at 23:59 on the last day of the month is evaluated once at run start. Accepted as-is: the window is a second wide and the error is one hunt.
- **Should `estimatedShare` affect the state?** A month that is 90% estimated is a much less trustworthy number than one that is 5% estimated. Currently reported by `/spend` but not acted on. Revisit if the fallback path turns out to fire often.
