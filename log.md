# Magpie — Project Log

Narrative record of decisions, findings, and dead-ends that don't live in commit
messages. `/brief` reads this. Newest on top.

## 2026-07

### [[07-31-26 Fri]] — Facebook Marketplace: the burner-account plan is wrong, manual-in-the-loop is right

Follow-up conversation on `docs/facebook-marketplace-account.md`. Ben's position: Marketplace is where
the good local stuff is, but he doesn't want a Facebook account — Firefox Facebook Container, AdGuard,
every tracking guard that survives daily use. Question was whether a **real** account with his real
number and email, browser-only and never the mobile apps, is an acceptable trade.

**Findings — three corrections to the guide's threat model.**
- **Magpie's Chrome profile is outside all of that hardening.** `launchPersistentContext` runs a stock
  Chrome with no container and no blockers, logging into Facebook and doing nothing but Marketplace
  searches. It's simultaneously the most exposed and the most fingerprintable surface, and none of the
  daily-driver protections reach it. This wasn't in the doc at all.
- **Instagram already settled the identity question.** Meta has the phone, email and device graph; a
  Facebook account adds a *behavior stream*, not an identity — and the stream is purchase intent, the
  most commercially valuable category there is. The off-platform surface (pixel/business tools, which
  profile non-users too) barely moves, and the container + blockers already blunt it.
- **The doc's §1.4 was written against a wrong premise.** It assumed a real Facebook account with a
  social graph to lose. There isn't one. But real-phone-real-email links the new account to
  **Instagram**, Meta enforces across linked properties, and automated scraping is a terms violation —
  so the account actually at risk is the one Ben uses.

**Decision.** The privacy question and the ban question pull opposite ways: a real account is the better
*privacy* posture (a plausible person survives where an empty burner gets ID-checkpointed) but the worse
thing to lose. **Manual-in-the-loop resolves both** — Magpie composes and posts the Marketplace search
URL to Discord, Ben clicks it. Real account, browser-only, no automation violation, Instagram never
exposed. Cost is ranking and dedup on that one source. The guide ranked this third; on the corrected
premise it's first, and the dedicated-burner path is effectively dead.

Unchanged: the §1.1 logged-out test still comes first and may moot everything, and §1.5 new-account
Marketplace gating applies no matter how real the credentials are.

**Open / next:** rewrite `docs/facebook-marketplace-account.md` around real-account + manual-in-the-loop
with the Chrome-profile gap called out (offered, not yet done — it's a shorter, different document).
Phase 5 implementation plan still deliberately unwritten. Branch `docs/vision-buy-anything` unpushed.

*Session spend: 1.25M tok (in 18 · out 24.6k · cache r 1.13M / w 86.9k) · ~$2.05 · opus-5 · 12:44→09:37*

**Later that day — seven external tools evaluated; the free option nobody tested is still the answer.**

Ben surfaced seven repos/services that might save build effort on Marketplace and the Phase 7 catalog.
Six are dead ends. Three (`gomarble-ai/facebook-ads-mcp-server`, `HagaiHen/facebook-mcp-server`,
`Livia-Zaharia/just_facebook_mcp`) are Graph-API wrappers for **Ads reporting and Page management** —
the wrong Facebook product, no listing surface at all. `jdcodes1/facebook-marketplace-mcp` is *worse
than what we already rejected*: it pulls live session cookies out of Chrome's macOS Keychain and
replays Facebook's internal GraphQL API **as the real account**, with core extraction broken per its
own open issue. `secondhand-mcp` survives only as a **reading reference** (MIT) — no Mercari, no
Vinted, so it doesn't advance the catalog thesis.

**Bright Data is real, but the first pass got its economics wrong.** The `$250 min` is the bulk
*Datasets* product and the `$1.50/1k` is *Web Unlocker* — neither is how Marketplace bills. The right
product is the **Web Scraper API** ($1.50/1k **records**, 5,000 free records/mo, no minimum, prepaid
hard stop), and its **MCP server is URL-only** — no keyword search, so the MCP path is a trap. Async
delivery supports **polling**, so outbound-only survives. *Meta v. Bright Data* (N.D. Cal. 3:23-cv-00077,
Chen J., 23 Jan 2024) held Meta's Terms don't bind logged-off visitors scraping public data; Meta
dismissed the remainder and waived appeal.

**The finding that reframes it: §1.1 was never run, and we now have evidence it might pass.**
`secondhand-mcp` reaches Marketplace over *plain unauthenticated fetch*, Bright Data's whole posture is
logged-out-public-only, and **Ben has no Facebook account to lose**. Checked against the code, the
asymmetry is decisive: a logged-out adapter is a `craigslist.ts` clone needing **zero engine changes**,
while a Bright Data adapter would have to take a `Page` it ignores, `hunt.ts:66` would launch Chrome
anyway, and `hunt.ts:93-95` would fire the vision fallback on a never-navigated blank tab and bill for
it. Worse, `llm.ts` exports **no non-LLM cost sink** — a metered vendor today means spend sitting
*outside* the meter Phase 5 exists to build.

**Decisions.** Adopt nothing; create no vendor account. Run the free §1.1 probe first
(`scripts/smoke-marketplace.ts`, throwaway Chromium — never the persistent profile), ~5 runs over ~3
days to test whether one residential IP survives a realistic cadence. If it passes → hand-written
`facebook.ts`, registered but **out of `DEFAULT_SOURCES`** like Craigslist, with `ChallengeDetectedError`
wired *before* the first run. If it fails → Bright Data, but **gated behind Phase 5** so its cost is
visible, which also adds two Phase 5 prerequisites: an exported non-LLM cost seam in `llm.ts`, and
`SpendRecord.model` widened to accept a vendor name. Plan in
`docs/superpowers/specs/2026-07-31-marketplace-access-decision.md`.

**Open / next:** run the probe — it's the gate on everything above, and it may retire
`docs/facebook-marketplace-account.md` outright. Phase 5 implementation plan still unwritten.

*Session spend: 10.58M tok (in 208 · out 201.2k · cache r 8.41M / w 1.96M) · ~≥$21.26 · opus-5 + sonnet-5 + <synthetic> · 14:35→22:02*

### [[07-30-26 Thu]] — Vision reset: "help me buy anything", and Phase 5 costs out the watchlist promise

Ben opened with a direction conversation rather than a task: Magpie should help with *any* purchase —
obscure category-specific marketplaces (a Japanese camera auction site), style search across new and
used (Etsy vs Poshmark/Vinted), preference questions ("is color or quality more important?"), an
onboarding interview, cheapest-routine-buys from Amazon/groceries, and forwarded promo emails. Ran
`superpowers:brainstorming`. Scoped it as **seven subsystems, not a feature list**, and decomposed
rather than trying to spec it whole.

**The reframe that made it tractable.** SPEC's "three modes of one engine" doesn't survive this, but
the instinct does — replaced modes with **four dimensions**: target kind (`exact`/`style`/`consumable`)
× objective (`cheapest`/`best_fit`/`best_value`) × trigger (asked/scheduled/promo/threshold) × sources
(catalog-routed). `/hunt` is `(exact, cheapest, asked)`; the t-shirt is `(style, best_fit)`. Everything
still produces an ordinary `hunt` row, so queue/worker/dedup/cost-accounting survive untouched. That's
the load-bearing constraint on all future work.

**Decisions (all via brainstorming questions):** source catalog grows by seed + **probe** + rare
explicit discovery — the probe *drives* a site to learn its search-URL template rather than letting an
LLM guess one, which is the whole reason breadth is feasible; hand-written adapters become an override,
not the only path. Style hunts get thumbnail vision **plus reference images** (drop a photo in Discord).
Hunts **never pause for input** — clarify before starting only when it changes source selection, else
assume-and-learn from corrections (rejected `awaiting_input` + resume as too much complexity in the
most reliable part of the system). Routines seed from Amazon order history **once**, then curated
(rejected continuous sync as exactly the ban risk SPEC §15 flags). Promos cross-check watches/routines
on arrival **and** nudge before expiry. Conversational surface is an **intent router in front of the
existing commands**, not a full agent loop.

**Findings.**
- Ben asked whether Amazon price-history APIs exist. They do, but: **Keepa** is the only serious one and
  API access is a *separate* subscription (~€49/mo) from the €19 Pro plan everyone means; Amazon's own
  PA-API never returned history, requires Associates-with-sales, and is deprecated 2026-05-15;
  CamelCamelCamel unverifiable (403s automated fetches, sources conflict). Crucially Keepa is
  Amazon-only, so it **backfills `price_point` rather than replacing it** — added a `provider` column so
  the subscription decision defers to Phase 10. Explicitly wrote *against* scraping Keepa's free
  extension through the persistent Chrome context, so it doesn't get proposed as clever later.
- **`SPEC.md` contradicts itself on cost, and Phase 5 is what exposed it.** `llm.ts` records a real
  measurement — a 60-row eBay hunt cost **$0.157, of which $0.118 was extraction**. The promised
  "dozens to hundreds" of watchlists is ~900 hunts/mo ≈ **$141/mo** against a stated $10–50 ceiling.
  Ben chose **$25/mo** deliberately, to force the discipline.
- Consequence: the **Haiku A/B test is now a blocker, not a Phase 4 leftover**. Soft degradation's only
  meaningful lever is the cheap extraction model (extraction is 75% of hunt cost), and
  `MAGPIE_EXTRACT_MODEL` is currently unset — so at 80% of budget Magpie would announce it was
  protecting spend while having no way to reduce it. Spec now requires a warning naming the unset var.
- Cost plumbing was better than assumed: OpenRouter already reports real USD, `withUsage()` brackets by
  async context, and `/hunt` + `/watch add` correctly bill parse cost via `initialCostCents`. The one
  gap is structural — **spend only becomes durable when it lands on a `hunt` row**, so an abandoned
  `/advise` thread bills nothing. Small now, fatal at Phase 8 where the router fires per message. Hence
  a dedicated `spend` ledger rather than `SUM(hunt.cost_cents)`.
- Ledger stores **`cost_micros`, not cents**: `withUsage` rounds up per *bracket* (correct), but
  rounding per *call* would turn four 0.3¢ calls into 4¢ — a ~2× overcount making a $25 ceiling behave
  like $12. Shipped as an explicit regression test.

**Shipped:** `docs/superpowers/specs/2026-07-30-magpie-vision-design.md` (north-star, resequences SPEC
§14 into phases 5–12) and `2026-07-30-phase-5-foundations-design.md` (implementation-ready). Branch
`docs/vision-buy-anything`, 3 commits, not pushed.

**Open / next:** Ben read the Phase 5 spec and explicitly deferred the implementation plan. Phase order
is 5 Foundations → 6 Promos → 7 Catalog (6/7 swapped at his call; independent) → 8 Conversational →
9 Style → 10 Routines → 11 Grocery → 12 Hub. Unresolved: catalog tag vocabulary, per-source quality
metric, **style-watch dedup** (`watch_hit` keys by listing, but a style watch sees an endless stream of
different-but-equivalent garments), promo-parse false-positive rate.

*Session spend: 9.64M tok (in 193 · out 158.6k · cache r 8.66M / w 822.5k) · ~$16.52 · opus-5 · 10:02→12:44*

### [[07-29-26 Wed]] — Phase 4 hardening complete: pacing backoff, BROWSER_CHANNEL, vision fallback (8/8, merge-ready)

Ben asked "what's next" — the resume-point memory said `phase-4-geo` was unmerged; it wasn't
(merged 07-24, see below). Corrected course: re-derived actual state from `CHECKLIST.md`/`log.md`/
`git log` instead of trusting the stale note, then picked the one open item that needed no live
Discord/region decision from Ben — Phase 4's three hardening boxes (pacing, detection mitigations,
vision/screenshot fallback) — over Facebook Marketplace (explicitly wants Ben present) and the
Haiku A/B test (deferred).

