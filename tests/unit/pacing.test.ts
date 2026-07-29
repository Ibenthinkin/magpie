import { describe, expect, test } from 'vitest';
import { makePacer } from '../../src/browser/pacing';

const CHALLENGE_COOLDOWN_MS = 60 * 60 * 1000;

function fakeClock() {
  let t = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: (ms: number) => {
      sleeps.push(ms);
      t += ms;
      return Promise.resolve();
    },
    advance: (ms: number) => {
      t += ms;
    },
    sleeps,
  };
}

const limit = { minDelayMs: 20_000, maxPerHour: 3 };

describe('pacing', () => {
  test('first visit to a source proceeds immediately', async () => {
    const clock = fakeClock();
    const { pace } = makePacer({ now: clock.now, sleep: clock.sleep, random: () => 0.5 });
    await pace('ebay', limit);
    expect(clock.sleeps).toEqual([]);
  });

  test('back-to-back visits wait a randomized gap in [minDelay, 2×minDelay]', async () => {
    const clock = fakeClock();
    const { pace } = makePacer({ now: clock.now, sleep: clock.sleep, random: () => 0.5 });
    await pace('ebay', limit);
    await pace('ebay', limit);
    expect(clock.sleeps).toEqual([30_000]); // 20s + 0.5×20s
  });

  test('a visit after a long natural gap does not wait', async () => {
    const clock = fakeClock();
    const { pace } = makePacer({ now: clock.now, sleep: clock.sleep, random: () => 1 });
    await pace('ebay', limit);
    clock.advance(120_000);
    await pace('ebay', limit);
    expect(clock.sleeps).toEqual([]);
  });

  test('maxPerHour caps the sliding window', async () => {
    const clock = fakeClock();
    const { pace } = makePacer({ now: clock.now, sleep: clock.sleep, random: () => 0 });
    await pace('ebay', limit); // t0
    clock.advance(60_000);
    await pace('ebay', limit); // t0+60s
    clock.advance(60_000);
    await pace('ebay', limit); // t0+120s — window full (3/hr)
    clock.advance(60_000);
    await pace('ebay', limit); // must wait until t0+1h
    const total = clock.sleeps.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(3_600_000 - 180_000 - 1);
  });

  test('sources pace independently', async () => {
    const clock = fakeClock();
    const { pace } = makePacer({ now: clock.now, sleep: clock.sleep, random: () => 0.5 });
    await pace('ebay', limit);
    await pace('fixture', { minDelayMs: 0, maxPerHour: 100_000 });
    expect(clock.sleeps).toEqual([]);
  });

  describe('challenge cooldown', () => {
    test('pace() throws immediately while a cooldown is active, without sleeping', async () => {
      const clock = fakeClock();
      const { pace, reportChallenge } = makePacer({
        now: clock.now,
        sleep: clock.sleep,
        random: () => 0.5,
        challengeCooldownMs: CHALLENGE_COOLDOWN_MS,
      });
      reportChallenge('ebay');
      await expect(pace('ebay', limit)).rejects.toThrow(/ebay/);
      expect(clock.sleeps).toEqual([]);
    });

    test('pace() behaves normally once the cooldown has expired', async () => {
      const clock = fakeClock();
      const { pace, reportChallenge } = makePacer({
        now: clock.now,
        sleep: clock.sleep,
        random: () => 0.5,
        challengeCooldownMs: CHALLENGE_COOLDOWN_MS,
      });
      reportChallenge('ebay');
      clock.advance(CHALLENGE_COOLDOWN_MS);
      await pace('ebay', limit); // cooldown just expired — first visit, no wait
      expect(clock.sleeps).toEqual([]);
    });

    test('a cooldown on one source does not affect another', async () => {
      const clock = fakeClock();
      const { pace, reportChallenge } = makePacer({
        now: clock.now,
        sleep: clock.sleep,
        random: () => 0.5,
        challengeCooldownMs: CHALLENGE_COOLDOWN_MS,
      });
      reportChallenge('ebay');
      await pace('craigslist', limit);
      expect(clock.sleeps).toEqual([]);
      await expect(pace('ebay', limit)).rejects.toThrow(/ebay/);
    });

    test('reporting a challenge again while already cooling down extends the cooldown', async () => {
      const clock = fakeClock();
      const { pace, reportChallenge } = makePacer({
        now: clock.now,
        sleep: clock.sleep,
        random: () => 0.5,
        challengeCooldownMs: CHALLENGE_COOLDOWN_MS,
      });
      reportChallenge('ebay');
      clock.advance(CHALLENGE_COOLDOWN_MS / 2);
      reportChallenge('ebay'); // extends cooldown another full period from here
      clock.advance(CHALLENGE_COOLDOWN_MS / 2 + 1); // would have cleared the ORIGINAL cooldown
      await expect(pace('ebay', limit)).rejects.toThrow(/ebay/);
    });
  });
});
