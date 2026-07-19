import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { chromium, type Browser } from 'playwright';
import { fileURLToPath } from 'node:url';
import { makePacer } from '../../../src/browser/pacing';
import { makeHuntsRepo } from '../../../src/db/hunts';
import { makeListingsRepo } from '../../../src/db/listings';
import { makeProfileRepo } from '../../../src/db/profile';
import { makeWatchesRepo } from '../../../src/db/watches';
import type { HuntRow } from '../../../src/db/types';
import { runHunt, type Reporter } from '../../../src/engine/hunt';
import { setGenerateForTests } from '../../../src/engine/llm';
import type { RankedListing } from '../../../src/engine/rank';
import { makeFixtureAdapter } from '../../../src/sources/fixture';
import { startWorker } from '../../../src/watch/worker';
import { openTestDb } from '../helpers/db';
import { serveStatic, type StaticServer } from '../../helpers/static-server';

// The Phase 1 exit-path e2e (SPEC §12): a full hunt through the QUEUE — enqueue
// → worker claims → engine drives real Playwright against the local fixture
// site → ranked hunt_result rows in a real SQLite db → reporter fires. Offline
// and free: the only faked seam is the LLM.

const FIXTURES = fileURLToPath(new URL('../../fixtures/fixture', import.meta.url));

let server: StaticServer;
let browser: Browser;

beforeAll(async () => {
  server = await serveStatic(FIXTURES);
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

afterEach(() => setGenerateForTests(null));

/** LLM seam for rank's two passes: everything matches, verdicts by index. 1¢/call. */
function fakeRankLlm() {
  setGenerateForTests(({ label, prompt }) => {
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

function makePipeline(baseUrl: string) {
  const db = openTestDb();
  const hunts = makeHuntsRepo(db);
  const listings = makeListingsRepo(db);
  const watches = makeWatchesRepo(db);
  const profile = makeProfileRepo(db);

  const reported: { hunt: HuntRow; ranked: RankedListing[]; extractedCount: number }[] = [];
  const errored: { hunt: HuntRow; message: string }[] = [];
  const { promise: settled, resolve: settle } = Promise.withResolvers<void>();
  const reporter: Reporter = {
    results: async (hunt, _target, ranked, extractedCount) => {
      reported.push({ hunt, ranked, extractedCount });
      settle();
    },
    error: async (hunt, message) => {
      errored.push({ hunt, message });
      settle();
    },
  };

  const worker = startWorker({
    hunts,
    idleMs: 20,
    runHunt: (hunt) =>
      runHunt(hunt, {
        adapters: () => [makeFixtureAdapter(baseUrl)],
        getPage: () => browser.newPage(),
        hunts,
        listings,
        watches,
        profile,
        reporter,
        pace: makePacer(),
      }),
  });

  return { db, hunts, listings, profile, reported, errored, settled, worker };
}

describe('hunt e2e through the queue (fixture source, offline)', () => {
  test(
    'enqueue → claim → search → rank → hunt_result rows + done, with cost accounted',
    async () => {
      fakeRankLlm();
      const p = makePipeline(server.baseUrl);
      const enqueued = p.hunts.enqueueHunt({
        mode: 'oneshot',
        query: 'widget pro 3000',
        targetJson: JSON.stringify({ description: 'widget pro 3000', constraints: {} }),
        channelId: 'chan-e2e',
        initialCostCents: 1, // the command-side parse cost rides along
      });

      await p.settled;
      await p.worker.stop();

      // Hunt row: done, cost = parse 1¢ + two rank calls (2¢).
      const done = p.hunts.getHunt(enqueued.id)!;
      expect(done.status).toBe('done');
      expect(done.finishedAt).not.toBeNull();
      expect(done.costCents).toBe(3);

      // Listings persisted (5 usable cards on the fixture page).
      expect(p.listings.countListings()).toBe(5);

      // Ranked results: 5 rows, ranks 1..5, landed cost ascending.
      const results = p.listings.resultsForHunt(enqueued.id);
      expect(results.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5]);
      const landed = results.map((r) => r.landedCostCents!);
      expect([...landed].sort((a, b) => a - b)).toEqual(landed);
      expect(results.every((r) => r.verdict?.startsWith('v'))).toBe(true);

      // Reporter saw the same picture.
      expect(p.reported).toHaveLength(1);
      expect(p.reported[0]!.extractedCount).toBe(5);
      expect(p.reported[0]!.ranked).toHaveLength(5);
      expect(p.errored).toHaveLength(0);
    },
    20_000,
  );

  test(
    'an unreachable source fails the hunt loudly: row failed + error reported',
    async () => {
      fakeRankLlm();
      const p = makePipeline('http://127.0.0.1:9'); // connection refused
      const enqueued = p.hunts.enqueueHunt({
        mode: 'oneshot',
        query: 'widget pro 3000',
        targetJson: JSON.stringify({ description: 'widget pro 3000', constraints: {} }),
        channelId: 'chan-e2e',
      });

      await p.settled;
      await p.worker.stop();

      const failed = p.hunts.getHunt(enqueued.id)!;
      expect(failed.status).toBe('failed');
      expect(failed.error).toMatch(/fixture/);
      expect(p.errored).toHaveLength(1);
      expect(p.reported).toHaveLength(0);
    },
    20_000,
  );
});
