import { and, asc, count, eq, inArray, lte, ne, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { Db } from './client';
import { watch, watchHit } from './schema';
import type { CreateWatchInput, WatchesRepo, WatchRow, WatchStatus } from './types';

export function makeWatchesRepo(db: Db, now: () => string = () => new Date().toISOString()): WatchesRepo {
  return {
    createWatch(input: CreateWatchInput): WatchRow {
      const rows = db
        .insert(watch)
        .values({
          id: nanoid(),
          name: input.name,
          targetJson: input.targetJson,
          cadenceMinutes: input.cadenceMinutes,
          nextRunAt: input.nextRunAt,
          channelId: input.channelId,
          createdAt: now(),
        })
        .returning()
        .all();
      return rows[0]!;
    },

    getWatch(id): WatchRow | null {
      return db.select().from(watch).where(eq(watch.id, id)).get() ?? null;
    },

    listWatches(): WatchRow[] {
      return db
        .select()
        .from(watch)
        .where(ne(watch.status, 'removed'))
        .orderBy(asc(watch.createdAt), asc(sql`rowid`))
        .all();
    },

    dueWatches(nowIso): WatchRow[] {
      return db
        .select()
        .from(watch)
        .where(and(eq(watch.status, 'active'), lte(watch.nextRunAt, nowIso)))
        .orderBy(asc(watch.nextRunAt))
        .all();
    },

    bumpNextRun(id, patch): void {
      db.update(watch)
        .set({ nextRunAt: patch.nextRunAt, lastRunAt: patch.lastRunAt })
        .where(eq(watch.id, id))
        .run();
    },

    setStatus(id, status: WatchStatus): void {
      db.update(watch).set({ status }).where(eq(watch.id, id)).run();
    },

    unseenListingIds(watchId, listingIds): string[] {
      if (listingIds.length === 0) return [];
      const seen = new Set(
        db
          .select({ listingId: watchHit.listingId })
          .from(watchHit)
          .where(and(eq(watchHit.watchId, watchId), inArray(watchHit.listingId, listingIds)))
          .all()
          .map((r) => r.listingId),
      );
      return listingIds.filter((id) => !seen.has(id));
    },

    insertHits(watchId, listingIds, notifiedAt): void {
      if (listingIds.length === 0) return;
      db.insert(watchHit)
        .values(listingIds.map((listingId) => ({ watchId, listingId, notifiedAt, createdAt: now() })))
        .run();
    },

    countHits(watchId): number {
      const row = db.select({ n: count() }).from(watchHit).where(eq(watchHit.watchId, watchId)).get();
      return row?.n ?? 0;
    },
  };
}
