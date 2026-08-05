# Turn-shape captures — provenance and recipe

These `claude-code-2.1.222-*.jsonl` files pin the **claude JSONL turn-shape
grammar** (`../turn-grammar-claude.ts`) for prd15 ruling 1's transcript-tail
state machine. Per the dialect-verification discipline the repo already applies
to its OTel fixtures, a grammar is a **versioned capture, not documentation** —
a hand-written fixture validates our reading of the docs, not the tool.

## What was captured

Surveyed 2026-08-05 across this machine's entire Claude Code corpus:

| | |
|---|---|
| transcripts | 253 (`~/.claude/projects/*/*.jsonl`) |
| lines | 64,979 |
| conversational entries | 42,842 |
| tool versions | claude-code 2.1.220 (35,404 lines) · 2.1.221 (4,620) · 2.1.222 (6,108) |

The grammar is identical across all three versions; the filenames pin the
newest, which is also the version of the binary that produced the most recent
lines. **An upstream rename is a fixture update, not a schema migration** —
re-run the recipe below, move the version in the filenames, and update the
`capture` string on `CLAUDE_JSONL_GRAMMAR` (its test asserts they agree).

## The files, and why each exists

Each captures one **outcome**, success and absence both — conformance rule 1.

| file | tail shape it pins | corpus frequency |
|---|---|---|
| `-tail-turn-complete.jsonl` | `turn-complete` via `stop_reason: end_turn`, **followed by bookkeeping lines** | 212 of 253 file tails |
| `-tail-stop-sequence.jsonl` | `turn-complete` via `stop_reason: stop_sequence` | 26 of 253 |
| `-tail-pending-tool.jsonl` | `pending-tool` — an assistant `tool_use` block awaiting its result | 15,821 entries |
| `-tail-mid-stream.jsonl` | `mid-stream` — `stop_reason: tool_use` with no `tool_use` block | 10,368 entries |
| `-tail-awaiting-reply.jsonl` | `awaiting-reply` — a `user` entry carrying `tool_result` | 15,815 blocks |
| `-tail-metadata-only.jsonl` | **the absence outcome**: a transcript of pure bookkeeping, no turn shape at all | — |
| `-session-multi-turn.jsonl` | a whole real session, used to state the prefix-consistency law over every prefix | — |

The single most load-bearing fact these pin: **249 of 253 real transcripts end
on a non-conversational line** (213 on `last-prompt` alone). A reader that took
"the last line" as the turn shape would be wrong 98% of the time, which is why
`-tail-turn-complete.jsonl` deliberately keeps the trailing bookkeeping run.

## Redaction

Real slices, mechanically redacted. Every field the grammar reads is kept
**byte-identical from the capture**:

`type` · `isSidechain` · `timestamp` · `message.stop_reason` ·
`message.content[].type` · `message.content[].id` ·
`message.content[].tool_use_id` · `message.usage.*` · `requestId` · `model` ·
`uuid` / `parentUuid`

Everything else is replaced with a fixed placeholder:

- free text — `text`, `thinking`, `signature`, string `content`, `toolUseResult`,
  `lastPrompt`, `aiTitle`, `agentName`, `error`;
- `attachment` bodies, reduced to their `type` discriminator;
- identity and host paths — `cwd` → `/repo-wt/lane-a`, `gitBranch` → `lane-a`,
  `sessionId` → a fixed UUID, `input.file_path` → a path under that worktree.

`turn-grammar-claude.test.ts` re-checks the result structurally on every run:
version-pinned filenames, no email addresses, no `/home/` or `/Users/` paths,
no NUL bytes, every line still parseable.

## Re-deriving

The capture script is not checked in — it reads a private corpus, and the fence
for the issue that produced these files covers this directory only. The recipe
is small enough to restate:

1. Walk `~/.claude/projects/*/*.jsonl`, parsing each line as JSON and skipping
   unparsable ones.
2. For each target shape, find the first file whose last conversational entry
   (or, for the mid-conversation shapes, any entry) matches it, and slice a few
   entries of lead-in plus everything after it to EOF.
3. Apply the redaction above field by field, preserving key order.
4. Write one JSON object per line, `ensure_ascii=False`, trailing newline.

Re-running it on a fresh corpus should reproduce equivalent files — the same
shapes, not necessarily the same bytes, since the source slices differ.
