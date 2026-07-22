import { describe, expect, it } from 'vitest';
import type { EmbedBuilder } from 'discord.js';
import type { NewProfileFact, ProfileFactRow } from '../../src/db/types';
import { handleProfileCommand, type ProfileInteractionPort } from '../../src/discord/commands/profile';

// SPEC §3.4. `/profile` is the standing-facts surface every hunt's ranking step
// consults. No LLM anywhere in this path — facts are stored verbatim, and the
// deterministic discount rule (engine/rank.ts) reads them later.

type Opts = { category?: string; label?: string; value?: string; id?: string };

function makeInteraction(sub: string, opts: Opts = {}) {
  const calls = { deferred: 0, replies: [] as (string | { embeds: EmbedBuilder[] })[] };
  const interaction: ProfileInteractionPort = {
    options: {
      getSubcommand: () => sub,
      getString: (name) => opts[name] ?? null,
    },
    deferReply: async () => void calls.deferred++,
    editReply: async (content) => void calls.replies.push(content),
  };
  return { interaction, calls };
}

const factRow = (over: Partial<ProfileFactRow> = {}): ProfileFactRow => ({
  id: 'f1',
  category: 'membership',
  label: 'warehouse club',
  value: 'active',
  active: 1,
  createdAt: '2026-07-22T00:00:00.000Z',
  updatedAt: '2026-07-22T00:00:00.000Z',
  ...over,
});

function makeProfile(seed: ProfileFactRow[] = []) {
  const rows = [...seed];
  let n = 0;
  const profile = {
    addFact: (input: NewProfileFact): ProfileFactRow => {
      const row = factRow({ id: `f${++n}`, ...input });
      rows.push(row);
      return row;
    },
    getFact: (id: string): ProfileFactRow | null => rows.find((r) => r.id === id) ?? null,
    activeFacts: (): ProfileFactRow[] => rows.filter((r) => r.active === 1),
    removeFact: (id: string): void => {
      const i = rows.findIndex((r) => r.id === id);
      if (i !== -1) rows[i] = { ...rows[i]!, active: 0 };
    },
  };
  return { rows, profile };
}

describe('handleProfileCommand — add', () => {
  it('stores the fact verbatim and confirms with its id', async () => {
    const { interaction, calls } = makeInteraction('add', {
      category: 'coupon_source',
      label: 'eBay coupon',
      value: '10% off ebay',
    });
    const { rows, profile } = makeProfile();

    await handleProfileCommand(interaction, { profile });

    expect(calls.deferred).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ category: 'coupon_source', label: 'eBay coupon', value: '10% off ebay' });
    expect(calls.replies[0]).toContain('eBay coupon');
    expect(calls.replies[0]).toContain('f1');
  });
});

describe('handleProfileCommand — list', () => {
  it('renders one line per active fact with id, category, label and value', async () => {
    const { interaction, calls } = makeInteraction('list');
    const { profile } = makeProfile([factRow({ id: 'f7', category: 'spec', label: 'server HDDs', value: '≥10TB, CMR only' })]);

    await handleProfileCommand(interaction, { profile });

    const desc = (calls.replies[0] as { embeds: EmbedBuilder[] }).embeds[0]!.data.description ?? '';
    expect(desc).toContain('server HDDs');
    expect(desc).toContain('≥10TB, CMR only');
    expect(desc).toContain('f7');
  });

  it('hides removed facts from the list', async () => {
    const { interaction, calls } = makeInteraction('list');
    const { profile } = makeProfile([factRow({ id: 'f1', label: 'gone', active: 0 }), factRow({ id: 'f2', label: 'here' })]);

    await handleProfileCommand(interaction, { profile });

    const desc = (calls.replies[0] as { embeds: EmbedBuilder[] }).embeds[0]!.data.description ?? '';
    expect(desc).toContain('here');
    expect(desc).not.toContain('gone');
  });

  it('a friendly message when there are no facts', async () => {
    const { interaction, calls } = makeInteraction('list');
    await handleProfileCommand(interaction, { profile: makeProfile().profile });
    expect(calls.replies[0]).toBe('No profile facts yet.');
  });
});

describe('handleProfileCommand — remove', () => {
  it('soft-removes the fact and confirms by label', async () => {
    const { interaction, calls } = makeInteraction('remove', { id: 'f1' });
    const { profile } = makeProfile([factRow({ id: 'f1', label: 'warehouse club' })]);

    await handleProfileCommand(interaction, { profile });

    expect(profile.activeFacts()).toEqual([]);
    expect(profile.getFact('f1')?.active).toBe(0); // row survives — history kept
    expect(calls.replies[0]).toContain('warehouse club');
  });

  it('an unknown id replies not-found and changes nothing', async () => {
    const { interaction, calls } = makeInteraction('remove', { id: 'nope' });
    const { profile } = makeProfile([factRow({ id: 'f1' })]);

    await handleProfileCommand(interaction, { profile });

    expect(profile.activeFacts()).toHaveLength(1);
    expect(calls.replies[0]).toMatch(/nope/);
  });

  it('an already-removed fact replies not-found rather than confirming a second removal', async () => {
    const { interaction, calls } = makeInteraction('remove', { id: 'f1' });
    const { profile } = makeProfile([factRow({ id: 'f1', active: 0 })]);

    await handleProfileCommand(interaction, { profile });

    expect(calls.replies[0]).toMatch(/f1/);
    expect(calls.replies[0]).not.toMatch(/Removed/);
  });
});
