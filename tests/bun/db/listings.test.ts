import { describe, expect, test } from 'bun:test';
import { makeHuntsRepo } from '../../../src/db/hunts';
import { makeListingsRepo } from '../../../src/db/listings';
import { openTestDb } from '../helpers/db';

const base = {
  source: 'ebay' as const,
  sourceId: '123456789012',
  url: 'https://www.ebay.com/itm/123456789012',
  title: 'MX Master 3S',
  priceCents: 5999,
  shippingCents: 0,
  currency: 'USD',
  condition: 'used',
  sellerRating: null,
  location: null,
  imageUrl: null,
  rawJson: '{}',
};

describe('listings repo', () => {
  test('first upsert inserts with first_seen == last_seen', () => {
    const repo = makeListingsRepo(openTestDb(), () => '2026-07-14T09:00:00.000Z');
    const row = repo.upsertListing(base);
    expect(row.id).toBeTruthy();
    expect(row.firstSeenAt).toBe('2026-07-14T09:00:00.000Z');
    expect(row.lastSeenAt).toBe('2026-07-14T09:00:00.000Z');
  });

  test('re-upsert on (source, source_id) refreshes fields without duplicating', () => {
    let now = '2026-07-14T09:00:00.000Z';
    const db = openTestDb();
    const repo = makeListingsRepo(db, () => now);
    const first = repo.upsertListing(base);

    now = '2026-07-15T09:00:00.000Z';
    const second = repo.upsertListing({ ...base, priceCents: 5499 });

    expect(second.id).toBe(first.id);
    expect(second.priceCents).toBe(5499);
    expect(second.firstSeenAt).toBe('2026-07-14T09:00:00.000Z');
    expect(second.lastSeenAt).toBe('2026-07-15T09:00:00.000Z');
    expect(repo.countListings()).toBe(1);
  });

  test('distinct source ids stay distinct rows', () => {
    const repo = makeListingsRepo(openTestDb());
    repo.upsertListing(base);
    repo.upsertListing({ ...base, sourceId: '999999999999' });
    expect(repo.countListings()).toBe(2);
  });

  test('insertHuntResults writes ranked rows readable back per hunt', () => {
    const db = openTestDb();
    const hunts = makeHuntsRepo(db);
    const repo = makeListingsRepo(db);
    const hunt = hunts.enqueueHunt({
      mode: 'oneshot',
      query: 'q',
      targetJson: '{}',
      channelId: 'chan',
    });
    const a = repo.upsertListing(base);
    const b = repo.upsertListing({ ...base, sourceId: '999999999999' });

    repo.insertHuntResults(hunt.id, [
      { listingId: a.id, rank: 1, landedCostCents: 5999, verdict: 'best match' },
      { listingId: b.id, rank: 2, landedCostCents: 6299, verdict: 'pricier' },
    ]);

    const rows = repo.resultsForHunt(hunt.id);
    expect(rows.map((r) => r.rank)).toEqual([1, 2]);
    expect(rows[0]?.listingId).toBe(a.id);
    expect(rows[0]?.verdict).toBe('best match');
  });
});