**Decisions (confirmed with Ben via plan-mode questions):** vision fallback triggers on both a
thrown adapter error *and* a legitimately-empty result set; vision model defaults to `MAGPIE_MODEL`,
override via `MAGPIE_VISION_MODEL`, no hard cost ceiling in code (stays visible via `llm.ts`'s
logging); screenshots sent to the LLM provider **as-is**, no cropping — CLAUDE.md's "never
screenshotted" invariant is about Discord, not the LLM call; challenge cooldown defaults to 60min,
global, env-overridable; `ChallengeDetectedError` wired for eBay only this pass (the only source
with an *observed* live block — no invented Craigslist heuristic); vision fallback ships opt-in via
`MAGPIE_VISION_FALLBACK_ENABLED` (default off).

**Shipped so far** on branch `phase-4-hardening` (subagent-driven-development, one implementer +
one independent reviewer per task, 4 of 8 tasks landed, all review-clean):
- **Task 1** (`439fbf0`) — `pacing.ts` gained `ChallengeDetectedError` + per-source cooldown
  (unconditional-set-on-repeat, so a second challenge during cooldown naturally extends it); wired
  into `ebay.ts`'s existing bot-challenge throw and `hunt.ts`'s catch block. Reviewer specifically
  verified the cooldown-blocked throw stays a *plain* `Error`, not `ChallengeDetectedError` — reusing
  the challenge type there would've let routine pacing guards perpetually re-extend a cooldown.
- **Task 2** (`3ecf1f8`) — `session.ts` got a pure, testable `resolveLaunchOptions()` and a
  `BROWSER_CHANNEL` env knob for `channel:'chrome'`. Empirically testing whether a real Chrome
  install actually reduces fingerprinting is left to Ben via the existing `scripts/smoke-browser.ts`
  — the code only adds the capability.
- **Task 3** (`04ca1c0`) — pure lift-and-shift of `extract.ts`'s row-validation loop into
  `sources/types.ts`'s `keepValidRows()`, unblocking reuse from the not-yet-built vision-extraction
  module without a circular import.
- **Task 4** (`8257cb7`) — `llm.ts` gained `genObject({images})` and `visionModel()`. First attempt
  stalled on a harness watchdog mid-edit with a complete but uncommitted diff; rather than discard
  it, handed the salvaged diff to a fresh implementer to *verify, not trust* — it checked the
  multimodal message shape against the real installed `ai`/`@ai-sdk/provider-utils` v7 type
  definitions rather than assuming, confirmed correct, and shipped as-is.
- Also fixed a `noUncheckedIndexedAccess` typecheck error in `types.test.ts` that Task 3's review
  missed (`bun run test` doesn't run `tsc`; now both are required per task in the plan's Global
  Constraints).

**Shipped, remaining four tasks** (same process, all review-clean after fix rounds where needed):
- **Task 5** (`6d8fab2`→`79dbdac`) — `visionExtract.ts` (`extractListingsFromImage`) and
  `visionFallback.ts` (`runVisionFallback`: screenshot + `$$eval` anchors + LLM call), reusing
  `extract.ts`'s schema rather than inventing one. Review caught two Important issues on first pass:
  the reused schema's `url` field still carried the *text*-path's "copy from the 'URL:' line"
  instruction, conflicting with the vision path's own anchor-based instruction (fixed via
  `.extend()` overriding just that field, not a new schema); and an unbounded anchor list risked a
  10-20k-token prompt on a real results page (capped at 200). One fix round, clean re-review.
- **Task 6** (`d3aed52`→`2a41d4f`) — wired vision fallback into `hunt.ts`'s per-adapter loop: a
  non-challenge search error or a zero-row result now recovers via `deps.visionFallback` when
  provided, flowing through the *same* `toListing`/`upsertListing` path as normal rows. Flagged in
  the plan as highest-risk (core orchestration loop) and it earned that label — review (on opus)
  found a Critical bug: the empty-result fallback check lived inside the same try/catch as the
  original search, so if *that* vision call itself threw, the shared catch re-invoked vision a
  second time and silently discarded the first error. Fixed by moving the empty-check outside the
  try/catch with a `recovered` guard; one fix round, clean re-review, regression test added.
- **Task 7** (`a6bd9ee`) — `index.ts` wiring: `MAGPIE_CHALLENGE_COOLDOWN_MS` (parsed int, defaults
  60min on unset/NaN) and `MAGPIE_VISION_FALLBACK_ENABLED === 'true'` deciding whether `runVisionFallback`
  or `undefined` gets passed as `deps.visionFallback` — the *only* place either gate is checked;
  `hunt.ts`/`visionFallback.ts`/`visionExtract.ts` stay env-unaware by design. Clean review, no fix
  round.
- **Task 8** (`1848382`→`546749c`) — `vision-fallback-e2e.test.ts` (real Playwright page against the
  local fixture server, LLM mocked), `scripts/smoke-vision.ts` for Ben's manual cost/quality check,
  `CHECKLIST.md`'s three hardening boxes checked. Review found one Important issue: the smoke script
  screenshotted right after `domcontentloaded`, before eBay's client-rendered results actually
  appear — exactly the script meant to inform the go/no-go on enabling vision fallback, giving a
  plausible-but-wrong low reading. Fixed with a `waitForLoadState('networkidle')` wait; bundled in a
  cheap assertion that the screenshot's `imageCount` actually reaches the LLM call. One fix round,
  clean re-review (first re-review attempt hit an infra error mid-response, unrelated to the code —
  retried fresh).

