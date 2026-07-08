# Magpie — Project Log

Narrative record of decisions, findings, and dead-ends that don't live in commit
messages. `/brief` reads this. Newest on top.

## 2026-07

### [[07-08-26 Wed]] — Phase 0 engine spike + in-repo log
**Shipped:**
- Browser layer: persistent-context Chromium (`src/browser/session.ts`) with a real-Chrome UA and `HEADLESS` toggle; `scripts/login.ts` for the one-time manual eBay login (session persists across restarts, profile mode 700).
- LLM wrapper (`src/engine/llm.ts`) over OpenRouter / Claude Sonnet 5 — single call path with token accounting.
- Target parser (`src/engine/target.ts`) and eBay guided search + extraction (`src/sources/ebay.ts`, `src/engine/extract.ts`). End-to-end smoke: freeform query → 40/40 valid structured listings off live eBay.
- This in-repo `log.md` convention + `/brief` integration.

**Decisions:**
- Keep the main eBay account for Phase 0 — read-only, human-paced browsing is low-risk, and a fresh account is *more* likely to get flagged. Reserve a dedicated/burner account for Facebook Marketplace in Phase 4.
- Extraction/target schemas avoid zod `.int()/.positive()/.min()/.max()` — Anthropic structured output rejects numeric min/max keywords (fails loud with a 400). Encode such intent in `.describe()` text instead. See memory `anthropic-structured-output-schema-limits`.
- Project log lives in-repo (`log.md` at root) and complements commits; retired the dead `VAULT_LOG_PATH` vault rollup.

**Findings / gotchas:**
- Empty-string env vars copied from `.env.example` (`BROWSER_PROFILE_DIR=`) silently override `??` fallbacks — the persistent profile was landing in an ephemeral dir and logins wouldn't have survived. Fixed by treating `""` as unset.
- OpenRouter is prepaid; the first real LLM call 402'd until credits were added.
- Per-hunt token cost is dominated by extraction *output* tokens (~5.6k out for 40 rows). Levers if it bites: cap extracted rows, or run extraction on Haiku while keeping verdicts on Sonnet.

**Open / next:**
- Phase 0 ranking: deterministic `landedCost` (price + shipping) sort + one-line LLM verdict per top listing.
- Then post top-N as Discord embeds (first gateway wiring).
