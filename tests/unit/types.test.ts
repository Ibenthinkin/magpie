import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { keepValidRows } from '../../src/sources/types';

describe('keepValidRows', () => {
  let consoleSpy: { warn: ReturnType<typeof vi.spyOn>; log: ReturnType<typeof vi.spyOn> };

  beforeEach(() => {
    consoleSpy = {
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
      log: vi.spyOn(console, 'log').mockImplementation(() => {}),
    };
  });

  afterEach(() => {
    consoleSpy.warn.mockRestore();
    consoleSpy.log.mockRestore();
  });

  it('keeps valid rows unchanged', () => {
    const validRows = [
      {
        title: 'Test Item 1',
        priceCents: 1000,
        shippingCents: 200,
        condition: 'New',
        url: 'https://example.com/item1',
        sellerRating: 99.5,
        location: 'San Jose, CA',
      },
      {
        title: 'Test Item 2',
        priceCents: 2000,
        shippingCents: null,
        condition: null,
        url: null,
        sellerRating: null,
        location: null,
      },
    ];

    const result = keepValidRows(validRows, 'test');

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(validRows[0]);
    expect(result[1]).toEqual(validRows[1]);
    expect(consoleSpy.warn).not.toHaveBeenCalled();
    expect(consoleSpy.log).toHaveBeenCalledWith('[test] kept 2/2 rows');
  });

  it('drops invalid rows and logs warnings', () => {
    const mixedRows = [
      {
        title: 'Valid Item',
        priceCents: 1000,
        shippingCents: 200,
        condition: 'New',
        url: 'https://example.com/item',
        sellerRating: null,
        location: null,
      },
      {
        // Missing required title
        title: null,
        priceCents: 1000,
        shippingCents: 200,
        condition: null,
        url: null,
      },
      {
        // Missing required priceCents
        title: 'Another Item',
        priceCents: null,
        shippingCents: null,
        condition: null,
        url: null,
      },
    ];

    const result = keepValidRows(mixedRows, 'extract');

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Valid Item');
    expect(consoleSpy.warn).toHaveBeenCalledTimes(2);
    expect(consoleSpy.log).toHaveBeenCalledWith('[extract] kept 1/3 rows');
  });

  it('handles empty array', () => {
    const result = keepValidRows([], 'empty');

    expect(result).toHaveLength(0);
    expect(consoleSpy.warn).not.toHaveBeenCalled();
    expect(consoleSpy.log).toHaveBeenCalledWith('[empty] kept 0/0 rows');
  });
});
