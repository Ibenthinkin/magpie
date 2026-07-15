// Hub conventions (SPEC §7.3): channel binding, allowlist guard, agent
// identity. Factored here so a second agent can reuse the shell in Phase 5 —
// but deliberately ONE file, not a framework, until that second tenant exists.

export interface HubConfig {
  /** Agent identity, e.g. "Magpie". */
  name: string;
  /** The one channel this agent responds in (SPEC §3.5). */
  channelId: string;
  /** Empty = allowlist unset: warn at boot, deny all (never fail open). */
  allowedUserIds: string[];
}

export type HubDenial = 'wrong_channel' | 'user_not_allowed';

export interface Hub {
  name: string;
  channelId: string;
  allowlistEmpty: boolean;
  /** null = allowed; otherwise why the interaction must be ignored. */
  permits(i: { channelId: string | null; userId: string }): HubDenial | null;
}

export function makeHub(cfg: HubConfig): Hub {
  const allowed = new Set(cfg.allowedUserIds);
  return {
    name: cfg.name,
    channelId: cfg.channelId,
    allowlistEmpty: allowed.size === 0,
    permits(i) {
      if (i.channelId !== cfg.channelId) return 'wrong_channel';
      if (!allowed.has(i.userId)) return 'user_not_allowed';
      return null;
    },
  };
}
