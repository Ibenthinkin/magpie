import { describe, expect, it } from 'vitest';
import type { EmbedBuilder } from 'discord.js';
import type { HuntRow } from '../../src/db/types';
import type { RankedListing } from '../../src/engine/rank';
import { makeDiscordReporter, type OutboundMessage } from '../../src/discord/report';

// The Reporter port (engine/hunt.ts) rendered to Discord: results become a
// header line + one embed per card in hunt.channel_id; zero results is the
// explicit nothing-found card (SPEC §3.1 — never silence); failures are an
// error embed carrying the reason.

const huntRow = (over: Partial<HuntRow> = {}): HuntRow =>
  ({
    id: 'h1',
    mode: 'oneshot',
    query: 'widget 3000',
    channelId: 'chan-9',
    targetJson: '{}',
    status: 'running',
    watchId: null,
    error: null,
    costCents: null,
    startedAt: null,
    finishedAt: null,
    createdAt: '',
  }) as HuntRow;

const target = { description: 'widget 3000', constraints: {} };

const ranked = (n: number): RankedListing => ({
  title: `Widget ${n}`,
  priceCents: n * 1000,
  shippingCents: null,
  condition: 'New',
  url: `https://example.com/item/${n}`,
  landedCents: n * 1000,
  matchesTarget: true,
  verdict: `verdict ${n}`,
});

function capture() {
  const sent: { channelId: string; message: OutboundMessage }[] = [];
  return {
    sent,
    send: async (channelId: string, message: OutboundMessage) => void sent.push({ channelId, message }),
  };
}

const embedJson = (e: EmbedBuilder) => e.toJSON();

describe('makeDiscordReporter', () => {
  it('posts a header plus one card per ranked listing to the hunt channel', async () => {
    const { sent, send } = capture();
    await makeDiscordReporter(send).results(huntRow(), target, [ranked(1), ranked(2)], 7);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.channelId).toBe('chan-9');
    expect(sent[0]!.message.content).toContain('top 2 of 7');
    expect(sent[0]!.message.embeds).toHaveLength(2);
    expect(embedJson(sent[0]!.message.embeds![0]!).title).toBe('Widget 1');
  });

  it('renders zero results as the explicit nothing-found card', async () => {
    const { sent, send } = capture();
    await makeDiscordReporter(send).results(huntRow(), target, [], 0);
    expect(sent).toHaveLength(1);
    expect(embedJson(sent[0]!.message.embeds![0]!).title).toMatch(/no listings/i);
  });

  it('reports a failure as an error embed carrying query and reason', async () => {
    const { sent, send } = capture();
    await makeDiscordReporter(send).error(huntRow(), 'all sources failed — ebay: bot challenge');
    expect(sent).toHaveLength(1);
    const json = embedJson(sent[0]!.message.embeds![0]!);
    expect(json.title).toMatch(/failed/i);
    expect(json.description).toContain('widget 3000');
    expect(json.description).toContain('bot challenge');
  });

  it('a send failure propagates (hunt.ts turns it into failHunt, not a silent drop)', async () => {
    const reporter = makeDiscordReporter(async () => {
      throw new Error('discord 403');
    });
    await expect(reporter.results(huntRow(), target, [ranked(1)], 1)).rejects.toThrow('discord 403');
  });
});
