# Magpie Vision — "help me buy anything"

**Status:** north-star design. Not an implementation spec.
**Date:** 2026-07-30
**Relationship to `SPEC.md`:** `SPEC.md` remains the build-ready source of truth for what exists. This document defines where Magpie is going, reframes the engine model to accommodate it, and resequences `SPEC.md` §14's phase list. Each phase below gets its own spec → plan → implementation cycle when its turn comes; nothing here is buildable as written.

---

## 1. The ambition

Magpie today hunts the cheapest listing for a specific item across a handful of hand-written sources. The target is broader: **any time Ben buys anything, Magpie helps** — by comparing options, finding the right product, or saving money.

Concretely, that means Magpie should be able to:

- Reach obscure, category-specific marketplaces (Japanese camera auction sites, niche resale communities) without someone hand-writing an adapter for each.
- Search for a *style* — "a boxy heavyweight cream tee" — across new (Etsy) and used (Poshmark, Vinted, Depop) simultaneously, matching on how things look rather than what they're called.
- Know Ben's preferences well enough to make judgment calls, and ask when a judgment call would be wrong.
- Track routine purchases (Amazon, groceries) and know what a good price actually is.
- Ingest forwarded promotional email and apply it, unprompted, to things Ben is already waiting on.
- Be talked to in plain language rather than driven by slash commands.

---

## 2. The reframe: dimensions, not modes

`SPEC.md` §1's core insight was *"three user modes are three modes of one engine."* That framing does not survive contact with the ambition above — but the underlying instinct does. The fix is to stop enumerating modes and start parameterizing one engine along four dimensions:

| Dimension | Values |
|---|---|
| **Target kind** | `exact` — a specific product · `style` — a described or depicted look · `consumable` — a tracked repeat purchase |
| **Objective** | `cheapest` — landed-cost sort · `best_fit` — match quality first, price as tiebreak · `best_value` — price relative to observed history |
| **Trigger** | user request · schedule · promo arrival · price threshold crossed |
| **Sources** | resolved from the source catalog by target tags |

Under this model the existing surface is unchanged, just re-expressed:

- `/hunt` → `(exact, cheapest, user request)`
- `/watch` → the same on a schedule
- `/advise` → still a reasoning step that *produces* a `TargetSpec`, unchanged
- t-shirt hunting → `(style, best_fit, user request)`
- routine coffee → `(consumable, best_value, promo arrival or schedule)`

**This is the load-bearing constraint of the whole plan.** Every new capability must express itself as a point in this space and produce an ordinary `hunt` row. That preserves the queue, the worker, dedup, boot recovery, cost accounting, and the embed vocabulary exactly as they are. Any feature that cannot be expressed this way should be challenged before it is built.

---

## 3. Subsystems

### 3.1 Source catalog

**Problem.** One hand-written adapter per source does not reach fifty sources, and certainly not a Japanese auction site used twice a year. But an LLM cannot be trusted to produce search URLs from memory — it will confidently emit `mercari.jp/search?q=` when the real pattern is `jp.mercari.com/search?keyword=`.

**Solution.** A `source` table is the authority on where Magpie can look. Rows are populated by three mechanisms:

| Mechanism | Description | Frequency |
|---|---|---|
| **Seed** | Ben names 20–40 sites he already uses | Once, up front |
| **Probe** | Magpie learns a source's search-URL template by *driving it* | Per source, at add time |
| **Discover** | A hunt finds no catalog source tagged for the target → Magpie web-searches for candidates, probes them, and asks for approval | Rare |

**Probing is the mechanism that makes this work.** `/source add jp.mercari.com` opens the site in the persistent browser context, locates the search box, submits a probe query, and records the resulting URL with the probe term replaced by `{query}`. The template is therefore *observed, not guessed*. Magpie then extracts from the results page, shows a sample back, and asks only for metadata it cannot infer (ships-to, new/used/both, category tags).

Discovery is explicit and requires approval rather than running automatically mid-hunt. The catalog absorbs its output permanently, so an obscure category costs one discovery round ever, and is a cheap lookup thereafter.

