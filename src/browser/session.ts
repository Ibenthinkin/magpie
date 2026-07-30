import { chromium, type BrowserContext } from 'playwright';

// Read an env var from a given source (default process.env), treating an
// empty string (a var present-but-blank in .env, e.g. copied straight from
// .env.example) the same as unset.
function readVar(source: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const v = source[key];
  return v === undefined || v === '' ? fallback : v;
}

// Crown-jewel profile: holds live logged-in sessions. Gitignored, mode 700,
// never leaves the host. One persistent context, serialized use (worker
// concurrency 1 makes that safe). See SPEC §6.1.
const PROFILE_DIR = readVar(process.env, 'BROWSER_PROFILE_DIR', 'browser-profile');

// A real desktop Chrome UA. Playwright's bundled Chromium otherwise advertises
// "HeadlessChrome", an obvious bot tell. Keep this tracking a current stable
// Chrome release.
const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

export interface LaunchOptions {
  headless: boolean;
  viewport: { width: number; height: number };
  userAgent: string;
  channel?: string;
}

// Pure env -> launch-options mapping, kept separate from getContext() so it's
// testable without a real Playwright launch.
//
// HEADLESS defaults true. Headed mode (HEADLESS=false) inside a container
// needs `xvfb-run` (or a running Xvfb + a DISPLAY env var) wrapping the
// process — there's no real display otherwise. That's deferred to future
// Docker/deployment work (no Dockerfile/docker-compose.yml exist yet).
//
// BROWSER_CHANNEL is optional: unset means bundled Chromium (today's
// behavior, no `channel` key at all); set (e.g. `chrome`) uses a real Chrome
// install instead, which may reduce fingerprinting — untested, Ben's call via
// scripts/smoke-browser.ts.
export function resolveLaunchOptions(env: NodeJS.ProcessEnv = process.env): LaunchOptions {
  const headless = readVar(env, 'HEADLESS', 'true') !== 'false';
  const channel = readVar(env, 'BROWSER_CHANNEL', '');

  const options: LaunchOptions = {
    headless,
    viewport: { width: 1440, height: 900 },
    userAgent: CHROME_UA,
  };
  if (channel) options.channel = channel;
  return options;
}

let context: BrowserContext | null = null;

export async function getContext(): Promise<BrowserContext> {
  if (context) return context;
  context = await chromium.launchPersistentContext(PROFILE_DIR, resolveLaunchOptions());
  return context;
}

export async function closeContext(): Promise<void> {
  if (!context) return;
  await context.close();
  context = null;
}
