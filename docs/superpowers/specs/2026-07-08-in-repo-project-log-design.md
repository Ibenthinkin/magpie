# In-repo project log (`log.md`) — design

**Date:** 2026-07-08
**Status:** Approved, pending implementation plan

## Problem

Magpie's narrative — decisions, findings, dead-ends, the *why* behind changes — has
nowhere durable to live. Commit messages capture *what changed in code* but miss the
reasoning and discussion around it. The planning vault's `/brief` skill, which
produces Ben's Daily Brief, can only see Magpie through raw `git log` one-liners
(Magpie is a "hybrid" project: code in `~/Dev/magpie`, project note in the vault).
So exactly the narrative that never hits a commit message is invisible to the brief.

The vault already solves this for *vault-native* projects: each keeps an append-only
`05 Projects/<name>/log.md` that `/brief` reads (the "pull model"). Code repos are
the gap. The existing CLAUDE.md "Rollup to planning vault" step was meant to bridge
it via `VAULT_LOG_PATH`, but that var is empty in `.env`, so nothing is written.

## Solution

Give the repo its own append-only `log.md` at the root, mirroring the vault's
project-log convention, and teach `/brief` to read it. The log **complements**
commits — commits stay the record of code changes; the log carries narrative and
decisions. `/brief` reads both, summarized, without duplication.

This is a small extension of a proven pattern, and it generalizes: any repo that
drops a root `log.md` gets richer brief entries automatically.

## The artifact: `log.md`

Location: **repo root** (`~/Dev/magpie/log.md`) — exact mirror of the vault's
`05 Projects/<name>/log.md`, so `/brief`, which already resolves a hybrid project's
repo path, reads `<repo>/log.md` with no extra path convention.

Structure — append-only, newest on top:

```markdown
# Magpie — Project Log

Narrative record of decisions, findings, and dead-ends that don't live in commit
messages. `/brief` reads this. Newest on top.

## 2026-07

### [[07-08-26 Wed]] — Phase 0 engine spike
**Shipped:** browser session, LLM wrapper, target parser, eBay search + extraction (40/40 rows).
**Decisions:** kept main eBay account (burner reserved for FB Marketplace, Phase 4);
extraction schemas avoid zod `.int()/.positive()` (Anthropic rejects numeric min/max).
**Open / next:** landedCost + verdict ranking; watch extraction output-token cost.
```

Conventions:

- `## YYYY-MM` month groupers, newest month first.
- `### [[MM-DD-YY ddd]] — <title>` day headings — wikilink form for vault
  consistency and so `/brief` can date-filter them.
- `**Shipped:** / **Decisions:** / **Open / next:**` are the default skeleton but
  flexible: only include what's relevant. An on-demand "log the findings above"
  entry might be just a `**Findings:**` block.
- One entry per day; a second write the same day **extends** that day's entry rather
  than adding a duplicate heading.

## Write triggers

The log is a convention Claude follows — no hooks or forced automation.

1. **On-demand** — "log this" / "summarize the above and log it" → append or extend
   today's entry.
2. **At commit checkpoints** — when Claude commits at Ben's request, it updates
   `log.md` if the work since the last entry is narrative-worthy. This is a
   *considered* update at a natural boundary, **not** a line per commit (that would
   be commit-granular noise, redundant with the commit message). Because Claude only
   commits when asked, every commit is already a deliberate checkpoint, so this is
   low-noise by construction. Skip if trivial or already logged.
3. **End of session** — backstop for sessions that end without a commit. Only on
   genuine progress; trivial sessions are skipped.

## `/brief` integration (edits the vault repo)

Edit `~/vaults/Memory-Palace/.claude/skills/brief/SKILL.md`, step 2 ("Catch
code-repo commits"):

- After resolving a hybrid project's `repo:` path, **read `<repo>/log.md`** and pull
  `### [[date]]` sections dated after the last brief's day. Use these as the
  project's narrative in its rollup bullet.
- **Keep** the existing `git log --since=<last brief date>` scan (the log complements
  commits, it does not replace them). Fold commit detail in alongside the log
  narrative, summarized — do not duplicate what the log already says.
- Skip cleanly if `log.md` is absent: such repos fall back to commits-only, exactly
  as today. This keeps the change backward-compatible and general across repos.

## Scope of edits

**Magpie repo:**

- New `log.md` at root, seeded with a `2026-07` / `[[07-08-26 Wed]]` entry covering
  the Phase 0 spike work done so far.
- `CLAUDE.md`: rewrite the "Rollup to planning vault" section into "Rollup to in-repo
  log," documenting the three triggers and the format above.
- `.env.example`: remove the now-dead `VAULT_LOG_PATH` var.

**Vault repo:**

- `.claude/skills/brief/SKILL.md`: step 2 updated as above.

## Non-goals (YAGNI)

- No hooks or automation forcing the write — it stays a convention Claude follows.
- No changes to how vault-native projects' logs work.
- No log rotation or archival yet; revisit if `log.md` grows unwieldy.
- No dedicated `/commit-and-log` command; commit-time logging is just trigger #2.

## Success criteria

- `log.md` exists at repo root with the Phase 0 entry, in the specified format.
- CLAUDE.md documents the log convention and triggers; `VAULT_LOG_PATH` is gone from
  `.env.example`.
- `/brief` reads `<repo>/log.md`, surfaces its narrative for Magpie, still folds in
  commit detail, and degrades cleanly for repos without a `log.md`.
