# Phase 0 — Discord embeds (send-only smoke)

**Status:** approved design, pre-implementation
**Phase:** 0 (engine spike — throwaway glue allowed; one file kept)
**Closes:** CHECKLIST.md "Post top-N results as Discord embeds" + the Phase 0 exit criterion.

## Goal

Validate the Discord plumbing and close Phase 0: run the existing
`query → target → eBay → extract → rank` pipeline and post the ranked top-N as
rich embeds to the bound channel. No slash commands, no gateway receive loop, no
worker — those are Phase 1. The one-shot script logs a bot in, posts, and exits.

## Scope

**In:**
- `src/discord/embeds.ts` — pure embed builders (kept and promoted by Phase 1).
- `scripts/smoke-discord.ts` — throwaway glue mirroring `scripts/smoke-rank.ts`.

**Out (deferred to Phase 1 or later, deliberately):**
- `/hunt` slash command, guild-scoped registration, defer + follow-up.
- Gateway receive loop, allowlist guard, `hub.ts` (no receive path here).
- `src/index.ts` process entry / worker.
- Thumbnail, source, location, seller-rating on the card — see "Embed card" below.

## Components

### `src/discord/embeds.ts` (kept)

Pure functions, no client or IO — trivially unit-testable when Phase 1 promotes them.

- `buildListingEmbed(listing: RankedListing, rank: number): EmbedBuilder`
  One listing card (see shape below).
- `buildNothingFoundEmbed(target: TargetSpec): EmbedBuilder`
  Explicit "nothing found" card — SPEC §3.1 requires a reply, never silence.
- `buildResultsHeader(target: TargetSpec, extractedCount: number): string`
  Plain-text content line above the cards, e.g.
  `**Magpie** · top 5 of 40 for "Logitech MX Master 3S wireless mouse"`.

### `scripts/smoke-discord.ts` (throwaway)

Mirrors `smoke-rank.ts` step-for-step, then adds the Discord post:

1. `parseTarget(query)` → `fetchResultsText(page, target)` → `extractListings` → `rankListings`.
2. `new Client({ intents: [GatewayIntentBits.Guilds] })`; `await client.login(DISCORD_TOKEN)`.
3. On ready, `channel = await client.channels.fetch(DISCORD_CHANNEL_ID)`; assert it is text-sendable.
4. Post **one message**: `{ content: header, embeds: rankedTop5.map(buildListingEmbed) }`
   (Discord allows up to 10 embeds/message; top-N is 5). Zero results → post
   `buildNothingFoundEmbed`.
5. `finally`: `await client.destroy()` and `await closeContext()`.

Query comes from `process.argv`, default `'logitech mx master 3s wireless mouse'`
(same default as `smoke-rank.ts`).

## Embed card

Built from the fields `RankedListing` actually carries today
(`title, priceCents, shippingCents, condition, url, landedCents, matchesTarget, verdict`):

- **Title:** masked link — `[<title>](<url>)`. If `url` is null, plain title.
- **Landed cost:** bold, in the description — `**$29.13 landed**` with a
  `(+$X shipping)` note when `shippingCents > 0`, else `(free/unknown shipping)`.
- **Condition:** shown when present (`Pre-Owned`, `Brand New`, …).
- **Verdict:** the one-line LLM verdict, in the description.
- **Footer:** `eBay · #<rank>`.
- **Color:** green (`0x2ecc71`) when `matchesTarget`, grey (`0x95a5a6`) when not.

**Deferred SPEC §7.2 fields and why:** thumbnail (extraction does not capture an
image URL yet — a Phase 1 extraction enhancement), source (constant `eBay` this
phase), location and seller rating (not extracted). A `// Phase 1:` comment in
`embeds.ts` marks the intended additions.

## Environment

- `DISCORD_TOKEN` — bot token.
- `DISCORD_CHANNEL_ID` — target channel.

`DISCORD_GUILD_ID` is not needed for send-only (no command registration).
Intent `Guilds` only — sending needs no `MessageContent` privileged intent.

A real gateway `Client` login is used deliberately (not a REST webhook) because
the point of Phase 0 is to exercise the same gateway plumbing Phase 1 reuses.

## Error handling (fail loud, never silent)

- Missing `DISCORD_TOKEN` or `DISCORD_CHANNEL_ID` → throw with a clear message
  before doing any work.
- Channel fetch fails, or the channel is not text-sendable → throw.
- Zero listings after ranking → post the nothing-found embed (this is a normal
  outcome, not an error).
- Browser context and Discord client are always torn down in `finally`, even on throw.

## Testing / validation

Live smoke by nature (real bot, real channel), consistent with the other
`scripts/smoke-*.ts`. Manual validation: the message lands in the bound channel,
the five cards render, links resolve, landed cost / condition / verdict read
correctly, and match/no-match coloring is right. Formal vitest for the pure
`embeds.ts` builders is held until Phase 1 promotes the file.

## Exit criterion (Phase 0)

A real query for a known item returns sanely-ranked real eBay listings, posted
as embeds to the Discord channel. Extraction quality judged good enough to
proceed. Observed per-hunt token cost noted in `log.md`.
