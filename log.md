# Magpie — Project Log

Narrative record of decisions, findings, and dead-ends that don't live in commit
messages. `/brief` reads this. Newest on top.

## 2026-07

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
