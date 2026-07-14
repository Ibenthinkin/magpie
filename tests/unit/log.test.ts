import { describe, expect, test } from 'vitest';
import { formatLine } from '../../src/log';

describe('formatLine', () => {
  test('renders step and fields as one scannable line', () => {
    expect(formatLine('hunt.claim', { id: 'abc', mode: 'oneshot' })).toBe(
      '[hunt.claim] id=abc mode=oneshot',
    );
  });

  test('renders a bare step with no fields', () => {
    expect(formatLine('worker.idle')).toBe('[worker.idle]');
  });

  test('stringifies non-string values and quotes values with spaces', () => {
    expect(formatLine('hunt.done', { costCents: 12, query: 'mx master 3s' })).toBe(
      '[hunt.done] costCents=12 query="mx master 3s"',
    );
  });
});
