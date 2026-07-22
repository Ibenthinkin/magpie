import { SlashCommandBuilder } from 'discord.js';
import type { ProfileFactCategory, ProfileRepo } from '../../db/types';
import { buildProfileFactsEmbed } from '../embeds';

// /profile (SPEC §3.4): standing shopper facts — memberships, coupon sources,
// hard specs — that every hunt's ranking step consults. No LLM in this path;
// facts are stored verbatim. A coupon becomes deterministic math only when its
// text names the source ("10% off ebay", see engine/rank.ts); anything fuzzier
// still reaches the verdict prompt as context.

export const profileCommandData = new SlashCommandBuilder()
  .setName('profile')
  .setDescription('Shopper profile facts — memberships, coupons and specs consulted by every hunt')
  .addSubcommand((s) =>
    s
      .setName('add')
      .setDescription('Add a profile fact')
      .addStringOption((o) =>
        o
          .setName('category')
          .setDescription('Kind of fact')
          .setRequired(true)
          .addChoices(
            { name: 'membership', value: 'membership' },
            { name: 'coupon source', value: 'coupon_source' },
            { name: 'spec', value: 'spec' },
          ),
      )
      .addStringOption((o) => o.setName('label').setDescription('Short name, e.g. "warehouse club"').setRequired(true))
      .addStringOption((o) =>
        o.setName('value').setDescription('Detail, e.g. "10% off ebay through June"').setRequired(true),
      ),
  )
  .addSubcommand((s) => s.setName('list').setDescription('Show active profile facts'))
  .addSubcommand((s) =>
    s
      .setName('remove')
      .setDescription('Remove a fact (keeps history)')
      .addStringOption((o) => o.setName('id').setDescription('Fact id (from /profile list)').setRequired(true)),
  );

// Narrow structural slice of ChatInputCommandInteraction — handlers are tested
// against this port with plain fakes (SPEC §12).
export interface ProfileInteractionPort {
  options: {
    getSubcommand(): string;
    getString(name: 'category' | 'label' | 'value' | 'id'): string | null;
  };
  deferReply(): Promise<unknown>;
  editReply(content: string | { embeds: import('discord.js').EmbedBuilder[] }): Promise<unknown>;
}

export interface ProfileCommandDeps {
  profile: Pick<ProfileRepo, 'addFact' | 'getFact' | 'activeFacts' | 'removeFact'>;
}

export async function handleProfileCommand(
  interaction: ProfileInteractionPort,
  deps: ProfileCommandDeps,
): Promise<void> {
  await interaction.deferReply();
  const sub = interaction.options.getSubcommand();
  if (sub === 'add') await handleAdd(interaction, deps);
  else if (sub === 'list') await handleList(interaction, deps);
  else await handleRemove(interaction, deps);
}

function handleAdd(interaction: ProfileInteractionPort, deps: ProfileCommandDeps): Promise<unknown> {
  // The category option is a required enum, so the fallback is unreachable in
  // practice — `spec` is the inert choice if Discord ever sends us nothing.
  const category = (interaction.options.getString('category') ?? 'spec') as ProfileFactCategory;
  const label = interaction.options.getString('label') ?? '';
  const value = interaction.options.getString('value') ?? '';
  const fact = deps.profile.addFact({ category, label, value });
  return interaction.editReply(
    `Added [${category}] **${label}** — ${value} (\`${fact.id}\`). Every hunt now consults it.`,
  );
}

function handleList(interaction: ProfileInteractionPort, deps: ProfileCommandDeps): Promise<unknown> {
  const facts = deps.profile.activeFacts();
  if (facts.length === 0) return interaction.editReply('No profile facts yet.');
  return interaction.editReply({ embeds: [buildProfileFactsEmbed(facts)] });
}

function handleRemove(interaction: ProfileInteractionPort, deps: ProfileCommandDeps): Promise<unknown> {
  const id = interaction.options.getString('id') ?? '';
  const fact = deps.profile.getFact(id);
  // An already-removed fact reports not-found rather than confirming a second
  // removal, so `/profile list` and the reply can never disagree.
  if (!fact || fact.active === 0) return interaction.editReply(`No active fact with id \`${id}\`.`);
  deps.profile.removeFact(id);
  return interaction.editReply(`Removed **${fact.label}**.`);
}
