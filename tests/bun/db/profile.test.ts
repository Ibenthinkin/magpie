import { describe, expect, test } from 'bun:test';
import { makeProfileRepo } from '../../../src/db/profile';
import { openTestDb } from '../helpers/db';

describe('profile repo', () => {
  test('addFact returns the stored row with id + timestamps', () => {
    const repo = makeProfileRepo(openTestDb(), () => '2026-07-19T00:00:00.000Z');
    const fact = repo.addFact({ category: 'membership', label: 'warehouse club', value: 'active' });
    expect(fact.id).toBeTruthy();
    expect(fact.category).toBe('membership');
    expect(fact.active).toBe(1);
    expect(fact.createdAt).toBe('2026-07-19T00:00:00.000Z');
    expect(repo.getFact(fact.id)).toEqual(fact);
  });

  test('activeFacts returns only active facts, insertion order', () => {
    const repo = makeProfileRepo(openTestDb());
    const a = repo.addFact({ category: 'membership', label: 'a', value: '1' });
    repo.addFact({ category: 'spec', label: 'b', value: '2' });
    repo.removeFact(a.id);
    expect(repo.activeFacts().map((f) => f.label)).toEqual(['b']);
    expect(repo.getFact(a.id)?.active).toBe(0); // row survives removal
  });

  test('removeFact on an unknown id is a no-op', () => {
    const repo = makeProfileRepo(openTestDb());
    repo.removeFact('nope');
    expect(repo.activeFacts()).toEqual([]);
  });
});
