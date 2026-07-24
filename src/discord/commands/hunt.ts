import { SlashCommandBuilder } from 'discord.js';
import type { HuntRow, HuntsRepo } from '../../db/types';
import { withUsage } from '../../engine/llm';
import { canAnchorRadius, type TargetSpec } from '../../engine/target';
import { logError } from '../../log';
import { DEFAULT_SOURCES } from '../../sources/registry';

// /hunt (SPEC §3.1): defer inside Discord's 3 s interaction window, parse the
// query into a TargetSpec, confirm it back in one line, enqueue. The worker
// posts the actual results later; this handler never runs the hunt itself.

export const huntCommandData = new SlashCommandBuilder()
  .setName('hunt')
  .setDescription('Hunt for the best-priced listings of an item')
  .addStringOption((o) => o.setName('query').setDescription('What to hunt for, in plain words').setRequired(true))
  .addNumberOption((o) => o.setName('max_price').setDescription('Hard price ceiling in dollars'))
  .addStringOption((o) => o.setName('sources').setDescription('Comma-separated source ids (default: ebay)'));

// Narrow structural slice of ChatInputCommandInteraction — handlers are tested
// against this port with plain fakes (SPEC §12).
export interface HuntInteractionPort {
  channelId: string;
  options: {
    getString(name: 'query' | 'sources'): string | null;
    getNumber(name: 'max_price'): number | null;
  };
  deferReply(): Promise<unknown>;
  editReply(content: string): Promise<unknown>;
}

export interface HuntCommandDeps {
  parseTarget: (query: string) => Promise<TargetSpec>;
  hunts: Pick<HuntsRepo, 'enqueueHunt'>;
}

/** One-line confirmation: "Hunting: **desc** · ≤ $60 · used or new — across ebay…" */
export function describeTarget(target: TargetSpec): string {
  const parts = [`**${target.description}**`];
  const c = target.constraints;
  if (c.maxPriceCents !== undefined) parts.push(`≤ $${(c.maxPriceCents / 100).toFixed(2).replace(/\.00$/, '')}`);
  if (c.conditions?.length) parts.push(c.conditions.join(' or '));
  if (c.location?.near) {
    parts.push(c.location.maxMiles != null ? `within ${c.location.maxMiles}mi of ${c.location.near}` : `near ${c.location.near}`);
  }
  const sources = target.sources?.length ? target.sources : DEFAULT_SOURCES;
  const line = `Hunting: ${parts.join(' · ')} — across ${sources.join(', ')}…`;

  // A radius we can't anchor is a request we're quietly not honouring. Say so
  // here rather than letting the results look like a narrowed search.
  if (c.location?.maxMiles != null && !canAnchorRadius(c.location)) {
    return `${line}\n(Heads up: I can only narrow by distance from a **zip code** — "${c.location.near}" isn't one, so this searches everywhere. Locations still show on each card.)`;
  }
  return line;
}

export async function handleHuntCommand(interaction: HuntInteractionPort, deps: HuntCommandDeps): Promise<HuntRow | null> {
  await interaction.deferReply();
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
    logError('hunt.parse', err, { query });
    await interaction.editReply(`Couldn't parse that request: ${msg}`);
    return null;
  }

  // Explicit options are hard overrides on top of the parsed spec.
  const maxPrice = interaction.options.getNumber('max_price');
  if (maxPrice !== null) target.constraints.maxPriceCents = Math.round(maxPrice * 100);
  const sourcesCsv = interaction.options.getString('sources');
  if (sourcesCsv) {
    const ids = sourcesCsv
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (ids.length > 0) target.sources = ids;
  }

  const hunt = deps.hunts.enqueueHunt({
    mode: 'oneshot',
    query,
    targetJson: JSON.stringify(target),
    channelId: interaction.channelId,
    initialCostCents: parseCostCents,
  });
  await interaction.editReply(describeTarget(target));
  return hunt;
}
