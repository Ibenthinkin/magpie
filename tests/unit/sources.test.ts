import { describe, expect, test } from 'vitest';
import { buildSearchUrl as clUrl, craigslistAdapter } from '../../src/sources/craigslist';
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

  test('an anchored radius engages the local-pickup filter (the only radius filter eBay honours)', () => {
    // _stpos + _sadis alone only PRE-FILL the option; verified live 2026-07-23 that
    // the result set is byte-identical with and without them. eBay's real "within N
    // miles" filter is local-pickup-only — LH_LPickup=1 (+ LH_PrefLoc=99, _fspt=1) is
    // what actually narrows and makes eBay render per-item "N mi from <zip>" distances.
    const url = new URL(
      buildSearchUrl({ description: 'x', constraints: { location: { near: '94601', maxMiles: 20 } } }),
    );
    expect(url.searchParams.get('LH_LPickup')).toBe('1');
    expect(url.searchParams.get('LH_PrefLoc')).toBe('99');
    expect(url.searchParams.get('_fspt')).toBe('1');
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
    // No radius ⇒ no narrowing: _stpos alone only sets eBay's ship-to context (useful
    // for shipping-cost estimates); the local-pickup filter must NOT be forced on.
    expect(anchored.searchParams.get('LH_LPickup')).toBeNull();

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

describe('craigslist buildSearchUrl', () => {
  const t = (over: Partial<{ constraints: object }> = {}) => ({
    description: 'mx master 3s',
    constraints: {},
    ...over,
  });

  test('region becomes the subdomain and carries the query', () => {
    const url = new URL(clUrl(t(), 'sfbay'));
    expect(url.host).toBe('sfbay.craigslist.org');
    expect(url.pathname).toBe('/search/sss');
    expect(url.searchParams.get('query')).toBe('mx master 3s');
  });

  // Measured live 2026-07-24: sort=priceasc floats free junk that merely mentions the
  // query words (4/10 relevant vs 10/10 on the default sort), and we re-sort by landed
  // cost ourselves anyway. Pinned so nobody restores it for symmetry with ebay's _sop=15.
  test('sends NO price sort — craigslist relevance beats cheapest-first here', () => {
    expect(new URL(clUrl(t(), 'sfbay')).searchParams.get('sort')).toBeNull();
  });

  test('a US zip becomes postal + an EXACT search_distance (no ladder snapping)', () => {
    const url = new URL(clUrl(t({ constraints: { location: { near: '94601', maxMiles: 23 } } }), 'sfbay'));
    expect(url.searchParams.get('postal')).toBe('94601');
    // eBay would snap 23 up to 25; Craigslist takes the exact radius.
    expect(url.searchParams.get('search_distance')).toBe('23');
  });

  test('a zip with no radius still anchors postal; a place name sets neither', () => {
    const anchored = new URL(clUrl(t({ constraints: { location: { near: '94601' } } }), 'sfbay'));
    expect(anchored.searchParams.get('postal')).toBe('94601');
    expect(anchored.searchParams.get('search_distance')).toBeNull();
    const place = new URL(clUrl(t({ constraints: { location: { near: 'Oakland, CA', maxMiles: 20 } } }), 'sfbay'));
    expect(place.searchParams.get('postal')).toBeNull();
    expect(place.searchParams.get('search_distance')).toBeNull();
  });

  test('max price as whole dollars; condition only for new', () => {
    const url = new URL(clUrl(t({ constraints: { maxPriceCents: 6050, conditions: ['new'] } }), 'sfbay'));
    expect(url.searchParams.get('max_price')).toBe('61');
    expect(url.searchParams.get('condition')).toBe('10');
    const used = new URL(clUrl(t({ constraints: { conditions: ['used'] } }), 'sfbay'));
    expect(used.searchParams.get('condition')).toBeNull();
  });

  test('no region throws — we never guess a zip into a region', () => {
    expect(() => clUrl(t(), '')).toThrow(/CRAIGSLIST_REGION/);
  });
});

describe('craigslist toListing', () => {
  const clRaw = (over: Partial<RawListing> = {}): RawListing =>
    raw({ url: 'https://sfbay.craigslist.org/eby/ele/d/oakland-logitech-mx-master/7712345678.html', ...over });

  test('derives source_id from the numeric post id (legacy permalink)', () => {
    const l = craigslistAdapter.toListing(clRaw());
    expect(l).toMatchObject({ source: 'craigslist', sourceId: '7712345678', currency: 'USD' });
  });

  // The shape craigslist's gallery actually emits as of 2026-07-24. The pre-live guess
  // accepted only the legacy form, so every live row would have been dropped here —
  // extraction would have looked fine and the hunt would have returned nothing.
  test('derives source_id from the modern /view/d/<slug>/<token> permalink', () => {
    const url = 'https://www.craigslist.org/view/d/broomall-new-uplift-standing-desk/8EhtzWDrDcXbcQiWBpsYRA';
    expect(craigslistAdapter.toListing(clRaw({ url }))).toMatchObject({
      source: 'craigslist',
      sourceId: '8EhtzWDrDcXbcQiWBpsYRA',
      url,
    });
  });

  test('rejects a foreign host or a URL with no post id', () => {
    expect(craigslistAdapter.toListing(clRaw({ url: null }))).toBeNull();
    expect(craigslistAdapter.toListing(clRaw({ url: 'https://evil.example/d/x/7712345678.html' }))).toBeNull();
    expect(
      craigslistAdapter.toListing(clRaw({ url: 'https://sfbay.craigslist.org/eby/ele/d/x/index.html' })),
    ).toBeNull();
    // A foreign host must not sneak through the modern branch either.
    expect(
      craigslistAdapter.toListing(clRaw({ url: 'https://evil.example/view/d/slug/8EhtzWDrDcXbcQiWBpsYRA' })),
    ).toBeNull();
    // /view/d/ with no token is an index page, not a post.
    expect(craigslistAdapter.toListing(clRaw({ url: 'https://www.craigslist.org/view/d/slug' }))).toBeNull();
  });

  test('carries item location and seller rating through', () => {
    expect(craigslistAdapter.toListing(clRaw({ location: 'Oakland' }))!.location).toBe('Oakland');
    expect(craigslistAdapter.toListing(clRaw({ sellerRating: null }))!.sellerRating).toBeNull();
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

  test('craigslist is resolvable when named but never a default', () => {
    expect(resolveAdapters(undefined).map((a) => a.source)).toEqual(['ebay']);
    expect(resolveAdapters(['craigslist']).map((a) => a.source)).toEqual(['craigslist']);
  });

  test('resolves named sources, skipping unknown ids', () => {
    expect(resolveAdapters(['fixture', 'amazon', 'ebay']).map((a) => a.source)).toEqual([
      'fixture',
      'ebay',
    ]);
  });
});
