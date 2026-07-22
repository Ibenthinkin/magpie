import { describe, expect, test } from 'vitest';
import { buildSearchUrl, ebayAdapter } from '../../src/sources/ebay';
import { makeFixtureAdapter } from '../../src/sources/fixture';
import { resolveAdapters } from '../../src/sources/registry';
import { rawListingSchema, type RawListing } from '../../src/sources/types';

const raw = (over: Partial<RawListing> = {}): RawListing => ({
  title: 'MX Master 3S',
  priceCents: 5999,
  shippingCents: 499,
  condition: 'used',
  url: 'https://www.ebay.com/itm/123456789012',
  ...over,
});

describe('ebay buildSearchUrl', () => {
  test('encodes query with cheapest-first sort', () => {
    const url = new URL(buildSearchUrl({ description: 'mx master 3s', constraints: {} }));
    expect(url.searchParams.get('_nkw')).toBe('mx master 3s');
    expect(url.searchParams.get('_sop')).toBe('15');
  });

  test('a zip-coded location becomes _stpos plus a snapped _sadis radius', () => {
    const url = new URL(
      buildSearchUrl({
        description: 'x',
        constraints: { location: { near: '94601', maxMiles: 20 } },
      }),
    );
    expect(url.searchParams.get('_stpos')).toBe('94601');
    // eBay only honours a fixed set of radii; 20 is not one, so snap UP to 25 —
    // a superset is safe, narrowing below what was asked would hide real matches.
    expect(url.searchParams.get('_sadis')).toBe('25');
  });

  test('radius snaps up to the nearest eBay-supported distance and clamps at the maximum', () => {
    const radius = (maxMiles: number) =>
      new URL(buildSearchUrl({ description: 'x', constraints: { location: { near: '94601', maxMiles } } }))
        .searchParams.get('_sadis');
    expect(radius(3)).toBe('10');
    expect(radius(10)).toBe('10');
    expect(radius(26)).toBe('50');
    expect(radius(9999)).toBe('1000');
  });

  test('a zip with no radius still anchors the search; a radius with no zip sets neither', () => {
    const anchored = new URL(buildSearchUrl({ description: 'x', constraints: { location: { near: '94601' } } }));
    expect(anchored.searchParams.get('_stpos')).toBe('94601');
    expect(anchored.searchParams.get('_sadis')).toBeNull();

    const orphan = new URL(buildSearchUrl({ description: 'x', constraints: { location: { maxMiles: 25 } } }));
    expect(orphan.searchParams.get('_sadis')).toBeNull();
  });

  test('a place name eBay cannot anchor on is NOT guessed into a zip', () => {
    const url = new URL(
      buildSearchUrl({ description: 'x', constraints: { location: { near: 'Oakland, CA', maxMiles: 20 } } }),
    );
    expect(url.searchParams.get('_stpos')).toBeNull();
    expect(url.searchParams.get('_sadis')).toBeNull();
  });

  test('price ceiling lands as whole dollars, condition as its eBay code', () => {
    const url = new URL(
      buildSearchUrl({
        description: 'x',
        constraints: { maxPriceCents: 6050, conditions: ['used'] },
      }),
    );
    expect(url.searchParams.get('_udhi')).toBe('61');
    expect(url.searchParams.get('LH_ItemCondition')).toBe('3000');
  });
});

describe('ebay toListing', () => {
  test('normalizes a valid row, deriving source_id from the item URL', () => {
    const l = ebayAdapter.toListing(raw());
    expect(l).toMatchObject({
      source: 'ebay',
      sourceId: '123456789012',
      url: 'https://www.ebay.com/itm/123456789012',
      title: 'MX Master 3S',
      priceCents: 5999,
      shippingCents: 499,
      currency: 'USD',
      condition: 'used',
    });
    expect(JSON.parse(l!.rawJson)).toEqual(raw());
  });

  test('rejects rows without a real item URL', () => {
    expect(ebayAdapter.toListing(raw({ url: null }))).toBeNull();
    expect(ebayAdapter.toListing(raw({ url: 'https://www.ebay.com/itm/123456' }))).toBeNull();
    expect(ebayAdapter.toListing(raw({ url: 'https://evil.example/itm/123456789012' }))).toBeNull();
  });

  test('carries an extracted seller rating through to the normalized row', () => {
    expect(ebayAdapter.toListing(raw({ sellerRating: 99.4 }))!.sellerRating).toBe(99.4);
  });

  test('carries an extracted item location through to the normalized row', () => {
    expect(ebayAdapter.toListing(raw({ location: 'San Jose, CA' }))!.location).toBe('San Jose, CA');
    expect(ebayAdapter.toListing(raw())!.location).toBeNull();
  });

  test('a row with no seller rating still parses and normalizes to null', () => {
    expect(rawListingSchema.safeParse(raw()).success).toBe(true);
    expect(ebayAdapter.toListing(raw())!.sellerRating).toBeNull();
    expect(ebayAdapter.toListing(raw({ sellerRating: null }))!.sellerRating).toBeNull();
  });
});

describe('fixture toListing', () => {
  test('derives source_id from the fixture item path', () => {
    const adapter = makeFixtureAdapter('http://127.0.0.1:1234');
    const l = adapter.toListing(raw({ url: 'http://127.0.0.1:1234/item/fx-001.html' }));
    expect(l).toMatchObject({ source: 'fixture', sourceId: 'fx-001' });
  });

  test('carries an extracted seller rating', () => {
    const adapter = makeFixtureAdapter('http://127.0.0.1:1234');
    const l = adapter.toListing(raw({ url: 'http://127.0.0.1:1234/item/fx-001.html', sellerRating: 98 }));
    expect(l!.sellerRating).toBe(98);
  });

  test('rejects rows without an item URL', () => {
    const adapter = makeFixtureAdapter('http://127.0.0.1:1234');
    expect(adapter.toListing(raw({ url: null }))).toBeNull();
  });
});

describe('registry', () => {
  test('defaults to the enabled live sources (fixture is opt-in only)', () => {
    expect(resolveAdapters(undefined).map((a) => a.source)).toEqual(['ebay']);
    expect(resolveAdapters([]).map((a) => a.source)).toEqual(['ebay']);
  });

  test('resolves named sources, skipping unknown ids', () => {
    expect(resolveAdapters(['fixture', 'amazon', 'ebay']).map((a) => a.source)).toEqual([
      'fixture',
      'ebay',
    ]);
  });
});
