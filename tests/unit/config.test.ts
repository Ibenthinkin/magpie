import { describe, expect, test } from 'vitest';
import { loadConfig } from '../../src/config';

const fullEnv = {
  DISCORD_TOKEN: 'tok',
  DISCORD_GUILD_ID: 'guild1',
  DISCORD_CHANNEL_ID: 'chan1',
  DISCORD_ALLOWED_USER_IDS: '111, 222,333',
  OPENROUTER_API_KEY: 'sk-or-abc',
  MAGPIE_MODEL: 'some/model',
  MAGPIE_DB_PATH: '/tmp/x.db',
  BROWSER_PROFILE_DIR: '/tmp/profile',
  HEADLESS: 'false',
};

describe('loadConfig', () => {
  test('parses a fully-populated env', () => {
    const c = loadConfig(fullEnv);
    expect(c).toEqual({
      discordToken: 'tok',
      discordGuildId: 'guild1',
      discordChannelId: 'chan1',
      allowedUserIds: ['111', '222', '333'],
      openrouterApiKey: 'sk-or-abc',
      model: 'some/model',
      dbPath: '/tmp/x.db',
      browserProfileDir: '/tmp/profile',
      headless: false,
    });
  });

  test('missing required var throws naming the var', () => {
    const { OPENROUTER_API_KEY: _drop, ...env } = fullEnv;
    expect(() => loadConfig(env)).toThrow(/OPENROUTER_API_KEY/);
  });

  test('empty string counts as unset for required vars', () => {
    expect(() => loadConfig({ ...fullEnv, DISCORD_TOKEN: '' })).toThrow(/DISCORD_TOKEN/);
  });

  test('optional vars fall back to defaults', () => {
    const { MAGPIE_DB_PATH: _a, BROWSER_PROFILE_DIR: _b, HEADLESS: _c, ...env } = fullEnv;
    const c = loadConfig(env);
    expect(c.dbPath).toBe('data/magpie.db');
    expect(c.browserProfileDir).toBe('browser-profile');
    expect(c.headless).toBe(true);
  });

  test('empty or missing allowlist parses to [] (deny-all)', () => {
    expect(loadConfig({ ...fullEnv, DISCORD_ALLOWED_USER_IDS: '' }).allowedUserIds).toEqual([]);
    const { DISCORD_ALLOWED_USER_IDS: _drop, ...env } = fullEnv;
    expect(loadConfig(env).allowedUserIds).toEqual([]);
  });

  test('allowlist drops empty segments from sloppy csv', () => {
    const c = loadConfig({ ...fullEnv, DISCORD_ALLOWED_USER_IDS: ' 111,, 222 ,' });
    expect(c.allowedUserIds).toEqual(['111', '222']);
  });
});
