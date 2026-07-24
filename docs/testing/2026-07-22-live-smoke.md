# Live smoke — Phase 3 exit criterion + geo narrowing

**Written 2026-07-22. Everything below is offline-green and live-unverified.**

Two things need a real Discord + real eBay run, and only you can do them:

1. **Phase 3's exit criterion** (`CHECKLIST.md`) — a hunt where a stored membership/coupon fact
   visibly changes the ranking and the verdict cites it. Deliberately left unticked until you see it.
2. **Geo narrowing** — the eBay `_stpos`/`_sadis` params are confirmed from eBay's docs but have
   never hit a real page. If eBay quietly ignores them, everything still *looks* fine, which is
   exactly why this needs eyes.

Budget roughly **15 minutes** and **~50¢** of LLM spend (each real hunt ran ~16¢ in the Phase 1 smoke).

---

## 0 · Before you start (2 min)

```bash
cd ~/Dev/magpie
git branch --show-current          # main = Phase 3 only · phase-4-geo = Phase 3 + geo
```

**Test 4 (geo) needs `phase-4-geo`.** Tests 1–3 pass on either. Simplest is to run everything on
`phase-4-geo` — it contains all of `main`.

```bash
git checkout phase-4-geo
bun run typecheck && bun run test    # expect: clean, 154 passed
```

Sanity-check the environment without booting:

```bash
grep -c . .env                       # non-empty
grep -E '^(DISCORD_ALLOWED_USER_IDS|MAGPIE_MODEL)=' .env   # both must have values
```

> An empty `DISCORD_ALLOWED_USER_IDS` means **every interaction is denied** and the bot will look
> broken while behaving exactly as designed.

---

## 1 · Boot (2 min)

```bash
bun run start
```

**Expect, in order:**

