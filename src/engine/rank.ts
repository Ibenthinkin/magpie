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
  verdict: string;
}

const verdictsSchema = z.object({
  verdicts: z.array(
    z.object({
      index: z.number().describe('the listing index from the input list'),
      verdict: z.string().describe('one concise sentence judging fit and value vs the target'),
    }),
  ),
});

const TOP_N = 5;

const SYSTEM = [
  'You are a savvy shopping assistant. For each listing, give ONE concise sentence',
  'judging how well it fits the target and whether it looks like good value.',
  'Cite only the fields shown (title, landed price, condition) — never invent details.',
  'Be direct: flag accessories or wrong items, and call out standout deals.',
].join(' ');

/** Deterministic landed-cost sort, then a single batched verdict pass over the top-N. */
export async function rankListings(listings: RawListing[], target: TargetSpec): Promise<RankedListing[]> {
  const sorted = [...listings].sort((a, b) => landedCost(a) - landedCost(b));
  const top = sorted.slice(0, TOP_N);
  if (top.length === 0) return [];

  const lines = top
    .map(
      (l, i) =>
        `${i}. ${l.title} — $${(landedCost(l) / 100).toFixed(2)} landed, condition: ${l.condition ?? 'unknown'}`,
    )
    .join('\n');

  const { verdicts } = await genObject({
    label: 'rankVerdicts',
    schema: verdictsSchema,
    system: SYSTEM,
    prompt: `Target: ${target.description}\nConstraints: ${JSON.stringify(target.constraints)}\n\nListings:\n${lines}`,
  });

  const byIndex = new Map(verdicts.map((v) => [v.index, v.verdict]));
  return top.map((l, i) => ({
    ...l,
    landedCents: landedCost(l),
    verdict: byIndex.get(i) ?? '(no verdict)',
  }));
}
