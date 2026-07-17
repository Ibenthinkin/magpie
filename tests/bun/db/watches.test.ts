import { describe, expect, test } from 'bun:test';
import { makeHuntsRepo } from '../../../src/db/hunts';
import { makeListingsRepo } from '../../../src/db/listings';
import { makeWatchesRepo } from '../../../src/db/watches';
import { openTestDb } from '../helpers/db';

// WatchesRepo on real sqlite: due-selection, next-run bumping, lifecycle
// (soft states, never deletes), and the watch_hit dedup primitives
// (SPEC §3.3, §5.2, §5.6).

const T0 = '2026-07-17T00:00:00.000Z';
const T1 = '2026-07-17T01:00:00.000Z';

function repos(now: () => string = () => T0) {
  const db = openTestDb();
  return {
    watches: makeWatchesRepo(db, now),
    listings: makeListingsRepo(db, now),
    hunts: makeHuntsRepo(db, now),
  };
}

const input = (over: Partial<Parameters<ReturnType<typeof makeWatchesRepo>['createWatch']>[0]> = {}) => ({
  name: 'server hdd deal',
  targetJson: JSON.stringify({ description: '10TB CMR HDD', constraints: {} }),
  cadenceMinutes: 1440,
  channelId: 'chan-1',
  nextRunAt: T0,
  ...over,
});

describe('createWatch / getWatch / listWatches', () => {
  test('creates active with the given cadence and next run', () => {
    const { watches } = repos();
    const w = watches.createWatch(input());
    expect(w.status).toBe('active');
    expect(w.cadenceMinutes).toBe(1440);
    expect(w.nextRunAt).toBe(T0);
    expect(watches.getWatch(w.id)?.name).toBe('server hdd deal');
  });

  test('listWatches returns active and paused but not removed', () => {
    const { watches } = repos();
    const a = watches.createWatch(input({ name: 'a' }));
    const b = watches.createWatch(input({ name: 'b' }));
    const c = watches.createWatch(input({ name: 'c' }));
    watches.setStatus(b.id, 'paused');
    watches.setStatus(c.id, 'removed');
    expect(watches.listWatches().map((w) => w.name)).toEqual(['a', 'b']);
  });
});

describe('dueWatches', () => {
  test('returns only active watches whose nextRunAt has arrived', () => {
    const { watches } = repos();
    const due = watches.createWatch(input({ name: 'due', nextRunAt: T0 }));
    watches.createWatch(input({ name: 'future', nextRunAt: '2027-01-01T00:00:00.000Z' }));
    const paused = watches.createWatch(input({ name: 'paused', nextRunAt: T0 }));
    watches.setStatus(paused.id, 'paused');

    expect(watches.dueWatches(T1).map((w) => w.id)).toEqual([due.id]);
  });
});

describe('bumpNextRun', () => {
  test('advances nextRunAt and records lastRunAt so the watch stops being due', () => {
    const { watches } = repos();
    const w = watches.createWatch(input());
    watches.bumpNextRun(w.id, { nextRunAt: '2026-07-18T00:07:00.000Z', lastRunAt: T1 });
    const updated = watches.getWatch(w.id)!;
    expect(updated.nextRunAt).toBe('2026-07-18T00:07:00.000Z');
    expect(updated.lastRunAt).toBe(T1);
    expect(watches.dueWatches(T1)).toEqual([]);
  });
});

describe('watch_hit dedup primitives', () => {
  function withListings() {
    const r = repos();
    const l1 = r.listings.upsertListing({
      source: 'fixture',
      sourceId: 'fx-1',
      url: 'http://x/item/fx-1.html',
      title: 'one',
      priceCents: 100,
      shippingCents: null,
      currency: 'USD',
      condition: null,
      sellerRating: null,
      location: null,
      imageUrl: null,
      rawJson: '{}',
    });
    const l2 = r.listings.upsertListing({
      source: 'fixture',
      sourceId: 'fx-2',
      url: 'http://x/item/fx-2.html',
      title: 'two',
      priceCents: 200,
      shippingCents: null,
      currency: 'USD',
      condition: null,
      sellerRating: null,
      location: null,
      imageUrl: null,
      rawJson: '{}',
    });
    return { ...r, l1, l2 };
  }

  test('unseenListingIds filters out listings already hit for this watch — notify at most once, ever', () => {
    const { watches, l1, l2 } = withListings();
    const w = watches.createWatch(input());
    expect(watches.unseenListingIds(w.id, [l1.id, l2.id])).toEqual([l1.id, l2.id]);

    watches.insertHits(w.id, [l1.id], T0);
    expect(watches.unseenListingIds(w.id, [l1.id, l2.id])).toEqual([l2.id]);
  });

  test('hits are per-watch: another watch still sees the listing as new', () => {
    const { watches, l1 } = withListings();
    const w1 = watches.createWatch(input({ name: 'w1' }));
    const w2 = watches.createWatch(input({ name: 'w2' }));
    watches.insertHits(w1.id, [l1.id], T0);
    expect(watches.unseenListingIds(w2.id, [l1.id])).toEqual([l1.id]);
  });

  test('countHits powers /watch list', () => {
    const { watches, l1, l2 } = withListings();
    const w = watches.createWatch(input());
    expect(watches.countHits(w.id)).toBe(0);
    watches.insertHits(w.id, [l1.id, l2.id], T0);
    expect(watches.countHits(w.id)).toBe(2);
  });

  test('unseenListingIds with an empty candidate list is [] without touching the db', () => {
    const { watches } = withListings();
    const w = watches.createWatch(input());
    expect(watches.unseenListingIds(w.id, [])).toEqual([]);
  });
});
