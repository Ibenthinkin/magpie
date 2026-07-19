import { afterEach, describe, expect, it } from 'vitest';
import type { EmbedBuilder } from 'discord.js';
import type { CreateWatchInput, EnqueueHuntInput, HuntRow, WatchRow } from '../../src/db/types';
import { setGenerateForTests } from '../../src/engine/llm';
import { parseTarget } from '../../src/engine/target';
import { handleWatchCommand, type WatchInteractionPort } from '../../src/discord/commands/watch';

// SPEC §3.3 / §11. `/watch add` parses the query into a TargetSpec (billing the
// parse cost onto the immediate first run, since watch rows hold no cost),
// creates an active watch, and schedules the next run one cadence ahead.
// list/pause/resume/remove are lifecycle over the watches repo.

afterEach(() => setGenerateForTests(null));

const NOW = new Date('2026-07-17T12:00:00.000Z');

function fakeParse(target: unknown, costUsd = 0.02) {
  setGenerateForTests(({ label }) => {
    if (label !== 'parseTarget') throw new Error(`unexpected llm call: ${label}`);
    return { object: target, usage: { inputTokens: 200, outputTokens: 50 }, costUsd };
  });
}

type Opts = { query?: string; id?: string; cadence?: number; max_price?: number };

function makeInteraction(sub: string, opts: Opts = {}) {
  const calls = { deferred: 0, replies: [] as (string | { embeds: EmbedBuilder[] })[] };
  const interaction: WatchInteractionPort = {
    channelId: 'chan-1',
    options: {
      getSubcommand: () => sub,
      getString: (name) => (name === 'query' ? (opts.query ?? null) : name === 'id' ? (opts.id ?? null) : null),
      getNumber: (name) => (name === 'max_price' ? (opts.max_price ?? null) : null),
      getInteger: (name) => (name === 'cadence' ? (opts.cadence ?? null) : null),
    },
    deferReply: async () => void calls.deferred++,
    editReply: async (content) => void calls.replies.push(content),
  };
  return { interaction, calls };
}

function makeWatches(seed: WatchRow[] = [], hits: Record<string, number> = {}) {
  const created: CreateWatchInput[] = [];
  const statusCalls: { id: string; status: string }[] = [];
  const store = new Map(seed.map((w) => [w.id, w]));
  const watches = {
    createWatch: (input: CreateWatchInput): WatchRow => {
      created.push(input);
      const row = { id: 'w-new', status: 'active' as const, lastRunAt: null, createdAt: NOW.toISOString(), ...input };
      store.set(row.id, row);
      return row;
    },
    listWatches: (): WatchRow[] => [...store.values()].filter((w) => w.status !== 'removed'),
    getWatch: (id: string): WatchRow | null => store.get(id) ?? null,
    setStatus: (id: string, status: WatchRow['status']) => {
      statusCalls.push({ id, status });
      const w = store.get(id);
      if (w) store.set(id, { ...w, status });
    },
    countHits: (id: string): number => hits[id] ?? 0,
  };
  return { created, statusCalls, watches };
}

function makeHunts() {
  const enqueued: EnqueueHuntInput[] = [];
  return {
    enqueued,
    hunts: {
      enqueueHunt: (input: EnqueueHuntInput): HuntRow => {
        enqueued.push(input);
        return { id: 'h1' } as HuntRow;
      },
    },
  };
}

const watchRow = (over: Partial<WatchRow> = {}): WatchRow => ({
  id: 'w1',
  name: 'MX Master 3S',
  targetJson: '{"description":"MX Master 3S","constraints":{}}',
  cadenceMinutes: 1440,
  nextRunAt: '2026-07-18T00:00:00.000Z',
  status: 'active',
  channelId: 'c1',
  lastRunAt: null,
  createdAt: '2026-07-10T00:00:00.000Z',
  ...over,
});

