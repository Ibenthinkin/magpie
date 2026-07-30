import type { Page } from 'playwright';
import { ChallengeDetectedError, type Pacer } from '../browser/pacing';
import type { HuntRow, HuntsRepo, ListingsRepo, NewHuntResult, ProfileRepo, WatchesRepo } from '../db/types';
import { log, logError } from '../log';
import type { RawListing, SourceAdapter } from '../sources/types';
import { applyConstraints } from './filter';
import { withUsage } from './llm';
import { rankListings, type RankedListing } from './rank';
import { targetSpecSchema, type TargetSpec } from './target';
import type { VisionFallback } from './visionFallback';

// The hunt engine: one hunt end to end per SPEC §8. All three user modes
// funnel through here; watch_run mode adds step 6 (dedup — notify each
// listing at most once, ever). runHunt never throws — every failure path ends
// in failHunt + an error report so the worker loop stays alive.

// The port the engine reports through; src/discord/report.ts implements it.
// Empty `ranked` means "hunt ran, nothing matched" — the reporter renders the
// explicit nothing-found card (SPEC §3.1: a hunt always replies).
export interface Reporter {
  results(hunt: HuntRow, target: TargetSpec, ranked: RankedListing[], extractedCount: number): Promise<void>;
  error(hunt: HuntRow, message: string): Promise<void>;
}

