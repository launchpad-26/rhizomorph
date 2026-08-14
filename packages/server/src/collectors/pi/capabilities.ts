import type { AdapterCapabilities } from '@rhizomorph/core'

/**
 * pi's declared capabilities, per prd-26 ruling 2 — declared from the capture
 * (`./fixtures/CAPTURE.md`), never from documentation.
 *
 * Every signal below is `absent`. That is not "pi's captures show nothing" —
 * the opposite is true for `telemetry` and `cost` (see their reasons) — it is
 * a **structural** finding, real and first-hand, distinct from what stopped
 * codex: codex's rollout genuinely couldn't back a live signal without a
 * collector that doesn't exist. pi's session JSONL carries real per-turn
 * tokens, model names, tool calls **and an authoritative dollar cost on every
 * assistant message** (CAPTURE.md's cost finding — no other harness in this
 * repo has that, including claude's own sessionlog, which is tokens-only).
 * None of it can be declared `provided` or even `partial` today, because
 * there is no in-fence way to turn any of it into a real `RhizomorphEvent`:
 *
 * - `packages/core/src/events/common.ts`'s `eventSourceSchema` is a closed
 *   6-value enum (`git`, `tmux`, `workmux`, `system`, `sessionlog`, `otel`) —
 *   no `'pi'` literal exists.
 * - `llm.usage`, `llm.cost` and `tool.activity` — the three event types that
 *   could carry pi's real facts — are each built with
 *   `envelopeWithSources(['sessionlog', 'otel'], ...)` (`events/telemetry.ts`),
 *   closed to exactly those two sources. Reusing `'sessionlog'` for a pi-native
 *   event would misattribute it as Claude Code's own collector — the exact
 *   confusion prd-26's Problem statement exists to end, not a shortcut worth
 *   taking. Reusing `'otel'` would be false: pi has no OTLP export at all
 *   (confirmed absent, see CAPTURE.md).
 * - `trace.span` and `agent.activeTime` are pinned to `'otel'` only;
 *   `pane.activity`/`agent.status` to `tmux`/`workmux`; every git event to
 *   `git`. There is no event type today whose source a pi-native emitter
 *   could honestly claim.
 *
 * This is the same fence tripwire ruling 4 names for `packages/core/**`
 * ("if the event union genuinely lacks a fact, STOP and report: additive
 * core PR first") — one layer deeper than a missing *fact*: here the
 * payload shapes are already generic enough to carry pi's facts, but the
 * envelope's *source* vocabulary has no room for a third collector. Declared
 * here rather than quietly worked around; the remedy each signal names is
 * the same additive core PR ruling 4 asks for, not attempted in this issue.
 *
 * pi is not a `Collector` for the same reason codex isn't: no directory-
 * watcher exists yet for `~/.pi/agent/sessions/`, and even if one did, its
 * `poll()` would hit this exact same wall the moment it tried to `emit()` a
 * fact this rich. `./index.ts`'s header has the fuller version of this note.
 */
export const PI_CAPABILITIES: AdapterCapabilities = {
  identity: {
    level: 'absent',
    reason:
      "no live mechanism exists: OTEL_RESOURCE_ATTRIBUTES has zero effect on a pi session (verified — CAPTURE.md's env-var finding), and pi has no other identity-attribution mechanism. The session header does carry a structural cwd (like codex's rollout and claude's own transcript directory), but nothing reads it today — no collector watches `~/.pi/agent/sessions/`, and even a collector that did would have no event type whose source it could honestly claim (see this file's header comment).",
    remedy:
      'a pi session-tailing collector would give structural identity from the header\'s cwd, the same way sessionlog derives lane from claude\'s transcript directory — but it could not emit that fact as a real event until an additive core PR adds a `pi` EventSource literal (ruling 4).',
  },
  liveness: {
    level: 'absent',
    reason: 'no collector polls pi\'s session directory, so there is no cadence to read a liveness signal from.',
    remedy: 'a pi session-tailing collector would read liveness from the file\'s own append cadence, the same way sessionlog does — CAPTURE.md\'s incrementality finding confirms the file is appended to line by line, in real time, not written once at the end.',
  },
  activity: {
    level: 'absent',
    reason:
      'real tool calls are captured (`fixtures/pi-0.83.0-tool-call.jsonl` and kin) and the `PI_JSONL_GRAMMAR` registered in `../sessionlog/turn-grammar.ts` can already extract them — but nothing can turn an extracted `ToolUseFacts` into a real `tool.activity` event: that event type\'s envelope is closed to `sessionlog`/`otel` sources only (see this file\'s header comment).',
    remedy: 'the same additive core PR as identity/liveness (a `pi` EventSource literal, and widening `tool.activity`\'s envelope to allow it) would unblock this the moment a pi collector exists to call `emit()`.',
  },
  attention: {
    level: 'absent',
    reason:
      'no captured pi session shows a blocked/waiting-for-approval state, and no documented pi concept resembles one: unlike codex\'s `-a on-request`/`-a untrusted` approval policies, pi\'s own docs (`security.md`) describe no approval gate for tool execution at all — "Pi does not include a built-in sandbox... Built-in tools can read files, write files, edit files, and run shell commands with the permissions of the pi process," with no mention of a pause-for-human-approval mode. `--approve`/`-a` in pi governs trusting project-local settings/extension files, a different concept entirely, not gating an individual tool call.',
    remedy: 'if a future pi release adds a tool-approval gate, capture a session under it to test whether it writes a distinguishable blocked state to the session JSONL.',
  },
  telemetry: {
    level: 'absent',
    reason:
      "real per-turn token counts exist on every assistant message (`message.usage.{input,output,cacheRead,cacheWrite,reasoning,totalTokens}` — CAPTURE.md's usage finding, confirmed per-turn not cumulative across a 2-turn session) and `PI_JSONL_GRAMMAR.extractFacts` already reads them. This is blocked structurally, not by data absence: `llm.usage`'s envelope is closed to `sessionlog`/`otel` sources (see this file's header comment), so no in-fence code can emit it as a real event today.",
    remedy: 'an additive core PR adding a `pi` EventSource literal and widening `llm.usage`\'s envelope to allow it (ruling 4) — proposed here, not attempted.',
  },
  cost: {
    level: 'absent',
    reason:
      "the single most valuable fact this capture found: pi's CLI computes a real, authoritative per-turn dollar cost on every assistant message (`message.usage.cost.{input,output,cacheRead,cacheWrite,total}` — CAPTURE.md's cost finding) — something neither codex (`CODEX_CAPABILITIES`: 'no dollar figure appears anywhere') nor claude's own sessionlog organ (tokens-only, no dollars) has. It is `absent` here for the same structural reason as `telemetry`, not because the data doesn't exist: `llm.cost`'s envelope is closed to `sessionlog`/`otel` sources, with no `pi` literal in `EventSource` to route it through.",
    remedy:
      'the same additive core PR telemetry names. Once `pi` is a valid EventSource and `llm.cost`\'s envelope allows it, this signal could very plausibly land at `provided` (an authoritative cost, `authoritative: true`, no pricing-table estimate needed) on the very next issue that builds a pi collector — worth flagging to whoever picks that up.',
  },
}
