/**
 * codex — prd-26 wave 4, issue #322: "codex reads from a captured fixture,
 * not from documentation." Capture-first per ruling 3; see `./fixtures/CAPTURE.md`
 * for the recipe, the real captures backing every claim in `./capabilities.ts`,
 * and the six numbered findings this organ's declarations rest on.
 *
 * **No `TurnGrammar` is registered here.** codex's rollout format (its
 * `~/.codex/sessions/` transcript) is genuinely richer than claude's for two
 * of the six signals — explicit `role` per line, an explicit `task_complete`
 * completion event, both per-turn and cumulative token counts in one place —
 * and building one remains tempting. Two real captured facts stop it, not a
 * schedule: no capture ever shows a tool call written before its result (so
 * `opensToolUseIds`/`closesToolUseIds` would be invented, never observed), and
 * usage/model facts are split across three different line types in a way
 * `TurnGrammar.extractFacts(rawLine)`'s one-line-in-one-fact-out contract
 * cannot honestly join. CAPTURE.md's closing section is the fuller version of
 * this paragraph; ruling 5 already names the second problem as an ADR owed.
 *
 * This organ is not a `Collector<S>` either — no directory-watcher exists yet
 * for `~/.codex/sessions/`, and codex's own OTLP export lands on the *same*
 * shared receiver claude's does (`../otel/index.ts`, unmodified). So there is
 * nothing here to poll; `capabilities.ts` is the whole organ, and
 * `../conformance/codex.test.ts` proves each declared level by running that
 * unmodified receiver code over codex's own real fixtures.
 */
export { CODEX_CAPABILITIES } from './capabilities.js'
