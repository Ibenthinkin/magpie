import type { EmbedBuilder } from 'discord.js';
import type { HuntRow, WatchesRepo } from '../db/types';
import type { Reporter } from '../engine/hunt';
import type { RankedListing } from '../engine/rank';
import type { TargetSpec } from '../engine/target';
import { buildErrorEmbed, buildListingEmbed, buildNothingFoundEmbed, buildResultsHeader } from './embeds';

// Reporter port (engine/hunt.ts) rendered to Discord. Pure message assembly
// over an injected channel-send — gateway.ts supplies the real one, tests a
// capture. Send failures propagate: hunt.ts turns them into failHunt, because
// results the user never saw must not be marked delivered.

export interface OutboundMessage {
  content?: string;
  embeds?: EmbedBuilder[];
}

export type ChannelSend = (channelId: string, message: OutboundMessage) => Promise<void>;

export interface ReporterDeps {
  /** Watch name lookup for the watch-hit prefix (SPEC §7.2). */
  watches?: Pick<WatchesRepo, 'getWatch'>;
}

export function makeDiscordReporter(send: ChannelSend, deps: ReporterDeps = {}): Reporter {
  return {
    async results(hunt: HuntRow, target: TargetSpec, ranked: RankedListing[], extractedCount: number) {
      // Watch runs notify only on genuinely new hits: one batched message
      // prefixed with the watch name — and total silence when nothing is new
      // (SPEC §3.3; a daily "nothing found" ping would be spam).
      if (hunt.mode === 'watch_run' && hunt.watchId !== null) {
        if (ranked.length === 0) return;
        const name = deps.watches?.getWatch(hunt.watchId)?.name ?? hunt.query;
        await send(hunt.channelId, {
          content: `🔔 **${name}** — ${ranked.length} new`,
          embeds: ranked.map((l, i) => buildListingEmbed(l, i + 1)),
        });
        return;
      }

      if (ranked.length === 0) {
        await send(hunt.channelId, { embeds: [buildNothingFoundEmbed(target)] });
        return;
      }
      await send(hunt.channelId, {
        content: buildResultsHeader(target, ranked.length, extractedCount),
        embeds: ranked.map((l, i) => buildListingEmbed(l, i + 1)),
      });
    },

    async error(hunt: HuntRow, message: string) {
      await send(hunt.channelId, { embeds: [buildErrorEmbed(hunt.query, message)] });
    },
  };
}
