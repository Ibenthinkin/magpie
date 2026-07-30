import type { Page } from 'playwright';
import { log } from '../log';
import type { RawListing } from '../sources/types';
import { extractListingsFromImage } from './visionExtract';
import type { TargetSpec } from './target';

// Vision fallback orchestration (Task 5): screenshots the live page and hands
// it to extractListingsFromImage() when the deterministic text/DOM path can't
// be trusted (e.g. a pacing challenge was detected). No Discord dependency —
// the screenshot buffer is in-memory only and must never reach a Discord-
// facing code path or disk.

export type VisionFallback = (page: Page, source: string, target: TargetSpec) => Promise<RawListing[]>;

export async function runVisionFallback(page: Page, source: string, target: TargetSpec): Promise<RawListing[]> {
  const screenshot = await page.screenshot({ type: 'jpeg', quality: 70 });
  // page.$$eval is Playwright's DOM-query API (query selector + map), not the
  // JS eval() builtin — it runs a serialized callback inside the browser page
  // context to collect anchor data, no code execution in the Node process.
  const anchors = await page.$$eval('a[href]', (els) =>
    els.map((el) => ({ href: (el as HTMLAnchorElement).href, text: el.textContent?.trim() ?? '' })),
  );

  log('hunt.visionFallback', { source, anchors: anchors.length });

  return extractListingsFromImage({ data: screenshot, mediaType: 'image/jpeg' }, anchors, target);
}
