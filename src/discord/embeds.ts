import { EmbedBuilder } from 'discord.js';
import type { AdvisorCandidate } from '../engine/advisor';
import type { RankedListing } from '../engine/rank';
import type { TargetSpec } from '../engine/target';

// Pure embed builders — no client, no IO. Rendering only: everything here reads
// structured fields off a RankedListing, never raw page text. SPEC §7.2.

const MATCH_COLOR = 0x2ecc71;
const NO_MATCH_COLOR = 0x95a5a6;

// Discord hard limit on embed titles.
const TITLE_LIMIT = 256;

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

const truncate = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

// Extraction can hand back a relative href or junk; setURL rejects anything that
// isn't an absolute http(s) URL, so degrade to a plain title rather than a
// failed post.
function httpUrl(url: string | null): string | null {
  if (!url) return null;
  return /^https?:\/\//i.test(url) ? url : null;
}

/**
 * One listing card. `rank` is the 1-based position in the shown results.
 *
 * Phase 1 additions once the extractor captures them: `.setThumbnail(imageUrl)`,
 * real source name in the footer (constant `eBay` while eBay is the only
 * adapter), seller rating and location fields.
 */
export function buildListingEmbed(listing: RankedListing, rank: number): EmbedBuilder {
  const shipping =
    listing.shippingCents && listing.shippingCents > 0
      ? `(+${usd(listing.shippingCents)} shipping)`
      : '(free/unknown shipping)';

  const lines = [`**${usd(listing.landedCents)} landed** ${shipping}`];
  if (listing.condition) lines.push(`Condition: ${listing.condition}`);
  lines.push('', listing.verdict);

  const embed = new EmbedBuilder()
    .setTitle(truncate(listing.title, TITLE_LIMIT))
    .setDescription(lines.join('\n'))
    .setColor(listing.matchesTarget ? MATCH_COLOR : NO_MATCH_COLOR)
    .setFooter({ text: `eBay · #${rank}` });

  const url = httpUrl(listing.url);
  if (url) embed.setURL(url);

  return embed;
}

/** SPEC §3.1: a hunt always replies — an empty result set gets an explicit card, never silence. */
export function buildNothingFoundEmbed(target: TargetSpec): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle('No listings found')
    .setDescription(`Nothing on eBay matched **${target.description}**.`)
    .setColor(NO_MATCH_COLOR);
}

/** Plain-text content line above the cards. */
export function buildResultsHeader(target: TargetSpec, shownCount: number, extractedCount: number): string {
  return `**Magpie** · top ${shownCount} of ${extractedCount} for "${target.description}"`;
}

const ERROR_COLOR = 0xe74c3c;
const CANDIDATE_COLOR = 0x3498db;

/** Advisor candidate card (SPEC §3.2): name, pros/cons, the concretized search target. */
export function buildCandidateEmbed(c: AdvisorCandidate, index: number): EmbedBuilder {
  const bullets = (items: string[]) => items.map((s) => `• ${s}`).join('\n') || '—';
  return new EmbedBuilder()
    .setTitle(truncate(`${index + 1}. ${c.name}`, TITLE_LIMIT))
    .setDescription(`Search target: *${c.target.description}*`)
    .addFields(
      { name: 'Pros', value: truncate(bullets(c.pros), 1024), inline: true },
      { name: 'Cons', value: truncate(bullets(c.cons), 1024), inline: true },
    )
    .setColor(CANDIDATE_COLOR);
}

/** SPEC §3.1: a hunt that fails mid-run reports the reason, never silently dies. */
export function buildErrorEmbed(query: string, reason: string): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle('Hunt failed')
    .setDescription(`The hunt for **${query}** failed:\n${truncate(reason, 1000)}`)
    .setColor(ERROR_COLOR);
}
