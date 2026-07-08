// Throwaway smoke check: proves the persistent context launches on this host,
// loads a real page, and reports its (non-Headless) UA. Runs headless.
import { getContext, closeContext } from '../src/browser/session';

const context = await getContext();
const page = context.pages()[0] ?? (await context.newPage());

const ua = await page.evaluate(() => navigator.userAgent);
await page.goto('https://www.ebay.com', { waitUntil: 'domcontentloaded' });
const title = await page.title();

console.log('UA:   ', ua);
console.log('URL:  ', page.url());
console.log('Title:', title);
console.log('Headless tell present:', /headless/i.test(ua));

await closeContext();
