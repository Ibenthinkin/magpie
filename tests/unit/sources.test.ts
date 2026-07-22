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
