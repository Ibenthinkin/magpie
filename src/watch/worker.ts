import type { HuntRow, HuntsRepo } from '../db/types';
import { log, logError } from '../log';

// The hunt worker (SPEC §9): a single loop at concurrency 1 — claim → run →
// claim again, idle-sleeping when the queue is empty. Lives under watch/
// because Phase 2's watch_run hunts flow through this same loop.

export interface WorkerDeps {
  hunts: Pick<HuntsRepo, 'claimNextHunt'>;
  runHunt: (hunt: HuntRow) => Promise<void>;
  /** Idle sleep between empty claims. SPEC §9 says 5 s. */
  idleMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface WorkerHandle {
  /** Resolves when the loop has exited (after any in-flight hunt finishes). */
  done: Promise<void>;
  /** Ask the loop to exit; never interrupts a running hunt. */
  stop: () => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function startWorker(deps: WorkerDeps): WorkerHandle {
  const idleMs = deps.idleMs ?? 5000;
  const sleep = deps.sleep ?? defaultSleep;
  let stopping = false;

  const done = (async () => {
    while (!stopping) {
      const hunt = deps.hunts.claimNextHunt();
      if (!hunt) {
        await sleep(idleMs);
        continue;
      }
      try {
        await deps.runHunt(hunt);
      } catch (err) {
        // runHunt's contract is to never throw — this is a belt-and-braces
        // guard so a bug there can't kill the queue.
        logError('worker.run', err, { hunt: hunt.id });
      }
    }
    log('worker.stopped');
  })();

  return {
    done,
    stop: () => {
      stopping = true;
      return done;
    },
  };
}
