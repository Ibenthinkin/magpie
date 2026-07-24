import { afterEach, describe, expect, it } from 'vitest';
import type { ProfileFactRow } from '../../src/db/types';
import { setGenerateForTests } from '../../src/engine/llm';
import { discountCents, landedCost, rankListings } from '../../src/engine/rank';
import type { RawListing } from '../../src/sources/types';

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

// --- rankListings with facts (LLM seamed) ----------------------------------

afterEach(() => setGenerateForTests(null));

/** Same seam shape as hunt.test.ts: everything matches, verdict per index. */
function fakeRank(captured?: { prompts: string[]; systems: string[] }) {
  setGenerateForTests(({ label, prompt, system }) => {
    captured?.prompts.push(prompt);
    captured?.systems.push(system ?? '');
    const idx = [...prompt.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
    const usage = { inputTokens: 100, outputTokens: 20 };
    if (label === 'rankMatch') {
      return { object: { matches: idx.map((index) => ({ index, matchesTarget: true })) }, usage, costUsd: 0.01 };
    }
    if (label === 'rankVerdicts') {
      return { object: { verdicts: idx.map((index) => ({ index, verdict: `v${index}` })) }, usage, costUsd: 0.01 };
    }
    throw new Error(`unexpected llm call: ${label}`);
  });
}

const listing = (title: string, priceCents: number, source = 'ebay'): RawListing & { source?: string } => ({
  title,
  priceCents,
  shippingCents: null,
  condition: 'New',
  url: `https://example.com/${title}`,
  source,
});

describe('rankListings with profile facts', () => {
  const target = { description: 'widget', constraints: {} };

  it('sorts by DISCOUNTED landed cost and reports discountCents', async () => {
    fakeRank();
    // B is cheaper only after its 10% ebay coupon: A (amazon) = 1000, B (ebay) = 1050 → 945.
    const ranked = await rankListings([listing('A', 1000, 'amazon'), listing('B', 1050)], target, [fact()]);
    expect(ranked.map((r) => r.title)).toEqual(['B', 'A']);
    expect(ranked[0]!.landedCents).toBe(945);
    expect(ranked[0]!.discountCents).toBe(105);
    expect(ranked[1]!.discountCents).toBe(0);
  });

  it('facts appear in both prompts; discounted lines are annotated', async () => {
    const captured = { prompts: [] as string[], systems: [] as string[] };
    fakeRank(captured);
    await rankListings([listing('A', 1000)], target, [fact()]);
    expect(captured.prompts).toHaveLength(2);
    for (const p of captured.prompts) {
      expect(p).toContain('Shopper profile facts:');
      expect(p).toContain('[coupon_source] eBay coupon: 10% off ebay');
      expect(p).toContain('membership/coupon discount');
    }
  });

  it('no facts: prompts carry no facts block and discountCents is 0', async () => {
    const captured = { prompts: [] as string[], systems: [] as string[] };
    fakeRank(captured);
    const ranked = await rankListings([listing('A', 1000)], target);
    expect(ranked[0]!.discountCents).toBe(0);
    expect(captured.prompts.every((p) => !p.includes('Shopper profile facts'))).toBe(true);
  });
});

describe('rankListings — item location', () => {
  it('shows each listing location and states the requested area, so the model can judge distance', async () => {
    const captured = { prompts: [] as string[], systems: [] as string[] };
    fakeRank(captured);
    await rankListings([{ ...listing('A', 1000), location: 'San Jose, CA' }], {
      description: 'desk',
      constraints: { location: { near: 'Oakland, CA', maxMiles: 20 } },
    });
    for (const p of captured.prompts) {
      expect(p).toContain('San Jose, CA');
      expect(p).toContain('Oakland, CA'); // the constraint itself reaches the prompt
    }
    expect(captured.systems.some((s) => /location/i.test(s))).toBe(true);
  });

  it('omits the field when the source gave no location', async () => {
    const captured = { prompts: [] as string[], systems: [] as string[] };
    fakeRank(captured);
    await rankListings([listing('A', 1000)], { description: 'desk', constraints: {} });
    for (const p of captured.prompts) expect(p).not.toContain('location:');
  });
});

describe('rankListings — seller rating', () => {
  const target = { description: 'widget', constraints: {} };

  it('shows the seller rating on the listing line and licenses the verdict to cite it', async () => {
    const captured = { prompts: [] as string[], systems: [] as string[] };
    fakeRank(captured);
    await rankListings([{ ...listing('A', 1000), sellerRating: 99.4 }], target);
    for (const p of captured.prompts) expect(p).toContain('seller: 99.4%');
    expect(captured.systems.some((s) => /seller rating/i.test(s))).toBe(true);
  });

  it('omits the field entirely when no rating was extracted', async () => {
    const captured = { prompts: [] as string[], systems: [] as string[] };
    fakeRank(captured);
    await rankListings([listing('A', 1000), { ...listing('B', 2000), sellerRating: null }], target);
    for (const p of captured.prompts) expect(p).not.toContain('seller:');
  });
});
