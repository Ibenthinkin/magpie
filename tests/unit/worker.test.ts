import { describe, expect, it } from 'vitest';
import type { HuntRow } from '../../src/db/types';
import { startWorker } from '../../src/watch/worker';

// SPEC §9 worker: single loop, concurrency 1 — claim → run → claim again;
// idle-sleeps when the queue is empty. runHunt never throws by contract, but
// the loop must survive one anyway (fail loud, keep serving the queue).

const huntRow = (id: string): HuntRow => ({
  id,
  mode: 'oneshot',
  query: 'widget',
  targetJson: '{}',
  status: 'running',
  watchId: null,
  channelId: 'c1',
  error: null,
  costCents: null,
  startedAt: '2026-07-15T00:00:00.000Z',
  finishedAt: null,
  createdAt: '2026-07-15T00:00:00.000Z',
});

/** FIFO queue fake + a sleep that records idle waits and can trigger actions. */
function makeHarness(ids: string[]) {
  const queue = ids.map(huntRow);
  const h = {
    ran: [] as string[],
    slept: [] as number[],
    claims: 0,
    onIdle: undefined as (() => void) | undefined,
    claimNextHunt(): HuntRow | null {
      h.claims++;
      return queue.shift() ?? null;
    },
    sleep: async (ms: number) => {
      h.slept.push(ms);
      await Promise.resolve(); // yield so the test can attach onIdle after startWorker returns
      h.onIdle?.();
    },
  };
  return h;
}

describe('startWorker', () => {
  it('drains the queue in claim order, then idle-sleeps', async () => {
    const h = makeHarness(['h1', 'h2']);
    const worker = startWorker({
      hunts: { claimNextHunt: () => h.claimNextHunt() },
      runHunt: async (hunt) => void h.ran.push(hunt.id),
      idleMs: 5000,
      sleep: h.sleep,
    });
    h.onIdle = () => void worker.stop();
    await worker.done;

    expect(h.ran).toEqual(['h1', 'h2']);
    expect(h.slept).toEqual([5000]);
  });

  it('a throwing runHunt is caught and the loop continues to the next hunt', async () => {
    const h = makeHarness(['h1', 'h2']);
    const worker = startWorker({
      hunts: { claimNextHunt: () => h.claimNextHunt() },
      runHunt: async (hunt) => {
        h.ran.push(hunt.id);
        if (hunt.id === 'h1') throw new Error('boom');
      },
      idleMs: 5000,
      sleep: h.sleep,
    });
    h.onIdle = () => void worker.stop();
    await worker.done;

    expect(h.ran).toEqual(['h1', 'h2']);
  });

  it('stop() resolves only after the in-flight hunt finishes, and claims nothing new', async () => {
    const h = makeHarness(['h1', 'h2']);
    let finishHunt!: () => void;
    let huntFinished = false;
    const worker = startWorker({
      hunts: { claimNextHunt: () => h.claimNextHunt() },
      runHunt: (hunt) => {
        h.ran.push(hunt.id);
        return new Promise<void>((resolve) => {
          finishHunt = () => {
            huntFinished = true;
            resolve();
          };
        });
      },
      idleMs: 5000,
      sleep: h.sleep,
    });

    // Let the loop claim h1 and enter runHunt.
    await Promise.resolve();
    expect(h.ran).toEqual(['h1']);

    let stopped = false;
    const stopping = worker.stop().then(() => {
      stopped = true;
      expect(huntFinished).toBe(true); // never resolves mid-hunt
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    finishHunt();
    await stopping;
    expect(h.ran).toEqual(['h1']); // h2 stays queued
    expect(h.claims).toBe(1);
  });

  it('idle sleep defaults to 5s per SPEC §9', async () => {
    const h = makeHarness([]);
    const worker = startWorker({
      hunts: { claimNextHunt: () => h.claimNextHunt() },
      runHunt: async () => {},
      sleep: h.sleep,
    });
    h.onIdle = () => void worker.stop();
    await worker.done;
    expect(h.slept).toEqual([5000]);
  });
});
