import { describe, expect, it } from 'vitest';
import type { EnqueueHuntInput, HuntRow, WatchRow } from '../../src/db/types';
import { runSchedulerTick, startScheduler } from '../../src/watch/scheduler';

// SPEC §2.1 / Phase 2 watch scheduler: a 60s croner tick marks due watches and
// enqueues watch_run hunts, bumping next_run_at forward by cadence ± 10% jitter
// (jitter math lives here with an injectable random; the repo stays deterministic).

const watchRow = (over: Partial<WatchRow> = {}): WatchRow => ({
  id: 'w1',
  name: 'MX Master 3S',
  targetJson: '{"query":"MX Master 3S","maxPriceCents":7000}',
  cadenceMinutes: 1440,
  nextRunAt: '2026-07-17T00:00:00.000Z',
  status: 'active',
  channelId: 'c1',
  lastRunAt: null,
  createdAt: '2026-07-10T00:00:00.000Z',
  ...over,
});

/** Fakes for the two repos the tick touches, recording every call. */
function makeHarness(due: WatchRow[]) {
  const enqueued: EnqueueHuntInput[] = [];
  const bumps: { id: string; nextRunAt: string; lastRunAt: string }[] = [];
  return {
    enqueued,
    bumps,
    watches: {
      dueWatches: (_nowIso: string) => due,
      bumpNextRun: (id: string, patch: { nextRunAt: string; lastRunAt: string }) =>
        void bumps.push({ id, ...patch }),
    },
    hunts: {
      enqueueHunt: (input: EnqueueHuntInput): HuntRow => {
        enqueued.push(input);
        return { id: `h${enqueued.length}` } as HuntRow;
      },
    },
  };
}

const NOW = new Date('2026-07-17T12:00:00.000Z');

describe('runSchedulerTick', () => {
  it('enqueues one watch_run hunt per due watch, carrying the watch identity', () => {
    const h = makeHarness([
      watchRow({ id: 'w1', name: 'Mouse', targetJson: '{"a":1}', channelId: 'chan-1' }),
      watchRow({ id: 'w2', name: 'Keyboard', targetJson: '{"b":2}', channelId: 'chan-2' }),
    ]);

    const n = runSchedulerTick({ watches: h.watches, hunts: h.hunts, now: () => NOW });

    expect(n).toBe(2);
    expect(h.enqueued).toEqual([
      { mode: 'watch_run', query: 'Mouse', targetJson: '{"a":1}', channelId: 'chan-1', watchId: 'w1' },
      { mode: 'watch_run', query: 'Keyboard', targetJson: '{"b":2}', channelId: 'chan-2', watchId: 'w2' },
    ]);
  });

  it('bumps next_run_at forward by cadence (jitter-free at random=0.5) and records lastRunAt = now', () => {
    const h = makeHarness([watchRow({ id: 'w1', cadenceMinutes: 60 })]);

    runSchedulerTick({ watches: h.watches, hunts: h.hunts, now: () => NOW, random: () => 0.5 });

    // random 0.5 → jitter factor 1.0 → exactly +60 min.
    expect(h.bumps).toEqual([
      { id: 'w1', nextRunAt: '2026-07-17T13:00:00.000Z', lastRunAt: '2026-07-17T12:00:00.000Z' },
    ]);
  });

  it('keeps jitter within ±10% of cadence at the random extremes', () => {
    const cadenceMs = 1440 * 60_000;
    for (const r of [0, 1, 0.5, 0.123, 0.999]) {
      const h = makeHarness([watchRow({ id: 'w1', cadenceMinutes: 1440 })]);
      runSchedulerTick({ watches: h.watches, hunts: h.hunts, now: () => NOW, random: () => r });
      const delta = new Date(h.bumps[0]!.nextRunAt).getTime() - NOW.getTime();
      expect(delta).toBeGreaterThanOrEqual(cadenceMs * 0.9);
      expect(delta).toBeLessThanOrEqual(cadenceMs * 1.1);
    }
  });

  it('does nothing and returns 0 when no watch is due', () => {
    const h = makeHarness([]);
    const n = runSchedulerTick({ watches: h.watches, hunts: h.hunts, now: () => NOW });
    expect(n).toBe(0);
    expect(h.enqueued).toEqual([]);
    expect(h.bumps).toEqual([]);
  });

  it('a watch that fails to enqueue is skipped loudly; the rest still run', () => {
    const enqueued: EnqueueHuntInput[] = [];
    const bumps: string[] = [];
    const watches = {
      dueWatches: () => [watchRow({ id: 'bad' }), watchRow({ id: 'good' })],
      bumpNextRun: (id: string) => void bumps.push(id),
    };
    const hunts = {
      enqueueHunt: (input: EnqueueHuntInput): HuntRow => {
        if (input.watchId === 'bad') throw new Error('db down');
        enqueued.push(input);
        return { id: 'h1' } as HuntRow;
      },
    };

    const n = runSchedulerTick({ watches, hunts, now: () => NOW });

    expect(n).toBe(1);
    expect(enqueued.map((e) => e.watchId)).toEqual(['good']);
    expect(bumps).toEqual(['good']); // the failed watch is NOT bumped — it stays due to retry
  });
});

describe('startScheduler', () => {
  it('wires an every-minute cron tick and stop() stops the job', () => {
    let captured: { pattern: string; cb: () => void } | undefined;
    let stopped = false;
    const h = makeHarness([watchRow({ id: 'w1' })]);

    const handle = startScheduler({
      watches: h.watches,
      hunts: h.hunts,
      now: () => NOW,
      cron: (pattern, cb) => {
        captured = { pattern, cb };
        return { stop: () => void (stopped = true) };
      },
    });

    expect(captured?.pattern).toBe('* * * * *');
    expect(h.enqueued).toEqual([]); // nothing runs until the cron fires

    captured!.cb(); // simulate a tick
    expect(h.enqueued).toHaveLength(1);

    handle.stop();
    expect(stopped).toBe(true);
  });

  it('a throwing tick never escapes the cron callback', () => {
    const watches = {
      dueWatches: () => {
        throw new Error('boom');
      },
      bumpNextRun: () => {},
    };
    let cb!: () => void;
    startScheduler({
      watches,
      hunts: { enqueueHunt: () => ({ id: 'h1' }) as HuntRow },
      cron: (_p, c) => {
        cb = c;
        return { stop: () => {} };
      },
    });
    expect(() => cb()).not.toThrow();
  });
});