**Adapters become an override, not the only path.** A generic adapter — URL template plus the existing source-agnostic LLM extraction — handles most sources. Hand-written adapters remain for the few worth their maintenance cost (eBay, Craigslist, Facebook Marketplace), and eBay and Craigslist migrate to catalog rows that point at their existing adapters.

**Known failure mode.** A login-walled source (Poshmark, Marketplace) cannot be probed until Ben has logged in via `bun run login`. The probe must detect a login wall and fail loudly rather than record a template pointing at a sign-in page. Catalog rows carry `requires_login` for this reason.

**Cost consequence.** The generic adapter trades maintenance for tokens: without hand-written structure, more page text reaches the model. Breadth therefore costs money per hunt, which is why the catalog should record per-source result quality — so sources that never earn their keep can be demoted.

### 3.2 Price history

`listing` upserts by `(source, source_id)` and overwrites `price_cents`, so Magpie knows today's price but cannot say whether it is a good one. An append-only `price_point` table fixes this.

This is a small change with disproportionate payoff. It is a hard prerequisite for the `best_value` objective and for routine tracking, and it improves hunts that already work — *"lowest it's been in 3 months"* is most of what makes a price agent feel intelligent.

**Two caveats.** First, history accrues from the day it ships; the feature is worth nothing on day one and compounds from there, so it belongs early for that reason alone. Second, observations are keyed by **listing** identity, which is the right grain for `exact` hunts but the wrong one for consumables — the same coffee is a different listing on Amazon and at a big-box store. A product-level identity that rolls listings up is a real unsolved piece, deferred to Phase 10 where routines first need it.

### 3.3 Promotions inbox

Ben forwards promotional email to a dedicated mailbox. Magpie polls it over IMAP, parses each message into a structured promo, and applies it.

**This fits the existing discount rule rather than loosening it.** `SPEC.md` §6.5 requires a fact to name the listing's source before Magpie will do arithmetic with it, and §15 resolved that Magpie does not go hunting for coupons. Both hold: a promo email inherently names its source (it is *from* the retailer), and the promos still originate with Ben — he is handing them over by forwarding instead of typing `/profile add`.

**Promos need their own table because they expire.** `profile_fact` has no notion of time. A `promo` row carries valid-from, valid-until, code, and terms, so an expired discount stops affecting rankings instead of quietly producing wrong numbers.

**Promos are active, not passive.** On arrival, a parsed promo is cross-checked against active watches and tracked routines; if it makes something Ben is already waiting on a genuinely good deal, Magpie says so unprompted. Magpie also warns before a useful promo expires unused.

**Known failure mode.** This is the feature most likely to become notification noise. Loose parsing plus proactive push is a bad combination. Nudges should require a concrete intersection with an existing watch or routine — never a generic "here's a sale."

### 3.4 Preference model

Preferences extend `profile_fact` rather than getting a new table, but the existing shape is too flat. Two columns are needed:

- **`scope`** — which target categories a preference applies to. "Quality over color" is not a universal truth; it applies to clothing, not to hard drives.
- **`provenance`** — `stated` (onboarding), `inferred` (observed from choices), or `corrected` (Ben overrode an assumption). Corrections should outrank inferences.

Preferences are gathered two ways. An **onboarding interview** bulk-writes stated preferences up front. **Assume-and-learn** refines them one at a time thereafter.

**Hunts never pause for input.** Magpie clarifies *before* a hunt starts only when the answer would change which sources get searched or would blow the budget. Otherwise it assumes, states the assumption alongside results, and learns from the correction:

> *"Hunting: linen shirt, ≤$120 — optimized for fabric quality over exact color, since that's what you've picked before."*
> *"actually color matters more here"* → recorded, applied next time.

**Rejected: suspendable hunts.** Letting a hunt block on a Discord reply would require an `awaiting_input` status, resume logic, timeouts for unanswered questions, and stale-parked-hunt recovery on boot — significant complexity in the most reliable part of the system, for a marginal gain over assume-and-learn.

