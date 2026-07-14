// Typed env loader (SPEC §10). Pure function of an env map — no import-time
// side effects, so tests and tools can load this module without a real .env.

export interface Config {
  discordToken: string;
  discordGuildId: string;
  discordChannelId: string;
  /** Empty array means the allowlist is unset: warn at boot and deny all interactions. */
  allowedUserIds: string[];
  openrouterApiKey: string;
  model: string;
  dbPath: string;
  browserProfileDir: string;
  headless: boolean;
}

type Env = Record<string, string | undefined>;

// Empty string counts as unset — .env stubs ship the keys with empty values.
function get(env: Env, key: string): string | undefined {
  const v = env[key];
  return v === undefined || v === '' ? undefined : v;
}

function require_(env: Env, key: string): string {
  const v = get(env, key);
  if (v === undefined) throw new Error(`Missing required env var: ${key}`);
  return v;
}

export function loadConfig(env: Env = process.env): Config {
  return {
    discordToken: require_(env, 'DISCORD_TOKEN'),
    discordGuildId: require_(env, 'DISCORD_GUILD_ID'),
    discordChannelId: require_(env, 'DISCORD_CHANNEL_ID'),
    allowedUserIds: (get(env, 'DISCORD_ALLOWED_USER_IDS') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    openrouterApiKey: require_(env, 'OPENROUTER_API_KEY'),
    model: require_(env, 'MAGPIE_MODEL'),
    dbPath: get(env, 'MAGPIE_DB_PATH') ?? 'data/magpie.db',
    browserProfileDir: get(env, 'BROWSER_PROFILE_DIR') ?? 'browser-profile',
    headless: get(env, 'HEADLESS') !== 'false',
  };
}
