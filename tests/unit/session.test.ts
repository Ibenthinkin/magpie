import { describe, expect, it } from 'vitest';
import { resolveLaunchOptions } from '../../src/browser/session';

// Pure env -> launch-options mapping (SPEC §10 BROWSER_CHANNEL knob). No real
// Playwright launch involved.

describe('resolveLaunchOptions', () => {
  it('defaults to headless bundled Chromium with no channel key', () => {
    const options = resolveLaunchOptions({});
    expect(options.headless).toBe(true);
    expect(options).not.toHaveProperty('channel');
  });

  it('sets channel when BROWSER_CHANNEL is non-empty', () => {
    const options = resolveLaunchOptions({ BROWSER_CHANNEL: 'chrome' });
    expect(options.channel).toBe('chrome');
  });

  it('treats an empty-string BROWSER_CHANNEL as unset', () => {
    const options = resolveLaunchOptions({ BROWSER_CHANNEL: '' });
    expect(options).not.toHaveProperty('channel');
  });

  it('respects HEADLESS=false', () => {
    const options = resolveLaunchOptions({ HEADLESS: 'false' });
    expect(options.headless).toBe(false);
  });

  it('keeps the userAgent constant regardless of env', () => {
    const defaults = resolveLaunchOptions({});
    const withChannel = resolveLaunchOptions({ BROWSER_CHANNEL: 'chrome' });
    expect(defaults.userAgent).toBe(withChannel.userAgent);
    expect(defaults.userAgent).toContain('Chrome/');
  });
});
