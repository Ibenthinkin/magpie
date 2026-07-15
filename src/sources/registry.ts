import { ebayAdapter } from './ebay';
import { fixtureAdapter } from './fixture';
import type { SourceAdapter, SourceId } from './types';

export const registry: Record<SourceId, SourceAdapter> = {
  ebay: ebayAdapter,
  fixture: fixtureAdapter,
};

// Sources a hunt uses when the target names none. The fixture source is test
// plumbing — resolvable when named, never in the default set.
export const DEFAULT_SOURCES: SourceId[] = ['ebay'];

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
