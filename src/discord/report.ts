import type { EmbedBuilder } from 'discord.js';
import type { HuntRow } from '../db/types';
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

export function makeDiscordReporter(send: ChannelSend): Reporter {
  return {
    async results(hunt: HuntRow, target: TargetSpec, ranked: RankedListing[], extractedCount: number) {
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
