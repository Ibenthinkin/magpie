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
    ...over,
  }) as HuntRow;

const target = { description: 'widget 3000', constraints: {} };

const ranked = (n: number, over: Partial<RankedListing> = {}): RankedListing => ({
  title: `Widget ${n}`,
  priceCents: n * 1000,
  shippingCents: null,
  condition: 'New',
  url: `https://example.com/item/${n}`,
  landedCents: n * 1000,
  discountCents: 0,
  matchesTarget: true,
  verdict: `verdict ${n}`,
  ...over,
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

  it('a card whose landed cost included a membership/coupon discount says so', async () => {
    const { sent, send } = capture();
    await makeDiscordReporter(send).results(huntRow(), target, [ranked(1, { discountCents: 250 })], 1);
    const desc = embedJson(sent[0]!.message.embeds![0]!).description ?? '';
    expect(desc).toContain('$2.50');
    expect(desc).toMatch(/discount/i);
  });

  it('a card with no discount carries no discount line', async () => {
    const { sent, send } = capture();
    await makeDiscordReporter(send).results(huntRow(), target, [ranked(1)], 1);
    expect(embedJson(sent[0]!.message.embeds![0]!).description ?? '').not.toMatch(/discount/i);
  });

  it('the card footer names the listing source, not a hardcoded eBay', async () => {
    const { sent, send } = capture();
    await makeDiscordReporter(send).results(huntRow(), target, [ranked(1, { source: 'fixture' })], 1);
    expect(embedJson(sent[0]!.message.embeds![0]!).footer?.text).toContain('Fixture');
  });

  it('an untagged listing still footers as eBay (the only real source today)', async () => {
    const { sent, send } = capture();
    await makeDiscordReporter(send).results(huntRow(), target, [ranked(1)], 1);
    expect(embedJson(sent[0]!.message.embeds![0]!).footer?.text).toContain('eBay');
  });

  it('the nothing-found card names the sources actually searched', async () => {
    const { sent, send } = capture();
    await makeDiscordReporter(send).results(huntRow(), { ...target, sources: ['fixture'] }, [], 0);
    expect(embedJson(sent[0]!.message.embeds![0]!).description).toContain('Fixture');
  });

  it('a send failure propagates (hunt.ts turns it into failHunt, not a silent drop)', async () => {
    const reporter = makeDiscordReporter(async () => {
      throw new Error('discord 403');
    });
    await expect(reporter.results(huntRow(), target, [ranked(1)], 1)).rejects.toThrow('discord 403');
  });

  describe('watch runs (SPEC §3.3, §7.2)', () => {
    const watchHunt = huntRow({ mode: 'watch_run', watchId: 'w1' } as Partial<HuntRow>);
    const watches = { getWatch: (id: string) => (id === 'w1' ? ({ name: 'hdd deals' } as never) : null) };

    it('new hits go out as ONE batched message prefixed with the watch name', async () => {
      const { sent, send } = capture();
      await makeDiscordReporter(send, { watches }).results(watchHunt, target, [ranked(1), ranked(2)], 9);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.message.content).toContain('hdd deals');
      expect(sent[0]!.message.content).toContain('2');
      expect(sent[0]!.message.embeds).toHaveLength(2);
    });

    it('nothing new = complete silence, NOT a nothing-found card', async () => {
      const { sent, send } = capture();
      await makeDiscordReporter(send, { watches }).results(watchHunt, target, [], 9);
      expect(sent).toEqual([]);
    });
  });
});
