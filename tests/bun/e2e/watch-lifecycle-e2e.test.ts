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
import { runSchedulerTick } from '../../../src/watch/scheduler';
import { startWorker } from '../../../src/watch/worker';
import { openTestDb } from '../helpers/db';
import { serveStatic, type StaticServer } from '../../helpers/static-server';

// The Phase 2 exit-path e2e: the watch lifecycle across the scheduler↔dedup
// seam no unit test covers. A watch becomes due → runSchedulerTick enqueues a
// watch_run hunt into the SAME queue the worker drains → engine runs it against
// the fixture site and reports N new → the second scheduled run finds the same
// listings, reports NOTHING (dedup) while hunt_result still keeps the full
// ranked set. Offline and free: the only faked seam is the LLM.

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

const MINUTE = 60_000;

describe('watch lifecycle e2e (scheduler → queue → engine dedup, fixture source, offline)', () => {
  test(
    'due watch → tick enqueues → first run reports all new; second run reports nothing new',
    async () => {
      fakeRankLlm();
      const db = openTestDb();
      const hunts = makeHuntsRepo(db);
      const listings = makeListingsRepo(db);
      const watches = makeWatchesRepo(db);
      const profile = makeProfileRepo(db);

      // The recording reporter; one deferred settles per COMPLETED run (settling
      // on report alone would race the post-report insertHits/completeHunt).
      const reported: { hunt: HuntRow; ranked: RankedListing[]; extractedCount: number }[] = [];
      const errored: { hunt: HuntRow; message: string }[] = [];
      const runs = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
      let settleIdx = 0;
      const reporter: Reporter = {
        results: async (hunt, _target, ranked, extractedCount) => {
          reported.push({ hunt, ranked, extractedCount });
        },
        error: async (hunt, message) => {
          errored.push({ hunt, message });
        },
      };

      const { pace, reportChallenge } = makePacer();
      const worker = startWorker({
        hunts,
        idleMs: 20,
        runHunt: async (hunt) => {
          await runHunt(hunt, {
            adapters: () => [makeFixtureAdapter(server.baseUrl)],
            getPage: () => browser.newPage(),
            hunts,
            listings,
            watches,
            profile,
            reporter,
            pace,
            reportChallenge,
          });
          runs[settleIdx++]?.resolve();
        },
      });

      try {
        // A watch due NOW, cadence 24h. random=0.5 → jitter factor exactly 1.0,
        // so the bump lands at t0 + cadence deterministically.
        const t0 = Date.now();
        const cadenceMinutes = 24 * 60;
        const w = watches.createWatch({
          name: 'widget pro 3000',
          targetJson: JSON.stringify({ description: 'widget pro 3000', constraints: {} }),
          cadenceMinutes,
          channelId: 'chan-watch-e2e',
          nextRunAt: new Date(t0).toISOString(),
        });

        // Tick 1: enqueues the watch_run and bumps next_run_at one cadence out.
        const tickDeps = { watches, hunts, random: () => 0.5 };
        expect(runSchedulerTick({ ...tickDeps, now: () => new Date(t0) })).toBe(1);
        const bumped = watches.getWatch(w.id)!;
        expect(bumped.lastRunAt).toBe(new Date(t0).toISOString());
        expect(bumped.nextRunAt).toBe(new Date(t0 + cadenceMinutes * MINUTE).toISOString());

        // Same-instant re-tick is a no-op: the watch is no longer due.
        expect(runSchedulerTick({ ...tickDeps, now: () => new Date(t0) })).toBe(0);

        // First run: worker claims the enqueued watch_run; all 5 fixture
        // listings are new → all reported, all marked as hits.
        await runs[0]!.promise;
        expect(errored).toHaveLength(0);
        const run1 = reported[0]!;
        expect(run1.hunt.mode).toBe('watch_run');
        expect(run1.hunt.watchId).toBe(w.id);
        expect(run1.ranked).toHaveLength(5);
        expect(watches.countHits(w.id)).toBe(5);
        const done1 = hunts.getHunt(run1.hunt.id)!;
        expect(done1.status).toBe('done');
        expect(done1.costCents).toBe(2); // two rank calls, no parse cost on scheduled runs

        // Tick 2, one cadence (+1min) later: due again, enqueues run 2.
        const t1 = t0 + (cadenceMinutes + 1) * MINUTE;
        expect(runSchedulerTick({ ...tickDeps, now: () => new Date(t1) })).toBe(1);

        // Second run: same 5 listings extracted and ranked, but every one has a
        // watch_hit → the report is EMPTY (silence, not a nothing-found card)...
        await runs[1]!.promise;
        expect(errored).toHaveLength(0);
        const run2 = reported[1]!;
        expect(run2.hunt.id).not.toBe(run1.hunt.id);
        expect(run2.extractedCount).toBe(5);
        expect(run2.ranked).toHaveLength(0);

        // ...while hunt_result keeps the full ranked history for run 2,
        // hit markers don't double up, and listings dedup by (source, source_id).
        const results2 = listings.resultsForHunt(run2.hunt.id);
        expect(results2.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5]);
        expect(watches.countHits(w.id)).toBe(5);
        expect(listings.countListings()).toBe(5);
        expect(hunts.getHunt(run2.hunt.id)!.status).toBe('done');
      } finally {
        await worker.stop();
      }
    },
    30_000,
  );
});
