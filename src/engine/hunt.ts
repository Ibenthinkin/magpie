import type { Page } from 'playwright';
import type { Pacer } from '../browser/pacing';
import type { HuntRow, HuntsRepo, ListingsRepo, NewHuntResult } from '../db/types';
import { log, logError } from '../log';
import type { RawListing, SourceAdapter } from '../sources/types';
import { applyConstraints } from './filter';
import { withUsage } from './llm';
import { rankListings, type RankedListing } from './rank';
import { targetSpecSchema, type TargetSpec } from './target';

// The hunt engine: one hunt end to end per SPEC §8. All three user modes
// funnel through here. Step 6 (watch dedup) lands with Phase 2; a oneshot run
// covers steps 1–5 and 7. runHunt never throws — every failure path ends in
// failHunt + an error report so the worker loop stays alive.

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
  reporter: Reporter;
  pace: Pacer;
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
      const collected: { raw: RawListing; listingId: string }[] = [];
      const sourceErrors: string[] = [];
      const page = await deps.getPage();
      try {
        for (const adapter of adapters) {
          try {
            await deps.pace(adapter.source, adapter.rateLimit);
            const raws = await adapter.search(page, target);
            let dropped = 0;
            for (const raw of raws) {
              const norm = adapter.toListing(raw);
              if (!norm) {
                dropped++;
                continue;
              }
              const row = deps.listings.upsertListing(norm);
              collected.push({ raw, listingId: row.id });
            }
            log('hunt.search', { hunt: huntRow.id, source: adapter.source, kept: raws.length - dropped, dropped });
          } catch (err) {
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

      // 4–5. Filter (deterministic, pre-LLM) then rank.
      const kept = applyConstraints(
        collected.map((c) => c.raw),
        target,
      );
      const ranked = kept.length > 0 ? await rankListings(kept, target) : [];

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

      // 7. Report, then done. A reporter throw falls through to failHunt — results
      // the user never saw must not be marked delivered.
      await deps.reporter.results(huntRow, target, ranked, collected.length);
      deps.hunts.completeHunt(huntRow.id, { addCostCents: usage().costCents });
      log('hunt.done', { hunt: huntRow.id, extracted: collected.length, shown: ranked.length });
    } catch (err) {
      const msg = message(err);
      deps.hunts.failHunt(huntRow.id, msg, { addCostCents: usage().costCents });
      logError('hunt.failed', err, { hunt: huntRow.id });
      await deps.reporter.error(huntRow, msg).catch((e) => logError('hunt.reportError', e, { hunt: huntRow.id }));
    }
  });
}
