/**
 * pi — prd-26 wave 4, issue #324: "pi reads from a captured fixture, not from
 * documentation." Capture-first per ruling 3; see `./fixtures/CAPTURE.md` for
 * the recipe, the real captures backing every claim in `./capabilities.ts`
 * and `./grammar.ts`, and what this capture could NOT establish.
 *
 * **A `TurnGrammar` IS registered** (`./grammar.ts`, wired into
 * `../sessionlog/turn-grammar.ts`'s `TURN_GRAMMARS` as `pi`) — the first time
 * this seam has taken a real second dialect. codex (#322) captured real
 * evidence and declined: its rollout never showed a tool call written before
 * its result, and usage/model facts were split across three line types this
 * interface's one-line contract cannot join. Neither problem holds for pi —
 * a real SIGINT sent mid-tool-call left a truncated transcript ending on the
 * pending call itself, and every assistant message carries model, tokens
 * *and* cost together on one line. `./grammar.ts`'s header comment has the
 * full argument.
 *
 * **Every `AdapterCapabilities` signal is still `absent`** — a separate,
 * structural finding, not a contradiction of the grammar decision. Turn
 * *shape* (`TurnGrammar`) is a pure, in-repo interface with no dependency on
 * `packages/core`'s event schema. Turn *facts as a real `RhizomorphEvent`*
 * (what `AdapterCapabilities` actually certifies, per ADR-0010) does depend on
 * it — and `packages/core/src/events/common.ts`'s `EventSource` enum has no
 * `'pi'` literal, so no in-fence code can emit `llm.usage`/`llm.cost`/
 * `tool.activity` from pi's real facts today. `./capabilities.ts`'s header
 * comment has the full argument, including why `cost` — the standout finding
 * of this capture, an authoritative per-turn dollar figure neither codex nor
 * claude's own sessionlog has — is `absent` rather than `provided` for a
 * schema reason, not a data reason.
 *
 * This organ is not a `Collector<S>` either: no directory-watcher exists yet
 * for `~/.pi/agent/sessions/`, and building one would immediately hit the
 * same `EventSource` wall the moment it tried to `emit()` anything — so there
 * is nothing to poll. `../conformance/pi.test.ts` proves the grammar directly
 * against real fixtures and proves every capability's `absent` declaration is
 * itself unbacked-by-nothing (ADR-0010), the same way codex's conformance
 * test proves its declarations against the shared otel receiver.
 */
export { PI_CAPABILITIES } from './capabilities.js'
export { PI_COMPLETING_STOP_REASONS, PI_JSONL_GRAMMAR } from './grammar.js'
