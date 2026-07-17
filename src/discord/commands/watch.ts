import { SlashCommandBuilder } from 'discord.js';
import type { HuntsRepo, WatchesRepo, WatchRow } from '../../db/types';
import { withUsage } from '../../engine/llm';
import type { TargetSpec } from '../../engine/target';
import { logError } from '../../log';
import { buildWatchListEmbed } from '../embeds';

// /watch (SPEC §3.3): standing watchlists. `add` parses the query into a
// TargetSpec, creates an active watch, and kicks off an immediate first run —
// the parse cost rides onto that hunt since watch rows carry no cost. The
// scheduler (src/watch/scheduler.ts) handles every run after this one.

const DEFAULT_CADENCE_HOURS = 24;

export const watchCommandData = new SlashCommandBuilder()
  .setName('watch')
  .setDescription('Standing watchlists — run on a schedule, notify only on new hits')
  .addSubcommand((s) =>
    s
      .setName('add')
      .setDescription('Create a watch')
      .addStringOption((o) => o.setName('query').setDescription('What to watch for, in plain words').setRequired(true))
      .addIntegerOption((o) => o.setName('cadence').setDescription('How often to run, in hours (default 24)'))
      .addNumberOption((o) => o.setName('max_price').setDescription('Hard price ceiling in dollars')),
  )
  .addSubcommand((s) => s.setName('list').setDescription('Show all watches'))
  .addSubcommand((s) =>
    s
      .setName('pause')
      .setDescription('Pause a watch')
      .addStringOption((o) => o.setName('id').setDescription('Watch id (from /watch list)').setRequired(true)),
  )
  .addSubcommand((s) =>
    s
      .setName('resume')
      .setDescription('Resume a paused watch')
      .addStringOption((o) => o.setName('id').setDescription('Watch id (from /watch list)').setRequired(true)),
  )
  .addSubcommand((s) =>
    s
      .setName('remove')
      .setDescription('Remove a watch (keeps history)')
      .addStringOption((o) => o.setName('id').setDescription('Watch id (from /watch list)').setRequired(true)),
  );

// Narrow structural slice of ChatInputCommandInteraction — handlers are tested
// against this port with plain fakes (SPEC §12).
export interface WatchInteractionPort {
  channelId: string;
  options: {
    getSubcommand(): string;
    getString(name: 'query' | 'id'): string | null;
    getNumber(name: 'max_price'): number | null;
    getInteger(name: 'cadence'): number | null;
  };
  deferReply(): Promise<unknown>;
  editReply(content: string | { embeds: import('discord.js').EmbedBuilder[] }): Promise<unknown>;
}

export interface WatchCommandDeps {
  parseTarget: (query: string) => Promise<TargetSpec>;
  watches: Pick<WatchesRepo, 'createWatch' | 'listWatches' | 'getWatch' | 'setStatus' | 'countHits'>;
  hunts: Pick<HuntsRepo, 'enqueueHunt'>;
  now?: () => Date;
}

const LIFECYCLE: Record<string, WatchRow['status']> = { pause: 'paused', resume: 'active', remove: 'removed' };

export async function handleWatchCommand(interaction: WatchInteractionPort, deps: WatchCommandDeps): Promise<void> {
  await interaction.deferReply();
  const sub = interaction.options.getSubcommand();
  if (sub === 'add') await handleAdd(interaction, deps);
  else if (sub === 'list') await handleList(interaction, deps);
  else await handleLifecycle(interaction, deps, sub);
}

async function handleAdd(interaction: WatchInteractionPort, deps: WatchCommandDeps): Promise<void> {
  const query = interaction.options.getString('query') ?? '';

  let target: TargetSpec;
  let parseCostCents = 0;
  try {
    target = await withUsage(async (usage) => {
      const t = await deps.parseTarget(query);
      parseCostCents = usage().costCents;
      return t;
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError('watch.parse', err, { query });
    await interaction.editReply(`Couldn't parse that request: ${msg}`);
    return;
  }

  const maxPrice = interaction.options.getNumber('max_price');
  if (maxPrice !== null) target.constraints.maxPriceCents = Math.round(maxPrice * 100);

  const cadenceHours = interaction.options.getInteger('cadence') ?? DEFAULT_CADENCE_HOURS;
  const cadenceMinutes = cadenceHours * 60;
  const targetJson = JSON.stringify(target);
  const nowMs = (deps.now ?? (() => new Date()))().getTime();

  const watch = deps.watches.createWatch({
    name: target.description,
    targetJson,
    cadenceMinutes,
    channelId: interaction.channelId,
    // First run fires now (enqueued below); the scheduler takes over one cadence out.
    nextRunAt: new Date(nowMs + cadenceMinutes * 60_000).toISOString(),
  });

  deps.hunts.enqueueHunt({
    mode: 'watch_run',
    query,
    targetJson,
    channelId: interaction.channelId,
    watchId: watch.id,
    initialCostCents: parseCostCents,
  });

  const price = target.constraints.maxPriceCents;
  const ceiling = price !== undefined ? ` · ≤ $${(price / 100).toFixed(2).replace(/\.00$/, '')}` : '';
  await interaction.editReply(`Watching **${target.description}**${ceiling} · every ${cadenceHours}h — first run queued now.`);
}

function handleList(interaction: WatchInteractionPort, deps: WatchCommandDeps): Promise<unknown> {
  const rows = deps.watches.listWatches();
  if (rows.length === 0) return interaction.editReply('No watches yet.');
  const withHits = rows.map((watch) => ({ watch, hits: deps.watches.countHits(watch.id) }));
  return interaction.editReply({ embeds: [buildWatchListEmbed(withHits)] });
}

function handleLifecycle(interaction: WatchInteractionPort, deps: WatchCommandDeps, sub: string): Promise<unknown> {
  const status = LIFECYCLE[sub];
  if (!status) {
    logError('watch.route', new Error(`unknown /watch subcommand: ${sub}`), {});
    return interaction.editReply('Unknown watch command.');
  }
  const id = interaction.options.getString('id') ?? '';
  const watch = deps.watches.getWatch(id);
  if (!watch) return interaction.editReply(`No watch with id \`${id}\`.`);
  deps.watches.setStatus(id, status);
  const verb = sub === 'remove' ? 'Removed' : sub === 'pause' ? 'Paused' : 'Resumed';
  return interaction.editReply(`${verb} **${watch.name}**.`);
}
