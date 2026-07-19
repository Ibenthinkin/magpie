import { Cron } from 'croner';
import type { HuntsRepo, WatchesRepo } from '../db/types';
import { log, logError } from '../log';

// The watch scheduler (SPEC §2.1, Phase 2 mode B = mode A on a timer): a croner
// tick marks due watches and enqueues watch_run hunts, funneling them into the
// same queue the worker drains. next_run_at is bumped forward by cadence with
// ±10% jitter so watches don't thundering-herd — the jitter math lives here
// (injectable random), keeping the repo's bumpNextRun deterministic.

const JITTER = 0.1; // ±10%

export interface SchedulerTickDeps {
  watches: Pick<WatchesRepo, 'dueWatches' | 'bumpNextRun'>;
  hunts: Pick<HuntsRepo, 'enqueueHunt'>;
  now?: () => Date;
  random?: () => number;
}

/** One scheduler pass: enqueue a watch_run hunt per due watch and reschedule it.
 *  Returns the number of watches successfully enqueued (one bad watch is
 *  skipped loudly and left due, not allowed to starve the rest). */
export function runSchedulerTick(deps: SchedulerTickDeps): number {
  const now = deps.now ?? (() => new Date());
  const random = deps.random ?? Math.random;
  const nowMs = now().getTime();
  const nowIso = new Date(nowMs).toISOString();

  let enqueued = 0;
  for (const w of deps.watches.dueWatches(nowIso)) {
    try {
      deps.hunts.enqueueHunt({
        mode: 'watch_run',
        query: w.name,
        targetJson: w.targetJson,
        channelId: w.channelId,
        watchId: w.id,
      });
      // Bump only after a successful enqueue: a failed enqueue leaves the watch
      // due so the next tick retries it, rather than silently skipping a run.
      const factor = 1 + (random() * 2 - 1) * JITTER; // [0.9, 1.1]
      const delayMs = Math.round(w.cadenceMinutes * 60_000 * factor);
      deps.watches.bumpNextRun(w.id, {
        nextRunAt: new Date(nowMs + delayMs).toISOString(),
        lastRunAt: nowIso,
      });
      enqueued++;
    } catch (err) {
      logError('scheduler.watch', err, { watch: w.id });
    }
  }
  if (enqueued > 0) log('scheduler.tick', { enqueued });
  return enqueued;
}

/** Injectable croner seam: (pattern, onTick) → a stoppable job. */
export type CronFactory = (pattern: string, onTick: () => void) => { stop: () => void };

export interface SchedulerDeps extends SchedulerTickDeps {
  cron?: CronFactory;
}

export interface SchedulerHandle {
  stop: () => void;
}

const defaultCron: CronFactory = (pattern, onTick) => new Cron(pattern, onTick);

/** Start the every-minute scheduler. The tick is wrapped so a throwing pass
 *  (e.g. dueWatches failing) can never escape and kill the croner job. */
export function startScheduler(deps: SchedulerDeps): SchedulerHandle {
  const cron = deps.cron ?? defaultCron;
  const job = cron('* * * * *', () => {
    try {
      runSchedulerTick(deps);
    } catch (err) {
      logError('scheduler.tick', err);
    }
  });
  return { stop: () => job.stop() };
}
