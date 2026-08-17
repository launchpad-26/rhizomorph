/**
 * THE ROSTER — prd-26 ruling 6's "never two rosters", as data rather than as
 * prose parsed out of a source file at runtime.
 *
 * ## Why this lives outside `concierge/`
 *
 * The roster is a fact about the *product* — which harnesses this instrument
 * names, and which of them it can actually launch. The concierge is one
 * consumer of that fact, not its owner. It used to be stored inside
 * `concierge/harness/not-implemented.ts`, and that placement had a consequence
 * nobody intended:
 *
 * `cli/doctor.ts` must report the roster (#325 — "one roster exists, all three
 * surfaces read it"), and the concierge namespace law (ADR-0019 / prd-20
 * ruling 1) grants an import edge into `concierge/` to exactly one file,
 * `api/concierge.ts`. `namespace-law.test.ts`'s `SPECIFIER_RE` matches
 * `from '…'`, which catches **type-only imports too**, so doctor could not
 * even borrow a `HarnessId`. The first attempt (#325, `42ed2df`) worked around
 * that by reading the adapter *source text* at runtime — legal, since text is
 * not a module edge, and correct in development.
 *
 * It was wrong in the shipped artifact. `npm run build` emits a single esbuild
 * bundle, `packages/server/dist/cli/index.js`, and the root `package.json`
 * `files` array publishes `dist` and `bin` with no `src/`. So the `.ts` files
 * the check reads do not exist where an installed CLI looks for them, and every
 * `rhizomorph doctor` — and `GET /api/doctor` with it — reported
 * `could not read the harness roster … source was not found at the expected
 * path`. A check that describes its own absence as a source-shape change, on
 * the one surface #325 exists to make honest.
 *
 * Moving the data out is what makes one roster readable from both sides:
 * `concierge/harness/not-implemented.ts` imports it to build its adapters
 * (concierge importing *outward* is unconstrained — the law is about what
 * reaches *in*), and `cli/doctor.ts` imports it directly. No import edge into
 * the hand, no filesystem read at runtime, and it survives bundling because it
 * is ordinary code the bundler carries.
 *
 * The alternative — adding `packages/server/src/concierge/harness/**` to the
 * published `files` allowlist so the regex keeps working — was rejected:
 * publishing TypeScript source in the npm artifact is a packaging-policy change
 * made for one check's convenience, and it would leave the roster's single
 * source of truth being *parsed* rather than *imported* by its own consumers.
 *
 * ## What keeps this from becoming the second roster
 *
 * Nothing here is a copy. `not-implemented.ts` builds every declared adapter
 * from {@link DECLARED_HARNESSES} and holds no table of its own, so there is
 * one table, in one place, with two readers. Two pins hold it there:
 *
 * - **The compiler.** `not-implemented.ts` assigns these entries to a
 *   `readonly DeclaredHarness[]` whose `id` is `HarnessId`, so an id spelled
 *   wrong here fails the build rather than the operator.
 * - **`concierge/harness/harness-law.test.ts`.** It pins
 *   {@link IMPLEMENTED_HARNESS_IDS} against the live `HARNESS_ADAPTERS` and the
 *   declared ids against the live declared adapters — the two facts this file
 *   states that the compiler cannot check on its own.
 */

/**
 * The harnesses this instrument knows the name of.
 *
 * Deliberately a local union rather than an import of `concierge/harness/`'s
 * `HarnessId`: importing it would be exactly the edge the namespace law
 * forbids, and it is the reason this module exists. The two are pinned to each
 * other by the compiler at the one place that legitimately sees both — see this
 * module's own doc comment.
 */
export type RosterHarnessId = 'claude' | 'codex' | 'openclaw' | 'pi' | 'shell'

/** One declared-not-implemented harness, as the roster records it. */
export interface DeclaredHarnessEntry {
  id: RosterHarnessId
  displayName: string
  /**
   * The executable name, only where this repo actually records one. `null`
   * means nobody has written down what the binary is called, so PATH cannot
   * honestly be searched for it.
   */
  command: string | null
  reason: string
  whatItWouldTake: string
  /** Used when {@link command} is `null` — why the name is not known. */
  unnamedReason?: string
}