### 3.5 Style matching

`landedCost()` cannot rank a style hunt. There is no canonical product; dozens of different garments are candidates, and the winner is whichever best matches a description, with price as a tiebreak. This is the `best_fit` objective.

On resale sources the listing text is nearly useless — *"EUC cream tee sz M"* — and everything that matters is in the photograph. Style matching therefore requires **vision on the happy path**, which cuts against `SPEC.md` §4's "no screenshots on the happy path" cost rule.

**The cheap resolution: thumbnails, not screenshots.** `listing.image_url` is already extracted (§5.4). Scoring thirty thumbnails in a single vision call is far cheaper than screenshotting thirty pages, and it crosses no trust boundary that extracted page text does not already cross.

`TargetSpec` gains `referenceImages`, so Ben can attach a photo to Discord as the target — *"find me this jacket, new or used"* — and candidates get matched against it.

### 3.6 Routines

Tracked repeat purchases, ranked by `best_value` against observed price history.

Magpie reads Amazon order history **once** through the logged-in browser, proposes the repeat purchases it finds, and Ben confirms which to track. After seeding, routines are curated by hand.

**Rejected: continuous order-history sync.** Regularly driving a logged-in Amazon account is exactly the behavior `SPEC.md` §15 flags as ban risk, and it accumulates far more purchase data than the feature needs. One-time seeding gets most of the value at a fraction of the exposure.

**Grocery is a separate difficulty tier and must not block Amazon.** Amazon is one national catalog behind a login the profile already holds. Grocery pricing is per-store, gated behind a zip or store picker, often behind a loyalty login, and frequently only visible through Instacart's markup rather than real shelf prices.

### 3.7 Intent router

Plain messages in the bound channel are classified into an existing action (hunt, advise, watch, routine, profile) and routed. Slash commands still work and bypass the router entirely, remaining the precise and free path.

**Rejected: full agentic chat.** Exposing the engine as tools to an agent loop is more capable and more natural, but per-exchange cost becomes unbounded, failures stop being localizable to one component, and the determinism guarantees in `SPEC.md` §4 weaken substantially. The router keeps exactly one fuzzy component in the path; everything behind it stays a deterministic, testable unit.

The tradeoff accepted: every casual message in the channel costs one classification call. At personal volume, behind the existing allowlist, this is acceptable.

---

## 4. Schema additions

| Table | Purpose |
|---|---|
| `source` | catalog: name, homepage, search-URL template, category tags, region, `requires_login`, adapter override, result-quality tracking |
| `price_point` | append-only price observations, keyed by listing identity (`source`, `source_id`) |
| `promo` | parsed promotional offers with validity window, code, terms, source scope |
| `routine` | tracked repeat purchases with baseline price |

Modified:

| Table / type | Change |
|---|---|
| `profile_fact` | adds `scope`, `provenance` |
| `TargetSpec` | adds `kind`, `objective`, `referenceImages` |

---

## 5. Cost posture

**The $10–50/mo ceiling in `SPEC.md` §4 is genuinely at risk.** Vision on style hunts, a classification call on every casual message, and broader source routing all push the same direction, and the generic adapter raises per-hunt extraction cost on top.

A **hard budget guard** is therefore a design element, not a footnote: a monthly cents ceiling that **degrades gracefully** — skipping the vision pass and falling back to text matching, narrowing the source set — rather than a target discovered to have been blown after the fact. It ships in the first new phase, deliberately before anything expensive.

The **Haiku A/B test**, currently parked in Phase 4, becomes load-bearing rather than nice-to-have. Knowing what a cheap model costs in extraction quality is a prerequisite for budgeting the generic adapter.

---

## 6. Resequenced roadmap

Phases 0–3 are merged. Phase 4 is mostly merged (Craigslist, hardening, geo), with Facebook Marketplace and the Haiku A/B test outstanding. Everything below follows.