**Final whole-branch review** (opus, after all 8 tasks individually clean): merge-ready on code, no
fix round needed. It traced both the non-challenge-error-with-vision-enabled path and the
challenge-with-vision-enabled path end to end through the real code (confirmed the multimodal
message shape against the installed `@openrouter/ai-sdk-provider` source, not just typechecking),
verified cost accounting fires exactly once per `genObject` call on every path, and confirmed the
two opt-in gates (`MAGPIE_VISION_FALLBACK_ENABLED` for whether fallback runs at all,
`MAGPIE_VISION_MODEL` for which model) stay genuinely independent and checked only in `index.ts`.
Found two Important **documentation** gaps (no code changes): this log entry was stale at 4/8, and
`SPEC.md` §10's config table was missing the three new env vars Task 7 added (only `.env.example`
had them). Also two Minor leftover comments in `visionExtract.ts` and `llm.test.ts` still described
`MAGPIE_VISION_MODEL` as the opt-in trigger rather than `MAGPIE_VISION_FALLBACK_ENABLED` — a stale
claim from before Task 4's doc fix, worth correcting since it could lead to setting the wrong var
and expecting fallback to turn on. All four fixed directly (docs/comments only, no logic change,
`bun run test`/`typecheck` reconfirmed clean after).

**The one thing to flag to Ben before enabling the flag for real** (from the final review, not new):
vision fallback fires on every *legitimately empty* result, not just errors — for `/watch`, "nothing
new" is the steady state, so an enabled fallback means a screenshot + vision call per source per
scheduler tick, indefinitely. The plan's mitigations (default off, `smoke-vision.ts` for a manual
cost/quality look first) are the right shape for this, but it's the cost lever to watch after the
first smoke run — not the error-recovery trigger, which only fires on genuine adapter breakage.

Full plan at `~/.claude/plans/so-what-s-next-in-delegated-barto.md`; ledger at
`.superpowers/sdd/so-what-s-next-in-delegated-barto/progress.md` (every task's deferred Minor
findings and plan-mandated notes live there, triaged by the final review). Branch is 15 commits
ahead of `main` (`git merge-base` = `1f801ce`), all suites green (197 unit · 17 bun-e2e · typecheck
clean). Next: merge (`finishing-a-development-branch` — likely a local `--no-ff` merge per Ben's
established style, confirm with Ben rather than assume).

*Session spend: 25.15M tok (in 434 · out 171.3k · cache r 23.83M / w 1.15M) · ~≥$12.64 · sonnet-5 + opus-4-7 + <synthetic> · 14:35→20:59*
*Session spend: 24.04M tok (in 484 · out 157.6k · cache r 23.28M / w 606.0k) · ~$11.19 · sonnet-5 + opus-4-7 · 20:59→22:29*

### [[07-24-26 Fri]] — `phase-4-geo` merged to main; Craigslist taken live (four bugs)

**Shipped — Craigslist live-verified, and the pre-live guess was wrong in four ways.** Ben
pushed the merge, then asked to take Craigslist live. Rather than spend a Discord hunt to find
out, probed the real site with throwaway Playwright scripts first (no LLM, no Discord) — cheap
enough to iterate, and it turned a single pass/fail into four separate findings.

- **The card is a `DIV`, not an `LI`.** `li.cl-search-result` matched **0 of 24** live cards.
  Selectors are tag-agnostic now (`.cl-search-result, .cl-static-search-result`). *Lesson worth
  keeping: name the class, not the tag — the element type is the site's business.*
