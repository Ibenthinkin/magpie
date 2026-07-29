import { afterEach, describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import type {
  HuntRow,
  HuntsRepo,
  ListingRow,
  ListingsRepo,
  NewHuntResult,
  NewListing,
  ProfileFactRow,
} from '../../src/db/types';
import { ChallengeDetectedError } from '../../src/browser/pacing';
import { setGenerateForTests } from '../../src/engine/llm';
import { runHunt, type HuntDeps, type Reporter } from '../../src/engine/hunt';
import type { RawListing, SourceAdapter, SourceId } from '../../src/sources/types';

// SPEC §8 orchestration, fully offline: fake repos, fake adapters, fake
// reporter, LLM seam. Step 6 (watch dedup) is Phase 2; oneshot path here.

afterEach(() => setGenerateForTests(null));

// --- fixtures -------------------------------------------------------------

const huntRow = (over: Partial<HuntRow> = {}): HuntRow => ({
  id: 'h1',
  mode: 'oneshot',
  query: 'widget 3000',
  targetJson: JSON.stringify({ description: 'widget 3000', constraints: {} }),
  status: 'running',
  watchId: null,
  channelId: 'c1',
  error: null,
  costCents: null,
  startedAt: '2026-07-14T00:00:00.000Z',
  finishedAt: null,
  createdAt: '2026-07-14T00:00:00.000Z',
  ...over,
});

const raw = (n: number, over: Partial<RawListing> = {}): RawListing => ({
  title: `Widget ${n}`,
  priceCents: n * 1000,
  shippingCents: null,
  condition: 'New',
  url: `https://example.com/item/${n}`,
  ...over,
});

/** Adapter that returns canned rows (or throws). toListing mirrors the real ones: null when URL-less. */
const fakeAdapter = (source: SourceId, rows: RawListing[] | Error): SourceAdapter => ({
  source,
  rateLimit: { minDelayMs: 0, maxPerHour: 1000 },
  async search() {
    if (rows instanceof Error) throw rows;
    return rows;
  },
  toListing(r) {
    if (!r.url) return null;
    return {
      source,
      sourceId: r.url.split('/').pop()!,
      url: r.url,
      title: r.title,
      priceCents: r.priceCents,
      shippingCents: r.shippingCents,
      currency: 'USD',
      condition: r.condition,
      sellerRating: null,
      location: null,
      imageUrl: null,
      rawJson: JSON.stringify(r),
    };
  },
});

/** LLM seam covering rankListings' two passes; everything matches, verdict per index. */
function fakeRank(captured?: { prompts: string[] }) {
  setGenerateForTests(({ label, prompt }) => {
    captured?.prompts.push(prompt);
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

interface Harness {
  deps: HuntDeps;
  upserts: NewListing[];
  resultRows: { huntId: string; rows: NewHuntResult[] }[];
  completed: { id: string; addCostCents: number }[];
  failed: { id: string; error: string }[];
  reported: { hunt: HuntRow; rankedTitles: string[]; extractedCount: number }[];
  errored: { hunt: HuntRow; message: string }[];
  paced: string[];
  challengedSources: string[];
  /** watch dedup fake: listing ids already hit, and insertHits calls made. */
  seen: Set<string>;
  hitsInserted: { watchId: string; listingIds: string[] }[];
  /** profile fake: what activeFacts() hands the engine. */
  facts: ProfileFactRow[];
}

function makeHarness(adapters: SourceAdapter[]): Harness {
  const h: Harness = {
    deps: undefined as unknown as HuntDeps,
    upserts: [],
    resultRows: [],
    completed: [],
    failed: [],
    reported: [],
    errored: [],
    paced: [],
    challengedSources: [],
    seen: new Set(),
    hitsInserted: [],
    facts: [],
  };
  let n = 0;
  const hunts: HuntsRepo = {
    enqueueHunt: () => {
      throw new Error('unused');
    },
    claimNextHunt: () => null,
    completeHunt: (id, patch) => void h.completed.push({ id, addCostCents: patch.addCostCents }),
    failHunt: (id, error) => void h.failed.push({ id, error }),
    resetStaleRunning: () => 0,
    getHunt: () => null,
  };
  const listings: ListingsRepo = {
    upsertListing: (input) => {
      h.upserts.push(input);
      return { id: `L${++n}`, firstSeenAt: '', lastSeenAt: '', ...input } as ListingRow;
    },
    insertHuntResults: (huntId, rows) => void h.resultRows.push({ huntId, rows }),
    resultsForHunt: () => [],
    countListings: () => h.upserts.length,
  };
  const reporter: Reporter = {
    results: async (hunt, _target, ranked, extractedCount) =>
      void h.reported.push({ hunt, rankedTitles: ranked.map((r) => r.title), extractedCount }),
    error: async (hunt, message) => void h.errored.push({ hunt, message }),
  };
  h.deps = {
    adapters: () => adapters,
    getPage: async () => ({ close: async () => {} }) as unknown as Page,
    hunts,
    listings,
    reporter,
    pace: async (source) => void h.paced.push(source),
    reportChallenge: (source) => void h.challengedSources.push(source),
    watches: {
      unseenListingIds: (_watchId, ids) => ids.filter((id) => !h.seen.has(id)),
      insertHits: (watchId, listingIds) => void h.hitsInserted.push({ watchId, listingIds }),
    },
    profile: { activeFacts: () => h.facts },
  };
  return h;
}

// --- tests ------------------------------------------------------------------

describe('runHunt', () => {
  it('happy path: upserts, ranks, stores hunt_results, reports, completes with LLM cost', async () => {
    fakeRank();
    const h = makeHarness([fakeAdapter('ebay', [raw(3), raw(1), raw(2)])]);
    await runHunt(huntRow(), h.deps);

    expect(h.upserts).toHaveLength(3);
    expect(h.paced).toEqual(['ebay']);

    // Ranked by landed cost ascending (all matchesTarget); listing ids follow upsert order.
    expect(h.resultRows).toHaveLength(1);
    const rows = h.resultRows[0]!.rows;
    expect(rows.map((r) => [r.rank, r.landedCostCents])).toEqual([
      [1, 1000],
      [2, 2000],
      [3, 3000],
    ]);
    expect(rows[0]!.listingId).toBe('L2'); // raw(1) was upserted second
    expect(rows.every((r) => r.verdict?.startsWith('v'))).toBe(true);

    expect(h.reported).toHaveLength(1);
    expect(h.reported[0]!.rankedTitles).toEqual(['Widget 1', 'Widget 2', 'Widget 3']);
    expect(h.reported[0]!.extractedCount).toBe(3);

    expect(h.completed).toEqual([{ id: 'h1', addCostCents: 2 }]); // 2 × $0.01
    expect(h.failed).toEqual([]);
  });

  it('drops URL-less rows (toListing null) before persisting', async () => {
    fakeRank();
    const h = makeHarness([fakeAdapter('ebay', [raw(1), raw(2, { url: null })])]);
    await runHunt(huntRow(), h.deps);
    expect(h.upserts).toHaveLength(1);
    expect(h.reported[0]!.extractedCount).toBe(1);
  });

  it('applies the hard-constraint pre-filter BEFORE the LLM sees listings', async () => {
    const captured = { prompts: [] as string[] };
    fakeRank(captured);
    const h = makeHarness([fakeAdapter('ebay', [raw(1), raw(50)])]); // raw(50) lands at 50_000
    await runHunt(
      huntRow({ targetJson: JSON.stringify({ description: 'w', constraints: { maxPriceCents: 10_000 } }) }),
      h.deps,
    );
    expect(h.upserts).toHaveLength(2); // still persisted for history
    expect(captured.prompts.every((p) => !p.includes('Widget 50'))).toBe(true);
    expect(h.reported[0]!.rankedTitles).toEqual(['Widget 1']);
  });

  it('one adapter failing continues with the rest and still completes', async () => {
    fakeRank();
    const h = makeHarness([
      fakeAdapter('ebay', new Error('bot challenge')),
      fakeAdapter('fixture', [raw(1)]),
    ]);
    await runHunt(huntRow(), h.deps);
    expect(h.upserts).toHaveLength(1);
    expect(h.completed).toHaveLength(1);
    expect(h.failed).toEqual([]);
  });

  it('an adapter throwing ChallengeDetectedError reports the challenge and the hunt still completes', async () => {
    fakeRank();
    const h = makeHarness([
      fakeAdapter('ebay', new ChallengeDetectedError('eBay served a bot challenge')),
      fakeAdapter('fixture', [raw(1)]),
    ]);
    await runHunt(huntRow(), h.deps);
    expect(h.challengedSources).toEqual(['ebay']);
    expect(h.upserts).toHaveLength(1);
    expect(h.completed).toHaveLength(1);
    expect(h.failed).toEqual([]);
  });

  it('an adapter throwing a plain Error does NOT report a challenge', async () => {
    fakeRank();
    const h = makeHarness([
      fakeAdapter('ebay', new Error('bot challenge')),
      fakeAdapter('fixture', [raw(1)]),
    ]);
    await runHunt(huntRow(), h.deps);
    expect(h.challengedSources).toEqual([]);
    expect(h.completed).toHaveLength(1);
  });

  it('ALL adapters failing marks the hunt failed and reports the error', async () => {
    fakeRank();
    const h = makeHarness([
      fakeAdapter('ebay', new Error('bot challenge')),
      fakeAdapter('fixture', new Error('down')),
    ]);
    await runHunt(huntRow(), h.deps);
    expect(h.completed).toEqual([]);
    expect(h.failed).toHaveLength(1);
    expect(h.failed[0]!.error).toMatch(/ebay/);
    expect(h.failed[0]!.error).toMatch(/fixture/);
    expect(h.errored).toHaveLength(1);
  });

  it('zero extracted listings is a DONE hunt with an empty report, not a failure — and no LLM spend', async () => {
    setGenerateForTests(() => {
      throw new Error('LLM must not be called for an empty result set');
    });
    const h = makeHarness([fakeAdapter('ebay', [])]);
    await runHunt(huntRow(), h.deps);
    expect(h.completed).toHaveLength(1);
    expect(h.failed).toEqual([]);
    expect(h.reported).toEqual([{ hunt: expect.anything(), rankedTitles: [], extractedCount: 0 }]);
  });

  it('unparseable targetJson fails the hunt loudly', async () => {
    const h = makeHarness([fakeAdapter('ebay', [raw(1)])]);
    await runHunt(huntRow({ targetJson: 'not json' }), h.deps);
    expect(h.failed).toHaveLength(1);
    expect(h.errored).toHaveLength(1);
    expect(h.completed).toEqual([]);
  });

  it('no resolvable sources fails the hunt', async () => {
    const h = makeHarness([]);
    await runHunt(huntRow(), h.deps);
    expect(h.failed).toHaveLength(1);
    expect(h.failed[0]!.error).toMatch(/source/i);
  });

  describe('step 6 — watch dedup (watch_run mode only)', () => {
    const watchRun = (over: Partial<HuntRow> = {}) => huntRow({ mode: 'watch_run', watchId: 'w1', ...over });

    it('first run: everything is new — all ranked reported, hits recorded for the reported ids', async () => {
      fakeRank();
      const h = makeHarness([fakeAdapter('ebay', [raw(1), raw(2)])]);
      await runHunt(watchRun(), h.deps);
      expect(h.reported[0]!.rankedTitles).toEqual(['Widget 1', 'Widget 2']);
      expect(h.hitsInserted).toEqual([{ watchId: 'w1', listingIds: ['L1', 'L2'] }]);
      expect(h.completed).toHaveLength(1);
    });

    it('repeat run: already-hit listings are filtered from the report; only new ones get hit rows', async () => {
      fakeRank();
      const h = makeHarness([fakeAdapter('ebay', [raw(1), raw(2)])]);
      h.seen.add('L1'); // raw(1) upserts first → L1
      await runHunt(watchRun(), h.deps);
      expect(h.reported[0]!.rankedTitles).toEqual(['Widget 2']);
      expect(h.hitsInserted).toEqual([{ watchId: 'w1', listingIds: ['L2'] }]);
    });

    it('nothing new: reporter still gets the (empty) results call, and no hits are inserted', async () => {
      fakeRank();
      const h = makeHarness([fakeAdapter('ebay', [raw(1)])]);
      h.seen.add('L1');
      await runHunt(watchRun(), h.deps);
      expect(h.reported[0]!.rankedTitles).toEqual([]);
      expect(h.hitsInserted).toEqual([]);
      expect(h.completed).toHaveLength(1);
    });

    it('hunt_result history still records ALL ranked rows, not just the unseen ones', async () => {
      fakeRank();
      const h = makeHarness([fakeAdapter('ebay', [raw(1), raw(2)])]);
      h.seen.add('L1');
      await runHunt(watchRun(), h.deps);
      expect(h.resultRows[0]!.rows).toHaveLength(2);
    });

    it('hits are recorded only AFTER a successful report — a failed post must not suppress future notification', async () => {
      fakeRank();
      const h = makeHarness([fakeAdapter('ebay', [raw(1)])]);
      h.deps.reporter.results = async () => {
        throw new Error('discord down');
      };
      await runHunt(watchRun(), h.deps);
      expect(h.hitsInserted).toEqual([]);
      expect(h.failed).toHaveLength(1);
    });

    it('oneshot hunts never consult the dedup', async () => {
      fakeRank();
      const h = makeHarness([fakeAdapter('ebay', [raw(1)])]);
      h.seen.add('L1'); // would suppress if dedup ran
      await runHunt(huntRow(), h.deps);
      expect(h.reported[0]!.rankedTitles).toEqual(['Widget 1']);
      expect(h.hitsInserted).toEqual([]);
    });
  });

  describe('profile facts (Phase 3)', () => {
    const couponFact = (value: string): ProfileFactRow => ({
      id: 'f1',
      category: 'coupon_source',
      label: 'eBay coupon',
      value,
      active: 1,
      createdAt: '',
      updatedAt: '',
    });

    it('active profile facts discount landed cost and reach the rank prompts', async () => {
      const captured = { prompts: [] as string[] };
      fakeRank(captured);
      const h = makeHarness([fakeAdapter('ebay', [raw(1)])]); // price 1000
      h.facts.push(couponFact('10% off ebay'));
      await runHunt(huntRow(), h.deps);
      expect(h.resultRows[0]!.rows[0]!.landedCostCents).toBe(900);
      expect(captured.prompts.every((p) => p.includes('Shopper profile facts:'))).toBe(true);
    });

    it('discounted price can rescue a listing from the hard price ceiling', async () => {
      fakeRank();
      const h = makeHarness([fakeAdapter('ebay', [raw(1, { priceCents: 10_500 })])]);
      h.facts.push(couponFact('10% off ebay'));
      await runHunt(
        huntRow({ targetJson: JSON.stringify({ description: 'w', constraints: { maxPriceCents: 10_000 } }) }),
        h.deps,
      );
      expect(h.reported[0]!.rankedTitles).toEqual(['Widget 1']);
    });
  });

  it('a reporter failure marks the hunt failed rather than losing results silently', async () => {
    fakeRank();
    const h = makeHarness([fakeAdapter('ebay', [raw(1)])]);
    h.deps.reporter.results = async () => {
      throw new Error('discord 403');
    };
    await runHunt(huntRow(), h.deps);
    expect(h.completed).toEqual([]);
    expect(h.failed).toHaveLength(1);
    expect(h.failed[0]!.error).toMatch(/discord 403/);
  });
});