/**
 * The harnesses with a built adapter of their own — `concierge/harness/`'s
 * `claude.ts` and `codex.ts`, which `registry.ts` composes as
 * `[claudeAdapter, codexAdapter, ...declaredAdapters]`.
 *
 * This is the one fact in this file that is a *restatement* rather than the
 * source itself, because the adapters are modules and a module list cannot live
 * outside the namespace that holds them. `harness-law.test.ts` pins it against
 * the live registry, so a third adapter landing without a line here reds the
 * suite instead of quietly making `doctor` undercount.
 */
export const IMPLEMENTED_HARNESS_IDS: readonly RosterHarnessId[] = ['claude', 'codex']

/**
 * Every declared-not-implemented harness, alphabetical by id — the order
 * `registry.ts` re-sorts into anyway, kept here so a reader of this table sees
 * the same order the picker does.
 *
 * Three things are deliberately true of every entry, and
 * `concierge/harness/not-implemented.ts` is where they are enforced:
 *
 * 1. **It is listed.** Omitting a harness would hide one an operator is using.
 * 2. **It carries its reason**, plus what it would take to change — never
 *    "coming soon", which is a promise rather than a fact.
 * 3. **It cannot produce a launch line.** The adapter built from it throws
 *    rather than returning a plausible-looking argv nobody has captured.
 */
export const DECLARED_HARNESSES: readonly DeclaredHarnessEntry[] = [
  {
    id: 'openclaw',
    displayName: 'OpenClaw',
    // Named as an adapter target in docs/research/2026-08-05-agnostic-adapters-spike.md
    // and nowhere else — the note names the harness, never its binary.
    command: null,
    unnamedReason:
      'this repo records no executable name for OpenClaw — it appears as an adapter target in the agnostic-adapters ' +
      'spike and nowhere else. Searching PATH for a name this lane invented would report a confident "absent" about ' +
      'a spelling nobody verified, which is worse than admitting the name is unknown',
    reason:
      'no capture, and no telemetry or session-file surface recorded anywhere in this repo — there is nothing to ' +
      'write an adapter against beyond the name',
    whatItWouldTake:
      'a capture: the executable name, whether it emits OTLP or writes session files, and whether it has a resume ' +
      'verb at all. prd-15 ruling 4 shared conformance suite, then an adapter',
  },
  {
    id: 'pi',
    displayName: 'pi',
    // The one thing this repo does record: `AGENT_COMMANDS` in
    // collectors/sessionlog/process-probe.ts lists 'pi' as an agent argv[0].
    command: 'pi',
    reason:
      'named in prd-15 ruling 3 and listed in the process probe\'s AGENT_COMMANDS, so a running pi is *seen* — and ' +
      'OBSERVING it is no longer the gap: pi is captured (#324), has a registered session-file dialect ' +
      '(`PI_JSONL_GRAMMAR`, #540) and a real collector emits its llm.usage/llm.cost/tool.activity under ' +
      'harness: \'pi\' (#609, see collectors/pi/capabilities.ts). What remains unverified is LAUNCHING it: no ' +
      'capture in this repo shows what argv or env makes a fresh pi process this hand starts, and pi\'s own ' +
      'CAPTURE.md found OTEL_RESOURCE_ATTRIBUTES-shaped env has zero effect on it — so envRecipe, launchArgv, ' +
      'continueArgv and resumeArgv have no verified answer yet',
    whatItWouldTake:
      'a captured pi launch under a real env/argv recipe pointed at this server, and a captured continuity attempt ' +
      '(a --continue/--resume-shaped flag or otherwise) — the observation half (capture, grammar, collector) is ' +
      'already done (#324/#540/#609); only the launch half remains',
  },
  {
    id: 'shell',
    displayName: 'a bare shell',
    command: null,
    unnamedReason:
      'a bare shell is not one executable — it is bash, zsh, fish, pwsh or whatever the operator uses — so there is ' +
      'no single name to search PATH for, and finding one would not answer the question anyway',
    reason:
      'a bare shell is not a conductor. It emits no telemetry, keeps no session transcript this instrument can ' +
      'read, and has no continuity verb — there is no "relaunch it with continuity" to offer, because there is no ' +
      'conversation to continue. Relaunching a shell inside a wired envelope instruments the shell, not the work ' +
      'done in it',
    whatItWouldTake:
      'a different mechanism entirely rather than an adapter — wrapping the terminal (the pty-wrap route sketched in ' +
      'the agnostic-adapters spike), which is a separate decision with its own blast radius',
  },
]