- **Post URLs no longer end in `<pid>.html`.** Craigslist serves
  `https://www.craigslist.org/view/d/<slug>/<token>`. The guarded `POST_URL` regex accepted only
  the legacy form, so **every extracted row would have been dropped by `toListing`** — extraction
  logging a happy `kept 22/22` and the hunt returning nothing. The quietest failure of the four,
  and the reason the guard exists. Both shapes accepted now; the token is safe as a dedup key
  (**24/24 identical across two loads**, and the post page's own "post id" matches the card's
  `data-pid`, so it's a permalink, not a session handle).
- **`waitForSelector('attached')` was reading a skeleton.** Sampling the page every 500ms showed
  craigslist ships pre-hydration markup whose cards have no anchors and no text; `attached`
  resolved on it at **~200ms**, the app destroyed it (**~700ms, zero cards**), and the real list
  mounted at **~1200ms**. The adapter was reading a full second early. Now waits on the actual
  precondition — a card with both a posting link and rendered text — which needs no
  craigslist-internal class name and self-corrects if they retime hydration. *My first probe
  masked this with a `waitForTimeout(6000)`; the bug only surfaced when I ran the real
  `search()`. A fixed sleep in a probe is a lie detector you've disabled.*
- **`sort=priceasc` was actively harmful.** Copied from eBay's `_sop=15`, but craigslist's
  `query` matches post *body* text loosely, so cheapest-first floats free junk: **4/10 relevant**
  in the top ten ("Curb alert!", a patriotic shadow box, three duplicate elliptical pedals)
  vs **10/10** real desks on the default relevance sort. Dropped it. The reasoning generalises —
  `rankListings` re-sorts by landed cost regardless, so a source-side sort only decides *which
  candidates we pay to extract*, and there relevance is the entire job. eBay gets away with
  `_sop=15` because its query matching is tight.
- Also stripped the gallery swipe dots (14 bare `•` per card) from the reduced text — pure token
  waste in every extraction prompt.
- **Full live path then proven end to end:** 12/12 rows extracted, **12 kept / 0 dropped**, real
  per-item locations, **$0.033** extraction (cheaper than eBay's ~$0.077 — fewer, shorter cards).
  Fail-loud on an unset `CRAIGSLIST_REGION` also confirmed live, by accident, which was pleasant.
- Fixture rebuilt from the real DOM shape (replacing the hand-authored guess) and the e2e widened
  to pin all four fixes. Suite **166 vitest · 21 bun-db · 16 bun-e2e**, typecheck clean.

**Decisions:** Craigslist stays **opt-in** for now — promoting it into `DEFAULT_SOURCES` needs
`CRAIGSLIST_REGION` set in Ben's `.env` (it isn't, and `buildSearchUrl` throws loud by design),
and the region is his call. `philadelphia` is the obvious one given the 19147 anchor.

**Shipped:** merged `phase-4-geo` → `main` (local `--no-ff`, the Phase 3 pattern). Seven commits:
geo-local constraints end to end, the eBay `LH_LPickup` radius fix and the two extraction bugs the
live smoke surfaced, the Craigslist adapter, and the live-smoke plan. Suite green on the branch
before merging and on merged main: typecheck clean, **164 vitest · 21 bun-db · 13 bun-e2e**.

Also corrected a stale `CHECKLIST.md` note that still called the geo live re-confirm "pending" —
it passed on 07-23 and the log already said so.

**Open / next:** decide whether Craigslist joins `DEFAULT_SOURCES` (needs `CRAIGSLIST_REGION` in
`.env` first), and a Discord-side `/hunt … sources:craigslist` to see the cards render — the
adapter contract is proven, the embed path for a second source isn't. Then the deferred Haiku
extraction A/B. Facebook Marketplace remains the account-ban-risk item that wants Ben present.

### [[07-23-26 Thu]] — Live smoke: Phase 3 exit criterion met against real eBay

Walking Ben through `docs/testing/2026-07-22-live-smoke.md`.

**Findings so far:**
- **Boot clean** — `commands=4`, `Magpie#8183`, `[boot.ready] headless=true`, no allowlist warning. A pre-existing `/watch` (Casio A500W) came due and fired on boot: `[scheduler.tick] enqueued=1` → full hunt, extracted 60/60, `shown=4`, ~$0.099. **Mode B proven live, unprompted**, before the scripted tests even started.
- **`/profile` CRUD** — add / list / bogus-remove all as specified.
- **Phase 3 exit criterion ✅ (the ⭐ one).** `/hunt logitech mx master 3s max_price:70` with an active `coupon_source` fact: discount line, ~10%-below-sticker landed price, verdict cites the coupon, footer `eBay · #1`. Removed the fact, re-ran: same listings, no discount, sticker prices. **Proven both directions.** Ticked `CHECKLIST.md` Phase-3 exit criterion.
- **Extraction cost holding at real prices** — Sonnet extraction ~$0.077, rank ~$0.018 + ~$0.004 per hunt (in line with the ~16¢ Phase-1 baseline).

**Geo narrowing — the live smoke earned its keep (found + fixed a real bug).**
- **`_stpos`/`_sadis` alone were a silent no-op.** parseTarget + buildSearchUrl emit them correctly (confirmed: `…&_stpos=19147&_sadis=25`), but the result set was *byte-identical* with and without them — same "3,700+ results", same items, same order. Proven by loading both URLs in-browser and diffing. This is exactly the silent-degradation the invariants exist to catch, and exactly why this step needed live eyes.
- **Root cause, via eBay's own UI:** `_stpos`/`_sadis` only *pre-fill* eBay's location option; nothing filters until you tick "Local Pickup within N mi", which the UI emits as **`LH_LPickup=1` (+ `LH_PrefLoc=99`, `_fspt=1`)**. eBay has **no ship-inclusive radius filter** — radius is inseparable from local pickup.
- **Fix (Ben's call):** an anchored radius now adds `LH_LPickup=1&LH_PrefLoc=99&_fspt=1`. Narrows for real (**3,700+ → 59**) and eBay then renders per-item **"N mi from <zip>"** distances (a far better signal than the country-only "Located in United States" that search results otherwise expose). **Semantics Ben chose:** honoring "within N miles" = **local-pickup only**, ship-only listings excluded — the honest reading of "near me". Zip-only (no radius) still just sets ship-to context, no forced pickup filter.
- Verified in-browser against the *exact* URL `buildSearchUrl` emits. New URL-contract test pins `LH_LPickup`.

**Then test 4a surfaced two DEEPER bugs — both ours, both now fixed (Ben: "fix both now").** Enabling the filter revealed the first live hunt still ranked a *Santa Clarita* pickup desk (~2,390 mi from 19147) at #1 with "location unclear". Inspecting the real page (`get_page_text`) explained why:
- **Bug A — we threw away the distance.** Every card's innerText carries eBay's own **"N mi from 19147"**, but extraction captured the coarse "Located in United States" instead, leaving the ranker blind ("distance unclear"). Fix: `extract.ts` `location` field now *prefers* the "N mi from <zip>" distance when present — it's eBay's computed number, not a guess, so it stays inside the never-geocode rule.
- **Bug B — we ingested eBay's out-of-radius padding.** eBay stacks the genuine in-radius results, then pads with **"Results matching fewer words"** and **"<N> items found from eBay international sellers"** sections whose cards run to 4,885 mi. `fetchResultsText` was scraping every card on the page. Fix: extracted the DOM reduction into `reduceResultsText(page)` (mirrors craigslist.ts) and it now drops everything from the first padding heading onward (`RESULT_BOUNDARIES`, document-order via `compareDocumentPosition`).
- Pinned by a new bun e2e (`tests/bun/e2e/ebay-fetch.test.ts` + `tests/fixtures/ebay/`) built from the real 2026-07-23 page: keeps the 3 in-radius cards, preserves "N mi", drops Santa Clarita / the international + fewer-words sections, fails loud on an empty page. Suite now **164 vitest · 34 bun**, typecheck clean.

**Live-confirmed on the restarted (signed-in) process ✅** — re-ran `/hunt standing desk near 19147 within 25 miles`: cards now show the distance ("N mi from <zip>") on the Location line, no cross-country items. Geo narrowing works end to end. **Test 4 fully green** (4a fixed + confirmed; 4b radius 20→25 snap ✓; 4c Oakland place-name warning + no params ✓).

**Open / next:**
- **DEFERRED — cheap-extraction A/B (smoke doc §5).** Biggest cost lever: extraction was ~$0.118 of a ~$0.157 hunt. Re-run a known hunt with `MAGPIE_EXTRACT_MODEL=anthropic/claude-haiku-4.5` and compare row count / dropped-row warnings / quality / `usd=` against the Sonnet baseline. Keep only if row count and quality hold; unset = today's behavior. Ships off by design — a cheap model quietly mangling extraction is worse than a few extra cents.
- Cleanup is effectively moot: the test coupon fact was already removed in test 3, and the smoke created no watches. The pre-existing Casio A500W `/watch` (fired on boot) is real, not test debris — Ben to decide whether to keep it.

### [[07-22-26 Wed]] — Phase 3 lands: `/profile`, seller rating, SPEC caught up

*(Later the same day — Phase 3 pushed to `main` by Ben; live smoke deferred, so picked up the one Phase 4 item that needs no live testing. Branch `phase-4-geo`, suite **154 vitest · 21 bun-db · 7 bun-e2e**, typecheck clean.)*

**Shipped — Craigslist adapter (Phase 4, offline, autonomous overnight session).** Ben went to bed and asked to "start on the next work item without me doing those tests," so I picked the Phase 4 item that's real progress *and* needs no live smoke: the **Craigslist adapter**. Spec + plan committed at `docs/superpowers/{specs,plans}/2026-07-22-craigslist-adapter*`. Suite now **163 vitest · 21 bun-db · 9 bun-e2e**, typecheck clean.
- **Why Craigslist and not the other open Phase 4 items:** Facebook Marketplace is the "big risk" — needs a logged-in (maybe burner) account and *live* detection testing, exactly the work to do with Ben watching (CLAUDE.md: "account-ban risk respected"); Docker can't be built here (no Docker). Craigslist has **no login, no account → no ban risk**, is fully buildable/verifiable offline, and is the **second consumer of the geo plumbing** this branch added (only eBay read `constraints.location` before).
- **Mirrors `ebay.ts` exactly.** Deterministic `buildSearchUrl` (query, `sort=priceasc`, `max_price` in whole dollars, `condition=10` only for `new`), LLM extraction via the shared `extractListings`, `toListing` guarded on a `craigslist.org` post id (`…/<id>.html`), conservative pacing (`15s` / `20/hr`).
- **The geo contrast is the nice part:** eBay's `_sadis` snaps to a fixed ladder (radius rounds *up*); **Craigslist takes an exact `search_distance` integer** — same zip-anchored, never-geocode rule (`canAnchorRadius`), no snapping. Craigslist also has **no national search** (sharded into ~400 regional subdomains), so the region is the geography — configured via `CRAIGSLIST_REGION`, and `buildSearchUrl` **throws loud** if it's unset rather than guessing a zip into a region.
- **Registered but opt-in.** `DEFAULT_SOURCES` stays `['ebay']`; Craigslist runs only via `sources:craigslist`. The result selectors (`li.cl-search-result`, `a.posting-title`) are a **live-unverified best-guess** pinned by a fixture — same posture that keeps the fixture source opt-in and `MAGPIE_EXTRACT_MODEL` off: don't silently enable an unverified path. A bun e2e reduces a hand-authored Craigslist-shaped page through real Playwright (`reduceResultsText`, no LLM), proving the DOM reduction and the fail-loud-on-zero-cards path.
- **Nothing merged or pushed**, nothing in the default source set changed — so this is additive and fully reversible if the design wants redirecting.
- **Open for Ben (in the spec):** (1) single `CRAIGSLIST_REGION` vs a per-`/hunt` region override — went with the single env for a personal single-user agent; (2) sanity-check that Craigslist was the right next source vs holding for Marketplace. Then the one live step this can't self-verify: a real `sources:craigslist` hunt to confirm the selectors, after which it can join `DEFAULT_SOURCES`.

**Shipped — geo-local constraints, end to end:**
- **Found dead code that had been live since Phase 1**: `constraints.location` (`near`/`maxMiles`) was parsed into every `TargetSpec` and read by *nothing* — `applyConstraints` destructured only price and condition, `RawListing` had no location field, and `ebay.ts` hardcoded `location: null`. Asking for "within 20 miles" silently searched everywhere.
- **Narrowing now happens at the source**, where it can be exact: `buildSearchUrl` sets eBay's `_stpos` (zip) + `_sadis` (radius) so eBay computes distance server-side. Verified the param names by search rather than guessing — a wrong param is a silent no-op, the exact failure this repo forbids.
- **`_sadis` only honours a fixed ladder** (10/25/50/100/200/500/1000), so a requested radius **snaps up** to the next rung. Up, never down: a superset is safe, narrowing tighter than asked would hide real matches — same instinct as the filter's "ties go to keeping the listing".
- **Location extracted, ranked and shown** — optional-nullable through `RawListing`, into both rank prompts and onto the card, same pattern as seller rating.

**Decisions:**
- **We do not compute distance, on purpose.** Deciding "San Jose, CA" is outside 20 miles of Oakland needs geocoding, and Magpie's whole network posture is Discord + OpenRouter + retail sites. Adding a geo service to *hard-drop* listings would trade a load-bearing constraint for a guess. So: narrow at the source, surface the location, let the verdict judge it — and the prompt explicitly tells the model to say it's unsure rather than invent a distance. Pinned with a test (`never drops a listing on location`) so nobody later "fixes" it into fake math. Same shape as the Phase 3 discount rule: machine-apply only what's arithmetically defensible.
- **A place name is never guessed into a zip.** A fabricated centroid would search the *wrong place* — worse than not narrowing. `canAnchorRadius` lives in `target.ts` and is shared by the adapter and the command.
- **`/hunt` warns at request time** when a radius can't be anchored. A request we're quietly not honouring is the silent-degradation mode the invariants exist to prevent; results that look narrowed but aren't would be worse than the un-narrowed search itself.

**Testing plan written for Ben** — `docs/testing/2026-07-22-live-smoke.md`, a pick-up-cold checklist covering the Phase 3 exit criterion, the geo params, and an optional Haiku extraction A/B (~15 min, ~50¢). Writing it surfaced a real gap: **the eBay search URL was never logged**, so there was no way to see whether `_stpos`/`_sadis` had actually been applied — added `[ebay] search <url>` at the search step, which is the adapter's whole contract with eBay and useful well beyond tonight. The plan is explicit that params-present-but-locations-nationwide means eBay is ignoring them (probably wants `LH_PrefLoc` too), since that failure looks identical to success from the Discord side.

**Open / next:** the `_stpos`/`_sadis` behavior is **live-unverified** — param names are confirmed from docs but the actual narrowing needs one real eBay run, ideally alongside the Phase 3 smoke. Then the genuinely risky Phase 4 work (Marketplace/Craigslist adapters, detection mitigations) and the still-unwritten Dockerfile/compose (couldn't be built here — no Docker on this machine).

**Shipped** (branch `phase-3-profile`, tasks 6–9 of the plan; suite green at each step — typecheck clean, **141 vitest, 21 bun-db, 7 bun-e2e**):
- **`/profile add|list|remove`** (`src/discord/commands/profile.ts`) — the missing user-facing half. Until now the discount machinery from tasks 1–5 was unreachable: there was no way to get a fact into the database. No LLM in this path; facts are stored verbatim. `remove` is soft and deliberately reports **not-found for an already-removed fact** rather than confirming a second removal, so the reply can never disagree with `/profile list`.
- **Listing cards tell the truth about the number they show** — a card whose landed cost was discounted now says so (`Includes $X membership/coupon discount`), and the footer names the listing's **actual source** instead of a hardcoded `eBay`. `sourceLabel`/`effectiveSourceLabels` live in `sources/registry.ts` so a Phase 4 adapter adds its display name beside its registration.
- **Seller rating extracted end to end** — optional-nullable on `rawListingSchema` (old fixtures stay valid), asked for in the extraction schema, carried by both adapters, shown on the rank line and the card. Per SPEC §6.5 it is **verdict-layer judgment, never cost math**.
- **E2E through the real queue** — a `coupon_source` fact naming the fixture source discounts every persisted `hunt_result`. Mutation-checked: deleting the `addFact` line fails the test, so it isn't vacuous.

**Decisions:**
- **The "best deal" open question (SPEC §15) is resolved as a deliberate "no".** Magpie applies discounts *only* from stored facts, and only when the fact names the source; it does not go hunting for coupons. Anything the owner can't state as a source-scoped fact stays LLM narration on top of honest arithmetic. Written into SPEC §6.5 as the rule, with the §15 bullet struck through — it had been sitting as *"scoped in Phase 3"* with the actual rule living only in a code comment.
- **The extraction cost lever ships opt-in and default-off.** `MAGPIE_EXTRACT_MODEL` routes only the extraction pass to a cheaper model (`genObject`/`genText` now take a per-call model; `llm.ts` caches one model per id and the `[llm]` line reports which was used). Unset = today's behavior exactly. Deliberate: extraction quality on a cheap model is unvalidated, and this codebase's whole posture is that a regression should be loud, not silent — so the switch waits for a smoke test rather than defaulting on and quietly degrading hunts.
- **`CHECKLIST.md`'s "condition + seller-rating adjustment" resolved toward the LLM**, not deterministic math — SPEC §6.5 is explicit that those are verdict judgment. Money math stays limited to figures defensible arithmetically.
- Also caught SPEC up on the **Phase 1 `test:e2e` amendment** (owed since 07-16): the spec still claimed `playwright test`, which can never work because it runs under Node where `bun:sqlite` doesn't exist.

**Housekeeping:**
- **`CHECKLIST.md` had drifted badly** — every Phase 1 and Phase 2 item was still unticked (30 + 9 boxes) for work that shipped and merged weeks ago, which meant ticking Phase 3 would have left the doc claiming Phase 3 landed before Phases 1–2. Reconciled against the actual tree rather than blanket-ticked: two items came back **unticked or annotated** because they aren't true as written — *"add 1–2 more well-behaved sources (Google Shopping + retailer)"* was quietly **deferred** (eBay + fixture carried Phases 1–3), and `src/watch/dedup.ts` never existed as a file (the logic is two queries living in `db/watches.ts` + engine step 6). Phase 1's exit criterion is annotated too: it says "across the multiple sources" and was met against eBay alone.
- **System-map artifact refreshed** at the phase boundary, in place at the same URL: https://claude.ai/code/artifact/2d576775-2542-4021-b5d4-cf9e1a7d4955. Nearly everything that was dashed is now solid — only the P5 hub box, the P4 marketplace adapters, and the deferred Google/retailer chips remain planned. Also corrected two things the old map asserted that were never true: prod Docker is *not* built, and Google/retailer were never P1 deliverables in practice.

**Open / next:** **live Discord smoke is the only thing standing between Phase 3 and its exit criterion** — `/profile add|list|remove`, then a hunt where a coupon fact visibly moves the ranking and the verdict cites it. After that, `git push origin main` (Ben — classifier-blocked for Claude). Then Phase 4 (hard sources), where the source-aware footer and per-source pacing start earning their keep. `MAGPIE_EXTRACT_MODEL` is worth an A/B on a real eBay page once someone's watching.

### [[07-19-26 Sun]] — Phase 2 merged to main; branch protection removed

**Shipped:**
- **Phase 2 merged to `main`** via a local `--no-ff` merge commit (`b48b54d`). Offline suite green on merged main: typecheck clean, 105 vitest, 18 bun-db, 6 bun-e2e.
- **Removed the branch-protection rule on `main`.** It — not the repo-level merge-type toggle — was the real source of the "no merge commits" constraint: `required_linear_history: true` (forbids merge commits) + required PR + `enforce_admins: true`. Deleted at Ben's request ("it's just me on this project, I'll just do a regular merge commit"). Repo-level `mergeCommitAllowed` was already true; the protection rule was the actual gate.

**Findings:**
- `gh repo view … mergeCommitAllowed` reports the repo-level merge-button config, **not** branch protection — checking it gave a false "merge commits are allowed" read while protection still blocked the push. For "can I push a merge commit to main?", check `gh api repos/:owner/:repo/branches/main/protection` (`required_linear_history`).
- **Claude Code's auto-mode classifier independently blocks** direct pushes to `main` and branch-protection deletion, regardless of GitHub settings. Those steps are Ben-run (`! git push origin main`), or need a Bash allow-rule.

**Open / next:** `git push origin main` (Ben — classifier-blocked for Claude); local `main` is ahead of origin by the merge commit until then. Then Phase 3 (profile/best-deal).

**Phase 3 begun (overnight autonomous session, branch `phase-3-profile`)** — plan at `docs/superpowers/plans/2026-07-19-phase-3-profile.md`; tasks 1–5 of 9 landed, suite green at each step (typecheck clean, 121 vitest, 21 bun-db, 6 bun-e2e):
- **Profile repo** (`src/db/profile.ts`): `activeFacts()` + soft-remove CRUD over the `profile_fact` table (already in the baseline migration — no new migration needed).
- **Deterministic best-deal rule decided** — this scopes SPEC §15's open "best-deal definition depth" question: a `membership`/`coupon_source` fact is machine-applied **only when its text names the listing's source** ("10% off ebay" discounts eBay rows, nothing else). `N% off` hits the item price, `$N off` the landed total, percent wins when a fact has both, applicable facts stack, landed clamps ≥ 0. Anything fuzzier is verdict-prompt context only — the LLM narrates deals, never invents math.
- **Ranking + filter consume facts**: `landedCost(l, facts)`/`discountCents` pure and unit-tested; `rankListings` sorts by discounted landed cost, injects a facts block into both LLM passes, annotates discounted lines, and returns `discountCents` per row; `applyConstraints` price ceiling now judges the discounted cost (a coupon can rescue a listing from the ceiling) and is generic so source-tagged rows survive filtering.
- **Engine wired**: `HuntDeps.profile`, raws tagged with their adapter's source at collection, facts fetched once per hunt.

**Open / next (Phase 3):** Task 6 `/profile` command family + embeds (discount line on cards), Task 7 seller-rating extraction field, Task 8 e2e (coupon fact through the real queue), Task 9 checklist/log/PR. Live smoke of `/profile` + a discounted hunt is Ben-gated.

### [[07-18-26 Sat]] — Phase 2 live smoke of `/watch` against Discord — passed

**Findings** (live boot as `Magpie#8183`, 3 commands registered incl. the subcommand-built `/watch`; two Casio watches added during the run):
- **Full `/watch` surface verified live.** `add` (immediate first run — real `ChatInputCommandInteraction` satisfies `WatchInteractionPort`), `list`, `pause`/`resume`/`remove` (removed watch disappears from `list`, history kept).
- **Dedup silence proven through the real scheduler**, not just `runSchedulerTick`: backdated a watch's `next_run_at` → the live croner tick logged `[scheduler.tick] enqueued=1`, worker ran it, `extractListings kept 3/3` → `[hunt.done] … shown=0` (no card posted). Ledger confirms: hit count stayed 4 (no new markers), `hunt_result` retained the full 3-row set, `next_run_at` bumped ~57min out (±10% jitter applied), `last_run_at` set. The "keep full history, filter the notification" invariant holds end-to-end.
- **Fail-loud, one source** — a Casio query hit an eBay interstitial (`no result cards found … site drift or interstitial?`); that hunt alone went `watch_run`/`failed` with 0 hits while the process continued. Worth watching as watch volume grows — eBay occasionally serves an interstitial.
- **Clean graceful shutdown** — SIGTERM drained in order: `shutdown.begin → worker.stopped → gateway.stopped → shutdown.done` (scheduler.stop() runs silently first; worker drains before the gateway drops).

**Gotcha:** `bun run src/index.ts` spawns **two** pids — a `bun run` wrapper and the real child holding the SIGTERM handler. Killing the wrapper (`pgrep … | head -1`) reports exit 144 but leaves the actual gateway **orphaned and alive**; graceful shutdown must signal the *child* running `index.ts`. Extends the M8 "`bun run` is never env-isolated" note.

**Open / next:** merge `phase-2-watchlists` → main. Regular **merge commit** — corrected the long-standing "repo disallows merge commits → rebase-merge" note: GitHub actually allows all three merge types (`mergeCommitAllowed: true`), and it's a single-user project, so a plain merge commit is the norm going forward.

### [[07-17-26 Fri]] — Phase 2 begins: watches repo, engine dedup, watch-hit reporting

**Shipped** (branch `phase-2-watchlists`; Phase 1 merged to main via PR #4 — rebase-merge, the repo disallows merge commits):
- **Watches repo** (`src/db/watches.ts`, real-sqlite bun tests): `dueWatches(now)` (active + `next_run_at ≤ now`), `bumpNextRun`, soft lifecycle (`removed` keeps history, hidden from list), and the dedup primitives — `unseenListingIds(watchId, ids)` + `insertHits` (the at-most-once markers) + `countHits` for `/watch list`.
- **Engine step 6** — `runHunt` now takes a `watches` dep; on `watch_run` hunts the *report* is filtered to unseen listings while `hunt_result` keeps the full ranked history. Hits are marked **after** a successful report, mirroring the Phase 1 reporter rule: a failed Discord post must not suppress a future notification (at-least-once).
- **Watch-hit reporting** — watch runs render as ONE batched message prefixed with the watch name (`🔔 **name** — N new`); zero new hits is total silence, not a nothing-found card (daily nothing-pings would be spam). Oneshot behavior unchanged.
- **Scheduler** (`src/watch/scheduler.ts`, 7 vitest): `runSchedulerTick` (the tested core) enqueues a `watch_run` hunt per due watch into the same queue the worker drains, then bumps `next_run_at` by cadence ±10% jitter (injectable random); `startScheduler` is a thin croner `* * * * *` wrapper with the `Cron` constructor seamed and the tick wrapped so a throwing pass can't kill the job. Wired into `index.ts` — `scheduler.stop()` runs first in shutdown so no new runs enqueue while the in-flight hunt drains.
- **`/watch` command family** (`src/discord/commands/watch.ts`, 10 vitest): subcommands `add`/`list`/`pause`/`resume`/`remove` on one handler dispatching off `getSubcommand()`. `add` parses the query (LLM cost captured via `withUsage`), applies a `max_price` override, creates an active watch (`name` = target description, cadence in **hours**, default 24), and **directly enqueues the first `watch_run` now** carrying the parse cost as `initialCostCents` — the watch's own `nextRunAt` is set one cadence out so the scheduler picks up from there (no double first-run). `list` renders a `buildWatchListEmbed` (id · name · status · cadence · last-run · hit count, one line each) or "No watches yet."; lifecycle maps sub→status via `setStatus` (soft `removed` keeps history), unknown id replies not-found. Gateway's `GatewayCommand.data` widened to accept `SlashCommandSubcommandsOnlyBuilder`; the real interaction satisfies the `WatchInteractionPort` structurally (incl. embed-capable `editReply`), so `index.ts` passes `i` straight through like `/hunt`. **Not yet live-smoked** — unit-covered end to end (real `parseTarget` through the LLM seam), Discord-side verification pending.

**Decisions:**
- Jitter math lives in the scheduler (injectable random), not the repo — `bumpNextRun` takes explicit timestamps and stays deterministic.
- **Enqueue-then-bump ordering:** a failed enqueue leaves the watch *due* (not bumped) so the next tick retries, rather than bump-first which would silently drop a run. The duplicate-hunt risk is already absorbed by the engine's dedup, so retry is the safer failure mode. One bad watch is logged loudly and skipped, never starving the rest.

**Open / next:** watch-lifecycle e2e (add → scheduler tick → run → second run notifies nothing new) → live smoke of `/watch` against Discord → PR.

### [[07-16-26 Thu]] — M5–M7 land: full Discord surface, /advise, offline e2e

**Shipped** (continuing on `phase-1-scaffold`; vitest 80 + bun 15, all green, typecheck clean):
- **M5 complete.** `report.ts` (Reporter port → header + cards / nothing-found / new `buildErrorEmbed`; send failures propagate so undelivered results become `failHunt`, never silently "done"), `gateway.ts` (dumb IO glue: guild-scoped command registration, hub-guarded routing, last-resort error net per interaction), and `index.ts` — the composition root wiring config → db + `resetStaleRunning` → hub → gateway → reporter → worker, with SIGINT/SIGTERM draining the in-flight hunt.
- **M6 — `/advise` (mode C).** `engine/advisor.ts`: one `genObject` turn per round — clarifying questions until ready, then 2–4 concrete candidates each carrying a concretized `TargetSpec`; a `force` flag (round cap / reply timeout) makes questions unacceptable. Discord flow: thread off the deferred reply, bounded Q&A (3 rounds, 10-min reply timeout), candidate cards with **Hunt this**/**Watch this** buttons. Sessions are in-memory keyed by thread id (restart expires buttons — acceptable at personal scale); advisor LLM spend bills onto the *first* hunt enqueued from the session. Watch button is a friendly Phase 2 stub.
- **M7 — offline e2e.** Full pipeline through the real queue: enqueue → worker claim → fixture adapter under real Playwright → ranked `hunt_result` rows in a real SQLite db → reporter; plus the loud-failure path. Only the LLM is seamed. Free and offline.

**Findings / gotchas:**
- **An accidental live boot proved index.ts works.** Tried to smoke-test the "fails loud without env" path with `env -i` — but Bun auto-loads `.env` from cwd regardless, so the process booted for real: gateway logged in, registered commands on the guild, worker idled until killed. Unintended but harmless (queue was empty), and it *was* a successful boot smoke. Lesson: `bun run src/index.ts` is never env-isolated in-repo.
- Buttons arrive in advisor *threads*, so the hub's channel binding can't apply — added `hub.permitsUser()` (allowlist-only) for interactions on our own messages; channel binding stays mandatory for slash commands.

**Decisions:**
- Gateway now needs **GuildMessages + MessageContent intents** (thread Q&A replies). MessageContent is privileged — **must be enabled in the Discord dev portal before `/advise` works live**.
- `/advise` hunt results post into the advisor thread (button's channel), keeping context together rather than spamming the main channel.

**M8 live smoke (later the same day)** — both gates were already clear (allowlist filled days ago, MessageContent intent already on). Controlled boot: gateway up as `Magpie#8183`, 2 commands registered, no allowlist warning. Enqueued a real hunt directly into the queue (MX Master 3S ≤ $70): worker claimed it, live eBay search extracted **60/60 rows**, top-5 posted as embeds, row `done` at **16¢** — landed costs $37.79–$39.98, verdicts sharp (flagged a Mac-specific variant and a vague listing). SIGTERM drained cleanly in order (`worker.stopped → gateway.stopped → shutdown.done`; the `bun run` wrapper reports exit 144 on signal — cosmetic).
- **Cost profile:** extraction output tokens dominate hard — $0.118 of the $0.157 total was `extractListings` on Sonnet (10k output tokens for 60 rows). At 16¢/hunt a single daily watch is ~$5/mo; fine, but running extraction on Haiku is now clearly the first lever when Phase 2 multiplies hunt volume.

**Receive path verified by owner** — real `/hunt` and `/advise` typed in Discord against the running process; results judged good. That closes M8 and with it the Phase 1 exit criteria (SPEC §14): `/hunt` + `/advise` end-to-end, suite green (80 vitest + 15 bun), live eBay smoke passed. Branch merged to main.

**Open / next:** Phase 2 — watch scheduler (croner tick, ±10% jitter), dedup (`watch_hit`), `/watch` commands. First cost lever when volume grows: extraction on Haiku. Also worth a SPEC §13 amendment (`test:e2e` runs under `bun test`, not `@playwright/test`) and a system-map artifact refresh at this phase boundary.

### [[07-15-26 Wed]] — M4 worker + Discord surface underway (M5)

**Shipped** (continuing the Phase 1 plan on `phase-1-scaffold`):
- **M4 — worker loop.** `src/watch/worker.ts` (it lives under `watch/` per SPEC §2.2 because Phase 2's `watch_run` hunts flow through the same loop): claim → run → repeat at concurrency 1, 5s idle sleep, graceful `stop()` that never interrupts an in-flight hunt, and a belt-and-braces catch so a `runHunt` bug can't kill the queue. `src/index.ts` deliberately **not** written yet — writing it once after the gateway exists beats wiring a throwaway console reporter now and re-wiring in M5.
- **`withUsage` refactor in `llm.ts`.** Found while designing `/hunt`: the module-level `beginUsage()/endUsage()` bracket would be clobbered if a command-side `parseTarget` interleaved with a running hunt (gateway and worker share one process) — the hunt's cost would be lost entirely. Usage brackets are now AsyncLocalStorage-scoped; concurrent brackets can't cross-contaminate (test proves it), and failure paths read `usage()` from the catch block so spent cents still land on failed hunts.
- **M5 started — Discord surface.** `hub.ts` (channel binding + allowlist guard + identity; empty allowlist = deny all, flagged for the boot warning) and `commands/hunt.ts` (defer → parse → one-line confirm → enqueue; `max_price`/`sources` options act as hard overrides on the parsed spec; parse LLM cost rides onto the hunt row via `initialCostCents`).

**Decisions:**
- Command handlers are coded against narrow structural "interaction ports" (`HuntInteractionPort`) rather than discord.js types — the real `ChatInputCommandInteraction` satisfies them structurally, and handler tests use plain fakes (SPEC §12's "handler level with mocked interactions") with the *real* `parseTarget` running through the LLM seam, so cost attribution is tested end-to-end.
- `DEFAULT_SOURCES` exported from the registry so the `/hunt` confirmation line states the effective sources instead of hardcoding "eBay".

**Open / next (paused mid-TDD):** `tests/unit/report.test.ts` is written and RED — `src/discord/report.ts` (Reporter port → header + embed cards, nothing-found card, error embed + a new `buildErrorEmbed` in embeds.ts) is the next GREEN step. Then gateway.ts (client, guild-scoped registration, hub-guarded routing) → `index.ts` composition root → M6 `/advise` → M7 offline e2e → M8 live gates → PR.

### [[07-14-26 Tue]] — Phase 1 scaffold begins: config, DB/queue, sources layer

**Shipped** (overnight autonomous session, branch `phase-1-scaffold`, milestones M0–M2 of the approved plan):
- **M0 — real project scaffold.** `tsconfig.json` (strict), `src/config.ts` (typed loader for all SPEC §10 vars, empty-string-as-unset, allowlist csv → array), `src/log.ts`, and the test-runner split: vitest owns `tests/unit/**`, `bun test` owns `tests/bun/**` (via `bunfig.toml` `[test] root`) so the 07-10 bun:sqlite/vitest finding is solved structurally, not by convention.
- **M1 — DB layer.** Full six-table SPEC §5 schema in one baseline Drizzle migration (watch/profile tables land now, logic later). drizzle-kit is codegen-only; migrations apply at runtime via the bun-sqlite migrator, so drizzle-kit never needs a driver. `claimNextHunt()` is a single atomic `UPDATE … RETURNING` with a rowid FIFO tie-break. Repos are factories over an injected db + clock, coded against `HuntsRepo`/`ListingsRepo` interfaces so everything above the DB stays vitest-testable.
- **M2 — sources layer.** `SourceAdapter` interface (`search()` returns `RawListing[]`; pure `toListing()` → §5.4 shape, `null` = unusable row), registry with `resolveAdapters` (unknown ids skipped loudly; fixture source opt-in only, never default), eBay promoted into the adapter shape, and a **deterministic fixture adapter** over a hand-authored local static site — the engine's offline/free e2e path. `pacing.ts` landed (per-source min-gap + hourly sliding window, injectable clock). 22 vitest + 13 bun tests green, incl. real-Playwright fixture-adapter tests on a throwaway browser.

**Decisions:**
- `@playwright/test` dropped for Phase 1: the SPEC §13 `test:e2e` script would run under Node where `bun:sqlite` doesn't exist; the e2e uses the playwright *library* under `bun test` instead (`test:e2e` = `bun test tests/bun/e2e`). SPEC needs a one-line amendment.
- `llm.ts` model init went lazy (was module-top-level env reads) so adapters/extract stay importable under vitest with the LLM mocked.
- Fixture HTML is hand-authored (a stable fake-market markup contract with deliberate edge-case cards), not captured eBay HTML — we control the edge cases and dodge markup churn.
- Empty `DISCORD_ALLOWED_USER_IDS` will mean *warn loudly at boot, deny all interactions* (it's still empty in `.env`) — so overnight live verification is send-only; the receive path gets exercised once the allowlist is filled.

**Open / next:** M3 engine orchestrator (`hunt.ts`, per-hunt cost accounting in `llm.ts`, deterministic pre-filter) → M4 worker + `index.ts` → M5 gateway + `/hunt` → M6 `/advise` → M7 offline e2e → M8 live gates → stretch Phase 2 groundwork → PR.

### [[07-11-26 Sat]] — System map artifact

**Shipped:**
- Published a one-page architecture/system-design artifact for Magpie — physical topology, layered service architecture, the three engine-mode data flows, and the load-bearing invariants: https://claude.ai/code/artifact/2d576775-2542-4021-b5d4-cf9e1a7d4955. Styled as a sibling of the Sibyl system map (same editorial layout, magpie-teal palette instead of Sibyl gold).
- The live-vs-planned split reflects the *repo's* actual state, not the spec's aspiration: Phase 0 pieces (`session.ts`, `ebay.ts`, `target/extract/rank/llm`, `embeds.ts`) marked built; everything Phase 1+ dashed with its phase tag, including the pulled-forward `pacing.ts` and the `bun:sqlite`/vitest test split from the 07-10 finding. Worth re-publishing at phase boundaries so it stays honest.

### [[07-10-26 Fri]] — bun:sqlite doesn't work under vitest

**Findings / gotchas:**
- **`bun:sqlite` cannot be imported inside a vitest test file, full stop.** Confirmed with a throwaway probe (`tests/probe-bun-sqlite.test.ts`): `vitest run` (invoked via `bun run test`) fails with `Cannot find package 'bun:sqlite'`. Tried the two standard workarounds — `test.server.deps.external: [/^bun:/]` and `pool: 'threads'`, together and separately — neither works. With externalization on, the error changes to Node's ESM loader rejecting the `bun:` scheme outright (`Only URLs with a scheme in: file, data, and node are supported`), which means vitest/vite-node's module runner falls back to a Node-based loader for native-protocol imports regardless of which runtime (`bun run`) invoked vitest. This looks like a real vitest/vite-node limitation, not a config mistake on our end.
- This matters immediately: CLAUDE.md commits to `bun run test = vitest run`, and the next unchecked Phase 1 item is `src/db/client.ts` on `bun:sqlite`.

**Decisions:**
- Keep `bun:sqlite` as the Phase 1 db driver (not switching to `better-sqlite3`). `src/db/client.ts` stays a thin `bun:sqlite` singleton; everything built on top of it (`hunts.ts`, `listings.ts`, repositories) is unit-tested in vitest via mocks/fakes, never a live db. A small number of true integration tests exercise the real sqlite path via `bun test` (Bun's native runner) instead of `vitest run`. Recorded in `CHECKLIST.md` under Phase 1 Database.

### [[07-09-26 Thu]] — Discord embeds land; eBay adapter was scraping the wrong DOM

**Shipped:**
- `src/discord/embeds.ts` — pure embed builders (listing card, nothing-found card, results header), no client/IO, ready for Phase 1 to promote.
- `scripts/smoke-discord.ts` — send-only gateway login (real `Client`, not a webhook, so Phase 1 reuses the same plumbing) posting the ranked top-5 as one message.
- **Phase 0 closed.** MX Master 3S: 60/60 rows extracted, top-5 all genuine units, every card links to a resolving `/itm/` listing. ~14.0k in / 12.7k out tokens, ~104s per hunt.

**Findings / gotchas:**
- **The eBay adapter had been scraping the wrong DOM the whole time, silently.** `fetchResultsText` did `querySelector('ul.srp-results') ?? document.body` — and eBay serves *two different result layouts*: `li.s-card` under `ul.srp-results` when **signed out**, `li.su-grid__item` under `ul.su-grid` when **signed in**. Since the persistent profile is signed in, the selector missed, the `?? document.body` fallback swallowed it, and extraction ran over whole-page innerText. It *looked* fine (41 rows, sane verdicts) because the listing text is in the body either way. The tell was every `url` coming back `null`. Adapter now matches either card class, and throws when zero cards match rather than falling back.
- **That silent fallback was also the "intermittent empty-extraction flake"** logged 07-08 (838-token page text, 0 rows) — not a settle race. Same root cause, different symptom.
- `innerText` drops hrefs, so the extractor never had a URL to extract; no amount of prompt work would have fixed it. Reduced text is now one block per card: card text + `URL: <canonical /itm/ url>` (query params stripped).
- The signed-in SRP ships a **template anchor** pointing at the placeholder `ebay.com/itm/123456`. Taking the first `a[href*="/itm/"]` per card would have emitted a fake link that still renders as a valid card. Item links now require `/itm/\d{9,}`.
- eBay bounced us through `https://www.ebay.com/splashui/challenge` (bot check) after ~8 rapid headless loads. It auto-redirected back and results rendered, but this is the first real sighting of eBay's bot detection — `loadResults` now detects the challenge URL and fails with a clear message instead of blindly retrying (retrying a bot check makes it worse). Argues for landing `src/browser/pacing.ts` sooner than Phase 1 nominally requires.
- Sponsored badges arrive in innerText as `derosnopS` — "Sponsored" reversed via a CSS direction flip, an anti-scraper trick. Stripped as noise.

**Decisions:**
- Embed titles use `setTitle` + `setURL`, not the design spec's masked `[title](url)` — Discord doesn't render markdown in embed titles, so the masked form would show literally. Same clickable result.
- `buildResultsHeader` takes an explicit `shownCount` rather than hardcoding "top 5", so a 2-result hunt doesn't claim 5.
- Extraction budget raised 12k → 16k chars: the per-card URL line costs ~40 chars/row, and whole rows are budgeted (never a partial row — a row truncated mid-URL yields a plausible card pointing at the wrong item).

**Open / next:**
- Phase 1 scaffold: `tsconfig.json`, `src/config.ts` typed env loader, `src/index.ts`, Drizzle schema + queue.
- `DISCORD_ALLOWED_USER_IDS` is still empty — needed before any receive path exists.
- Thumbnail on the card is deferred: extraction captures no image URL yet. Location and seller rating *are* present in the card text (`Located in United States`, `seller 99.2% positive (11.8K)`) and would be cheap to add to the extraction schema.
- Consider running extraction on Haiku: it dominates cost (9.6k output tokens of the run's 12.7k).

### [[07-08-26 Wed]] — Phase 0 engine spike + in-repo log
**Shipped:**
- Browser layer: persistent-context Chromium (`src/browser/session.ts`) with a real-Chrome UA and `HEADLESS` toggle; `scripts/login.ts` for the one-time manual eBay login (session persists across restarts, profile mode 700).
- LLM wrapper (`src/engine/llm.ts`) over OpenRouter / Claude Sonnet 5 — single call path with token accounting.
- Target parser (`src/engine/target.ts`) and eBay guided search + extraction (`src/sources/ebay.ts`, `src/engine/extract.ts`). End-to-end smoke: freeform query → 40/40 valid structured listings off live eBay.
- Ranking (`src/engine/rank.ts`): pure `landedCost` (price + shipping) sort + a single batched LLM verdict pass. Verdicts are sharp — correctly flag accessories/parts and a suspiciously-cheap "mouse".
- This in-repo `log.md` convention + `/brief` integration.

**Decisions:**
- Keep the main eBay account for Phase 0 — read-only, human-paced browsing is low-risk, and a fresh account is *more* likely to get flagged. Reserve a dedicated/burner account for Facebook Marketplace in Phase 4.
- Extraction/target schemas avoid zod `.int()/.positive()/.min()/.max()` — Anthropic structured output rejects numeric min/max keywords (fails loud with a 400). Encode such intent in `.describe()` text instead. See memory `anthropic-structured-output-schema-limits`.
- Project log lives in-repo (`log.md` at root) and complements commits; retired the dead `VAULT_LOG_PATH` vault rollup.

**Findings / gotchas:**
- Empty-string env vars copied from `.env.example` (`BROWSER_PROFILE_DIR=`) silently override `??` fallbacks — the persistent profile was landing in an ephemeral dir and logins wouldn't have survived. Fixed by treating `""` as unset.
- OpenRouter is prepaid; the first real LLM call 402'd until credits were added.
- Per-hunt token cost is dominated by extraction *output* tokens (~5.6k out for 40 rows). Levers if it bites: cap extracted rows, or run extraction on Haiku while keeping verdicts on Sonnet.

**Relevance-aware ranking — built (two-pass).** First tried a single verdict pass over the cheapest 15 that also returned `matchesTarget`; it correctly re-sorted real units above accessories, but the cheapest-15 *pool* biased toward junk — the only real units it saw were suspiciously cheap ($17–20 vs ~$60–70 retail) and fairly-priced units above slot 15 never got judged. Fixed by splitting into two passes (`src/engine/rank.ts`): **pass 1** a cheap `matchesTarget` triage (bool only, no prose) over *all* extracted rows; sort `matchesTarget` desc → `landedCost` asc → top 5; **pass 2** prose verdicts for just those finalists. Smoke (MX Master 3S): top-5 are now *all* genuine units ($17.76 → $33.24, incl. a brand-new one), zero accessories/button-boards/scroll-wheels. Cost stayed modest — pass 1 in=2850/out=650, pass 2 in=762/out=321, run ~11.3k in / 6.6k out, ~54s. Ranking exit criterion met.
- Ticked all Phase-0 **Setup & secrets** boxes. Machine-verified: playwright `chromium-1228` installed, `.env` populated (443 B) + gitignored, OpenRouter working (live calls). Discord app/token/ids on owner's word (`.env` is shell-read-guarded; Discord not yet wired).

**Open / next (pick up here):**
- Post top-N as Discord embeds (first gateway wiring) — the one remaining Phase 0 checklist item; closes Phase 0.
- Watch for the intermittent empty-extraction flake: one smoke run got ~838-token page text (0 rows) before a clean retry — eBay interstitial or page not settled. If it recurs, harden `fetchResultsText` (wait-for results selector / retry).
