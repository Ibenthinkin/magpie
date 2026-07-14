import type { hunt, huntResult, listing, watch } from './schema';

// Repository seam (engine/worker/commands depend on these interfaces; only
// index.ts, scripts/ and tests/bun/ import the concrete bun:sqlite-backed
// implementations — keeps everything above the DB vitest-testable).

export type HuntRow = typeof hunt.$inferSelect;
export type HuntMode = HuntRow['mode'];
export type ListingRow = typeof listing.$inferSelect;
export type NewListing = Omit<typeof listing.$inferInsert, 'id' | 'firstSeenAt' | 'lastSeenAt'>;
export type HuntResultRow = typeof huntResult.$inferSelect;
export type WatchRow = typeof watch.$inferSelect;

export interface EnqueueHuntInput {
  mode: HuntMode;
  query: string;
  targetJson: string;
  channelId: string;
  watchId?: string;
  initialCostCents?: number;
}

export interface HuntsRepo {
  enqueueHunt(input: EnqueueHuntInput): HuntRow;
  /** Atomically claim the oldest pending hunt, or null when the queue is empty. */
  claimNextHunt(): HuntRow | null;
  completeHunt(id: string, patch: { addCostCents: number }): void;
  failHunt(id: string, error: string, patch?: { addCostCents?: number }): void;
  /** Boot recovery: orphaned `running` rows go back to `pending`. Returns count. */
  resetStaleRunning(): number;
  getHunt(id: string): HuntRow | null;
}

export interface NewHuntResult {
  listingId: string;
  rank: number;
  landedCostCents: number | null;
  verdict: string | null;
}

export interface ListingsRepo {
  /** Insert or refresh by (source, source_id); first_seen_at survives, last_seen_at refreshes. */
  upsertListing(input: NewListing): ListingRow;
  insertHuntResults(huntId: string, rows: NewHuntResult[]): void;
  resultsForHunt(huntId: string): HuntResultRow[];
  countListings(): number;
}
