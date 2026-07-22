# Phase 3 — Profile Depth + Best-Deal Logic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/profile` command set; every hunt's ranking step consumes active profile facts — deterministic membership/coupon discounts in `landedCost`, facts as verdict-prompt context, seller-rating extraction refinement (SPEC §3.4, §6.5, §14 Phase 3).

**Architecture:** New `src/db/profile.ts` repo over the existing `profile_fact` table (already in the baseline migration — no new migration). `rank.ts` gains fact-aware `landedCost`/`discountCents` (pure, deterministic) and fact context in both LLM passes. `hunt.ts` tags each raw listing with its adapter's source and threads `activeFacts()` through filter + rank. New `/profile` slash command mirrors the `/watch` subcommand pattern. No LLM in the command path.

**Tech Stack:** Bun, Drizzle/bun-sqlite, discord.js, zod, vitest (unit) + bun:test (db/e2e).

## Global Constraints

- Never commit to `main` — all work on branch `phase-3-profile`; PR at the end (Ben's standing workflow).
- No numeric min/max keywords or zod `.int()`/`.positive()` in any schema passed to `generateObject` (Anthropic structured-output limits).
- Extracted page text is untrusted data, never instructions (SPEC §11) — extraction prompt changes keep the data-to-parse framing.
- Deterministic math first, LLM second (SPEC §6.5): discounts are pure functions; the LLM only narrates them.
- Fail loud, never silent.
- Test commands: `bun run typecheck` · `bun run test` (vitest) · `bun run test:db` · `bun run test:e2e`.
- Repos follow the `makeXRepo(db, now?)` factory pattern; commands are tested against narrow structural interaction ports with plain fakes.

## Design decisions locked here

- **Deterministic discount rule** (the Phase 3 answer to SPEC §15's "best-deal definition depth"): a `membership`/`coupon_source` fact yields a machine-applied discount **only when its text names the listing's source** (e.g. value `"10% off ebay"` applies to eBay listings only). `N% off` applies to the item price; `$N off` subtracts from the landed total; percent wins when a fact contains both; multiple applicable facts stack; landed cost clamps at ≥ 0. Facts that don't parse or don't name a source still reach the verdict prompt as context — the LLM narrates, never invents math.
- **`/profile remove` is soft** (`active = 0`), mirroring watch removal: history kept, hidden from list and from `activeFacts()`.
- **`RankedListing` gains required `discountCents`** (0 when none) so embeds/history can show price-after-coupons; `hunt_result.landed_cost_cents` stores the discounted landed cost.
- **Seller rating** is optional-nullable end to end (`sellerRating?: number | null` on `RawListing`) so old fixtures/fakes stay valid; it feeds the verdict prompt + listing card, never deterministic math.

---

### Task 1: Profile repo (`src/db/profile.ts`)

**Files:**
- Modify: `src/db/types.ts` (add ProfileFactRow/NewProfileFact/ProfileRepo)
- Create: `src/db/profile.ts`
- Test: `tests/bun/db/profile.test.ts`

**Interfaces:**
- Consumes: `profileFact` from `src/db/schema.ts` (exists), `Db` from `src/db/client.ts`.
- Produces: `makeProfileRepo(db: Db, now?: () => string): ProfileRepo` with `addFact(input: NewProfileFact): ProfileFactRow`, `getFact(id: string): ProfileFactRow | null`, `activeFacts(): ProfileFactRow[]`, `removeFact(id: string): void`. Types `ProfileFactRow`, `ProfileFactCategory`, `NewProfileFact`, `ProfileRepo` from `src/db/types.ts`.

- [ ] **Step 1: Branch**

```bash
git checkout -b phase-3-profile
```

- [ ] **Step 2: Add types to `src/db/types.ts`**

Extend the schema import to include `profileFact`, then add (near the other row types / after `WatchesRepo`):

```typescript
export type ProfileFactRow = typeof profileFact.$inferSelect;
export type ProfileFactCategory = ProfileFactRow['category'];

export interface NewProfileFact {
  category: ProfileFactCategory;
  label: string;
  value: string;
}

export interface ProfileRepo {
  addFact(input: NewProfileFact): ProfileFactRow;
  getFact(id: string): ProfileFactRow | null;
  /** active = 1, insertion order — every hunt's ranking step consumes these (SPEC §3.4). */
  activeFacts(): ProfileFactRow[];
  /** Soft remove (active = 0): keeps the row, hides it from list and ranking. */
  removeFact(id: string): void;
}
```

- [ ] **Step 3: Write the failing test** `tests/bun/db/profile.test.ts`

Mirror `tests/bun/db/watches.test.ts` structure (bun:test + `openTestDb`):

```typescript
import { describe, expect, test } from 'bun:test';
import { makeProfileRepo } from '../../../src/db/profile';
import { openTestDb } from '../helpers/db';

describe('profile repo', () => {
  test('addFact returns the stored row with id + timestamps', () => {
    const repo = makeProfileRepo(openTestDb(), () => '2026-07-19T00:00:00.000Z');
    const fact = repo.addFact({ category: 'membership', label: 'warehouse club', value: 'active' });
    expect(fact.id).toBeTruthy();
    expect(fact.category).toBe('membership');
    expect(fact.active).toBe(1);
    expect(fact.createdAt).toBe('2026-07-19T00:00:00.000Z');
    expect(repo.getFact(fact.id)).toEqual(fact);
  });

  test('activeFacts returns only active facts, insertion order', () => {
    const repo = makeProfileRepo(openTestDb());
    const a = repo.addFact({ category: 'membership', label: 'a', value: '1' });
    const b = repo.addFact({ category: 'spec', label: 'b', value: '2' });
    repo.removeFact(a.id);
    expect(repo.activeFacts().map((f) => f.label)).toEqual(['b']);
    expect(repo.getFact(a.id)?.active).toBe(0); // row survives removal
    void b;
  });

  test('removeFact on an unknown id is a no-op', () => {
    const repo = makeProfileRepo(openTestDb());
    repo.removeFact('nope');
    expect(repo.activeFacts()).toEqual([]);
  });
});
```

- [ ] **Step 4: Run to verify it fails** — `bun test tests/bun/db/profile.test.ts` → FAIL (module `src/db/profile` not found).

- [ ] **Step 5: Implement `src/db/profile.ts`**

```typescript
import { asc, eq, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { Db } from './client';
import { profileFact } from './schema';
import type { NewProfileFact, ProfileFactRow, ProfileRepo } from './types';

export function makeProfileRepo(db: Db, now: () => string = () => new Date().toISOString()): ProfileRepo {
  return {
    addFact(input: NewProfileFact): ProfileFactRow {
      const ts = now();
      const rows = db
        .insert(profileFact)
        .values({ id: nanoid(), category: input.category, label: input.label, value: input.value, createdAt: ts, updatedAt: ts })
        .returning()
        .all();
      return rows[0]!;
    },

    getFact(id): ProfileFactRow | null {
      return db.select().from(profileFact).where(eq(profileFact.id, id)).get() ?? null;
    },

    activeFacts(): ProfileFactRow[] {
      return db
        .select()
        .from(profileFact)
        .where(eq(profileFact.active, 1))
        .orderBy(asc(profileFact.createdAt), asc(sql`rowid`))
        .all();
    },

    removeFact(id): void {
      db.update(profileFact).set({ active: 0, updatedAt: now() }).where(eq(profileFact.id, id)).run();
    },
  };
}
```

- [ ] **Step 6: Verify pass** — `bun test tests/bun/db/profile.test.ts` → PASS; `bun run typecheck` clean.
- [ ] **Step 7: Commit** — `git add src/db/types.ts src/db/profile.ts tests/bun/db/profile.test.ts && git commit -m "Profile repo: activeFacts + soft-remove CRUD over profile_fact"`

---

### Task 2: Deterministic discounts in `landedCost` (`src/engine/rank.ts`)

**Files:**
- Modify: `src/engine/rank.ts` (landedCost + new discountCents; nothing else yet)
- Test: `tests/unit/rank.test.ts` (new file)

**Interfaces:**
- Consumes: `ProfileFactRow` from `src/db/types.ts`.
- Produces: `type CostableListing = Pick<RawListing, 'priceCents' | 'shippingCents'> & { source?: string }`; `discountCents(l: CostableListing, facts: ProfileFactRow[]): number`; `landedCost(l: CostableListing, facts?: ProfileFactRow[]): number` (facts default `[]` — all existing callers unchanged).

- [ ] **Step 1: Write failing tests** — `tests/unit/rank.test.ts`, pure-math describe block:

```typescript
import { describe, expect, it } from 'vitest';
import type { ProfileFactRow } from '../../src/db/types';
import { discountCents, landedCost } from '../../src/engine/rank';

const fact = (over: Partial<ProfileFactRow> = {}): ProfileFactRow => ({
  id: 'f1',
  category: 'coupon_source',
  label: 'eBay coupon',
  value: '10% off ebay',
  active: 1,
  createdAt: '2026-07-19T00:00:00.000Z',
  updatedAt: '2026-07-19T00:00:00.000Z',
  ...over,
});

describe('landedCost + discountCents (deterministic best-deal math)', () => {
  const l = { priceCents: 10_000, shippingCents: 500, source: 'ebay' };

  it('no facts: price + shipping, null shipping = 0', () => {
    expect(landedCost(l)).toBe(10_500);
    expect(landedCost({ priceCents: 1000, shippingCents: null })).toBe(1000);
  });

  it('percent-off fact naming the source discounts the item price', () => {
    expect(discountCents(l, [fact()])).toBe(1000); // 10% of price, not landed
    expect(landedCost(l, [fact()])).toBe(9_500);
  });

  it('$N-off fact naming the source subtracts flat cents', () => {
    expect(landedCost(l, [fact({ value: '$5 off ebay orders' })])).toBe(10_000);
  });

  it('percent wins when a fact contains both patterns', () => {
    expect(discountCents(l, [fact({ value: '10% off or $2 off ebay' })])).toBe(1000);
  });

  it('facts that do not name the listing source never apply', () => {
    expect(landedCost(l, [fact({ value: '10% off at costco' })])).toBe(10_500);
    expect(landedCost({ ...l, source: undefined }, [fact()])).toBe(10_500);
  });

  it('source match may come from the label', () => {
    expect(landedCost(l, [fact({ label: 'ebay bucks', value: '10% off everything' })])).toBe(9_500);
  });

  it('spec facts never discount, even when they name the source', () => {
    expect(landedCost(l, [fact({ category: 'spec' })])).toBe(10_500);
  });

  it('applicable facts stack and landed cost clamps at zero', () => {
    expect(landedCost(l, [fact(), fact({ id: 'f2', value: '$5 off ebay' })])).toBe(9_000);
    expect(landedCost({ priceCents: 100, shippingCents: null, source: 'ebay' }, [fact({ value: '$50 off ebay' })])).toBe(0);
  });

  it('unparseable membership facts contribute nothing deterministically', () => {
    expect(landedCost(l, [fact({ category: 'membership', value: 'ebay plus member, free shipping perks' })])).toBe(10_500);
  });

  it('source matching is case-insensitive', () => {
    expect(landedCost(l, [fact({ value: '10% off eBay' })])).toBe(9_500);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `bun run test -- tests/unit/rank.test.ts` → FAIL (`discountCents` not exported; `landedCost` rejects 2nd arg).

- [ ] **Step 3: Implement in `src/engine/rank.ts`** — replace the current `landedCost` and its comment:

```typescript
import type { ProfileFactRow } from '../db/types';

/** What the deterministic cost math needs; `source` scopes discount facts. */
export type CostableListing = Pick<RawListing, 'priceCents' | 'shippingCents'> & { source?: string };

// Phase 3 best-deal rule (SPEC §15 "definition depth", scoped here): a
// membership/coupon fact is machine-applied ONLY when its text names the
// listing's source — "10% off ebay" discounts eBay rows, nothing else. Percent
// applies to the item price, "$N off" to the landed total, percent wins if a
// fact has both, applicable facts stack. Anything fuzzier stays LLM-verdict
// context: the model narrates deals, it never invents math.
const PERCENT_OFF = /(\d+(?:\.\d+)?)\s*%\s*off/i;
const DOLLARS_OFF = /\$\s*(\d+(?:\.\d+)?)\s*off/i;

export function discountCents(l: CostableListing, facts: ProfileFactRow[]): number {
  if (!l.source) return 0;
  const source = l.source.toLowerCase();
  let total = 0;
  for (const f of facts) {
    if (f.category !== 'membership' && f.category !== 'coupon_source') continue;
    if (!`${f.label} ${f.value}`.toLowerCase().includes(source)) continue;
    const pct = f.value.match(PERCENT_OFF);
    if (pct) {
      total += Math.round((l.priceCents * Number(pct[1])) / 100);
      continue;
    }
    const usd = f.value.match(DOLLARS_OFF);
    if (usd) total += Math.round(Number(usd[1]) * 100);
  }
  return total;
}

// Landed cost in cents: price + shipping − deterministic membership/coupon
// discounts. Pure and unit-tested; the LLM verdict pass sits on top. SPEC §6.5.
export function landedCost(l: CostableListing, facts: ProfileFactRow[] = []): number {
  return Math.max(0, l.priceCents + (l.shippingCents ?? 0) - discountCents(l, facts));
}
```

- [ ] **Step 4: Verify** — `bun run test -- tests/unit/rank.test.ts` → PASS; `bun run typecheck` clean (existing `landedCost(l)` callers unaffected).
- [ ] **Step 5: Commit** — `git add src/engine/rank.ts tests/unit/rank.test.ts && git commit -m "landedCost: deterministic source-scoped membership/coupon discounts"`

---

### Task 3: `rankListings` consumes facts (prompts + discountCents)

**Files:**
- Modify: `src/engine/rank.ts`
- Modify: `tests/unit/report.test.ts` (fixture gains `discountCents: 0`)
- Test: `tests/unit/rank.test.ts` (extend)

**Interfaces:**
- Consumes: Task 2's `discountCents`/`landedCost`; `setGenerateForTests` seam from `src/engine/llm.ts`.
- Produces: `rankListings(listings: (RawListing & { source?: string })[], target: TargetSpec, facts?: ProfileFactRow[]): Promise<RankedListing[]>`; `RankedListing` gains required `discountCents: number`.

- [ ] **Step 1: Write failing tests** — append to `tests/unit/rank.test.ts`:

```typescript
import { afterEach } from 'vitest';
import { rankListings } from '../../src/engine/rank';
import { setGenerateForTests } from '../../src/engine/llm';
import type { RawListing } from '../../src/sources/types';

afterEach(() => setGenerateForTests(null));

/** Same seam shape as hunt.test.ts: everything matches, verdict per index. */
function fakeRank(captured?: { prompts: string[]; systems: string[] }) {
  setGenerateForTests(({ label, prompt, system }) => {
    captured?.prompts.push(prompt);
    captured?.systems.push(system ?? '');
    const idx = [...prompt.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
    const usage = { inputTokens: 100, outputTokens: 20 };
    if (label === 'rankMatch') {
      return { object: { matches: idx.map((index) => ({ index, matchesTarget: true })) }, usage, costUsd: 0.01 };
    }
    if (label === 'rankVerdicts') {
      return { object: { verdicts: idx.map((index) => ({ index, verdict: `v${index}` })) }, usage, costUsd: 0.01 };
    }
    throw new Error(`unexpected llm call: ${label}`);
  });
}

const listing = (title: string, priceCents: number, source = 'ebay'): RawListing & { source?: string } => ({
  title,
  priceCents,
  shippingCents: null,
  condition: 'New',
  url: `https://example.com/${title}`,
  source,
});

describe('rankListings with profile facts', () => {
  const target = { description: 'widget', constraints: {} };

  it('sorts by DISCOUNTED landed cost and reports discountCents', async () => {
    fakeRank();
    // B is cheaper only after its 10% ebay coupon: A=1000, B=1050→945.
    const ranked = await rankListings([listing('A', 1000), listing('B', 1050)], target, [fact()]);
    expect(ranked.map((r) => r.title)).toEqual(['B', 'A']);
    expect(ranked[0]!.landedCents).toBe(945);
    expect(ranked[0]!.discountCents).toBe(105);
    expect(ranked[1]!.discountCents).toBe(0);
  });

  it('facts appear in both prompts; discounted lines are annotated', async () => {
    const captured = { prompts: [] as string[], systems: [] as string[] };
    fakeRank(captured);
    await rankListings([listing('A', 1000)], target, [fact()]);
    expect(captured.prompts).toHaveLength(2);
    for (const p of captured.prompts) {
      expect(p).toContain('Shopper profile facts:');
      expect(p).toContain('[coupon_source] eBay coupon: 10% off ebay');
      expect(p).toContain('membership/coupon discount');
    }
  });

  it('no facts: prompts carry no facts block and discountCents is 0', async () => {
    const captured = { prompts: [] as string[], systems: [] as string[] };
    fakeRank(captured);
    const ranked = await rankListings([listing('A', 1000)], target);
    expect(ranked[0]!.discountCents).toBe(0);
    expect(captured.prompts.every((p) => !p.includes('Shopper profile facts'))).toBe(true);
  });
});
```

- [ ] **Step 2: Verify failure** — `bun run test -- tests/unit/rank.test.ts` → FAIL.
- [ ] **Step 3: Implement in `src/engine/rank.ts`**:

```typescript
export interface RankedListing extends RawListing {
  landedCents: number;
  /** Deterministic membership/coupon discount already inside landedCents (0 = none). */
  discountCents: number;
  matchesTarget: boolean;
  verdict: string;
}

type RankInput = RawListing & { source?: string };

const VERDICT_SYSTEM = [
  'You are a savvy shopping assistant. For each listing give ONE concise sentence judging fit',
  'and value vs the target. Cite only the fields shown (title, landed price, condition) — never',
  'invent details. Be direct: flag anything off about fit or price, and call out standout deals.',
  'When a membership or coupon discount changed a landed price, say so.',
].join(' ');

const factsBlock = (facts: ProfileFactRow[]) =>
  facts.length === 0
    ? ''
    : `\n\nShopper profile facts:\n${facts.map((f) => `- [${f.category}] ${f.label}: ${f.value}`).join('\n')}`;

const listingLine = (l: RankInput, i: number, facts: ProfileFactRow[]) => {
  const off = discountCents(l, facts);
  const discount = off > 0 ? ` (after $${(off / 100).toFixed(2)} membership/coupon discount)` : '';
  return `${i}. ${l.title} — $${(landedCost(l, facts) / 100).toFixed(2)} landed${discount}, condition: ${l.condition ?? 'unknown'}`;
};

const targetPrompt = (target: TargetSpec, lines: string, facts: ProfileFactRow[]) =>
  `Target: ${target.description}\nConstraints: ${JSON.stringify(target.constraints)}${factsBlock(facts)}\n\nListings:\n${lines}`;

export async function rankListings(
  listings: RankInput[],
  target: TargetSpec,
  facts: ProfileFactRow[] = [],
): Promise<RankedListing[]> { … }
```

Inside the body: `sort` comparator and `landedCents` computations become `landedCost(x, facts)`; both `targetPrompt(...)` calls pass `facts`; both `listingLine` call sites pass `facts` (`sorted.map((l, i) => listingLine(l, i, facts))` and `finalists.map((f, i) => listingLine(f.l, i, facts))`); the returned objects gain `discountCents: discountCents(f.l, facts)`. Everything else (two-pass structure, TOP_N, match systems) unchanged except the one VERDICT_SYSTEM sentence.

- [ ] **Step 4: Fix `tests/unit/report.test.ts`** — the `ranked(n)` fixture object gains `discountCents: 0`.
- [ ] **Step 5: Verify** — `bun run test` all green; `bun run typecheck` clean.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "rankListings: profile facts in both passes, discounted sort + discountCents"`

---

### Task 4: Filter uses discounted landed cost

**Files:**
- Modify: `src/engine/filter.ts`
- Test: `tests/unit/filter.test.ts` (extend)

**Interfaces:**
- Produces: `applyConstraints<T extends RawListing & { source?: string }>(listings: T[], target: TargetSpec, facts?: ProfileFactRow[]): T[]` — generic so hunt.ts's source-tagged raws keep their tag through filtering.

- [ ] **Step 1: Failing test** — append to `tests/unit/filter.test.ts` (reuse its existing listing fixture helper, adding `source`):

```typescript
it('price ceiling applies AFTER deterministic discounts (price-after-coupons)', () => {
  const facts = [
    {
      id: 'f1', category: 'coupon_source', label: 'c', value: '10% off ebay',
      active: 1, createdAt: '', updatedAt: '',
    } as ProfileFactRow,
  ];
  const over = { title: 'x', priceCents: 10_500, shippingCents: null, condition: null, url: 'https://e/1', source: 'ebay' };
  const target = { description: 'x', constraints: { maxPriceCents: 10_000 } };
  expect(applyConstraints([over], target)).toEqual([]); // 10500 > ceiling undiscounted
  expect(applyConstraints([over], target, facts)).toEqual([over]); // 9450 after coupon
});
```

- [ ] **Step 2: Verify failure**, **Step 3: Implement** (signature above; `landedCost(l, facts)` in the ceiling check; `facts` default `[]`), **Step 4: `bun run test` green + typecheck**, **Step 5: Commit** `git add -A && git commit -m "applyConstraints: generic + price ceiling on discounted landed cost"`.

---

### Task 5: Engine wiring — hunts consult the profile

**Files:**
- Modify: `src/engine/hunt.ts`
- Test: `tests/unit/hunt.test.ts` (harness + new tests)

**Interfaces:**
- Consumes: `ProfileRepo` from `src/db/types.ts`.
- Produces: `HuntDeps` gains `profile: Pick<ProfileRepo, 'activeFacts'>`; collected raws are tagged `{ ...raw, source: adapter.source }` before upsert/filter/rank.

- [ ] **Step 1: Failing tests** — in `tests/unit/hunt.test.ts`: `Harness` gains `facts: ProfileFactRow[]` (init `[]`); `h.deps` gains `profile: { activeFacts: () => h.facts }`. New tests:

```typescript
it('active profile facts discount landed cost and reach the rank prompts', async () => {
  const captured = { prompts: [] as string[] };
  fakeRank(captured);
  const h = makeHarness([fakeAdapter('ebay', [raw(1)])]); // price 1000
  h.facts.push({
    id: 'f1', category: 'coupon_source', label: 'eBay coupon', value: '10% off ebay',
    active: 1, createdAt: '', updatedAt: '',
  });
  await runHunt(huntRow(), h.deps);
  expect(h.resultRows[0]!.rows[0]!.landedCostCents).toBe(900);
  expect(captured.prompts.every((p) => p.includes('Shopper profile facts:'))).toBe(true);
});

it('discounted price can rescue a listing from the hard price ceiling', async () => {
  fakeRank();
  const h = makeHarness([fakeAdapter('ebay', [raw(1, { priceCents: 10_500 })])]);
  h.facts.push({
    id: 'f1', category: 'coupon_source', label: 'c', value: '10% off ebay',
    active: 1, createdAt: '', updatedAt: '',
  });
  await runHunt(huntRow({ targetJson: JSON.stringify({ description: 'w', constraints: { maxPriceCents: 10_000 } }) }), h.deps);
  expect(h.reported[0]!.rankedTitles).toEqual(['Widget 1']);
});
```

(Import `ProfileFactRow` in the test's type imports.)

- [ ] **Step 2: Verify failure** (typecheck fails on missing `profile` dep — that counts), **Step 3: Implement** in `src/engine/hunt.ts`:
  - `HuntDeps` gains `profile: Pick<ProfileRepo, 'activeFacts'>;` (import type `ProfileRepo`).
  - Collected entries: `const collected: { raw: RawListing & { source: string }; listingId: string }[] = [];` and `collected.push({ raw: { ...raw, source: adapter.source }, listingId: row.id });`
  - After the browser block: `const facts = deps.profile.activeFacts();` then `applyConstraints(collected.map((c) => c.raw), target, facts)` and `rankListings(kept, target, facts)`.
- [ ] **Step 4: `bun run test` green + typecheck** (e2e tests will fail typecheck until Task 8 wires `profile` — if so, wire `profile: makeProfileRepo(db)` into `tests/bun/e2e/hunt-e2e.test.ts` and `tests/bun/e2e/watch-lifecycle-e2e.test.ts` pipelines in THIS task to keep the tree green).
- [ ] **Step 5: Commit** — `git add -A && git commit -m "Engine: hunts consult active profile facts (discounts + prompt context)"`

---

### Task 6: `/profile` command + embeds

**Files:**
- Create: `src/discord/commands/profile.ts`
- Modify: `src/discord/embeds.ts` (buildProfileFactsEmbed + discount line on listing cards)
- Modify: `src/index.ts` (wire repo + command + hunt dep)
- Test: `tests/unit/commands-profile.test.ts` (new), `tests/unit/report.test.ts` (discount-line case)

**Interfaces:**
- Consumes: `ProfileRepo`, `ProfileFactRow`, `ProfileFactCategory` (Task 1), `RankedListing.discountCents` (Task 3), `makeProfileRepo` (Task 1).
- Produces: `profileCommandData` (SlashCommandSubcommandsOnlyBuilder), `handleProfileCommand(interaction: ProfileInteractionPort, deps: ProfileCommandDeps)`, `buildProfileFactsEmbed(facts: ProfileFactRow[]): EmbedBuilder`.

- [ ] **Step 1: Failing tests** — `tests/unit/commands-profile.test.ts`, mirroring `commands-watch.test.ts`'s fake-port style:

```typescript
import { describe, expect, it } from 'vitest';
import type { ProfileFactRow } from '../../src/db/types';
import { handleProfileCommand, type ProfileInteractionPort } from '../../src/discord/commands/profile';

function makePort(sub: string, strings: Record<string, string>) {
  const replies: unknown[] = [];
  let deferred = false;
  const port: ProfileInteractionPort = {
    options: {
      getSubcommand: () => sub,
      getString: (name) => strings[name] ?? null,
    },
    deferReply: async () => void (deferred = true),
    editReply: async (content) => void replies.push(content),
  };
  return { port, replies, deferred: () => deferred };
}

function makeFakeRepo(seed: ProfileFactRow[] = []) {
  const rows = [...seed];
  let n = 0;
  return {
    rows,
    repo: {
      addFact: (input: { category: ProfileFactRow['category']; label: string; value: string }) => {
        const row: ProfileFactRow = { id: `f${++n}`, active: 1, createdAt: 't', updatedAt: 't', ...input };
        rows.push(row);
        return row;
      },
      getFact: (id: string) => rows.find((r) => r.id === id) ?? null,
      activeFacts: () => rows.filter((r) => r.active === 1),
      removeFact: (id: string) => {
        const row = rows.find((r) => r.id === id);
        if (row) row.active = 0;
      },
    },
  };
}

describe('/profile', () => {
  it('add stores the fact and confirms with id + category', async () => {
    const { port, replies, deferred } = makePort('add', { category: 'membership', label: 'warehouse club', value: 'active' });
    const { repo, rows } = makeFakeRepo();
    await handleProfileCommand(port, { profile: repo });
    expect(deferred()).toBe(true);
    expect(rows).toHaveLength(1);
    expect(String(replies[0])).toContain('warehouse club');
    expect(String(replies[0])).toContain('f1');
  });

  it('list renders an embed of active facts', async () => {
    const { port, replies } = makePort('list', {});
    const { repo } = makeFakeRepo([
      { id: 'f1', category: 'spec', label: 'server HDDs', value: '≥10TB, CMR only', active: 1, createdAt: 't', updatedAt: 't' },
    ]);
    await handleProfileCommand(port, { profile: repo });
    const embeds = (replies[0] as { embeds: { data: { description?: string } }[] }).embeds;
    expect(embeds[0]!.data.description).toContain('server HDDs');
    expect(embeds[0]!.data.description).toContain('f1');
  });

  it('list with no facts replies plainly', async () => {
    const { port, replies } = makePort('list', {});
    await handleProfileCommand(port, { profile: makeFakeRepo().repo });
    expect(replies[0]).toBe('No profile facts yet.');
  });

  it('remove soft-deletes and confirms; unknown id replies not-found', async () => {
    const seed: ProfileFactRow = { id: 'f1', category: 'membership', label: 'club', value: 'x', active: 1, createdAt: 't', updatedAt: 't' };
    const { repo } = makeFakeRepo([seed]);
    const a = makePort('remove', { id: 'f1' });
    await handleProfileCommand(a.port, { profile: repo });
    expect(String(a.replies[0])).toContain('Removed');
    expect(repo.activeFacts()).toEqual([]);

    const b = makePort('remove', { id: 'zzz' });
    await handleProfileCommand(b.port, { profile: repo });
    expect(String(b.replies[0])).toContain('zzz');
  });

  it('removing an already-removed fact replies not-found (no resurrection confusion)', async () => {
    const seed: ProfileFactRow = { id: 'f1', category: 'membership', label: 'club', value: 'x', active: 0, createdAt: 't', updatedAt: 't' };
    const { repo } = makeFakeRepo([seed]);
    const { port, replies } = makePort('remove', { id: 'f1' });
    await handleProfileCommand(port, { profile: repo });
    expect(String(replies[0])).toContain('f1'); // not-found path
  });
});
```

And in `tests/unit/report.test.ts`, one new case: a ranked row with `discountCents: 250` renders a card whose description contains `$2.50` and `discount`.

- [ ] **Step 2: Verify failure**, **Step 3: Implement**:

`src/discord/commands/profile.ts`:

```typescript
import { SlashCommandBuilder } from 'discord.js';
import type { ProfileFactCategory, ProfileRepo } from '../../db/types';
import { buildProfileFactsEmbed } from '../embeds';

// /profile (SPEC §3.4): standing shopper facts — memberships, coupon sources,
// hard specs — consulted by every hunt's ranking step. No LLM here; facts are
// stored verbatim. To make a coupon deterministic, name the source in the
// value (e.g. "10% off ebay"); anything fuzzier still informs verdicts.

export const profileCommandData = new SlashCommandBuilder()
  .setName('profile')
  .setDescription('Shopper profile facts — memberships, coupons, specs consulted by every hunt')
  .addSubcommand((s) =>
    s
      .setName('add')
      .setDescription('Add a profile fact')
      .addStringOption((o) =>
        o
          .setName('category')
          .setDescription('Kind of fact')
          .setRequired(true)
          .addChoices(
            { name: 'membership', value: 'membership' },
            { name: 'coupon source', value: 'coupon_source' },
            { name: 'spec', value: 'spec' },
          ),
      )
      .addStringOption((o) => o.setName('label').setDescription('Short name, e.g. "warehouse club"').setRequired(true))
      .addStringOption((o) =>
        o.setName('value').setDescription('Detail, e.g. "10% off ebay through June"').setRequired(true),
      ),
  )
  .addSubcommand((s) => s.setName('list').setDescription('Show active profile facts'))
  .addSubcommand((s) =>
    s
      .setName('remove')
      .setDescription('Remove a fact (keeps history)')
      .addStringOption((o) => o.setName('id').setDescription('Fact id (from /profile list)').setRequired(true)),
  );

// Narrow structural slice of ChatInputCommandInteraction (SPEC §12).
export interface ProfileInteractionPort {
  options: {
    getSubcommand(): string;
    getString(name: 'category' | 'label' | 'value' | 'id'): string | null;
  };
  deferReply(): Promise<unknown>;
  editReply(content: string | { embeds: import('discord.js').EmbedBuilder[] }): Promise<unknown>;
}

export interface ProfileCommandDeps {
  profile: Pick<ProfileRepo, 'addFact' | 'getFact' | 'activeFacts' | 'removeFact'>;
}

export async function handleProfileCommand(interaction: ProfileInteractionPort, deps: ProfileCommandDeps): Promise<void> {
  await interaction.deferReply();
  const sub = interaction.options.getSubcommand();
  if (sub === 'add') {
    const category = (interaction.options.getString('category') ?? 'spec') as ProfileFactCategory;
    const label = interaction.options.getString('label') ?? '';
    const value = interaction.options.getString('value') ?? '';
    const fact = deps.profile.addFact({ category, label, value });
    await interaction.editReply(`Added [${category}] **${label}** — ${value} (\`${fact.id}\`). Every hunt now consults it.`);
  } else if (sub === 'list') {
    const facts = deps.profile.activeFacts();
    if (facts.length === 0) await interaction.editReply('No profile facts yet.');
    else await interaction.editReply({ embeds: [buildProfileFactsEmbed(facts)] });
  } else {
    const id = interaction.options.getString('id') ?? '';
    const fact = deps.profile.getFact(id);
    if (!fact || fact.active === 0) {
      await interaction.editReply(`No active fact with id \`${id}\`.`);
      return;
    }
    deps.profile.removeFact(id);
    await interaction.editReply(`Removed **${fact.label}**.`);
  }
}
```

`src/discord/embeds.ts`:
- Import `ProfileFactRow` alongside `WatchRow`.
- In `buildListingEmbed`, after the landed line: `if (listing.discountCents > 0) lines.splice(1, 0, `Includes ${usd(listing.discountCents)} membership/coupon discount`);` — implement as a plain push right after `const lines = [...]` so order is landed → discount → condition → blank → verdict.
- New builder:

```typescript
const PROFILE_COLOR = 0x1abc9c;

/** SPEC §3.4: `/profile list` — one line per active fact (id, category, label, value). */
export function buildProfileFactsEmbed(facts: ProfileFactRow[]): EmbedBuilder {
  const line = (f: ProfileFactRow) => `\`${f.id}\` [${f.category}] **${truncate(f.label, 80)}** — ${truncate(f.value, 200)}`;
  return new EmbedBuilder()
    .setTitle('Profile facts')
    .setDescription(truncate(facts.map(line).join('\n'), DESCRIPTION_LIMIT))
    .setColor(PROFILE_COLOR)
    .setFooter({ text: `${facts.length} fact${facts.length === 1 ? '' : 's'}` });
}
```

`src/index.ts`:
- `import { makeProfileRepo } from './db/profile';` + `import { handleProfileCommand, profileCommandData } from './discord/commands/profile';`
- `const profile = makeProfileRepo(db);` after the other repos.
- Command list gains `{ data: profileCommandData, execute: (i) => handleProfileCommand(i, { profile }) }`.
- `runHunt` deps gain `profile`.

- [ ] **Step 4: Verify** — `bun run test` + `bun run typecheck` green.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "/profile command family + profile-facts embed; listing cards show applied discounts"`

---

### Task 7: Seller-rating extraction refinement

**Files:**
- Modify: `src/sources/types.ts`, `src/engine/extract.ts`, `src/sources/ebay.ts`, `src/sources/fixture.ts`, `src/engine/rank.ts`, `src/discord/embeds.ts`
- Test: `tests/unit/sources.test.ts` (extend), `tests/unit/rank.test.ts` (extend)

**Interfaces:**
- Produces: `RawListing.sellerRating?: number | null` (optional so every existing fixture/fake stays valid); adapters map it into `NormalizedListing.sellerRating`; verdict lines + listing cards render it when present.

- [ ] **Step 1: Failing tests**
  - `tests/unit/sources.test.ts`: extraction row with `sellerRating: 99.4` survives the strict parse and `toListing` carries it into `NormalizedListing.sellerRating`; a row without the key still parses (back-compat).
  - `tests/unit/rank.test.ts`: with `fakeRank(captured)`, a listing `{ ...listing('A', 1000), sellerRating: 99.4 }` produces prompts containing `seller: 99.4%`; the verdict system prompt (captured `systems`) mentions `seller rating`.
- [ ] **Step 2: Verify failure**, **Step 3: Implement**:
  - `src/sources/types.ts` — `rawListingSchema` gains `sellerRating: z.number().nullable().optional()`.
  - `src/engine/extract.ts` — `looseRowSchema` gains `sellerRating: z.number().nullable().describe('seller rating as shown — eBay feedback percent like 99.4 — or null')`.
  - `src/sources/ebay.ts` + `src/sources/fixture.ts` `toListing` — `sellerRating: raw.sellerRating ?? null,` (drop the "not extracted yet" comment).
  - `src/engine/rank.ts` `listingLine` — append `, seller: ${l.sellerRating}%` when `l.sellerRating != null`; `VERDICT_SYSTEM` cite list becomes `(title, landed price, condition, seller rating)`.
  - `src/discord/embeds.ts` `buildListingEmbed` — `if (listing.sellerRating != null) lines.push(`Seller: ${listing.sellerRating}%`);` next to the condition line.
- [ ] **Step 4: Verify** — full `bun run test` + typecheck green.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "Seller rating: optional extraction field surfaced to verdicts and cards"`

---

### Task 8: E2E — profile facts through the real pipeline

**Files:**
- Modify: `tests/bun/e2e/hunt-e2e.test.ts` (pipeline gains `profile` + returns `db`; new test)
- Modify: `tests/bun/e2e/watch-lifecycle-e2e.test.ts` (deps gain `profile`) — if not already done in Task 5.

**Interfaces:**
- Consumes: `makeProfileRepo` (Task 1), Task 5's `HuntDeps.profile`, `listing` table from `src/db/schema.ts`.

- [ ] **Step 1: Wire** `makePipeline`: `const profile = makeProfileRepo(db);`, pass `profile` into `runHunt` deps, return `{ …, profile, db }`.
- [ ] **Step 2: New failing test** in `hunt-e2e.test.ts`:

```typescript
test(
  'a coupon_source fact naming the source discounts landed cost end to end',
  async () => {
    fakeRankLlm();
    const p = makePipeline(server.baseUrl);
    p.profile.addFact({ category: 'coupon_source', label: 'fixture promo', value: '10% off fixture' });
    const enqueued = p.hunts.enqueueHunt({
      mode: 'oneshot',
      query: 'widget pro 3000',
      targetJson: JSON.stringify({ description: 'widget pro 3000', constraints: {} }),
      channelId: 'chan-e2e',
    });

    await p.settled;
    await p.worker.stop();

    expect(p.hunts.getHunt(enqueued.id)!.status).toBe('done');
    const byId = new Map(p.db.select().from(listing).all().map((l) => [l.id, l]));
    const results = p.listings.resultsForHunt(enqueued.id);
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      const l = byId.get(r.listingId)!;
      const expected = Math.max(0, l.priceCents! + (l.shippingCents ?? 0) - Math.round(l.priceCents! * 0.1));
      expect(r.landedCostCents).toBe(expected);
    }
    expect(p.reported[0]!.ranked.every((x) => x.discountCents > 0)).toBe(true);
  },
  20_000,
);
```

(Import `listing` from `../../../src/db/schema` and `makeProfileRepo` from `../../../src/db/profile`.)

- [ ] **Step 3: Run** — `bun run test:e2e` → all green (new + existing). `bun run test:db` green.
- [ ] **Step 4: Commit** — `git add -A && git commit -m "E2E: profile coupon fact discounts landed cost through the real queue"`

---

### Task 9: Close-out — checklist, log, PR

- [ ] **Step 1: Full suite** — `bun run typecheck && bun run test && bun run test:db && bun run test:e2e` → all green (record counts).
- [ ] **Step 2: `CHECKLIST.md`** — tick the Phase 3 items that are now true (leave live-smoke items unticked; that's Ben-gated).
- [ ] **Step 3: `log.md`** — extend the `[[07-19-26 Sat]]`… (correct: `[[07-19-26 Sun]]`) entry (same-day entries extend, never duplicate) with a Phase 3 block: shipped, the deterministic-discount rule decision (SPEC §15 open question scoped), open/next (live smoke of `/profile` + a discounted hunt, then merge).
- [ ] **Step 4: Push + PR** —

```bash
git push -u origin phase-3-profile
gh pr create --title "Phase 3: profile facts + best-deal logic (/profile, discounts, seller rating)" --body "…summary, test counts, live-smoke checklist for Ben…

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

Note in the PR body: live Discord smoke (`/profile add/list/remove`, a hunt with a discount fact) is Ben-gated; offline suite fully green.
