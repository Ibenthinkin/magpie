// One-time manual login. Run headed via `bun run login` (sets HEADLESS=false).
// Opens the persistent context and parks on a source's sign-in page so the
// owner can log in by hand. The session is written to browser-profile/ as you
// go and persists across restarts. Ctrl-C (or closing the window) when done.
import { getContext, closeContext } from '../src/browser/session';

const START_URL = process.argv[2] ?? 'https://www.ebay.com/signin';

const context = await getContext();
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(START_URL);

console.log(
  `\nMagpie login session open at ${START_URL}.\n` +
    'Log into eBay (and any other sources) by hand — the session saves to\n' +
    'browser-profile/ as you go. Press Ctrl-C here when finished.\n',
);

// Stay alive until the browser closes or Ctrl-C.
await new Promise<void>((resolve) => {
  context.on('close', () => resolve());
  process.on('SIGINT', () => resolve());
});

await closeContext();
console.log('Session closed. browser-profile/ updated.');
