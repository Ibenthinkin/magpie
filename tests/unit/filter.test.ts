import { describe, expect, it } from 'vitest';
import type { ProfileFactRow } from '../../src/db/types';
import { applyConstraints } from '../../src/engine/filter';
import type { RawListing } from '../../src/sources/types';
import type { TargetSpec } from '../../src/engine/target';

// SPEC §8 step 4: cheap deterministic constraint pass BEFORE spending LLM
// tokens on ranking. Hard constraints only (maxPriceCents, condition);
// mustHave stays with the rank triage — it needs judgment.

const raw = (over: Partial<RawListing> = {}): RawListing => ({
  title: 'Widget 3000',
  priceCents: 10_000,
  shippingCents: null,
  condition: null,
  url: 'https://example.com/item/1',
  ...over,
});

const target = (constraints: TargetSpec['constraints'] = {}): TargetSpec => ({
  description: 'widget 3000',
  constraints,
});

describe('applyConstraints', () => {
  it('keeps everything when the target has no hard constraints', () => {
    const listings = [raw(), raw({ priceCents: 999_999 })];
    expect(applyConstraints(listings, target())).toEqual(listings);
  });

  it('drops listings whose LANDED cost (price + shipping) exceeds maxPriceCents', () => {
    const cheap = raw({ priceCents: 9_000, shippingCents: 500 }); // 9500 landed
    const overByShipping = raw({ priceCents: 9_800, shippingCents: 500 }); // 10300 landed
    const kept = applyConstraints([cheap, overByShipping], target({ maxPriceCents: 10_000 }));
    expect(kept).toEqual([cheap]);
  });

  it('keeps a listing landing exactly at the ceiling', () => {
    const atLimit = raw({ priceCents: 10_000, shippingCents: null });
    expect(applyConstraints([atLimit], target({ maxPriceCents: 10_000 }))).toEqual([atLimit]);
  });

  it('drops confidently-classified condition mismatches', () => {
    const used = raw({ condition: 'Pre-owned' });
    const refurb = raw({ condition: 'Certified - Refurbished' });
    const brandNew = raw({ condition: 'Brand New' });
    const kept = applyConstraints([used, refurb, brandNew], target({ conditions: ['new'] }));
    expect(kept).toEqual([brandNew]);
  });

  it('keeps null and unclassifiable conditions for the rank triage to judge', () => {
    const unknown = raw({ condition: null });
    const openBox = raw({ condition: 'Open box' });
    const kept = applyConstraints([unknown, openBox], target({ conditions: ['new'] }));
    expect(kept).toEqual([unknown, openBox]);
  });

  it('accepts any of several allowed conditions', () => {
    const used = raw({ condition: 'Used' });
    const refurb = raw({ condition: 'Seller refurbished' });
    const kept = applyConstraints([used, refurb], target({ conditions: ['used', 'refurbished'] }));
    expect(kept).toEqual([used, refurb]);
  });

  it('price ceiling applies AFTER deterministic discounts (price-after-coupons)', () => {
    const facts: ProfileFactRow[] = [
      {
        id: 'f1',
        category: 'coupon_source',
        label: 'c',
        value: '10% off ebay',
        active: 1,
        createdAt: '',
        updatedAt: '',
      },
    ];
    const over = { ...raw({ priceCents: 10_500 }), source: 'ebay' };
    expect(applyConstraints([over], target({ maxPriceCents: 10_000 }))).toEqual([]); // undiscounted: over ceiling
    expect(applyConstraints([over], target({ maxPriceCents: 10_000 }), facts)).toEqual([over]); // 9450 after coupon
  });
});
