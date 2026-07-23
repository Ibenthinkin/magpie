import { craigslistAdapter } from './craigslist';
import { ebayAdapter } from './ebay';
import { fixtureAdapter } from './fixture';
import type { SourceAdapter, SourceId } from './types';

export const registry: Record<SourceId, SourceAdapter> = {
  ebay: ebayAdapter,
  craigslist: craigslistAdapter,
  fixture: fixtureAdapter,
};

// Sources a hunt uses when the target names none. The fixture source is test
// plumbing — resolvable when named, never in the default set.
export const DEFAULT_SOURCES: SourceId[] = ['ebay'];

// Human-facing source names for embeds. A new adapter adds its label here
// alongside its registry entry.
const LABELS: Record<SourceId, string> = { ebay: 'eBay', craigslist: 'Craigslist', fixture: 'Fixture' };

/** Display name for a source id; an unrecognized id renders as-is, never throws. */
export function sourceLabel(id: string): string {
  return LABELS[id as SourceId] ?? id;
}

/** Labels for the sources a target actually searches (its own, or the defaults). */
export function effectiveSourceLabels(sources: string[] | undefined): string[] {
  return (sources && sources.length > 0 ? sources : DEFAULT_SOURCES).map(sourceLabel);
}

/** spec.sources ∩ registry; unknown ids are logged and skipped, never fatal. */
export function resolveAdapters(sources: string[] | undefined): SourceAdapter[] {
  if (!sources || sources.length === 0) return DEFAULT_SOURCES.map((id) => registry[id]);
  return sources.flatMap((id) => {
    const adapter = registry[id as SourceId];
    if (!adapter) {
      console.warn(`[sources] unknown source "${id}" — skipped`);
      return [];
    }
    return [adapter];
  });
}
