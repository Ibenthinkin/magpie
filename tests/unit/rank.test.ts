import { describe, expect, it } from 'vitest';
import type { ProfileFactRow } from '../../src/db/types';
import { discountCents, landedCost } from '../../src/engine/rank';

const fact = (over: Partial<ProfileFactRow> = {}): ProfileFactRow => ({
  id: 'f1',
  category: 'coupon_source',
  label: 'eBay coupon',
  value: '10% off ebay',
  active: 1,
  createdAt: '2026-07-19T00:00:00.000Z',
  updatedAt: '2026-07-19T00:00:00.000Z',
  ...over,
});

describe('landedCost + discountCents (deterministic best-deal math)', () => {
  const l = { priceCents: 10_000, shippingCents: 500, source: 'ebay' };

  it('no facts: price + shipping, null shipping = 0', () => {
    expect(landedCost(l)).toBe(10_500);
    expect(landedCost({ priceCents: 1000, shippingCents: null })).toBe(1000);
  });

  it('percent-off fact naming the source discounts the item price', () => {
    expect(discountCents(l, [fact()])).toBe(1000); // 10% of price, not landed
    expect(landedCost(l, [fact()])).toBe(9_500);
  });

  it('$N-off fact naming the source subtracts flat cents', () => {
    expect(landedCost(l, [fact({ value: '$5 off ebay orders' })])).toBe(10_000);
  });

  it('percent wins when a fact contains both patterns', () => {
    expect(discountCents(l, [fact({ value: '10% off or $2 off ebay' })])).toBe(1000);
  });

  it('facts that do not name the listing source never apply', () => {
    expect(landedCost(l, [fact({ label: 'Costco coupon', value: '10% off at costco' })])).toBe(10_500);
    expect(landedCost({ ...l, source: undefined }, [fact()])).toBe(10_500);
  });

  it('source match may come from the label', () => {
    expect(landedCost(l, [fact({ label: 'ebay bucks', value: '10% off everything' })])).toBe(9_500);
  });

  it('spec facts never discount, even when they name the source', () => {
    expect(landedCost(l, [fact({ category: 'spec' })])).toBe(10_500);
  });

  it('applicable facts stack and landed cost clamps at zero', () => {
    expect(landedCost(l, [fact(), fact({ id: 'f2', value: '$5 off ebay' })])).toBe(9_000);
    expect(landedCost({ priceCents: 100, shippingCents: null, source: 'ebay' }, [fact({ value: '$50 off ebay' })])).toBe(0);
  });

  it('unparseable membership facts contribute nothing deterministically', () => {
    expect(landedCost(l, [fact({ category: 'membership', value: 'ebay plus member, free shipping perks' })])).toBe(10_500);
  });

  it('source matching is case-insensitive', () => {
    expect(landedCost(l, [fact({ value: '10% off eBay' })])).toBe(9_500);
  });
});
