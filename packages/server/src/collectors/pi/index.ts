/**
 * pi — prd-26 wave 4. #324 captured pi's session JSONL and registered a
 * `TurnGrammar` (`./grammar.ts`) from it; #538/ADR-0021 then gave a transcript
 * dialect other than claude's an honest way to name itself (`harness` on the
 * shared telemetry attribution, `source` staying `'sessionlog'`); this file's
 * `createPiCollector` (`./collector.ts`) is what actually calls `emit()` with
 * both — the first live reader of `PI_JSONL_GRAMMAR`. See
 * `./fixtures/CAPTURE.md` for the recipe and the real captures backing every
 * claim in `./capabilities.ts`, `./grammar.ts` and `./collector.ts`.
 *
 * **A `TurnGrammar` IS registered** (wired into `../sessionlog/turn-grammar.ts`'s
 * `TURN_GRAMMARS` as `pi`) — the first time this seam has taken a real second
 * dialect. codex (#322) captured real evidence and declined: its rollout
 * never showed a tool call written before its result, and usage/model facts
 * were split across three line types this interface's one-line contract
 * cannot join. Neither problem holds for pi — a real SIGINT sent mid-tool-call
 * left a truncated transcript ending on the pending call itself, and every
 * assistant message carries model, tokens *and* cost together on one line.
 * `./grammar.ts`'s header comment has the full argument.
 *
 * **`PI_CAPABILITIES` is re-derived from the captures, not the pre-#538
 * declaration.** Every signal was `absent` for a structural reason — the
 * envelope had no room for a third collector, not a data gap — and that wall
 * is down: `identity`, `liveness`, `activity`, `telemetry` and `cost` are now
 * `provided`, each backed by a real fixture and a real emitted event
 * (`../conformance/pi.test.ts`). `attention` stays `partial`, the same
 * inferred-not-declared level sessionlog carries, for the same reason: the
 * turn-shape state machine this organ reuses can say "this transcript looks
 * done and has stayed quiet," but nothing in pi's own docs or captures
 * describes a CLI-declared approval gate for it to certify instead.
 * `./collector.ts`'s header comment has the full argument for why this is an
 * independent implementation rather than a generalisation of sessionlog's.
 */
export { PI_CAPABILITIES } from './capabilities.js'
export { createPiCollector } from './collector.js'
export type { PiCollectorConfig } from './collector.js'
export { PI_COMPLETING_STOP_REASONS, PI_JSONL_GRAMMAR } from './grammar.js'
export type { PiLaneLiveness, PiSnapshot, PiTailedFileState } from './types.js'
