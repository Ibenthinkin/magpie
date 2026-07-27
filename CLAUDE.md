# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Magpie is

A **personal, single-user, homelab-hosted AI shopping agent**: a Playwright-driven browser agent (real Chrome, persistent logged-in profile) that hunts best prices, turns fuzzy needs into concrete product specs, and watches standing wishlists — driven through a **Discord bot**. Strictly personal, never a product: no auth, no multi-tenancy, no web UI, outbound-only network surface.

**`SPEC.md` is the build-ready source of truth** — read it before scaffolding or making architectural decisions. It carries the full data model, engine flow, adapter interface, Discord surface, and phased build order. This file is the orientation layer; SPEC.md is the detail.

## Project status

Pre-scaffold. Repo currently holds `SPEC.md`, `package.json` (deps installed), and config stubs — **no `src/` yet**. The scripts below are specified in SPEC.md §13 and must be added to `package.json` as the code lands.

## Commands

```bash
bun run dev          # bun run --watch src/index.ts (headed browser available)
bun run start        # bun run src/index.ts
bun run login        # HEADLESS=false bun run scripts/login.ts — one-time manual login into sources
bun run db:generate  # drizzle-kit generate
bun run db:migrate   # drizzle-kit migrate
bun run test         # vitest run  (single test: bun run test -- <path> -t "<name>")
bun run test:e2e     # playwright test
```

Bun is both runtime and package manager (no npm/node). Set `LIVE_LLM=1` to opt a mocked-LLM test into a real (cheap-model) call.

## Architecture (big picture)

**One long-lived Bun process** (`src/index.ts`) hosts three concerns with no external broker — *the queue is a SQLite table*:

1. **Discord gateway** — receives commands, writes `hunt`/`watch` rows, renders result/notification embeds.
2. **Hunt worker** — single loop, concurrency 1: `claimNextHunt()` (atomic SQLite update) → run engine → report → repeat.
3. **Watch scheduler** — croner tick every 60s marks due watches and enqueues `watch_run` hunts (mode B is mode A on a timer + dedup).

**The three user modes are three modes of one engine, not three products:** A = one-shot `/hunt`, B = scheduled `/watch`, C = `/advise` (a need→spec reasoning step *before* the engine). Everything funnels through `src/engine/hunt.ts` and produces `hunt` rows.

Layer layout (all under `src/`, per SPEC §2.2): `discord/` (gateway, commands, embeds, hub) · `engine/` (hunt, advisor, target, extract, rank, llm) · `browser/` (session, pacing) · `sources/` (SourceAdapter per source; `ebay.ts` + `fixture.ts` first) · `watch/` (scheduler, worker, dedup) · `db/` (Drizzle schema, client, repositories).

### Load-bearing invariants

- **Persistent browser profile is the crown jewel.** `browser-profile/` holds live logged-in sessions — gitignored, mode 700, never leaves the host, never screenshotted to Discord. `chromium.launchPersistentContext`, one context, serialized use.
- **Adapters are guided, not free-form.** Each adapter knows its source's search-URL pattern and walks result pages deterministically; the **LLM is used for extraction (messy page text → structured listings), not navigation**, on the happy path. Free-form LLM/vision navigation is fallback-only.
- **Extracted page text is untrusted input.** Extraction prompts treat it as data-to-parse via schema-constrained `generateObject` (zod-validated, invalid rows dropped not crashed) — never as instructions. Verdicts cite only structured fields. This is the prompt-injection boundary.
- **Ranking = deterministic math first, LLM second.** `landedCost()` (price + shipping − membership/coupon discounts) is pure and unit-tested; the LLM verdict pass is a one-line judgment layer on top.
- **Fail loud, never silent.** A broken adapter fails that source only and continues; a failed hunt marks the row `failed` and reports to the channel. Site drift should break one file loudly, caught by fixture tests.
- **Reliability across restarts.** Queue state lives in SQLite; `resetStaleRunning()` returns orphaned `running` hunts to `pending` on boot.
- **Cost discipline.** Target $10–50/mo LLM ceiling. Playwright-first (text/DOM, no screenshots on happy path); every LLM call flows through the `src/engine/llm.ts` wrapper that accumulates tokens into `hunt.cost_cents`. Watch cadence defaults conservative (daily); scheduler adds ±10% jitter so watches don't thundering-herd.
- **Hub, no premature framework.** `src/discord/hub.ts` factors channel-binding/allowlist/identity for future reuse, but stays one file (not a package) until a second agent exists (SPEC Phase 5).

### Access control

Bot responds only in its bound channel (`DISCORD_CHANNEL_ID`) and only to allowlisted ids (`DISCORD_ALLOWED_USER_IDS`); all else ignored. Slash commands are guild-scoped (instant registration, single personal server).

## Build order

Phased in SPEC §14 — follow it. **Phase 0 first: engine spike** — Playwright + logged-in profile + LLM extraction running mode A against **eBay only**, end to end, posting embeds. Validate the core loop and extraction quality before any breadth. Then Phase 1 (scaffold + `/hunt` + `/advise`), 2 (watchlists), 3 (profile/best-deal), 4 (hard sources — Marketplace/Craigslist, account-ban risk respected), 5 (generalize hub).

## Config

All secrets in `.env` (gitignored; `.env.example` committed with empty keys). Vars in SPEC §10. Never put personal data (paths, memberships, measurements) in the repo — profile facts are runtime DB data, not code.

## Project log (`log.md`)

Keep a narrative log at repo root in `log.md` — the decisions, findings, and dead-ends that don't live in commit messages. It **complements** commits (which record *what changed in code*); the planning vault's `/brief` skill reads it directly for the Daily Brief. Don't duplicate what a commit already says.

**Format** — append-only, newest on top:
- `## YYYY-MM` month groupers (newest month first).
- `### [[MM-DD-YY ddd]] — <title>` day headings (wikilink form; one entry per day — a second write the same day *extends* that entry, never adds a duplicate heading).
- Default skeleton `**Shipped:** / **Decisions:** / **Open / next:**`, but flexible — include only what's relevant (an on-demand "log the findings above" might be just a `**Findings:**` block).

**Session spend** — every entry ends with a line recording the token spend of the work it covers. **Never estimate it**; get it from the shared script:

```sh
python3 ~/.claude/scripts/session-spend.py --session <session-uuid>
```

The session UUID is the second-to-last component of the scratchpad path in your system prompt (`…/<project-slug>/<session-uuid>/scratchpad`). Paste its stdout verbatim as the last line of the entry, after the `**Open / next:**` block:

```
*Session spend: 1.24M tok (in 187 · out 38.2k · cache r 1.13M / w 61.4k) · ~$2.41 · opus-5 · 09:12→11:40*
```

- It reports the **delta since its previous run in this session**, so a second write never double-counts the first. When a later session extends the same day's entry, **add a second spend line** rather than editing the first — each covers its own session, and the time windows tell them apart.
- Subagent spend is included (attributed by time window, since subagent transcripts carry no link to the parent).
- The dollar figure is list-price arithmetic, not what the subscription actually bills.
- **If the script exits non-zero** (no transcript, or nothing new since the last entry), **omit the line entirely** — don't substitute a guess.

**Write triggers:**
1. **On-demand** — "log this" / "summarize the above and log it".
2. **At commit checkpoints** — when you commit at the user's request, update `log.md` if the work since the last entry is narrative-worthy. A considered update at a natural boundary, *not* a line per commit.
3. **End of session** — backstop for sessions that end without a commit. Only on genuine progress; skip trivial sessions.