export interface HuntDeps {
  /** Step 2: spec.sources ∩ registry (prod: sources/registry.resolveAdapters). */
  adapters: (sources: string[] | undefined) => SourceAdapter[];
  /** Fresh page in the (serialized) persistent context; runHunt closes it. */
  getPage: () => Promise<Page>;
  hunts: HuntsRepo;
  listings: ListingsRepo;
  watches: Pick<WatchesRepo, 'unseenListingIds' | 'insertHits'>;
  /** Phase 3: every hunt's ranking step consults the active profile facts. */
  profile: Pick<ProfileRepo, 'activeFacts'>;
  reporter: Reporter;
  pace: Pacer;
  /** Puts a source into cooldown after it serves a bot challenge (SPEC Phase 4 hardening). */
  reportChallenge: (source: string) => void;
  /**
   * Opt-in vision recovery (SPEC Phase 4 hardening): screenshots the page and
   * extracts via LLM vision when an adapter's deterministic search() fails or
   * comes back empty. Undefined = fallback disabled entirely (Task 7 wires the
   * real function behind MAGPIE_VISION_FALLBACK_ENABLED); hunt.ts only ever
   * checks whether this is defined, no other gating lives here.
   */
  visionFallback?: VisionFallback;
  now?: () => string;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export async function runHunt(huntRow: HuntRow, deps: HuntDeps): Promise<void> {
  await withUsage(async (usage) => {
    try {
      // 1. Target.
      const target = targetSpecSchema.parse(JSON.parse(huntRow.targetJson));

      // 2. Plan.
      const adapters = deps.adapters(target.sources);
      if (adapters.length === 0) throw new Error('no usable sources for this hunt');

      // 3. Search: sequential per adapter; one source failing logs and continues.
      // Raws are tagged with their adapter's source so profile discounts can scope.
      const collected: { raw: RawListing & { source: string }; listingId: string }[] = [];
      const sourceErrors: string[] = [];
      const page = await deps.getPage();
      try {
        for (const adapter of adapters) {
          try {
            await deps.pace(adapter.source, adapter.rateLimit);
            let raws: RawListing[];
            let recovered = false;
            try {
              raws = await adapter.search(page, target);
            } catch (searchErr) {
              // Challenge pages have nothing useful to look at, and a disabled
              // fallback means recovery isn't available — either way, propagate
              // exactly as before Task 6 so the outer catch's reportChallenge /
              // sourceErrors handling fires unchanged. A vision fallback that
              // itself throws also propagates here — fail loud, not swallowed.
              if (!deps.visionFallback || searchErr instanceof ChallengeDetectedError) throw searchErr;
              log('hunt.visionRecover', { hunt: huntRow.id, source: adapter.source, error: message(searchErr) });
              raws = await deps.visionFallback(page, adapter.source, target);
              recovered = true;
            }
            // Empty is not an error — but it may still mean the deterministic
            // path missed usable content, so give vision one shot at it. This
            // check sits OUTSIDE the try/catch above: an error thrown from this
            // call must land in the outer per-adapter catch exactly once, not
            // be reinterpreted as a search() failure and trigger a second vision
            // call. `recovered` also stops an already-recovered empty result
            // from triggering a second, redundant fallback call.
            if (!recovered && raws.length === 0 && deps.visionFallback) {
              raws = await deps.visionFallback(page, adapter.source, target);
            }
            let dropped = 0;
            for (const raw of raws) {
              const norm = adapter.toListing(raw);
              if (!norm) {
                dropped++;
                continue;
              }
              const row = deps.listings.upsertListing(norm);
              collected.push({ raw: { ...raw, source: adapter.source }, listingId: row.id });
            }
            log('hunt.search', { hunt: huntRow.id, source: adapter.source, kept: raws.length - dropped, dropped });
          } catch (err) {
            if (err instanceof ChallengeDetectedError) deps.reportChallenge(adapter.source);
            sourceErrors.push(`${adapter.source}: ${message(err)}`);
            logError('hunt.search', err, { hunt: huntRow.id, source: adapter.source });
          }
        }
      } finally {
        await page.close().catch((err) => logError('hunt.pageClose', err, { hunt: huntRow.id }));
      }

      if (sourceErrors.length === adapters.length) {
        throw new Error(`all sources failed — ${sourceErrors.join('; ')}`);
      }

      // 4–5. Filter (deterministic, pre-LLM) then rank — both consult the
      // active profile facts (SPEC §3.4: every hunt's ranking step).
      const facts = deps.profile.activeFacts();
      const kept = applyConstraints(
        collected.map((c) => c.raw),
        target,
        facts,
      );
      const ranked = kept.length > 0 ? await rankListings(kept, target, facts) : [];

      // Persist hunt_result rows. Ranked rows are copies of the raws, so join back
      // to listing ids by URL — toListing guarantees every collected raw has one.
      const idByUrl = new Map(collected.map((c) => [c.raw.url, c.listingId]));
      const resultRows: NewHuntResult[] = [];
      ranked.forEach((r, i) => {
        const listingId = idByUrl.get(r.url);
        if (!listingId) {
          logError('hunt.results', new Error(`ranked row has no listing id: ${r.url}`), { hunt: huntRow.id });
          return;
        }
        resultRows.push({ listingId, rank: i + 1, landedCostCents: r.landedCents, verdict: r.verdict });
      });
      deps.listings.insertHuntResults(huntRow.id, resultRows);

      // 6. Dedup (watch runs only): drop listings this watch has already hit.
      // hunt_result above keeps the full ranked history; only the report is
      // filtered.
      let shown = ranked;
      const isWatchRun = huntRow.mode === 'watch_run' && huntRow.watchId !== null;
      if (isWatchRun) {
        const rankedIds = ranked.map((r) => idByUrl.get(r.url)).filter((id): id is string => id !== undefined);
        const unseen = new Set(deps.watches.unseenListingIds(huntRow.watchId!, rankedIds));
        shown = ranked.filter((r) => {
          const id = idByUrl.get(r.url);
          return id !== undefined && unseen.has(id);
        });
      }

      // 7. Report, then done. A reporter throw falls through to failHunt — results
      // the user never saw must not be marked delivered. Hits are marked AFTER
      // the report for the same reason: a failed post leaves the listing
      // eligible next run (at-least-once notification).
      await deps.reporter.results(huntRow, target, shown, collected.length);
      if (isWatchRun && shown.length > 0) {
        const nowIso = (deps.now ?? (() => new Date().toISOString()))();
        deps.watches.insertHits(
          huntRow.watchId!,
          shown.map((r) => idByUrl.get(r.url)!),
          nowIso,
        );
      }
      deps.hunts.completeHunt(huntRow.id, { addCostCents: usage().costCents });
      log('hunt.done', { hunt: huntRow.id, extracted: collected.length, shown: shown.length });
    } catch (err) {
      const msg = message(err);
      deps.hunts.failHunt(huntRow.id, msg, { addCostCents: usage().costCents });
      logError('hunt.failed', err, { hunt: huntRow.id });
      await deps.reporter.error(huntRow, msg).catch((e) => logError('hunt.reportError', e, { hunt: huntRow.id }));
    }
  });
}
