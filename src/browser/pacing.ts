import type { RateLimit } from '../sources/types';

// Human-ish pacing between navigations, per source: a randomized gap of
// [minDelayMs, 2×minDelayMs] since the last visit plus a maxPerHour sliding
// window. Enforced inside the hunt run regardless of queue pressure (SPEC §9).

export interface PacerDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export type Pacer = (source: string, limit: RateLimit) => Promise<void>;

const HOUR_MS = 3_600_000;

export function makePacer(deps: PacerDeps = {}): Pacer {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = deps.random ?? Math.random;
  const visits = new Map<string, number[]>();

  return async function pace(source, limit) {
    const t = now();
    const recent = (visits.get(source) ?? []).filter((v) => t - v < HOUR_MS);

    let readyAt = t;
    const last = recent[recent.length - 1];
    if (last !== undefined) {
      readyAt = Math.max(readyAt, last + limit.minDelayMs + random() * limit.minDelayMs);
    }
    const windowBlocker = recent[recent.length - limit.maxPerHour];
    if (windowBlocker !== undefined) {
      readyAt = Math.max(readyAt, windowBlocker + HOUR_MS);
    }

    if (readyAt > t) await sleep(readyAt - t);
    recent.push(readyAt);
    visits.set(source, recent);
  };
}
