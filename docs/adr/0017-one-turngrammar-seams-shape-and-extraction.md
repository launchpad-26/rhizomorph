# 0017. One `TurnGrammar` seams turn shape and extraction, not two

- **Status:** accepted
- **Date:** 2026-08-13

## Context and Problem Statement

prd15 ruling 1 already seamed *turn shape* behind `TurnGrammar`
(`packages/server/src/collectors/sessionlog/turn-grammar.ts`): one interface,
one claude implementation (`turn-grammar-claude.ts`, cited to a 253-transcript
capture), and `grammarFor()` refusing to guess at a dialect nobody has
captured. The organ's *other* half never got the same treatment. Usage,
model and tool-call extraction (`parse-session-line.ts`'s `parseAssistantLine`)
reads Claude Code's JSONL shape directly — `message.usage`,
`message.content[].type === 'tool_use'`, `input.file_path` — with no interface
between it and the collector that calls it. prd26 (the second dialect) names
this gap explicitly in ruling 5: a codex or gemini transcript has its own
usage/model/tool shape, and nothing today lets a second dialect supply one.

The two candidates named by the ruling itself:

- A **second interface beside `TurnGrammar`** — e.g. `TurnExtraction`, with
  its own `cli`/`capture`/`extract()`, registered in its own parallel
  registry.
- **One wider transcript-dialect interface** — `TurnGrammar` itself grows a
  second method, so one object per dialect answers both questions.

Both are real options; the code today only has evidence for what a *narrow*
seam looks like (`TurnGrammar` as it stood), not for which of these two is
right. This record is the argument for choosing between them, not a
description of an already-obvious fact — which is exactly what makes it worth
writing down rather than left as "the fix looked correct."

## Considered Options

- **A — A second interface beside `TurnGrammar`** (e.g. `TurnExtraction`),
  each dialect registered separately in its own registry, alongside
  `TURN_GRAMMARS`/`grammarFor`.
- **B — Widen `TurnGrammar` itself** into the shared transcript-dialect
  interface: one `cli`, one `capture`, two methods — `classify` (unchanged)
  and a new `extractFacts`.
- **C — Move the extraction type into `packages/core`**, on the theory that
  usage/model/tool facts are core event shapes rather than a sessionlog
  internal.

## Decision Outcome

Chosen: **B**. `TurnGrammar` (`turn-grammar.ts`) now carries both
`classify(rawLine): TurnEntry | null` and `extractFacts(rawLine):
AssistantLineFacts | null`. `CLAUDE_JSONL_GRAMMAR` (`turn-grammar-claude.ts`)
implements both from the *same* capture citation, and `extractFacts` is
wired straight to `parse-session-line.ts`'s existing `parseAssistantLine` —
the same function reference, not a reimplementation, so
`parse-session-line.test.ts`'s existing coverage of tokens/model/tool facts
is coverage of the wiring too (asserted directly in
`turn-grammar-claude.test.ts`: `CLAUDE_JSONL_GRAMMAR.extractFacts` `.toBe(`
`parseAssistantLine)`).

**Why B over A.** `classify` and `extractFacts` are read off the *same* raw
line, for the *same* dialect, pinned to the *same* version-pinned capture.
Two interfaces would mean two `cli`/`capture` pairs per dialect that could
silently drift — nothing would stop a future codex `TurnExtraction`'s
`capture` string citing a different rollout version than its sibling
`TurnGrammar`'s, and nothing would notice. prd26 ruling 4 already requires a
dialect to land *whole*, "one harness per issue, one fixture set per issue" —
so a design that lets one half of a dialect exist without the other buys
nothing a real adapter would ever use, and only adds a way for the halves to
disagree. One object per dialect makes that disagreement structurally
impossible instead of merely-disciplined-against.

**Why A was rejected, restated concretely.** `TurnGrammar`'s own docstring
(pre-existing, since prd15) explicitly disclaimed extraction: "tokens,
models, prompts, file paths — belong to the other readers of this directory,
not here." That disclaimer was about `TurnEntry`, the narrow *return type*
turn-shape's state machine consumes — and it still holds: `TurnEntry` did not
grow a single field. It was never a claim that the *interface itself* must
stay single-method. Reading it as the latter would be over-generalising one
sentence about a return type into an argument for a design the codebase
elsewhere already rejects: `AdapterCapabilities` bundles six signals
(identity/liveness/activity/attention/telemetry/cost) into one object per
collector rather than six parallel capability interfaces (ADR-0010), for the
same reason — one adapter, one place its facts live, no chance of two halves
shipping out of step.

**Why C was rejected.** `packages/core`'s event shapes (`llm.usage`,
`tool.activity` payloads) are what `AssistantLineFacts` gets *converted
into* by the collector, not the same shape. `TurnEntry` — the structurally
closest precedent, the other half of this exact interface — already lives
beside `TurnGrammar` in sessionlog, not in core, and nothing about
extraction's facts is any less collector-internal than turn shape's. Core
stays additive-only and untouched by this record.

## Consequences

- **Good.** A codex or gemini dialect lands as one file implementing the
  whole `TurnGrammar` contract, cited to one capture — exactly prd26 ruling
  4's shape, and exactly what prd15 ruling 1 already established for turn
  shape alone.
- **Good.** `turn-grammar-claude.ts` and `parse-session-line.ts` no longer
  carry two near-duplicate private copies of `asRecord`/`asString`/
  `asTimestamp` parsing the same JSON.parse'd line twice, for two different
  facts, independently. `parse-session-line.ts` now exports those three
  helpers; `turn-grammar-claude.ts` imports them instead of re-declaring them.
- **Bad — `collector.ts`'s own call site is unchanged, on purpose.** It still
  imports `parseAssistantLine` directly and calls it standalone, rather than
  through the `turnGrammar.extractFacts()` it already threads through for
  `classify()`. `collector.ts` sits outside this issue's fence (#320) — it is
  the conformance-suite-guarded live path, and this record is a pure type/module
  split, not a behaviour change to it. Wiring `collector.ts` to read
  extraction through the same injected `turnGrammar` value it already takes
  for turn shape is real follow-up work, left to whichever issue lands a
  second dialect's collector wiring (prd26 wave 4).
- **Neutral.** `TurnGrammar` keeps its name despite growing a second
  responsibility. Renaming it (to, say, `TranscriptDialect`) was considered
  and set aside purely for blast radius: `collector.ts` imports the type by
  name and sits outside this issue's fence, so a rename was not available
  without widening the fence silently — a decision made to preserve, not
  because the current name is the ideal one.
