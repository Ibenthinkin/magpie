import { describe, expect, it } from 'vitest';
import { makeHub } from '../../src/discord/hub';

// SPEC §3.5 / §7.3: respond only in the bound channel and only to allowlisted
// user ids; everything else is ignored. Empty allowlist = deny ALL (warn at
// boot) — never open.

const cfg = { name: 'Magpie', channelId: 'chan-1', allowedUserIds: ['user-1', 'user-2'] };

describe('makeHub().permits', () => {
  it('allows an allowlisted user in the bound channel', () => {
    expect(makeHub(cfg).permits({ channelId: 'chan-1', userId: 'user-1' })).toBeNull();
  });

  it('denies any other channel', () => {
    expect(makeHub(cfg).permits({ channelId: 'chan-2', userId: 'user-1' })).toBe('wrong_channel');
  });

  it('denies a null channel (DMs)', () => {
    expect(makeHub(cfg).permits({ channelId: null, userId: 'user-1' })).toBe('wrong_channel');
  });

  it('denies a non-allowlisted user even in the bound channel', () => {
    expect(makeHub(cfg).permits({ channelId: 'chan-1', userId: 'intruder' })).toBe('user_not_allowed');
  });

  it('empty allowlist denies everyone and is flagged for the boot warning', () => {
    const hub = makeHub({ ...cfg, allowedUserIds: [] });
    expect(hub.allowlistEmpty).toBe(true);
    expect(hub.permits({ channelId: 'chan-1', userId: 'user-1' })).toBe('user_not_allowed');
  });

  it('carries the agent identity', () => {
    expect(makeHub(cfg).name).toBe('Magpie');
  });
});
