# Marketplace access — run the logged-out probe before buying anything

**Status:** decision + implementation plan.
**Date:** 2026-07-31
**Parent:** [Magpie Vision](./2026-07-30-magpie-vision-design.md) §6 (Phase 4 remainder); supersedes the premise of [`docs/facebook-marketplace-account.md`](../../facebook-marketplace-account.md).

---

## 1. What prompted this

A research pass evaluated seven external tools — three Facebook MCP servers, `secondhand-mcp`, `facebook-marketplace-mcp`, and Bright Data — for whether any of them unblocks **Facebook Marketplace** (Magpie's one outstanding Phase 4 source) or cheapens the Phase 7 source catalog.

### 1.1 Tool evaluation

| Tool | What it actually is | Verdict |
|---|---|---|
| `gomarble-ai/facebook-ads-mcp-server` | Marketing API — campaigns, ad sets, insights. 348★, MIT, healthy. | **Not relevant.** Wrong Facebook product; no listing surface. |
| `HagaiHen/facebook-mcp-server` | Graph API Page management — posts, comments, DMs. 198★, MIT, maintained. | **Not relevant.** Page management, not Marketplace. |
| `Livia-Zaharia/just_facebook_mcp` | Repackaging of the above for PyPI. 9★, stale, issues disabled, behind upstream. | **Not relevant**, and strictly worse than its own upstream. |
| `jdcodes1/facebook-marketplace-mcp` | Extracts live session cookies from Chrome's macOS Keychain, replays Facebook's internal GraphQL API as the real account. 53★, 4 commits over 2 days, no license, no tests, core extraction broken per its own open issue. | **Rejected — worse than what was already rejected.** Authenticates as the real account; raw GraphQL replay outside a browser is more fingerprintable, not less. macOS-only, so a homelab platform mismatch too. |
| `jlsookiki/secondhand-mcp` | MCP server over eBay (official Browse API), Facebook Marketplace (unauthenticated fetch), Depop + Poshmark (Puppeteer + stealth plugin). 37★, MIT, TS. | **Reading reference only, never a dependency.** No Mercari, no Vinted, so it does not advance the catalog thesis. Its Facebook implementation informs §2; its `depop.ts` is a seed for Phase 7/9. |
| Bright Data | Web Scraper API with genuine Marketplace **keyword discovery** (`dataset_id=gd_lvt9iwuh6fbcwmx1a`). | **Deferred candidate** — see §4. |

### 1.2 Corrections to the first research pass

- The `$250 minimum / $0.0025 per record` figure is the bulk **Datasets** product; the `$1.50/1k` figure is **Web Unlocker**. Neither is how the Marketplace scraper bills.
- The right product is the **Web Scraper API**: **$1.50 per 1,000 records**, **5,000 free records/month**, **no minimum commitment**, prepaid wallet with a hard stop.
- Bright Data's **MCP server is URL-only** — it exposes no keyword search. The MCP path is a trap; only the raw API does discovery.
- Delivery is async trigger + **poll** (webhooks optional), so the **outbound-only invariant survives**.
- *Meta Platforms v. Bright Data*, N.D. Cal. 3:23-cv-00077, Judge Chen, **23 Jan 2024**: Meta's Terms cannot be construed to bind logged-off visitors scraping public data, and the survival clause was unenforceable as applied. Meta dismissed the remaining claim ~Feb 2024 and **waived appeal**. This is a contract holding on logged-out public data — not a general license, and it does not reach CFAA, copyright, or privacy claims.

### 1.3 The thing the research missed

**`docs/facebook-marketplace-account.md` §1.1's logged-out test was never run.** `log.md` (07-31-26) records it as still first in line and able to "moot everything." Three pieces of evidence now bear on it: `secondhand-mcp` reaches Marketplace over plain unauthenticated fetch; Bright Data's entire compliance posture is logged-out-public-only; and **Ben has no Facebook account to lose**.

That matters because of a decisive asymmetry, confirmed against the code:

| | Logged-out browser adapter | Bright Data HTTP adapter |
|---|---|---|
| Engine changes | **None** — a `craigslist.ts` clone | `search()` must accept a `Page` it ignores; `hunt.ts:66` launches Chrome regardless; `hunt.ts:93-95` fires the vision fallback on a never-navigated blank tab and bills for it |
| Cost | $0 | metered — and `llm.ts` exports **no non-LLM cost sink**, so vendor spend cannot reach `hunt.cost_cents` or the Phase 5 budget guard |
| Ban surface | No account exists to action; worst case is IP rate-limiting | None to Ben |

**Intended outcome:** spend one hour establishing whether the free, zero-dependency path works before committing to a paid vendor.

---

## 2. Step 1 — the logged-out probe (do this first)

**New file: `scripts/smoke-marketplace.ts`**, following the existing `scripts/smoke-*.ts` convention (`smoke-browser.ts` is the closest template).

Use a **throwaway `chromium.launch()`**, never `launchPersistentContext` / `src/browser/session.ts`. The persistent profile is the crown jewel holding real logged-in sessions; pointing it at a source likely to trip Meta's WAF risks fingerprint contamination for no benefit — there is no Facebook session to preserve. `tests/bun/e2e/*.test.ts` already establish the throwaway-browser pattern.

Logged out, the script should:

1. Navigate to a Marketplace search URL for a real query and region.
2. Print: final URL after redirects (did it bounce to `/login`?), HTTP status, whether result cards rendered, a plausible listing count, and reduced-text length.
3. Save the screenshot and reduced page text to a **gitignored local path** — never to Discord.
4. Exit non-zero on a login wall or checkpoint, so the outcome is unambiguous.

**Do not guess the URL pattern — observe it.** The vision doc §3.1's "observed, not guessed" rule applies exactly here. Read `secondhand-mcp`'s Facebook implementation first (MIT, so reading and reimplementing is clean), then confirm live.

**Run it ~5 times over ~3 days at human pacing.** The question is not only "does one request work" but "does a single residential IP survive a realistic cadence" — Bright Data succeeds here partly via residential proxy rotation and CAPTCHA solving, which Magpie will not have.

**Pass criteria:** results render logged out, a usable listing count is present, no login wall, no CAPTCHA, stable across runs.

Record the outcome in `log.md` either way — a negative result closes a question open since Phase 4.

---

## 3. Step 2a — if the probe passes: `src/sources/facebook.ts`

A near-copy of `src/sources/craigslist.ts`, the correct template (no login, deterministic URL, reduced page text, LLM extracts).

- **`buildSearchUrl(target, location)`** — pure, unit-tested alongside the existing eBay/Craigslist cases in `tests/unit/sources.test.ts`. Marketplace is geographically sharded like Craigslist, so mirror `makeCraigslistAdapter(region?)` with `makeFacebookAdapter(location?)` and a `FACEBOOK_MARKETPLACE_LOCATION` env fallback — following Craigslist's precedent of **throwing rather than guessing** when unset. Map `maxPriceCents` and location radius onto whatever params the probe actually observed.
- **`search(page, target)`** — the same four-line shape as `craigslist.ts:164-167`: fetch reduced results text, hand it to `extractListings`. No engine change; extraction already lives inside adapters.
- **`toListing(raw)`** — pure normalization. Must emit stable unique URLs: `hunt.ts:133` joins ranked rows back to listings by URL.
- **Challenge detection** — throw `ChallengeDetectedError` (`src/browser/pacing.ts:15`) on a login wall or checkpoint, mirroring `ebay.ts:110`. This buys the existing 60-minute cooldown for free and satisfies CLAUDE.md's requirement that Marketplace be wired into challenge detection *before* the first real run.
- **`rateLimit`** — deliberately stricter than eBay's and Craigslist's.

**Registration** (three mechanical edits; the exhaustive `Record` types make the compiler name every site):
- widen `SourceId` in `src/sources/types.ts:9`
- add entries to `registry` and `LABELS` in `src/sources/registry.ts`
- **leave it out of `DEFAULT_SOURCES`** — opt-in via `sources:facebook`, exactly as Craigslist is today. It earns the default set only after real runs.

No DB migration: `listing.source` is a plain text column.

**Tests:** pure `buildSearchUrl`/`toListing` cases in `tests/unit/sources.test.ts`, plus `tests/fixtures/facebook/results.html` and an `empty/` variant served by `tests/helpers/static-server.ts`, with an e2e test mirroring `tests/bun/e2e/craigslist-fetch.test.ts`.

Then **rewrite `docs/facebook-marketplace-account.md`** — it is premised on needing an account, and a passing probe moots it. Replace with a short note on the logged-out adapter and its real residual risk (IP rate limiting, not account loss).

---

## 4. Step 2b — if the probe fails: Bright Data, gated behind Phase 5

Do **not** wire this before Phase 5 lands. Vision doc §5 says the budget guard ships "deliberately before anything expensive," and `llm.ts` offers no way for a per-request vendor charge to reach the ledger — adopting a metered API now would put spend outside the meter Phase 5 exists to build.

Prerequisites to fold into Phase 5:
- Export a non-LLM cost seam from `src/engine/llm.ts` (the usage bucket and `account()` are module-private). Since `hunt.ts` already brackets the run in `withUsage`, a vendor charge then lands on `hunt.cost_cents` automatically.
- Widen `SpendRecord.model` — currently a required `string`; it must accept a vendor name or become nullable.

When built:
- **Web Scraper API, keyword discovery, async `/trigger` + poll `/progress` → `GET /snapshot`.** Never webhooks — polling preserves outbound-only.
- **Set `limit_per_input` explicitly on every call.** The uncapped default is undocumented and is the one thing that could turn a $0 month into $80.
- **`status: ready` does not mean listings arrived** — Bright Data returns empty snapshots containing errors on failure. Treat as a source failure, not an empty result.
- Add a `kind: 'browser' | 'http'` discriminant to `SourceAdapter` so `hunt.ts` can skip `getPage()` and suppress the vision fallback for non-browser sources.
- Standing structural risk: if Meta closes logged-out Marketplace search, keyword discovery breaks first, and Bright Data's compliance posture forbids the logged-in workaround. The vendor is not insulation against that.

---

## 5. Verification

1. `bun run scripts/smoke-marketplace.ts` — prints a clear verdict, exits non-zero on a wall. Re-run across ~3 days; confirm the verdict is stable.
2. If §3: `bun run test` (unit), `bun run test:e2e` (fixture-backed adapter), `bun run typecheck` to confirm the `SourceId` widening is complete everywhere.
3. One real opt-in hunt — `/hunt query:<something local> sources:facebook` — confirming listings extract, rank, and render, and that a forced login wall surfaces as a loud single-source failure rather than a silent empty result.
4. Confirm no vendor spend exists outside the ledger (trivially true on the §3 path).

---

## 6. Decisions

- **Adopt no MCP server and create no vendor account** as part of this plan.
- **Run the free probe before paying for anything** — it may moot the vendor question entirely, and it was already first in line in the go/no-go guide.
- **If a vendor is needed, it waits for Phase 5**, so its spend is visible to the budget guard rather than invisible beside it.
