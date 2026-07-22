import { z } from 'zod';
import { genObject } from './llm';

// Freeform shopper request → structured, search-ready target. SPEC §6.2.
export const targetSpecSchema = z.object({
  description: z.string().describe('concise, search-ready item description (brand, model, key specs)'),
  constraints: z.object({
    // NOTE: Anthropic structured output rejects minimum/maximum/exclusiveMinimum
    // on numeric types. zod's .int() ALSO injects safe-integer min/max bounds, so
    // use a plain z.number() and state "integer" in .describe() instead.
    maxPriceCents: z
      .number()
      .optional()
      .describe('hard price ceiling as an integer number of US cents, only if the user stated one'),
    conditions: z.array(z.enum(['new', 'used', 'refurbished'])).optional(),
    mustHave: z
      .array(z.string())
      .optional()
      .describe('hard requirements, e.g. "≥ 10 TB", "CMR not SMR"'),
    niceToHave: z.array(z.string()).optional(),
    location: z
      .object({
        near: z.string().optional(),
        maxMiles: z.number().optional().describe('search radius in miles (positive)'),
      })
      .optional(),
  }),
  sources: z.array(z.string()).optional().describe('specific sources, if the user named any'),
});

export type TargetSpec = z.infer<typeof targetSpecSchema>;

/**
 * Sources anchor a radius search on a postal code, not a place name, and we
 * never turn "Oakland, CA" into a zip ourselves — a guessed centroid would
 * silently search the wrong place, which is worse than not narrowing at all.
 * Callers use this to decide whether a radius can actually be enforced
 * (`ebay.ts` builds the URL from it; `/hunt` warns the user when it can't).
 */
const POSTAL_ANCHOR = /^\d{5}(?:-\d{4})?$/;

export function canAnchorRadius(location: TargetSpec['constraints']['location']): boolean {
  return location?.near !== undefined && POSTAL_ANCHOR.test(location.near.trim());
}

const SYSTEM = [
  "You turn a shopper's freeform request into a structured shopping target.",
  'Extract only what the user actually stated or clearly implied — never invent constraints.',
  '"description" must be a concise phrase suitable for a marketplace search box (brand, model, key specs).',
  'Express any price ceiling in US cents. Omit optional fields when the user gave no signal for them.',
].join(' ');

export function parseTarget(query: string): Promise<TargetSpec> {
  return genObject({
    label: 'parseTarget',
    schema: targetSpecSchema,
    system: SYSTEM,
    prompt: `Shopper request:\n${query}`,
  });
}
