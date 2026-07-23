# Magpie — Project Log

Narrative record of decisions, findings, and dead-ends that don't live in commit
messages. `/brief` reads this. Newest on top.

## 2026-07

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
