import type { AdapterCapabilities } from '@rhizomorph/core'

/**
 * pi's declared capabilities, per prd-26 ruling 2 — declared from the capture
 * (`./fixtures/CAPTURE.md`) and now from a real collector (`./collector.ts`),
 * never from documentation or ambition.
 *
 * Every signal here used to be `absent` for one structural reason, restated
 * from #324/#538's own history: `packages/core/src/events/common.ts`'s
 * `eventSourceSchema` was closed to `git`/`tmux`/`workmux`/`system`/
 * `sessionlog`/`otel`, and `llm.usage`/`llm.cost`/`tool.activity`'s envelopes
 * were closed to exactly `['sessionlog', 'otel']` — with no room for a third
 * collector's own literal. Reusing `'sessionlog'` for a pi-native event would
 * have misattributed it as Claude Code's own collector; reusing `'otel'`
 * would have been false, since pi has no OTLP export at all (CAPTURE.md).
 * ADR-0023 closed that gap additively: `harness` on the shared telemetry
 * attribution names any dialect other than Claude's, absent meaning Claude's
 * own collector, with `source` staying the generic `'sessionlog'` literal —
 * **not** a new `pi` `EventSource` literal, which ADR-0023 explicitly
 * rejected as option (a) (it would make every future dialect a core PR, the
 * exact coupling prd-26 ruling 4 exists to keep out of `packages/core/**`).
 *
 * `./collector.ts`'s `createPiCollector` is what turns that room into real
 * events: it tails `~/.pi/agent/sessions/` through the registered
 * `PI_JSONL_GRAMMAR` and emits `llm.usage`/`llm.cost`/`tool.activity` with
 * `harness: 'pi'`. Every `provided` signal below is backed by a real
 * emitted event over a real fixture, checked by
 * `../conformance/pi.test.ts`'s `findUnbackedProvidedSignals` law
 * (ADR-0010) — never a self-report.
 */
export const PI_CAPABILITIES: AdapterCapabilities = {
  /**
   * A real lane, derived from the session header's own structural `cwd` —
   * the same kind of fact sessionlog derives `identity` from, just read once
   * per file instead of repeated per line (`grammar.ts`'s header comment
   * explains why pi's shape differs there). That `cwd` is resolved to the
   * watched worktree containing it before it is allowed to name a lane, so
   * the key matches what every other collector calls the same worktree, and a
   * session belonging to an unrelated project on the same machine is not
   * attributed at all rather than folded into a same-named lane (#609).
   * `OTEL_RESOURCE_ATTRIBUTES` still has zero effect on a pi session
   * (CAPTURE.md's env-var finding) — this signal rests entirely on the
   * structural read, not on any pi-side cooperation.
   */
  identity: { level: 'provided' },
  /**
   * The file's own append cadence — CAPTURE.md's Finding 3 proved this by
   * execution (a live `sleep`-based tool call held the transcript at a fixed
   * line count for 19 consecutive 100ms polls before the closing line
   * landed), and `collector.ts` reuses sessionlog's own transcript-tail state
   * machine (`lane-state.ts`) unmodified to read it.
   */
  liveness: { level: 'provided' },
  /**
   * Real tool calls (`fixtures/pi-0.83.0-tool-call.jsonl` and kin), extracted
   * by `PI_JSONL_GRAMMAR.extractFacts` and now emitted as real `tool.activity`
   * events by `createPiCollector`.
   */
  activity: { level: 'provided' },
  /**
   * The same turn-shape state machine that earns sessionlog's own `attention:
   * partial` — inferred from transcript shape (a completed turn that stays
   * quiet), never declared by the CLI. Not `provided`: unlike codex's
   * `-a on-request`/`-a untrusted` approval policies, pi's own docs
   * (`security.md`) describe no tool-approval gate at all, so there is no
   * CLI-declared signal this organ could certify instead of inferring.
   */
  attention: {
    level: 'partial',
    reason: 'inferred from transcript shape via the same turn-shape state machine sessionlog uses, not declared by the CLI',
    remedy: 'if a future pi release adds a tool-approval gate, capture a session under it to test whether it writes a distinguishable blocked state to the session JSONL',
  },
  /**
   * Real per-turn token counts on every assistant message
   * (`message.usage.{input,output,cacheRead,cacheWrite,reasoning,totalTokens}`
   * — CAPTURE.md's usage finding), now emitted as real `llm.usage` events
   * with `harness: 'pi'`.
   */
  telemetry: { level: 'provided' },
  /**
   * The single most valuable fact this capture found: pi's CLI computes a
   * real, authoritative per-turn dollar cost on every assistant message
   * (`message.usage.cost.{input,output,cacheRead,cacheWrite,total}` —
   * CAPTURE.md's cost finding) — something neither codex (`CODEX_CAPABILITIES`:
   * "no dollar figure appears anywhere") nor claude's own sessionlog organ
   * (tokens-only, no dollars) has. `createPiCollector` emits it as a real
   * `llm.cost` event, `authoritative: true`, no pricing-table estimate
   * needed — exactly the outcome `capabilities.ts`'s pre-#546 remedy flagged
   * as "worth flagging to whoever picks that up."
   */
  cost: { level: 'provided' },
}
