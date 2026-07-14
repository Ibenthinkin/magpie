import type { RawListing } from '../sources/types';
import { landedCost } from './rank';
import type { TargetSpec } from './target';

// SPEC §8 step 4: deterministic hard-constraint pass before any LLM spend.
// Only constraints that can be checked mechanically live here (price ceiling,
// condition); mustHave needs judgment and stays with the rank triage.

type Condition = 'new' | 'used' | 'refurbished';

// Marketplace condition strings are free text ("Pre-owned", "Certified -
// Refurbished", "Brand New"). Classify only what's unambiguous; anything else
// (null, "Open box", "For parts") returns null and is KEPT — dropping on a
// guess would silently hide real matches, judging edge cases is rank's job.
function classifyCondition(text: string | null): Condition | null {
  if (!text) return null;
  const t = text.toLowerCase();
  if (/refurb|renewed/.test(t)) return 'refurbished';
  if (/pre-?owned|used/.test(t)) return 'used';
  if (/\bnew\b/.test(t)) return 'new';
  return null;
}

/** Drop listings that violate hard constraints; ties go to keeping the listing. */
export function applyConstraints(listings: RawListing[], target: TargetSpec): RawListing[] {
  const { maxPriceCents, conditions } = target.constraints;

  const kept = listings.filter((l) => {
    if (maxPriceCents != null && landedCost(l) > maxPriceCents) return false;
    if (conditions && conditions.length > 0) {
      const c = classifyCondition(l.condition);
      if (c !== null && !conditions.includes(c)) return false;
    }
    return true;
  });

  if (kept.length < listings.length) {
    console.log(`[filter] dropped ${listings.length - kept.length}/${listings.length} on hard constraints`);
  }
  return kept;
}
