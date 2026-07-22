import { EmbedBuilder } from 'discord.js';
import type { ProfileFactRow, WatchRow } from '../db/types';
import type { AdvisorCandidate } from '../engine/advisor';
import type { RankedListing } from '../engine/rank';
import type { TargetSpec } from '../engine/target';
import { effectiveSourceLabels, sourceLabel } from '../sources/registry';

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
 * Later additions once the extractor captures them: `.setThumbnail(imageUrl)`
 * and a location field.
 */
export function buildListingEmbed(listing: RankedListing, rank: number): EmbedBuilder {
  const shipping =
    listing.shippingCents && listing.shippingCents > 0
      ? `(+${usd(listing.shippingCents)} shipping)`
      : '(free/unknown shipping)';

  const lines = [`**${usd(listing.landedCents)} landed** ${shipping}`];
  // The landed figure is already discounted (engine/rank.ts) — say so, or the
  // number silently disagrees with the listing's own sticker price.
  if (listing.discountCents > 0) lines.push(`Includes ${usd(listing.discountCents)} membership/coupon discount`);
  if (listing.condition) lines.push(`Condition: ${listing.condition}`);
  lines.push('', listing.verdict);

  const embed = new EmbedBuilder()
    .setTitle(truncate(listing.title, TITLE_LIMIT))
    .setDescription(lines.join('\n'))
    .setColor(listing.matchesTarget ? MATCH_COLOR : NO_MATCH_COLOR)
    // Untagged rows predate source tagging; eBay was the only source then.
    .setFooter({ text: `${sourceLabel(listing.source ?? 'ebay')} · #${rank}` });

  const url = httpUrl(listing.url);
  if (url) embed.setURL(url);

  return embed;
}

/** SPEC §3.1: a hunt always replies — an empty result set gets an explicit card, never silence. */
export function buildNothingFoundEmbed(target: TargetSpec): EmbedBuilder {
  const where = effectiveSourceLabels(target.sources).join(', ');
  return new EmbedBuilder()
    .setTitle('No listings found')
    .setDescription(`Nothing on ${where} matched **${target.description}**.`)
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

const WATCH_COLOR = 0x9b59b6;

// Discord embed description hard limit.
const DESCRIPTION_LIMIT = 4096;

/** Whole-minute cadence rendered as hours when it divides evenly, else minutes. */
function cadenceLabel(minutes: number): string {
  return minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}

/** SPEC §3.3: `/watch list` — one line per watch (id, name, status, cadence, last run, hits). */
export function buildWatchListEmbed(rows: { watch: WatchRow; hits: number }[]): EmbedBuilder {
  const line = ({ watch, hits }: { watch: WatchRow; hits: number }) => {
    const flag = watch.status === 'active' ? '' : ` [${watch.status}]`;
    const last = watch.lastRunAt ? `last ${watch.lastRunAt.slice(0, 10)}` : 'never run';
    const s = hits === 1 ? '' : 's';
    return `\`${watch.id}\` **${truncate(watch.name, 80)}**${flag} · every ${cadenceLabel(watch.cadenceMinutes)} · ${last} · ${hits} hit${s}`;
  };
  return new EmbedBuilder()
    .setTitle('Watches')
    .setDescription(truncate(rows.map(line).join('\n'), DESCRIPTION_LIMIT))
    .setColor(WATCH_COLOR)
    .setFooter({ text: `${rows.length} watch${rows.length === 1 ? '' : 'es'}` });
}

const PROFILE_COLOR = 0x1abc9c;

/** SPEC §3.4: `/profile list` — one line per active fact (id, category, label, value). */
export function buildProfileFactsEmbed(facts: ProfileFactRow[]): EmbedBuilder {
  const line = (f: ProfileFactRow) =>
    `\`${f.id}\` [${f.category}] **${truncate(f.label, 80)}** — ${truncate(f.value, 200)}`;
  return new EmbedBuilder()
    .setTitle('Profile facts')
    .setDescription(truncate(facts.map(line).join('\n'), DESCRIPTION_LIMIT))
    .setColor(PROFILE_COLOR)
    .setFooter({ text: `${facts.length} fact${facts.length === 1 ? '' : 's'}` });
}

/** SPEC §3.1: a hunt that fails mid-run reports the reason, never silently dies. */
export function buildErrorEmbed(query: string, reason: string): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle('Hunt failed')
    .setDescription(`The hunt for **${query}** failed:\n${truncate(reason, 1000)}`)
    .setColor(ERROR_COLOR);
}
