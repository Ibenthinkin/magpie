import { eq, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { Db } from './client';
import { hunt } from './schema';
import type { EnqueueHuntInput, HuntRow, HuntsRepo } from './types';

export function makeHuntsRepo(db: Db, now: () => string = () => new Date().toISOString()): HuntsRepo {
  return {
    enqueueHunt(input: EnqueueHuntInput): HuntRow {
      const rows = db
        .insert(hunt)
        .values({
          id: nanoid(),
          mode: input.mode,
          query: input.query,
          targetJson: input.targetJson,
          channelId: input.channelId,
          watchId: input.watchId ?? null,
          costCents: input.initialCostCents ?? 0,
          createdAt: now(),
        })
        .returning()
        .all();
      return rows[0]!;
    },

    claimNextHunt(): HuntRow | null {
      // Single atomic UPDATE — the queue has no broker, this IS the claim.
      // rowid tie-break keeps FIFO stable when created_at collides.
      const rows = db
        .update(hunt)
        .set({ status: 'running', startedAt: now() })
        .where(
          sql`${hunt.id} = (SELECT id FROM hunt WHERE status = 'pending' ORDER BY created_at, rowid LIMIT 1)`,
        )
        .returning()
        .all();
      return rows[0] ?? null;
    },

    completeHunt(id, patch): void {
      db.update(hunt)
        .set({
          status: 'done',
          finishedAt: now(),
          costCents: sql`COALESCE(${hunt.costCents}, 0) + ${patch.addCostCents}`,
        })
        .where(eq(hunt.id, id))
        .run();
    },

    failHunt(id, error, patch): void {
      db.update(hunt)
        .set({
          status: 'failed',
          error,
          finishedAt: now(),
          costCents: sql`COALESCE(${hunt.costCents}, 0) + ${patch?.addCostCents ?? 0}`,
        })
        .where(eq(hunt.id, id))
        .run();
    },

    resetStaleRunning(): number {
      const rows = db
        .update(hunt)
        .set({ status: 'pending', startedAt: null })
        .where(eq(hunt.status, 'running'))
        .returning({ id: hunt.id })
        .all();
      return rows.length;
    },

    getHunt(id): HuntRow | null {
      return db.select().from(hunt).where(eq(hunt.id, id)).get() ?? null;
    },
  };
}
