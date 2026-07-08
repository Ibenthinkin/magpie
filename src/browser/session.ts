import { chromium, type BrowserContext } from 'playwright';

// Read an env var, treating an empty string (a var present-but-blank in .env,
// e.g. copied straight from .env.example) the same as unset.
function env(key: string, fallback: string): string {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

// Crown-jewel profile: holds live logged-in sessions. Gitignored, mode 700,
// never leaves the host. One persistent context, serialized use (worker
// concurrency 1 makes that safe). See SPEC §6.1.
const PROFILE_DIR = env('BROWSER_PROFILE_DIR', 'browser-profile');
const HEADLESS = env('HEADLESS', 'true') !== 'false';

// A real desktop Chrome UA. Playwright's bundled Chromium otherwise advertises
// "HeadlessChrome", an obvious bot tell. Keep this tracking a current stable
// Chrome release.
const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

let context: BrowserContext | null = null;

export async function getContext(): Promise<BrowserContext> {
  if (context) return context;
  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: HEADLESS,
    viewport: { width: 1440, height: 900 },
    userAgent: CHROME_UA,
  });
  return context;
}

export async function closeContext(): Promise<void> {
  if (!context) return;
  await context.close();
  context = null;
}
