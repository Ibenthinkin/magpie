import { afterEach, describe, expect, it } from 'vitest';
import type { EnqueueHuntInput, HuntRow } from '../../src/db/types';
import { setGenerateForTests } from '../../src/engine/llm';
import { parseTarget } from '../../src/engine/target';
import { describeTarget, handleHuntCommand, type HuntInteractionPort } from '../../src/discord/commands/hunt';

// SPEC §3.1: defer immediately (3 s interaction window) → parse the query into
// a TargetSpec → confirm back in one line → enqueue. The parse call's LLM cost
// rides along as the hunt row's initial cost_cents.

afterEach(() => setGenerateForTests(null));

/** Seam for the real parseTarget: returns `target` and bills `costUsd`. */
function fakeParse(target: unknown, costUsd = 0.02) {
  setGenerateForTests(({ label }) => {
    if (label !== 'parseTarget') throw new Error(`unexpected llm call: ${label}`);
    return { object: target, usage: { inputTokens: 200, outputTokens: 50 }, costUsd };
  });
}

function makeInteraction(opts: { query?: string; maxPrice?: number; sources?: string } = {}) {
  const calls = { deferred: 0, replies: [] as string[] };
  const interaction: HuntInteractionPort = {
    channelId: 'chan-1',
    options: {
      getString: (name) => (name === 'query' ? (opts.query ?? 'casio a168') : (opts.sources ?? null)),
      getNumber: (name) => (name === 'max_price' ? (opts.maxPrice ?? null) : null),
    },
    deferReply: async () => void calls.deferred++,
    editReply: async (content: string) => void calls.replies.push(content),
  };
  return { interaction, calls };
}

function makeHunts() {
  const enqueued: EnqueueHuntInput[] = [];
  return {
    enqueued,
    hunts: {
      enqueueHunt: (input: EnqueueHuntInput) => {
        enqueued.push(input);
        return { id: 'h1' } as HuntRow;
      },
    },
  };
}

describe('describeTarget — location', () => {
  it('states the area being searched', () => {
    const line = describeTarget({
      description: 'standing desk',
      constraints: { location: { near: '94601', maxMiles: 25 } },
    });
    expect(line).toContain('94601');
    expect(line).toContain('25');
  });

  // The whole point: asking for a radius and silently not getting one is the
  // failure mode this codebase forbids. Say so at request time, not never.
  it('warns when a radius was asked for but the place name cannot anchor it', () => {
    const line = describeTarget({
      description: 'standing desk',
      constraints: { location: { near: 'Oakland, CA', maxMiles: 25 } },
    });
    expect(line).toMatch(/zip/i);
  });

  it('a zip-anchored radius carries no warning', () => {
    const line = describeTarget({
      description: 'standing desk',
      constraints: { location: { near: '94601', maxMiles: 25 } },
    });
    expect(line).not.toMatch(/zip/i);
  });

  it('says nothing about location when the request had none', () => {
    expect(describeTarget({ description: 'x', constraints: {} })).not.toMatch(/near|zip|mile/i);
  });
});

describe('handleHuntCommand', () => {
  it('defers, parses, enqueues a oneshot for the channel, and confirms in one line', async () => {
    fakeParse({ description: 'Casio A168WG-9VT', constraints: { maxPriceCents: 6000 } });
    const { interaction, calls } = makeInteraction({ query: 'casio a168 under $60' });
    const { hunts, enqueued } = makeHunts();

    await handleHuntCommand(interaction, { parseTarget, hunts });

    expect(calls.deferred).toBe(1);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({ mode: 'oneshot', query: 'casio a168 under $60', channelId: 'chan-1' });
    const target = JSON.parse(enqueued[0]!.targetJson);
    expect(target.description).toBe('Casio A168WG-9VT');
    expect(calls.replies).toHaveLength(1);
    expect(calls.replies[0]).toContain('Casio A168WG-9VT');
    expect(calls.replies[0]).toContain('$60');
  });

  it('bills the parse cost onto the hunt row as initialCostCents', async () => {
    fakeParse({ description: 'w', constraints: {} }, 0.0123); // 1.23¢ → ceil 2
    const { interaction } = makeInteraction();
    const { hunts, enqueued } = makeHunts();
    await handleHuntCommand(interaction, { parseTarget, hunts });
    expect(enqueued[0]!.initialCostCents).toBe(2);
  });

  it('a max_price option (dollars) overrides the parsed ceiling in cents', async () => {
    fakeParse({ description: 'w', constraints: { maxPriceCents: 99999 } });
    const { interaction } = makeInteraction({ maxPrice: 42.5 });
    const { hunts, enqueued } = makeHunts();
    await handleHuntCommand(interaction, { parseTarget, hunts });
    expect(JSON.parse(enqueued[0]!.targetJson).constraints.maxPriceCents).toBe(4250);
  });

  it('a sources csv option overrides the parsed sources', async () => {
    fakeParse({ description: 'w', constraints: {} });
    const { interaction } = makeInteraction({ sources: ' eBay, Fixture ' });
    const { hunts, enqueued } = makeHunts();
    await handleHuntCommand(interaction, { parseTarget, hunts });
    expect(JSON.parse(enqueued[0]!.targetJson).sources).toEqual(['ebay', 'fixture']);
  });

  it('a parse failure replies with the error and enqueues nothing', async () => {
    setGenerateForTests(() => {
      throw new Error('model unavailable');
    });
    const { interaction, calls } = makeInteraction();
    const { hunts, enqueued } = makeHunts();
    await handleHuntCommand(interaction, { parseTarget, hunts });
    expect(enqueued).toEqual([]);
    expect(calls.replies).toHaveLength(1);
    expect(calls.replies[0]).toMatch(/model unavailable/);
  });
});