- `[boot.ready]` with your db path
- gateway logs in as `Magpie#8183`
- **4 commands registered** — `hunt`, `advise`, `watch`, `profile` (3 before this branch; if you see
  3, `/profile` didn't register)
- **no** `boot.allowlistEmpty` warning

Leave it running. Everything below happens in the bound Discord channel.

> **Shutdown gotcha (bites every time):** `bun run start` spawns **two** pids — a `bun run` wrapper
> and the real child holding the SIGTERM handler. Killing the wrapper reports exit 144 but leaves
> the gateway **orphaned and alive**. Ctrl-C in the foreground terminal is fine. If you background
> it, signal the child: `pkill -f 'src/index.ts'`.
> A clean stop logs `shutdown.begin → worker.stopped → gateway.stopped → shutdown.done`.

---

## 2 · `/profile` CRUD (3 min)

```
/profile add category:coupon_source label:eBay coupon value:10% off ebay
```
✅ Replies `Added [coupon_source] **eBay coupon** — 10% off ebay (`<id>`). Every hunt now consults it.`
**Copy that id.**

```
/profile list
```
✅ A teal **Profile facts** embed, one line: `` `<id>` [coupon_source] **eBay coupon** — 10% off ebay ``, footer `1 fact`.

```
/profile remove id:totally-made-up
```
✅ `No active fact with id ...` — and `/profile list` is unchanged.

**Leave the real fact in place** — test 3 needs it.

---

## 3 · The Phase 3 exit criterion (5 min) ⭐

The one that matters. With the coupon fact still active:

```
/hunt query:logitech mx master 3s max_price:70
```

Watch the console for `[hunt.search] … kept=N` then two `[llm] rank…` lines, then `[hunt.done]`.

**On the cards, check all four:**

| Check | What you should see |
|---|---|
| Discount line | `Includes $X.XX membership/coupon discount` under the landed price |
| Landed price | ~10% **below** the listing's own sticker price |
| Verdict | At least one card's sentence mentions the coupon/discount |
| Footer | `eBay · #1` — the real source name, not a hardcoded string |

Also worth a glance: **Seller** and **Location** lines now appear on cards when eBay showed them.

**Then prove it was the fact doing the work:**

```
/profile remove id:<the id from step 2>
/hunt query:logitech mx master 3s max_price:70
```
✅ Same-ish listings, **no discount line**, landed prices back at sticker.

**If all of that holds, Phase 3's exit criterion is met** — tick `CHECKLIST.md` line 118 and note it
in `log.md`.

---

## 4 · Geo narrowing — the live-unverified bit (4 min)

**4a — the anchored case.** Substitute your own zip:

```
/hunt query:standing desk near <YOUR ZIP> within 25 miles
```

Two things to check, and the console one is the important one:

1. **Console** — `[ebay] search https://www.ebay.com/sch/i.html?...` should contain
   **`_stpos=<your zip>`** and **`_sadis=25`**.
   - No `_stpos`? `parseTarget` didn't pull a location out of your phrasing — try
     `/hunt query:standing desk, zip <YOUR ZIP>, within 25 miles`.
2. **Cards** — the `Location:` lines should be plausibly local. **This is the real test.** Params
   present but locations scattered nationwide ⇒ **eBay is ignoring them**, and the finding is that
   `_stpos`/`_sadis` alone are insufficient (probably needs `LH_PrefLoc` too). Say so and I'll fix it.

**4b — radius snapping.** Ask for a radius eBay doesn't support:

```
/hunt query:office chair near <YOUR ZIP> within 20 miles
```
✅ Console shows **`_sadis=25`**, not 20 — snapped *up* to eBay's ladder (10/25/50/100/200/500/1000).

**4c — the un-anchorable case.** A place name instead of a zip:

```
/hunt query:office chair near Oakland within 20 miles
```
✅ The confirmation reply carries a second line:
`(Heads up: I can only narrow by distance from a zip code — "Oakland" isn't one, so this searches everywhere...)`
✅ Console shows **no** `_stpos`/`_sadis`, plus an `[ebay] location ... is not a US zip` warning.

That's the deliberate behavior: we don't guess a zip from a place name, because a wrong centroid
searches the wrong city while looking like it worked.

---

## 5 · Optional — cheap-extraction A/B (3 min, ~30¢)

Extraction was **$0.118 of a $0.157 hunt**, so this is the biggest cost lever. It ships **off**.

```bash
# stop the process first
MAGPIE_EXTRACT_MODEL=anthropic/claude-haiku-4.5 bun run start
```

Re-run the test-3 hunt and compare against what you just saw:

- `[llm] extractListings model=anthropic/claude-haiku-4.5` confirms the routing worked
- **Row count** — did it still extract ~60/60, or did rows get dropped?
- **Quality** — any `[extract] dropped invalid row` warnings? Junk titles? Wrong prices?
- **Cost** — the `usd=` on that line vs the ~$0.118 baseline

Keep it only if row count and quality hold. If you're unsure, leave `MAGPIE_EXTRACT_MODEL` unset —
unset is exactly today's behavior, and a cheap model quietly mangling extraction is a much worse
outcome than a few extra cents per hunt.

---

## 6 · Cleanup

```
/profile list        → remove any leftover test facts
/watch list          → remove any watches you added
```

Then Ctrl-C the process and confirm the four-line clean shutdown.

---

## If something fails

A single failed hunt is **not necessarily a bug** — eBay periodically serves an interstitial or bot
challenge, and the engine is built to fail that hunt loudly and keep running (`[hunt.failed] … bot
challenge`). Retry once before treating it as real.

Worth capturing for me:

- the `[ebay] search <url>` line (shows exactly what was asked of eBay)
- any `[hunt.failed]` / `[extract] dropped` lines
- what the card showed vs what you expected
- `bun run dev` gives the same thing with reload-on-save if you want to poke at it

**Where things live:** discount math `src/engine/rank.ts` · geo URL `src/sources/ebay.ts`
(`buildSearchUrl`) · profile facts `src/db/profile.ts` · cards `src/discord/embeds.ts`.

## Scoreboard

- [ ] 1 · boots, 4 commands, no allowlist warning
- [ ] 2 · `/profile` add / list / remove
- [ ] 3 · **discounted hunt — Phase 3 exit criterion**
- [ ] 4a · `_stpos`/`_sadis` in URL **and locations actually local**
- [ ] 4b · radius snaps 20 → 25
- [ ] 4c · place-name warning, no params
- [ ] 5 · (optional) Haiku extraction A/B
