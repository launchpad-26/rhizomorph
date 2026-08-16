# 0021. A transcript dialect names itself with `harness`, not a new source literal

- **Status:** accepted
- **Date:** 2026-08-15

## Context and Problem Statement

`packages/core/src/events/telemetry.ts`'s `telemetryOriginSchema` is
`z.enum(['sessionlog', 'otel'])`, closing `llm.usage`, `llm.cost` and
`tool.activity` to exactly those two sources. `sessionlog` has only ever had
one dialect behind it: Claude Code's own `~/.claude/projects/*.jsonl` tailer.

#324's capture phase found that pi's session JSONL genuinely supports the
same `TurnGrammar` seam claude's does — real per-turn tokens, model names,
tool calls, and (unlike claude) an authoritative dollar cost on every
assistant message. But a pi collector has no honest source literal to emit
under: claiming `'sessionlog'` would misattribute pi's facts as Claude Code's
own collector, and emitting nothing would silently drop facts the capture
proves exist. `packages/server/src/collectors/pi/capabilities.ts` declares
every affected signal `absent` for exactly this reason, naming this issue as
the remedy — a structural block, not a data gap (prd-26 ruling 4's fence
tripwire, one layer deeper: the payload shapes are already generic enough,
only the envelope's source vocabulary is closed).

The issue was opened with three options and an operator ruling recorded on it
before dispatch, settling the first fork: a **generic transcript source**,
with the harness named in a payload field, is the direction — not a new
literal per harness, and not widening `telemetryOriginSchema` to all of
`EventSource`. What the ruling did not settle, and what this ADR is written
to decide, is the second fork: **is the generic literal a *new* spelling, or
is `sessionlog` itself made generic?**

## Considered Options

- **(a) — One literal per harness** (`'pi'`, later `'gemini'`, `'aider'`…).
- **(c) — Widen `telemetryOriginSchema` to all of `EventSource`.**
- **(b1) — A new generic literal**, e.g. `'transcript'`, with `harness`
  naming the dialect on the payload.
- **(b2) — Reuse `sessionlog` as the generic transcript-collector literal**,
  adding an optional `harness` field to the shared telemetry attribution.

## Decision Outcome

Chosen: **(b2)**. `telemetryOriginSchema` stays `z.enum(['sessionlog',
'otel'])` — no enum change at all, in either `common.ts`'s `eventSourceSchema`
or `telemetry.ts`'s narrower subset. What changes is additive: an optional,
nullable `harness: z.string().trim().min(1)` field — deliberately *not* the
shared `nonEmptyString`, whose bare `.min(1)` would admit a whitespace-only
name; trimming is applied to `harness` alone rather than by widening that
primitive for every other attribution field — on the attribution shared by
`llm.usage`, `llm.cost` and `tool.activity`. Absent or null `harness` means
Claude Code's own collector — the only meaning `sessionlog` has ever carried
before this — and is pinned by a test (`telemetry.test.ts`, "the harness
dimension (#538)"). A dialect other than Claude's sets `harness` to a free
string (`'pi'`, `'codex'`, …), never a closed enum, so a brand-new harness
lands entirely inside its own collector directory with no core PR at all —
the property (a) and (c) both cost.

**(a) is rejected** — recorded on the issue before dispatch — because it
makes every future dialect a core PR, which is exactly the coupling prd-26
ruling 4 exists to keep out of `packages/core/**`. It also scales the enum
with the roadmap rather than with the concept: "a transcript collector"
is one idea, not N.

**(c) is rejected** — also recorded before dispatch — because it discards
`telemetryOriginSchema`'s own stated invariant, *"a subset of `EventSource`"*,
and would let `git` or `tmux` claim a token count. The narrowing is
load-bearing: it is what makes "which collector produced this fact" a
closed, checkable question at the type level.

**(b1) is rejected** in favor of (b2) on ADR-0011's own ground — *recordings
never rot*. A new literal means claude's transcript events keep
`source: 'sessionlog'` forever while pi's read `source: 'transcript',
harness: 'pi'` — two spellings of one concept, permanently, since ADR-0011
forbids migrating existing recordings to fold them into one. (b2) costs
nothing on the wire: every event ever logged already reads `sessionlog` for
"an agent CLI's own transcript, tailed," which is precisely what the generic
concept means once stated plainly. The one real cost (b1) would have avoided
is that `sessionlog` reads claude-ish to a newcomer — a name chosen once,
before a second dialect existed, now carrying more than its name suggests.
That cost is paid once, in a doc comment, not on every future event.

**The consumer survey that makes this defensible, not aesthetic:** every
runtime branch in this repo that reads `origin === 'sessionlog'` was
enumerated before choosing (b2) over (b1). There are exactly four —
`packages/core/src/reduce.ts`'s `foldUsage`, `dedupedUsage`,
`foldSessionCoverage`, `indexUsageRecord` — and all four are role-based
("the depth collector wins the merge on cache-tier detail" vs. "otel is
authority on dollars"), never harness-specific. The same holds for
`fleet/constants.ts`'s `TOKEN_ORIGINS`, `fleet/buildFleet.ts`,
`selectors/spend.ts`, `selectors/spend-cursor.ts`, `selectors/connection.ts`,
`fleet/plumbing.ts`, and `server/src/api/meta.ts` — each treats `'sessionlog'`
as a named collector role, never as a proxy for "Claude." The web surface's
`StatusBar.tsx` labels the pill `'Sessionlog'`, not `'Claude'`. **No selector,
reducer, `/api/meta` field, or web panel needs a code change for `sessionlog`
to become generic.** The one place in the tree that explicitly worried about
this exact confusion is a prose comment in `pi/capabilities.ts` itself —
*"Reusing `'sessionlog'` for a pi-native event would misattribute it as
Claude Code's own collector"* — written against the *bare*-reuse shortcut
this ADR does not take; adding `harness` is the fix that comment was asking
for, not a case against it.

Two consumers are claude-specific by construction but read the filesystem
directly rather than an event's `source` field, so they are unaffected by
this change and are not this issue's fence: `cli/doctor.ts`'s
`checkClaudeProjects`/`checkEnrichmentLadder` probe `~/.claude/projects` and
print claude-specific strings; `api/transcript.ts` and
`log/transcript-attribution.ts`/`transcript-capture.ts` resolve transcript
paths under `claudeProjectsRoot` unconditionally. Neither breaks today —
nothing wires a `harness`-bearing event through them yet — but both are the
next domino if a non-claude harness is ever wired end-to-end, noted here so
that work doesn't have to rediscover it.

## Consequences

- **Good.** Byte-identical on the wire: `eventSourceSchema` is untouched,
  `telemetryOriginSchema`'s enum values are untouched, and the golden era
  corpus (`packages/core/src/eras/era-1`) folds to the committed snapshot
  unchanged — verified by running `eras.test.ts`, not assumed.
- **Good.** No consumer in `core`, `server`, or `web` needs a code change;
  the survey above is exhaustive, not a sample.
- **Good.** A harness after pi (codex, aider, …) costs one collector
  directory and zero core PRs — the property ruling 4 asks for.
- **Bad — `sessionlog` still reads claude-ish to a newcomer.** The literal
  was named before a second dialect existed and now means more than its
  name suggests. Paid once, here, in the doc comments this ADR adds to
  `common.ts` and `telemetry.ts` — not paid again per event or per consumer.
- **Bad — `harness` is a free string, not a checked enum.** A collector can
  in principle write `harness: 'claude'` explicitly (redundant with leaving
  it absent) or a typo'd name, and nothing here catches either — trimming and
  rejecting empty/whitespace-only catches the degenerate case, not a typo'd
  real one. Accepted as the cost of the "no core PR per harness" property: a
  closed enum would buy the typo check back at the price of reintroducing
  (a)'s coupling.
- **Neutral — `harness` also exists, unused, on `agent.activeTime`.** It
  rides the same shared `attribution` object as the three sessionlog-eligible
  payloads because `activeTimePayloadSchema` spreads the same shape, even
  though `agent.activeTime` is otel-only and `harness` can never mean
  anything there. Kept for one shared attribution shape rather than a
  fourth near-identical object; always absent in practice, and a test pins
  that it stays harmless.
- **Neutral — `cli/doctor.ts` and the transcript-retrieval path stay
  claude-only** until whichever issue wires a non-claude collector through
  them; flagged above, not fixed here, since `collectors/pi/**` and the rest
  of the server's transcript machinery are out of this issue's fence.
