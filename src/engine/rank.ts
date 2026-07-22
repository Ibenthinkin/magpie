import { z } from 'zod';
import type { ProfileFactRow } from '../db/types';
import { genObject } from './llm';
import type { RawListing } from '../sources/types';
import type { TargetSpec } from './target';

// Ranking = deterministic math first, LLM second. `landedCost` is pure and
// unit-testable; the verdict pass is a thin judgment layer on top. SPEC §6.5.

/** What the deterministic cost math needs; `source` scopes discount facts. */
export type CostableListing = Pick<RawListing, 'priceCents' | 'shippingCents'> & { source?: string };

// Phase 3 best-deal rule (SPEC §15 "definition depth", scoped here): a
// membership/coupon fact is machine-applied ONLY when its text names the
// listing's source — "10% off ebay" discounts eBay rows, nothing else. Percent
// applies to the item price, "$N off" to the landed total, percent wins if a
// fact has both, applicable facts stack. Anything fuzzier stays LLM-verdict
// context: the model narrates deals, it never invents math.
const PERCENT_OFF = /(\d+(?:\.\d+)?)\s*%\s*off/i;
const DOLLARS_OFF = /\$\s*(\d+(?:\.\d+)?)\s*off/i;

export function discountCents(l: CostableListing, facts: ProfileFactRow[]): number {
  if (!l.source) return 0;
  const source = l.source.toLowerCase();
  let total = 0;
  for (const f of facts) {
    if (f.category !== 'membership' && f.category !== 'coupon_source') continue;
    if (!`${f.label} ${f.value}`.toLowerCase().includes(source)) continue;
    const pct = f.value.match(PERCENT_OFF);
    if (pct) {
      total += Math.round((l.priceCents * Number(pct[1])) / 100);
      continue;
    }
    const usd = f.value.match(DOLLARS_OFF);
    if (usd) total += Math.round(Number(usd[1]) * 100);
  }
  return total;
}

// Landed cost in cents: price + shipping − deterministic membership/coupon
// discounts (Phase 3).
export function landedCost(l: CostableListing, facts: ProfileFactRow[] = []): number {
  return Math.max(0, l.priceCents + (l.shippingCents ?? 0) - discountCents(l, facts));
}

export interface RankedListing extends RawListing {
  landedCents: number;
  /** Deterministic membership/coupon discount already inside landedCents (0 = none). */
  discountCents: number;
  /** Adapter that produced the row, carried through for display; absent on untagged inputs. */
  source?: string;
  matchesTarget: boolean;
  verdict: string;
}

type RankInput = RawListing & { source?: string };

// Pass 1: cheap relevance triage over ALL rows — a bool per listing, no prose. Judging the
// whole set (not just the cheapest slice) means fairly-priced real units get assessed instead
// of being crowded out of the pool by cheap accessories/junk.
const matchesSchema = z.object({
  matches: z.array(
    z.object({
      index: z.number().describe('the listing index from the input list'),
      matchesTarget: z
        .boolean()
        .describe(
          'true ONLY if this listing IS the target item itself; false for accessories, parts, cases, cables, replacements, or any unrelated item',
        ),
    }),
  ),
});

// Pass 2: prose verdicts only for the finalists we actually show.
const verdictsSchema = z.object({
  verdicts: z.array(
    z.object({
      index: z.number().describe('the listing index from the input list'),
      verdict: z.string().describe('one concise sentence judging fit and value vs the target'),
    }),
  ),
});

const TOP_N = 5;

const MATCH_SYSTEM = [
  'You are a savvy shopping assistant triaging search results. For each listing decide',
  'matchesTarget: true ONLY if the listing IS the target item itself — false for accessories,',
  'parts, cases, cables, replacements, or unrelated items. Judge from the title and fields',
  'shown only; never invent details. Return a judgment for every listing.',
].join(' ');

const VERDICT_SYSTEM = [
  'You are a savvy shopping assistant. For each listing give ONE concise sentence judging fit',
  'and value vs the target. Cite only the fields shown (title, landed price, condition) — never',
  'invent details. Be direct: flag anything off about fit or price, and call out standout deals.',
  'When a membership or coupon discount changed a landed price, say so.',
].join(' ');

const factsBlock = (facts: ProfileFactRow[]) =>
  facts.length === 0
    ? ''
    : `\n\nShopper profile facts:\n${facts.map((f) => `- [${f.category}] ${f.label}: ${f.value}`).join('\n')}`;

const listingLine = (l: RankInput, i: number, facts: ProfileFactRow[]) => {
  const off = discountCents(l, facts);
  const discount = off > 0 ? ` (after $${(off / 100).toFixed(2)} membership/coupon discount)` : '';
  return `${i}. ${l.title} — $${(landedCost(l, facts) / 100).toFixed(2)} landed${discount}, condition: ${l.condition ?? 'unknown'}`;
};

const targetPrompt = (target: TargetSpec, lines: string, facts: ProfileFactRow[]) =>
  `Target: ${target.description}\nConstraints: ${JSON.stringify(target.constraints)}${factsBlock(facts)}\n\nListings:\n${lines}`;

/**
 * Two-pass rank. Pass 1: cheap matchesTarget triage over every extracted row. Sort matchesTarget
 * desc → landedCost asc and cut to the top-N. Pass 2: prose verdicts for just those finalists.
 * Keeps real units ahead of cheap accessories regardless of where they fall in the price order.
 */
export async function rankListings(
  listings: RankInput[],
  target: TargetSpec,
  facts: ProfileFactRow[] = [],
): Promise<RankedListing[]> {
  if (listings.length === 0) return [];
  const sorted = [...listings].sort((a, b) => landedCost(a, facts) - landedCost(b, facts));

  // Pass 1 — relevance triage over all rows.
  const { matches } = await genObject({
    label: 'rankMatch',
    schema: matchesSchema,
    system: MATCH_SYSTEM,
    prompt: targetPrompt(target, sorted.map((l, i) => listingLine(l, i, facts)).join('\n'), facts),
  });
  const matchByIndex = new Map(matches.map((m) => [m.index, m.matchesTarget]));

  const finalists = sorted
    .map((l, i) => ({ l, matchesTarget: matchByIndex.get(i) ?? false, landedCents: landedCost(l, facts) }))
    // matchesTarget desc → landedCost asc (sorted is already landed-cost ascending).
    .sort((a, b) =>
      a.matchesTarget !== b.matchesTarget ? (a.matchesTarget ? -1 : 1) : a.landedCents - b.landedCents,
    )
    .slice(0, TOP_N);

  // Pass 2 — prose verdicts for the finalists only.
  const { verdicts } = await genObject({
    label: 'rankVerdicts',
    schema: verdictsSchema,
    system: VERDICT_SYSTEM,
    prompt: targetPrompt(target, finalists.map((f, i) => listingLine(f.l, i, facts)).join('\n'), facts),
  });
  const verdictByIndex = new Map(verdicts.map((v) => [v.index, v.verdict]));

  return finalists.map((f, i) => ({
    ...f.l,
    landedCents: f.landedCents,
    discountCents: discountCents(f.l, facts),
    matchesTarget: f.matchesTarget,
    verdict: verdictByIndex.get(i) ?? '(no verdict)',
  }));
}
