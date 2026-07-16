import {
  Client,
  Events,
  GatewayIntentBits,
  type ChatInputCommandInteraction,
  type SlashCommandOptionsOnlyBuilder,
} from 'discord.js';
import { log, logError } from '../log';
import type { Hub } from './hub';
import type { ChannelSend } from './report';

// Thin IO glue over discord.js: client lifecycle, guild-scoped command
// registration (instant, single personal server — SPEC §3.5), and hub-guarded
// routing into the command handlers. All decision logic lives in hub.ts and
// commands/* where vitest can reach it; this file stays dumb.

export interface GatewayCommand {
  data: SlashCommandOptionsOnlyBuilder;
  execute: (interaction: ChatInputCommandInteraction) => Promise<unknown>;
}

export interface GatewayDeps {
  token: string;
  guildId: string;
  hub: Hub;
  commands: GatewayCommand[];
}

export interface Gateway {
  send: ChannelSend;
  stop: () => Promise<void>;
}

export async function startGateway(deps: GatewayDeps): Promise<Gateway> {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const byName = new Map(deps.commands.map((c) => [c.data.name, c]));

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const denial = deps.hub.permits({ channelId: interaction.channelId, userId: interaction.user.id });
    if (denial) {
      // SPEC §3.5: ignored, not answered — but logged so misconfig is visible.
      log('gateway.ignored', { reason: denial, user: interaction.user.id, command: interaction.commandName });
      return;
    }
    const command = byName.get(interaction.commandName);
    if (!command) {
      logError('gateway.route', new Error(`no handler for /${interaction.commandName}`), {});
      return;
    }
    try {
      await command.execute(interaction);
    } catch (err) {
      // Handlers manage their own errors; this is the last-resort net so one
      // interaction can't crash the gateway. Best-effort user-visible reply.
      logError('gateway.command', err, { command: interaction.commandName });
      const msg = 'Something went wrong handling that command — check the logs.';
      await (interaction.deferred || interaction.replied
        ? interaction.editReply(msg)
        : interaction.reply({ content: msg, ephemeral: true })
      ).catch(() => {});
    }
  });

  const ready = new Promise<void>((resolve) => client.once(Events.ClientReady, () => resolve()));
  await client.login(deps.token);
  await ready;

  // Guild-scoped set: replaces the guild's command list atomically on boot.
  await client.application!.commands.set(
    deps.commands.map((c) => c.data.toJSON()),
    deps.guildId,
  );
  log('gateway.ready', { user: client.user?.tag, commands: deps.commands.length });

  return {
    send: async (channelId, message) => {
      const channel = await client.channels.fetch(channelId);
      if (!channel?.isSendable()) throw new Error(`channel ${channelId} is not sendable`);
      await channel.send({ content: message.content, embeds: message.embeds });
    },
    stop: async () => {
      await client.destroy();
      log('gateway.stopped');
    },
  };
}
