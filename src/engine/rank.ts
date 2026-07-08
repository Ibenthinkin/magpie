import { z } from 'zod';
import { genObject } from './llm';
import type { RawListing } from './extract';
import type { TargetSpec } from './target';

// Ranking = deterministic math first, LLM second. `landedCost` is pure and
// unit-testable; the verdict pass is a thin judgment layer on top. SPEC §6.5.

// Landed cost in cents: price + shipping. Membership/coupon discounts and profile
// facts arrive in Phase 3; for now there are none to apply.
export function landedCost(l: Pick<RawListing, 'priceCents' | 'shippingCents'>): number {
  return l.priceCents + (l.shippingCents ?? 0);
}

export interface RankedListing extends RawListing {
  landedCents: number;
  matchesTarget: boolean;
  verdict: string;
}

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
].join(' ');

const listingLine = (l: RawListing, i: number) =>
  `${i}. ${l.title} — $${(landedCost(l) / 100).toFixed(2)} landed, condition: ${l.condition ?? 'unknown'}`;

const targetPrompt = (target: TargetSpec, lines: string) =>
  `Target: ${target.description}\nConstraints: ${JSON.stringify(target.constraints)}\n\nListings:\n${lines}`;

/**
 * Two-pass rank. Pass 1: cheap matchesTarget triage over every extracted row. Sort matchesTarget
 * desc → landedCost asc and cut to the top-N. Pass 2: prose verdicts for just those finalists.
 * Keeps real units ahead of cheap accessories regardless of where they fall in the price order.
 */
export async function rankListings(listings: RawListing[], target: TargetSpec): Promise<RankedListing[]> {
  if (listings.length === 0) return [];
  const sorted = [...listings].sort((a, b) => landedCost(a) - landedCost(b));

  // Pass 1 — relevance triage over all rows.
  const { matches } = await genObject({
    label: 'rankMatch',
    schema: matchesSchema,
    system: MATCH_SYSTEM,
    prompt: targetPrompt(target, sorted.map(listingLine).join('\n')),
  });
  const matchByIndex = new Map(matches.map((m) => [m.index, m.matchesTarget]));

  const finalists = sorted
    .map((l, i) => ({ l, matchesTarget: matchByIndex.get(i) ?? false, landedCents: landedCost(l) }))
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
    prompt: targetPrompt(target, finalists.map((f, i) => listingLine(f.l, i)).join('\n')),
  });
  const verdictByIndex = new Map(verdicts.map((v) => [v.index, v.verdict]));

  return finalists.map((f, i) => ({
    ...f.l,
    landedCents: f.landedCents,
    matchesTarget: f.matchesTarget,
    verdict: verdictByIndex.get(i) ?? '(no verdict)',
  }));
}