| Phase | Scope | Exit criteria |
|---|---|---|
| **5 — Foundations** | `price_point` table; monthly budget guard with graceful degradation | Repeat hunts on one item accumulate observations and the verdict cites them once there is history; exceeding budget degrades to text-only instead of billing |
| **6 — Promo inbox** | IMAP poll, parser, `promo` table, watch/routine cross-check, expiry nudges | A forwarded retailer email changes a ranking, and warns before expiring unused |
| **7 — Source catalog** | `source` table, prober, tag router, generic adapter; eBay + Craigslist migrate to catalog rows with adapter overrides; seed 20–40 sites | `/source add jp.mercari.com` learns a working template; a hunt reaches a source nobody wrote a file for |
| **8 — Conversational layer** | Preference model (`scope`, `provenance`), onboarding interview, intent router | A slash-free sentence produces a real hunt; a correction sticks across hunts |
| **9 — Style hunting** | Reference images, thumbnail vision scoring, `best_fit` objective, Etsy/Poshmark/Vinted via catalog | A photo plus "new or used" returns candidates worth buying |
| **10 — Routines** | Order-history seeding, `routine` table, Amazon + big-box tier | Magpie proposes repeat buys from order history and flags one below baseline |
| **11 — Grocery** | Store/zip selection, loyalty logins, per-store pricing | One store, one basket, real shelf prices |
| **12 — Hub** | Extract `hub.ts` into reusable multi-agent infrastructure | A second agent uses it |

**Sequencing rationale.**

- **Foundations first** because both pieces are small and both are instrumentation for everything after. The budget guard specifically must precede vision and broad routing.
- **Promos before catalog** by preference: promos are fully independent, have the best value-per-effort ratio in the plan, and touch the least. Nothing downstream depends on the order of 6 and 7.
- **Conversational after catalog** so that "find me X" has somewhere good to look before the surface invites open-ended asks.
- **Style late** because it needs the catalog for sources, the preference model for judgment, and the budget guard for safety. Moving it earlier is the change most likely to produce a surprising bill.
- **Grocery last** because it is materially harder than everything above it and must not be allowed to block anything.
- **Hub unchanged** from `SPEC.md` §14 — still gated on a second agent actually existing.

**Facebook Marketplace stays a hand-written adapter** and does not wait for Phase 7. It is precisely the case the catalog does not solve: hostile to automation, no stable search URL, real ban risk.

---

## 7. Invariants preserved

Nothing in this document changes the following, and any implementation that would should be challenged:

- **One engine, one `hunt` row.** New capabilities are points in the dimension space of §2, not parallel pipelines.
- **The persistent browser profile is the crown jewel.** Still gitignored, mode 700, never leaves the host.
- **Extracted page text is untrusted input.** Schema-constrained extraction, invalid rows dropped not crashed. Thumbnails and reference images get the same treatment — framed as data to parse, never as instructions.
- **Deterministic math first, LLM second.** `landedCost()` stays pure and unit-tested. `best_fit` adds a second objective; it does not make the first one fuzzy.
- **Fail loud, never silent.** A broken source fails that source only. A failed probe records nothing.
- **Outbound-only.** IMAP polling is a pull, so no inbound surface appears.
- **Discounts originate with Ben.** Magpie applies what it was given — typed or forwarded — and does not go looking for coupons.

---

## 8. Open questions

- **Catalog tag vocabulary.** Routing quality depends entirely on how target tags and source tags are drawn from the same space. A free-form tag soup will route badly. Resolve in Phase 7.
- **Per-source quality tracking.** The catalog should demote sources that never produce useful results, but the metric is unclear — result count, click-through, rank position? Needs real usage data.
- **Style hunt dedup.** `watch_hit` dedups by listing identity, which works for `exact`. A style watch will see a stream of different-but-equivalent garments; notifying on each is noise. Deferred to Phase 9.
- **Promo parsing precision.** Retail email is adversarially designed to look urgent. The false-positive rate determines whether §3.3's nudges are useful or intolerable. Measure before enabling nudges.
- **Whether the $10–50/mo ceiling survives.** The guard makes overruns safe, not impossible. If the real number lands above the ceiling, the ceiling should be revisited honestly rather than the features quietly cut.
