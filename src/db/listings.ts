import { asc, count, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { Db } from './client';
import { huntResult, listing } from './schema';
import type { ListingsRepo, NewListing } from './types';

export function makeListingsRepo(db: Db, now: () => string = () => new Date().toISOString()): ListingsRepo {
  return {
    upsertListing(input: NewListing) {
      const seen = now();
      const rows = db
        .insert(listing)
        .values({ ...input, id: nanoid(), firstSeenAt: seen, lastSeenAt: seen })
        .onConflictDoUpdate({
          target: [listing.source, listing.sourceId],
          // id and first_seen_at survive; everything the source reports refreshes.
          set: {
            url: input.url,
            title: input.title,
            priceCents: input.priceCents,
            shippingCents: input.shippingCents,
            currency: input.currency,
            condition: input.condition,
            sellerRating: input.sellerRating,
            location: input.location,
            imageUrl: input.imageUrl,
            rawJson: input.rawJson,
            lastSeenAt: seen,
          },
        })
        .returning()
        .all();
      return rows[0]!;
    },

    insertHuntResults(huntId, rows) {
      if (rows.length === 0) return;
      db.insert(huntResult)
        .values(rows.map((r) => ({ huntId, ...r })))
        .run();
    },

    resultsForHunt(huntId) {
      return db.select().from(huntResult).where(eq(huntResult.huntId, huntId)).orderBy(asc(huntResult.rank)).all();
    },

    countListings() {
      return db.select({ n: count() }).from(listing).get()?.n ?? 0;
    },
  };
}
