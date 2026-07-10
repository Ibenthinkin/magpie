// Throwaway end-to-end spike: query → TargetSpec → eBay search → extract → rank →
// post the ranked top-N as embeds to the bound Discord channel. Send-only: a real
// gateway login (the same plumbing Phase 1 reuses), no receive loop, no commands.
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { getContext, closeContext } from '../src/browser/session';
import { parseTarget } from '../src/engine/target';
import { fetchResultsText } from '../src/sources/ebay';
import { extractListings } from '../src/engine/extract';
import { rankListings } from '../src/engine/rank';
import { tokenTotals } from '../src/engine/llm';
import { buildListingEmbed, buildNothingFoundEmbed, buildResultsHeader } from '../src/discord/embeds';

function env(key: string): string {
  const v = process.env[key];
  if (v === undefined || v === '') throw new Error(`Missing required env var: ${key}`);
  return v;
}

// Fail before doing any (slow, paid) work if the Discord side can't possibly land.
const token = env('DISCORD_TOKEN');
const channelId = env('DISCORD_CHANNEL_ID');

const query = process.argv.slice(2).join(' ') || 'logitech mx master 3s wireless mouse';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

try {
  const t0 = Date.now();
  const target = await parseTarget(query);

  const context = await getContext();
  const page = context.pages()[0] ?? (await context.newPage());
  const text = await fetchResultsText(page, target);
  const listings = await extractListings(text, target);
  const ranked = await rankListings(listings, target);

  const ready = new Promise<void>((resolve) => client.once(Events.ClientReady, () => resolve()));
  await client.login(token);
  await ready;

  const channel = await client.channels.fetch(channelId);
  if (!channel) throw new Error(`Channel not found: ${channelId}`);
  if (!channel.isSendable()) throw new Error(`Channel is not text-sendable: ${channelId}`);

  if (ranked.length === 0) {
    await channel.send({ embeds: [buildNothingFoundEmbed(target)] });
  } else {
    // Discord allows up to 10 embeds per message; top-N is 5.
    await channel.send({
      content: buildResultsHeader(target, ranked.length, listings.length),
      embeds: ranked.map((l, i) => buildListingEmbed(l, i + 1)),
    });
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nTarget: ${target.description}`);
  console.log(`Posted ${ranked.length} of ${listings.length} extracted to channel ${channelId}`);
  console.log(`Elapsed: ${elapsed}s | Tokens:`, tokenTotals());
} finally {
  await client.destroy();
  await closeContext();
}