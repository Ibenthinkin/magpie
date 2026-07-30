import type { RateLimit } from '../sources/types';
import { log } from '../log';

// Human-ish pacing between navigations, per source: a randomized gap of
// [minDelayMs, 2×minDelayMs] since the last visit plus a maxPerHour sliding
// window. Enforced inside the hunt run regardless of queue pressure (SPEC §9).
//
// A source that serves a bot challenge (e.g. eBay's /splashui/challenge) is
// past the point where slower pacing helps — it needs to cool off entirely.
// reportChallenge() puts that source into a cooldown; pace() refuses to
// proceed (throws, doesn't sleep) until the cooldown elapses. In-memory only,
// per process — no persistence across restarts, no cross-source cap (SPEC
// Phase 4 hardening, Task 1).

export class ChallengeDetectedError extends Error {}

export interface PacerDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** How long a source stays in cooldown after a reported challenge. Default 60 min. */
  challengeCooldownMs?: number;
}

export type Pacer = (source: string, limit: RateLimit) => Promise<void>;

export interface PacerHandle {
  pace: Pacer;
  /** Puts `source` into cooldown for challengeCooldownMs from now. A second call
   * while already cooling down extends the cooldown (no separate backoff logic). */
  reportChallenge: (source: string) => void;
}

const HOUR_MS = 3_600_000;
const DEFAULT_CHALLENGE_COOLDOWN_MS = 60 * 60 * 1000;

export function makePacer(deps: PacerDeps = {}): PacerHandle {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = deps.random ?? Math.random;
  const challengeCooldownMs = deps.challengeCooldownMs ?? DEFAULT_CHALLENGE_COOLDOWN_MS;
  const visits = new Map<string, number[]>();
  const cooldownUntil = new Map<string, number>();

  const pace: Pacer = async (source, limit) => {
    const t = now();
    const cooldown = cooldownUntil.get(source) ?? -Infinity;
    if (t < cooldown) {
      throw new Error(`${source} is cooling down after a bot challenge until ${new Date(cooldown).toISOString()}`);
    }

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

  const reportChallenge = (source: string): void => {
    const until = now() + challengeCooldownMs;
    cooldownUntil.set(source, until);
    log('pacing.cooldown', { source, until: new Date(until).toISOString(), cooldownMs: challengeCooldownMs });
  };

  return { pace, reportChallenge };
}
