import { describe, expect, test } from 'bun:test';
import { makeHuntsRepo } from '../../../src/db/hunts';
import { openTestDb } from '../helpers/db';

const target = JSON.stringify({ description: 'x', constraints: {} });

function repoWithDb(now?: () => string) {
  const db = openTestDb();
  return makeHuntsRepo(db, now);
}

function enqueue(repo: ReturnType<typeof makeHuntsRepo>, query = 'q') {
  return repo.enqueueHunt({ mode: 'oneshot', query, targetJson: target, channelId: 'chan' });
}

describe('hunt queue', () => {
  test('claims pending hunts FIFO by arrival', () => {
    const repo = repoWithDb();
    enqueue(repo, 'first');
    enqueue(repo, 'second');
    expect(repo.claimNextHunt()?.query).toBe('first');
    expect(repo.claimNextHunt()?.query).toBe('second');
    expect(repo.claimNextHunt()).toBeNull();
  });

  test('claim marks the row running with started_at', () => {
    const repo = repoWithDb(() => '2026-07-14T09:00:00.000Z');
    enqueue(repo);
    const claimed = repo.claimNextHunt();
    expect(claimed?.status).toBe('running');
    expect(claimed?.startedAt).toBe('2026-07-14T09:00:00.000Z');
  });

  test('one pending hunt, many concurrent claims: exactly one winner', async () => {
    const repo = repoWithDb();
    enqueue(repo);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => Promise.resolve().then(() => repo.claimNextHunt())),
    );
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  test('completeHunt marks done and accumulates cost onto the initial parse cost', () => {
    const repo = repoWithDb();
    const hunt = repo.enqueueHunt({
      mode: 'oneshot',
      query: 'q',
      targetJson: target,
      channelId: 'chan',
      initialCostCents: 5,
    });
    repo.claimNextHunt();
    repo.completeHunt(hunt.id, { addCostCents: 7 });
    const row = repo.getHunt(hunt.id);
    expect(row?.status).toBe('done');
    expect(row?.costCents).toBe(12);
    expect(row?.finishedAt).not.toBeNull();
  });

  test('failHunt records the error and still accumulates cost', () => {
    const repo = repoWithDb();
    const hunt = enqueue(repo);
    repo.claimNextHunt();
    repo.failHunt(hunt.id, 'ebay served a bot challenge', { addCostCents: 3 });
    const row = repo.getHunt(hunt.id);
    expect(row?.status).toBe('failed');
    expect(row?.error).toBe('ebay served a bot challenge');
    expect(row?.costCents).toBe(3);
  });

  test('resetStaleRunning returns running hunts to pending, leaves finished ones alone', () => {
    const repo = repoWithDb();
    const stale = enqueue(repo, 'stale');
    const finished = enqueue(repo, 'finished');
    repo.claimNextHunt(); // stale → running (orphaned)
    repo.claimNextHunt();
    repo.completeHunt(finished.id, { addCostCents: 0 });

    expect(repo.resetStaleRunning()).toBe(1);
    expect(repo.getHunt(stale.id)?.status).toBe('pending');
    expect(repo.getHunt(stale.id)?.startedAt).toBeNull();
    expect(repo.getHunt(finished.id)?.status).toBe('done');
    // and the reset hunt is claimable again
    expect(repo.claimNextHunt()?.id).toBe(stale.id);
  });
});