describe('handleWatchCommand — add', () => {
  it('parses, creates an active watch, and enqueues an immediate watch_run carrying the parse cost', async () => {
    fakeParse({ description: 'Casio A168', constraints: { maxPriceCents: 6000 } }, 0.0123); // → 2¢
    const { interaction, calls } = makeInteraction('add', { query: 'casio a168 under $60' });
    const { created, watches } = makeWatches();
    const { hunts, enqueued } = makeHunts();

    await handleWatchCommand(interaction, { parseTarget, watches, hunts, now: () => NOW });

    expect(calls.deferred).toBe(1);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ name: 'Casio A168', channelId: 'chan-1', cadenceMinutes: 1440 });
    expect(enqueued).toEqual([
      {
        mode: 'watch_run',
        query: 'casio a168 under $60',
        targetJson: created[0]!.targetJson,
        channelId: 'chan-1',
        watchId: 'w-new',
        initialCostCents: 2,
      },
    ]);
    expect(calls.replies[0]).toContain('Casio A168');
  });

  it('defaults cadence to 24h and schedules nextRunAt exactly one cadence ahead of now', async () => {
    fakeParse({ description: 'w', constraints: {} });
    const { interaction } = makeInteraction('add', { query: 'thing' });
    const { created, watches } = makeWatches();
    const { hunts } = makeHunts();

    await handleWatchCommand(interaction, { parseTarget, watches, hunts, now: () => NOW });

    expect(created[0]!.cadenceMinutes).toBe(1440);
    expect(created[0]!.nextRunAt).toBe('2026-07-18T12:00:00.000Z'); // NOW + 24h
  });

  it('a cadence option (hours) sets cadenceMinutes and the next-run offset', async () => {
    fakeParse({ description: 'w', constraints: {} });
    const { interaction } = makeInteraction('add', { query: 'thing', cadence: 6 });
    const { created, watches } = makeWatches();
    const { hunts } = makeHunts();

    await handleWatchCommand(interaction, { parseTarget, watches, hunts, now: () => NOW });

    expect(created[0]!.cadenceMinutes).toBe(360);
    expect(created[0]!.nextRunAt).toBe('2026-07-17T18:00:00.000Z'); // NOW + 6h
  });

  it('a max_price option (dollars) overrides the parsed ceiling before the watch is stored', async () => {
    fakeParse({ description: 'w', constraints: { maxPriceCents: 99999 } });
    const { interaction } = makeInteraction('add', { query: 'thing', max_price: 42.5 });
    const { created, watches } = makeWatches();
    const { hunts } = makeHunts();

    await handleWatchCommand(interaction, { parseTarget, watches, hunts, now: () => NOW });

    expect(JSON.parse(created[0]!.targetJson).constraints.maxPriceCents).toBe(4250);
  });

  it('a parse failure replies with the error and creates no watch, enqueues nothing', async () => {
    setGenerateForTests(() => {
      throw new Error('model unavailable');
    });
    const { interaction, calls } = makeInteraction('add', { query: 'thing' });
    const { created, watches } = makeWatches();
    const { hunts, enqueued } = makeHunts();

    await handleWatchCommand(interaction, { parseTarget, watches, hunts, now: () => NOW });

    expect(created).toEqual([]);
    expect(enqueued).toEqual([]);
    expect(calls.replies[0]).toMatch(/model unavailable/);
  });
});

describe('handleWatchCommand — list', () => {
  it('renders each active watch with its name and hit count', async () => {
    const { interaction, calls } = makeInteraction('list');
    const { watches } = makeWatches([watchRow({ id: 'w1', name: 'Mouse' })], { w1: 3 });
    const { hunts } = makeHunts();

    await handleWatchCommand(interaction, { parseTarget, watches, hunts, now: () => NOW });

    const reply = calls.replies[0] as { embeds: EmbedBuilder[] };
    const desc = reply.embeds[0]!.data.description ?? '';
    expect(desc).toContain('Mouse');
    expect(desc).toContain('3');
  });

  it('a friendly message when there are no watches', async () => {
    const { interaction, calls } = makeInteraction('list');
    const { watches } = makeWatches([]);
    const { hunts } = makeHunts();

    await handleWatchCommand(interaction, { parseTarget, watches, hunts, now: () => NOW });

    expect(calls.replies[0]).toBe('No watches yet.');
  });
});

describe('handleWatchCommand — lifecycle', () => {
  it('remove soft-sets the watch to removed and confirms', async () => {
    const { interaction, calls } = makeInteraction('remove', { id: 'w1' });
    const { statusCalls, watches } = makeWatches([watchRow({ id: 'w1', name: 'Mouse' })]);
    const { hunts } = makeHunts();

    await handleWatchCommand(interaction, { parseTarget, watches, hunts, now: () => NOW });

    expect(statusCalls).toEqual([{ id: 'w1', status: 'removed' }]);
    expect(calls.replies[0]).toContain('Mouse');
  });

  it('pause sets paused and resume sets active', async () => {
    const seed = [watchRow({ id: 'w1' })];
    {
      const { interaction } = makeInteraction('pause', { id: 'w1' });
      const { statusCalls, watches } = makeWatches(seed);
      await handleWatchCommand(interaction, { parseTarget, watches, hunts: makeHunts().hunts, now: () => NOW });
      expect(statusCalls).toEqual([{ id: 'w1', status: 'paused' }]);
    }
    {
      const { interaction } = makeInteraction('resume', { id: 'w1' });
      const { statusCalls, watches } = makeWatches(seed);
      await handleWatchCommand(interaction, { parseTarget, watches, hunts: makeHunts().hunts, now: () => NOW });
      expect(statusCalls).toEqual([{ id: 'w1', status: 'active' }]);
    }
  });

  it('an unknown id replies not-found and changes nothing', async () => {
    const { interaction, calls } = makeInteraction('remove', { id: 'nope' });
    const { statusCalls, watches } = makeWatches([watchRow({ id: 'w1' })]);
    const { hunts } = makeHunts();

    await handleWatchCommand(interaction, { parseTarget, watches, hunts, now: () => NOW });

    expect(statusCalls).toEqual([]);
    expect(calls.replies[0]).toMatch(/nope/);
  });
});
