import type { Page } from 'playwright';
import { z } from 'zod';
import type { TargetSpec } from '../engine/target';

// SourceAdapter contract (SPEC §6.3): adapters are guided, not free-form — each
// knows its source's search-URL pattern and walks results deterministically;
// the LLM extracts, it never navigates, on the happy path.

export type SourceId = 'ebay' | 'craigslist' | 'fixture';

// Strict shape a usable extracted row must satisfy (validated locally, never
// sent to the LLM, so bound keywords are fine here).
export const rawListingSchema = z.object({
  title: z.string().min(1),
  priceCents: z.number(),
  shippingCents: z.number().nullable(),
  condition: z.string().nullable(),
  url: z.string().nullable(),
  // Optional so rows extracted before this field existed (and every hand-written
  // fixture) stay valid; it feeds the verdict prompt and the card, never the
  // deterministic cost math — SPEC §6.5 puts seller rating in the LLM's hands.
  sellerRating: z.number().nullable().optional(),
  // Item location as the source states it ("San Jose, CA"). Narrowing by radius
  // happens at the source (see ebay.ts buildSearchUrl); we never compute
  // distance ourselves — that would need geocoding we deliberately don't have.
  location: z.string().nullable().optional(),
});
export type RawListing = z.infer<typeof rawListingSchema>;

/**
 * Validates a batch of extracted rows against rawListingSchema, dropping invalid
 * ones with a warning per dropped row and a summary log. Used after LLM extraction
 * to filter rows to usable shape before further processing.
 *
 * @param rows - Unknown rows from extraction, each to be validated
 * @param label - Label for log messages (e.g. "extract"), used as [label] prefix
 * @returns Array of valid RawListing objects, others dropped with console warnings
 */
export function keepValidRows(rows: unknown[], label: string): RawListing[] {
  const kept: RawListing[] = [];
  for (const row of rows) {
    const parsed = rawListingSchema.safeParse(row);
    if (parsed.success) {
      kept.push(parsed.data);
    } else {
      console.warn(
        `[${label}] dropped invalid row: ${JSON.stringify(row)} — ` +
          parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    }
  }
  console.log(`[${label}] kept ${kept.length}/${rows.length} rows`);
  return kept;
}

/** §5.4 `listing` shape minus id/seen-timestamps — what upsertListing consumes. */
export interface NormalizedListing {
  source: SourceId;
  sourceId: string;
  url: string;
  title: string;
  priceCents: number | null;
  shippingCents: number | null;
  currency: string;
  condition: string | null;
  sellerRating: number | null;
  location: string | null;
  imageUrl: string | null;
  rawJson: string;
}

export interface RateLimit {
  minDelayMs: number;
  maxPerHour: number;
}

export interface SourceAdapter {
  source: SourceId;
  rateLimit: RateLimit;
  search(page: Page, target: TargetSpec): Promise<RawListing[]>;
  /** Pure normalization to the §5.4 shape; null = unusable row (caller logs the drop). */
  toListing(raw: RawListing): NormalizedListing | null;
}
