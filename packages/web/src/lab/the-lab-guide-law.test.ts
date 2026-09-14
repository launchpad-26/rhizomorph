import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONFOUND_VOICE, COUNTERFACTUAL_CLAUSE, isCompletedVerdict, MIN_ARMS_TO_RANK, MIN_COMPLETED_RUNS_TO_SUMMARISE } from '@rhizomorph/core'
import { cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import type { FetchLike } from '../replay/api.js'
import { NOT_MEASURED_VOICE, runOutcomeVoice } from './adapters.js'
import { markerX, sessionFraction } from './axis/position.js'
import { layoutCanvas } from './canvas/organism.js'
import { NOT_MEASURED, SCORING_UNAVAILABLE } from './compare/fromExperiment.js'
import { Frame, POSITIONS } from './frame/Frame.js'
import { OTHER_MODEL } from './launch/models.js'
import { MEASURE_URL } from './measure.js'
import { DEFAULT_GATE_COMMAND } from './measure-control/MeasureControl.js'
import { EMPTY_COPY } from './metrics/Metrics.js'
import { RD_HELD_BACK_ROW_COPY, RD_NO_CLI_SENTENCE_FIXTURE, RD_NO_CORPUS_COPY, RD_NOTHING_PROPOSED_COPY } from './rd/fixtures.js'
import { RD_NO_MEASURED_BASELINE, RD_OVERRIDE_SENTENCE } from './rd/index.js'
import type { LabCheckpoint, LabExperiment, LabRun } from './types.js'

/**
 * THE USER GUIDE'S CLAIMS ARE TESTS (prd53 ruling 9 — prd-43's "the claim is a
 * test", reaching the lab). `docs/user-guide/the-lab.md` marks every
 * behavioural paragraph with `<!-- claim: <id> -->`; this file holds one
 * assertion per marker, and two laws over the marking itself:
 *
 * 1. the set of ids in the document equals the set of ids here — an unmarked
 *    paragraph that names a route, a status code, a flag or a ruling fails,
 *    and a claim asserted here that the document no longer makes fails too;
 * 2. every claim's paragraph still says what its assertion checks — each entry
 *    carries a `says` pattern the paragraph must match, so the prose cannot
 *    drift from the test that vouches for it.
 *
 * What an assertion may read: this package's own exports (executed), core's
 * laws (executed), and — for the server, whose modules a web test may not
 * import — the SOURCE TEXT of the file that implements the claim, the grep
 * idiom every count law in this repository already uses. A grep law is
 * weaker than an executed one and says so in its name.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..', '..', '..')
const GUIDE = path.join(REPO, 'docs', 'user-guide', 'the-lab.md')

function read(rel: string): string {
  return readFileSync(path.join(REPO, rel), 'utf8')
}

const server = {
  api: () => read('packages/server/src/api/lab.ts'),
  fork: () => read('packages/server/src/lab/fork.ts'),
  compare: () => read('packages/server/src/lab/compare.ts'),
  restore: () => read('packages/server/src/lab/restore.ts'),
  cli: () => read('packages/server/src/cli/index.ts'),
  labFork: () => read('packages/server/src/cli/lab-fork.ts'),
  cliArgs: () => read('packages/server/src/cli/args.ts'),
  coreEvents: () => read('packages/core/src/events/lab.ts'),
  rd: () => read('packages/server/src/lab/rd.ts'),
}
const web = {
  nav: () => read('packages/web/src/app/Nav.tsx'),
  page: () => read('packages/web/src/lab/LabPage.tsx'),
  launch: () => read('packages/web/src/lab/launch/LaunchPanel.tsx'),
  frame: () => read('packages/web/src/lab/frame/Frame.tsx'),
  metrics: () => read('packages/web/src/lab/metrics/Metrics.tsx'),
  trace: () => read('packages/web/src/lab/trace/TraceDiff.tsx'),
  api: () => read('packages/web/src/lab/api.ts'),
  rail: () => read('packages/web/src/lab/rail/Rail.tsx'),
  rows: () => read('packages/web/src/lab/rail/rows.ts'),
  rdTab: () => read('packages/web/src/lab/rd/RdTab.tsx'),
  rdClient: () => read('packages/web/src/lab/rd/rd.ts'),
}

/** The measure route's handler, as text — from its registration to the next route's. */
function measureHandler(): string {
  const api = server.api()
  const start = api.indexOf("app.post('/api/lab/measure'")
  const end = api.indexOf("app.post('/api/lab/launch'", start)
  expect(start, 'the measure route is registered').toBeGreaterThan(-1)
  expect(end, 'the launch route follows it').toBeGreaterThan(start)
  return api.slice(start, end)
}

function run(id: string, n: number): LabRun {
  return { eventId: id, dispatchedAt: 1000, run: n, laneHandle: `lane-${id}`, worktreePath: '/tmp/x' }
}
const TWO_BY_TWO: LabExperiment = {
  forkId: 'fork-1',
  parentLane: 'feature',
  checkpointId: 'ckpt-1',
  arms: [
    { arm: 1, treatment: { model: 'opus', promptDigest: null }, runs: [run('a1', 1), run('a2', 2)] },
    { arm: 2, treatment: { model: 'sonnet', promptDigest: null }, runs: [run('b1', 1), run('b2', 2)] },
  ],
}
const CHECKPOINT: LabCheckpoint = {
  eventId: 'e',
  lane: 'feature',
  checkpointId: 'ckpt-1',
  capturedAt: 1,
  capturedBy: 'operator',
  snapshotRef: 'refs/rhizomorph/checkpoints/ckpt-1',
  snapshotSha: 's',
  headSha: 'h',
  eventIndex: 3,
  sessionCutByte: 460,
  sessionByteLength: 1000,
}

interface Claim {
  /** A pattern the marked block must match — the prose and the assertion stay tied. */
  says: RegExp
  /**
   * The assertion, handed the block's own text. `grep` in the name means
   * source text was read, not code executed. Most claims are synchronous;
   * `frame-five` (#402) is the first to render a component and await its
   * effects, so this may return a promise — the one loop below that calls
   * `check` returns it too, rather than discarding it, so vitest actually
   * awaits an async claim instead of reporting it green before it ran.
   */
  check: (text: string) => void | Promise<void>
}

/** A quoted message, as the reader sees it: `> ` stripped, the marker gone, code ticks and straight quotes off the ends, whitespace collapsed. */
function quotedText(block: string): string {
  return block
    .split('\n')
    .map((line) => line.replace(/^>\s?/, ''))
    .join(' ')
    .replace(/<!-- claim: [a-z0-9-]+ -->/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[`"]|[`"]$/g, '')
}

const CLAIMS: Readonly<Record<string, Claim>> = {
  'explicit-hand': {
    says: /POST \/api\/lab\/launch[\s\S]*runCli[\s\S]*never imports the lab's own modules/,
    check: () => {
      const api = server.api()
      expect(api, 'grep: the route reaches the CLI in-process').toMatch(/runCli\(/)
      expect(api, 'grep: and never imports a lab module directly').not.toMatch(/from '\.\.\/lab\/(?:fork|compare|checkpoint|restore)\.js'/)
      expect(api, 'grep: launch is a registered route').toContain("app.post('/api/lab/launch'")
    },
  },
  /**
   * The walkthrough's spine (#477). The guide was 493 lines of reference with no
   * ordered path through it: a reader wanting to run one experiment had to
   * assemble the sequence out of six sections, and nothing said the three
   * commands were three steps of one workflow.
   *
   * What this claim holds is the sentence that makes the walkthrough safe to
   * follow — that the steps are three separate acts. A walkthrough is exactly
   * where a reader would otherwise assume the tool chains them, and the lab's
   * whole constitutional position is that it does not.
   */
  'walkthrough-three-acts': {
    says: /three separate[\s\S]*explicit acts[\s\S]*no entry point but the one you type/,
    check: () => {
      const args = server.cliArgs()
      expect(args, "grep: the usage table lists the three build steps in the walkthrough's order").toMatch(
        /rhizomorph lab checkpoint <lane>[\s\S]*rhizomorph lab fork <lane>[\s\S]*rhizomorph lab compare <fork-id>/,
      )
      // "No entry point but the one you type" is a claim about the namespace, not
      // about the table: the CLI reaches the lab through exactly one branch, and
      // `lab/namespace-law.test.ts` is what keeps any other caller out.
      expect(server.cli(), 'grep: one branch into the namespace').toContain("argv[0] === 'lab'")
      expect(server.cli(), 'grep: and it dispatches to the lab command').toContain('runLabCommand(')
    },
  },
  /**
   * Step 2's claim. Deliberately overlaps `writes-confined` and
   * `no-launch-quote` in what it ASSERTS while differing in what it says: those
   * two hold the confinement as constitutional text, this one holds it as the
   * thing a reader following step 2 will actually see happen.
   */
  'walkthrough-no-launch-default': {
    says: /bare .?fork.? dispatches nothing[\s\S]*off by[\s\S]*default/,
    check: () => {
      expect(server.labFork(), 'grep: --launch is off by default').toMatch(/--launch\s+Also run 'workmux add'[^\n]*OFF by default/)
      const cli = server.cli()
      expect(cli, 'grep: a bare fork says what it did not do').toContain('No tmux window was opened and no branch was created')
      expect(cli, 'grep: and names the flag that would authorise it').toContain('Pass --launch to authorise that yourself.')
    },
  },
  /**
   * Step 3's claim, and the reason the walkthrough is shorter than the reference
   * it replaces: the CLI already hands the operator the next command at both
   * ends, and nothing said so. A fork id is minted by the fork, so a walkthrough
   * that told the reader to "find your fork id" would be inventing work the tool
   * does not require.
   */
  'walkthrough-next-step': {
    says: /never have to find a fork id[\s\S]*exact compare invocation[\s\S]*as the step to run first/,
    check: () => {
      expect(server.cli(), 'grep: fork ends by printing the whole compare invocation').toContain('Compare them with: rhizomorph lab compare ')
      // Matched in two quote-free halves: the source writes this message with
      // escaped single quotes inside a single-quoted literal, so the sentence as
      // a reader sees it does not appear contiguously in the source text.
      const compare = server.compare()
      expect(compare, 'grep: the refusal names the fork subcommand').toContain('rhizomorph lab fork <lane>')
      expect(compare, 'grep: and offers the other possibility').toContain('first, or check the fork id')
    },
  },
  'writes-confined': {
    says: /refs\/rhizomorph\/[\s\S]*--ignore-scripts[\s\S]*--launch/,
    check: () => {
      expect(server.restore(), 'grep: the install never runs scripts').toContain("'--ignore-scripts'")
      expect(server.cli(), 'grep: without --launch the CLI says so and stops').toContain('Pass --launch to authorise that yourself.')
      expect(server.labFork(), 'grep: --launch is off by default').toMatch(/--launch\s+Also run 'workmux add'[^\n]*OFF by default/)
    },
  },
  'checkpoint-coordinates': {
    says: /byte the session transcript was cut at[\s\S]*total byte length[\s\S]*null/,
    check: () => {
      const api = server.api()
      for (const field of ['eventIndex', 'sessionCutByte', 'sessionByteLength']) expect(api, `grep: the checkpoint DTO carries ${field}`).toContain(field)
      expect(web.api(), 'grep: the console parses the byte length').toContain('sessionByteLength')
      expect(sessionFraction(CHECKPOINT.sessionCutByte, null), 'executed: unknown length is null, not a number').toBeNull()
    },
  },
  'one-fork-r-runs': {
    says: /--arms.*defaults to \*\*3\*\*[\s\S]*--runs.*to \*\*1\*\*[\s\S]*--fork-id[\s\S]*--arm-number[\s\S]*share one\s+fork id/,
    check: () => {
      const labFork = server.labFork()
      expect(labFork, 'grep: --runs defaults to 1').toMatch(/--runs <r>\s+How many runs of each arm \(default: 1\)/)
      expect(labFork, 'grep: --arms default is the ruling-4 floor').toMatch(/DEFAULT_FORK_ARMS/)
      expect(`${labFork}${server.fork()}`, 'grep: the floor is three').toMatch(/DEFAULT_FORK_ARMS = 3/)
      expect(labFork, 'grep: --fork-id joins an existing experiment').toMatch(/--fork-id <id>\s+Dispatch into an existing experiment/)
      expect(labFork, 'grep: --arm-number names the arm').toMatch(/--arm-number <k>\s+Which arm this call dispatches/)
      expect(server.api(), 'grep: the web launch passes one fork id per experiment').toContain("'--fork-id'")
    },
  },
  'run-restored': {
    says: /own Claude Code session[\s\S]*--no-audit --no-fund --ignore-scripts/,
    check: () => {
      expect(server.restore(), 'grep: the install, with exactly these flags').toContain("['install', '--no-audit', '--no-fund', '--ignore-scripts']")
    },
  },
  'no-launch-message': {
    says: /Without `--launch`, nothing runs/,
    check: () => {
      const cli = server.cli()
      expect(cli, 'grep: the message opens by naming what did not happen').toMatch(/No tmux window was opened/)
      expect(cli, 'grep: and closes with the flag').toContain('Pass --launch to authorise that yourself.')
    },
  },
  'cli-shares-treatment': {
    says: /shares the \*same\* treatment[\s\S]*LaunchPanel\.tsx/,
    check: () => {
      expect(server.labFork(), 'grep: one --model for the whole call').toMatch(/--model <m>\s+Model each arm's agent runs/)
      // A select per arm row since prd-55 wave 1 (the free-text input it replaced matched `arm.model`).
      expect(web.launch(), 'grep: the panel takes a model per arm row, as a select').toMatch(/<select\s+data-testid=\{`launch-arm-model-\$\{arm\.key\}`\}/)
      expect(web.launch(), 'grep: and a brief per arm row').toContain('data-testid={`launch-arm-brief-${arm.key}`}')
    },
  },
  'launch-ceiling': {
    says: /at most \*\*8\*\* spending lanes[\s\S]*--ceiling-override[\s\S]*"ceilingOverride"[\s\S]*recorded on\s+every `fork\.dispatched`/,
    check: () => {
      expect(server.api(), 'grep: the HTTP ceiling is 8').toContain('export const LAUNCH_CEILING_LANES = 8')
      expect(server.fork(), 'grep: the CLI ceiling is 8, duplicated by the namespace law').toMatch(/LAUNCH_CEILING_LANES = 8/)
      expect(server.api(), 'grep: the HTTP refusal names the override to pass').toContain('pass "ceilingOverride": ${lanes} to authorise exactly this many, and it is recorded on every fork.dispatched')
      expect(server.fork(), 'grep: the CLI refusal names the flag to pass').toContain('pass --ceiling-override ${lanes} to authorise')
      expect(server.coreEvents(), 'grep: the override is on the dispatched event').toContain('ceilingOverride')
    },
  },
  'compare-table': {
    says: /`arm`, `run`, `lane`[\s\S]*--no-verify[\s\S]*`not-run`[\s\S]*--json/,
    check: () => {
      expect(server.compare(), 'grep: --no-verify reports not-run').toContain("{ outcome: 'not-run' as const, detail: '--no-verify' }")
      expect(server.cli(), 'grep: compare has a --json form the measure route reads').toMatch(/--json/)
      expect(server.api(), 'grep: the measure route asks for it').toContain("'--json'")
    },
  },
  floors: {
    says: /\*\*3\*\* of its runs have completed[\s\S]*judged it, pass or fail[\s\S]*\*\*3\*\* of them[\s\S]*one observation, not a distribution/,
    check: () => {
      expect(MIN_COMPLETED_RUNS_TO_SUMMARISE, 'executed: the run floor').toBe(3)
      expect(MIN_ARMS_TO_RANK, 'executed: the arm floor').toBe(3)
      expect((['pass', 'fail', 'not-run', undefined] as const).map(isCompletedVerdict), 'executed: completed = judged').toEqual([true, true, false, false])
      for (const rel of ['packages/web/src/lab/metrics/spend.ts', 'packages/web/src/lab/compare/fromExperiment.ts', 'packages/web/src/lab/adapters.ts', 'packages/server/src/lab/compare.ts']) {
        expect(read(rel), `grep: ${rel} counts with core's predicate`).toContain('isCompletedVerdict')
      }
      expect(existsSync(path.join(HERE, 'floor-agreement-law.test.ts')), 'the cross-surface law exists').toBe(true)
      expect(COUNTERFACTUAL_CLAUSE).toBe('what actually happened is one observation, not a distribution')
      expect(server.compare(), 'grep: the CLI reads both floors from core').toMatch(/MIN_ARMS_TO_RANK,\s+MIN_COMPLETED_RUNS_TO_SUMMARISE/)
      expect(server.compare(), 'grep: the refusal carries the clause').toContain('`${COUNTERFACTUAL_CLAUSE}.`')
    },
  },
  'no-winner': {
    says: /no winner is\s+named: prd12 ruling 4 reports distributions, and the choice stays yours/,
    check: () => {
      expect(server.compare(), 'grep: the closing sentence, verbatim').toContain("'no winner is named: prd12 ruling 4 reports distributions, and the choice stays yours.'")
      expect(server.compare(), 'grep: the table is never sorted by a measurement').toMatch(/NOT sorted by any measurement/)
    },
  },
  'confound-voice': {
    says: new RegExp(CONFOUND_VOICE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')),
    check: () => {
      expect(server.compare(), 'grep: the CLI speaks core\'s voice').toContain('confoundVoice(dimensionsOf(comparison.arms))')
      expect(read('packages/web/src/lab/compare/attribution.ts'), 'grep: the console speaks the same').toContain('CONFOUND_VOICE')
    },
  },
  'measure-route': {
    says: /POST \/api\/lab\/measure[\s\S]*capability token[\s\S]*`fork\.measured`[\s\S]*\*\*400\*\*[\s\S]*\*\*404\*\*[\s\S]*\*\*503\*\*[\s\S]*\*\*409\*\*/,
    check: () => {
      const handler = measureHandler()
      expect(handler, 'grep: token-gated').toContain('requireCapabilityToken')
      for (const code of [400, 404, 503, 409]) expect(handler, `grep: answers ${code}`).toContain(`.code(${code})`)
      expect(MEASURE_URL, 'executed: the console posts to the same path').toBe('/api/lab/measure')
      expect(server.api(), 'grep: runs compare with the gate').toContain("'--verify'")
      expect(server.coreEvents(), 'grep: fork.measured is an event').toContain("'fork.measured'")
      expect(server.api(), 'grep: a leading dash is refused as a flag').toContain('a fork id names an experiment, not a flag')
    },
  },
  'measure-control': {
    says: /\*\*measure\*\* control[\s\S]*defaulting to `npm test`[\s\S]*naming how many worktrees[\s\S]*re-reads its experiments[\s\S]*verbatim/,
    check: () => {
      // The field's default IS the CLI's default — executed on the web side,
      // grepped on the server side a web test may not import.
      expect(DEFAULT_GATE_COMMAND, 'executed: the field default').toBe('npm test')
      expect(read('packages/server/src/cli/lab-compare.ts'), "grep: which is the CLI's own").toContain("const DEFAULT_VERIFY = 'npm test'")
      const control = read('packages/web/src/lab/measure-control/MeasureControl.tsx')
      expect(control, 'grep: one confirmation, naming the worktree count').toMatch(/measure-confirm-dialog-\$\{id\}[\s\S]*in \{worktrees\} worktree/)
      expect(control, 'grep: the route is reached only through the module that names it').toContain("from '../measure.js'")
      expect(control, 'grep: the refusal is the message, verbatim').toContain('{phase.message}')
      expect(web.page(), 'grep: mounted by the experiment panel, and the page re-reads on success').toMatch(/<MeasureControl[\s\S]*onMeasured=\{[^}]*reloadExperiments/)
      expect(existsSync(path.join(HERE, 'measure-control', 'MeasureControl.test.tsx')), "the control's own tests exist").toBe(true)
    },
  },
  'not-measured-voice': {
    says: /not measured\s+yet — no outcome is invented in its place[\s\S]*passed npm test \(measure-route\)/,
    check: () => {
      expect(NOT_MEASURED_VOICE).toBe('not measured yet — no outcome is invented in its place')
      expect(NOT_MEASURED, 'executed: one voice, two surfaces').toBe(NOT_MEASURED_VOICE)
      const provenance = { source: 'measure-route' as const, verifyCommand: 'npm test', measuredAt: 1 }
      const measured: LabRun = { ...run('m', 1), outcome: { verified: 'pass', verifiedDetail: null, costUsd: 1, durationMs: 1, commits: 1, provenance } }
      expect(runOutcomeVoice(measured), 'executed').toBe('passed npm test (measure-route)')
      expect(runOutcomeVoice({ ...measured, outcome: { ...measured.outcome!, verified: 'not-run' } }), 'executed: not-run reads unmeasured').toBe(NOT_MEASURED_VOICE)
      expect(runOutcomeVoice(run('u', 1)), 'executed').toBe(NOT_MEASURED_VOICE)
    },
  },
  'cli-lock': {
    says: /one lab CLI call in flight at a time[\s\S]*\*\*30 s\*\*[\s\S]*\*\*503\*\*/,
    check: () => {
      const api = server.api()
      expect(api, 'grep: the lock ceiling').toContain('export const LAB_CLI_LOCK_CEILING_MS = 30_000')
      expect(api, 'grep: the launch route maps it to 503').toMatch(/LabCliLockCeilingError\) \{\s*return reply\.code\(503\)/)
      expect(api, 'grep: process-wide queue').toContain('let labCliQueue')
    },
  },
  'nav-and-header': {
    says: /unavailable during replay — the lab forks live checkpoints, and this\s+session is history[\s\S]*forked realities only — checkpoints you captured,\s+and experiments forked from them\. Never live fleet state/,
    check: () => {
      expect(web.nav(), 'grep: the disabled reason, verbatim').toContain("'unavailable during replay — the lab forks live checkpoints, and this session is history'")
      expect(web.page(), 'grep: the header, verbatim').toContain('forked realities only — checkpoints you captured, and experiments forked from them. Never live fleet state.')
    },
  },
  'axis-one-function': {
    says: /percentage of its session[\s\S]*exactly one function[\s\S]*axis\/position\.ts[\s\S]*degraded/,
    check: () => {
      expect(sessionFraction(CHECKPOINT.sessionCutByte, CHECKPOINT.sessionByteLength), 'executed').toBe(0.46)
      const x = markerX(CHECKPOINT, 1000)
      expect(x, 'executed: placed inside the axis').toBeGreaterThan(0)
      expect(x as number).toBeLessThan(1000)
      expect(markerX({ ...CHECKPOINT, sessionCutByte: 900 }, 1000) as number, 'executed: a later cut sits further right').toBeGreaterThan(x as number)
      expect(markerX({ ...CHECKPOINT, sessionByteLength: null }, 1000), 'executed: unknown length places nothing').toBeNull()
      expect(existsSync(path.join(HERE, 'axis', 'position-law.test.ts')), 'the grep law that keeps it to one function exists').toBe(true)
    },
  },
  'frame-five': {
    says: /telemetry, cost, scene, divergence, footprint \(keys 1–5\)[\s\S]*read the lab's own routes[\s\S]*refused by name[\s\S]*sentences of their own, never blanks/,
    check: async () => {
      expect(POSITIONS.map((p) => p.label), 'executed').toEqual(['telemetry', 'cost', 'scene', 'divergence', 'footprint'])
      const frame = web.frame()
      expect(frame, 'grep: the scene position mounts the canvas').toContain('<LaneCanvas')
      // grep: the two positions this claim is about reach the lab's own
      // routes by name — the executed round trip below is what proves a
      // reading from them draws a real sentence, not just that the path
      // string appears somewhere in the source.
      expect(frame, 'grep: telemetry reads the lab route').toContain('/api/lab/telemetry')
      expect(frame, 'grep: footprint reads the lab route').toContain('/api/lab/footprint')

      // EXECUTED (#402): render the frame at positions 1 and 5 with a
      // fixture `fetchImpl` — the same escape hatch TraceDiff's own contract
      // test uses — so the REAL readLabTelemetry/readLabFootprint round-trip
      // runs, never a mock of the component itself. A refusal and an empty
      // reading each draw a non-empty sentence of their own; a live reading
      // draws the figure.
      const fixture =
        (telemetry: unknown, footprint: unknown): FetchLike =>
        (async (input: string | URL | Request) => {
          const href = String(input)
          const body = href.includes('/api/lab/telemetry') ? telemetry : href.includes('/api/lab/footprint') ? footprint : { available: false, reason: 'unhandled in claim fixture' }
          return { ok: true, status: 200, json: async () => body } as Response
        }) as unknown as FetchLike

      async function rendersASentenceAt(position: 1 | 5, fetchImpl: FetchLike, testId: string): Promise<void> {
        render(createElement(Frame, { position, onPosition: () => {}, seated: CHECKPOINT, experiments: [], fetchImpl }))
        const node = await screen.findByTestId(testId)
        expect(node.textContent, `executed: ${testId} is a sentence, not a blank`).not.toBe('')
        cleanup()
      }

      const refused = fixture(
        { available: false, reason: 'NO SUCH LANE "feature" in the lab\'s record' },
        { available: false, reason: 'NO SUCH LANE "feature" in the fold\'s branch record' },
      )
      await rendersASentenceAt(1, refused, 'frame-gap-telemetry')
      await rendersASentenceAt(5, refused, 'frame-gap-footprint')

      const empty = fixture(
        { available: true, lane: 'feature', atByte: CHECKPOINT.sessionCutByte, asOf: null, usage: [], costs: [], tools: [], activeTime: [] },
        { available: true, lane: 'feature', files: [], collisions: {} },
      )
      await rendersASentenceAt(1, empty, 'frame-telemetry-empty')
      await rendersASentenceAt(5, empty, 'frame-footprint-empty')

      const live = fixture(
        { available: true, lane: 'feature', atByte: CHECKPOINT.sessionCutByte, asOf: 1_700_000_000_000, usage: [{}], costs: [], tools: [], activeTime: [] },
        { available: true, lane: 'feature', files: ['src/a.ts'], collisions: {} },
      )
      await rendersASentenceAt(1, live, 'frame-telemetry')
      await rendersASentenceAt(5, live, 'frame-footprint')
    },
  },
  'launch-one-confirmation': {
    says: /no second dialog after that one/,
    check: () => {
      const launch = web.launch()
      expect(launch, 'grep: the estimate is the one confirmation').toContain("status: 'confirming'")
      expect(launch, 'grep: no browser dialog follows it').not.toMatch(/\bconfirm\(/)
    },
  },
  'estimate-basis': {
    says: /\/api\/lab\/estimate[\s\S]*\*\*hour\*\*[\s\S]*arms ×\s+runs[\s\S]*rate cannot\s+be established/,
    check: () => {
      const api = server.api()
      expect(api, 'grep: the window is one hour').toContain('const ESTIMATE_WINDOW_MS = 60 * 60_000')
      expect(api, 'grep: rate × lanes').toContain('estimatedTotalUsd: laneRow.costUsdPerHour * lanes')
      expect(web.launch(), 'grep: the basis is on screen').toContain("own rate over")
      expect(web.launch(), 'grep: no rate, no figure').toContain('the rate cannot be established')
    },
  },
  /**
   * The id keeps the name ruling 7 gave it — "the guide's `launch-panel-gap`
   * claim is rewritten to say what is now true, and its test fails until it
   * is". It did: the checks below are the old ones inverted. Until prd-55
   * wave 1 this claim asserted the panel did NOT contain `ceilingOverride`
   * and asked the estimate for arms alone.
   */
  'launch-panel-gap': {
    says: /\*runs per arm\*[\s\S]*\*ceiling override\*[\s\S]*only when set[\s\S]*arms ×\s+runs[\s\S]*`lab\.models`[\s\S]*\*other…\*[\s\S]*never a gate/,
    check: () => {
      const launch = web.launch()
      expect(launch, 'grep: runs travels only when set').toContain('...(runs === undefined ? {} : { runs })')
      expect(launch, 'grep: the override travels only when set').toContain('...(ceilingOverride === undefined ? {} : { ceilingOverride })')
      expect(launch, 'grep: the estimate is asked for arms × runs once runs is set').toMatch(
        /fetchLabEstimate\(\s*selectedCheckpoint\.lane,\s*runs === undefined \? arms\.length : \{ arms: arms\.length, runs \},/,
      )
      expect(launch, 'grep: the basis line prints the lanes the server counted').toContain('spending lane(s) — ${estimate.arms} arm(s) × ${estimate.runs} run(s)')
      expect(launch, 'grep: the model is a select over the list plus other…').toContain('<option value={OTHER_MODEL}>')
      expect(OTHER_MODEL, 'executed: the escape is spelled so no model name can collide with it').toBe('other…')
      expect(read('packages/web/src/settings/registry.ts'), 'grep: the list is declared, and it is the repo\'s').toMatch(/id: 'lab\.models',\s+group: 'repo'/)
      expect(read('packages/server/src/api/lab.ts'), 'grep: only the grammar refuses a model').toContain('export const MODEL_GRAMMAR')
    },
  },
  'workspace-regions': {
    says: /prd-55 ruling 8[\s\S]*prd-53-the-lab\.md[\s\S]*prd-55-the-lab-stage-two\.md/,
    check: () => {
      expect(web.page(), 'grep: the two regions in the live tree').toMatch(/<Rail/)
      expect(web.page(), 'grep: the stage top is pinned').toContain('data-testid="lab-stage-pinned"')
      expect(web.page(), 'grep: pinned means sticky, not merely first in DOM order').toMatch(/lab-stage-pinned"[^>]*sticky top-0/)
    },
  },
  'rail-rows': {
    says: /lists every checkpoint and every experiment[\s\S]*launch's\s+own step 1 reuses that same rail selection[\s\S]*arms ·\s+runs ·\s+verdict counts[\s\S]*partial launch's row says how many/,
    check: () => {
      expect(web.rail(), 'grep: one row per checkpoint').toContain('data-checkpoint-row')
      expect(web.rail(), 'grep: one row per experiment').toContain('data-experiment-row')
      expect(web.rows(), 'grep: the row carries a passed/failed/unmeasured verdict count').toMatch(/passed.*failed.*unmeasured/)
      expect(web.rows(), 'grep: a partial row is k of N arms, N the requested count').toMatch(/\$\{counts\.arms\} of \$\{counts\.arms \+ failedArms\.length\} arms/)
      expect(web.page(), 'grep: launch step 1 is the rail selection, not a second table').toMatch(/initialCheckpointId=\{seated/)
    },
  },
  'stage-tablist': {
    says: /Compare, Trace,\s+Metrics and R&D.*sit in a `role="tablist"`[\s\S]*R&D sits last in the strip[\s\S]*also reachable the moment a checkpoint is seated, before any experiment\s+exists at all/,
    check: () => {
      expect(web.page(), 'grep: the four tabs, R&D last').toContain("const TABS = ['Compare', 'Trace', 'Metrics', 'R&D'] as const")
      expect(web.page(), 'grep: it really is a tablist').toContain('role="tablist"')
      expect(web.page(), 'grep: R&D mounts even with no experiment selected, when a checkpoint is seated').toMatch(/seatedCheckpoint !== null[\s\S]{0,500}<RdTab/)
    },
  },
  'refusals-verbatim': {
    says: /prints the refusal it received verbatim/,
    check: () => {
      expect(web.launch(), 'grep: the failure phase carries the server\'s own message').toContain("setPhase({ status: 'launch-failed', message: err instanceof Error ? err.message : String(err) })")
      expect(server.api(), 'grep: a bad runs value names the ruling').toContain('"runs" must be a positive integer when present (prd53 ruling 1)')
      expect(server.api(), 'grep: replay answers 409').toContain('there is nothing live to measure')
    },
  },
  'empty-states': {
    says: /there are no checkpoints yet — capture\s+one with[\s\S]*there are no experiments yet —\s+fork a checkpoint with[\s\S]*the lab cannot see its experiments/,
    check: () => {
      const page = web.page()
      expect(page, 'grep').toContain('there are no checkpoints yet — capture one with `rhizomorph lab checkpoint')
      expect(page, 'grep').toContain('the lab cannot see its experiments — {experiments.message}')
      expect(EMPTY_COPY, 'executed: Metrics says it in the same words').toBe('there are no experiments yet — fork a checkpoint with `rhizomorph lab fork <lane>`')
    },
  },
  'partial-launch': {
    says: /n sequential CLI calls with no atomicity[\s\S]*names the arm that failed[\s\S]*k of N requested arms dispatched[\s\S]*never attempted[\s\S]*present and excluded[\s\S]*stub — named, and never counted/,
    check: () => {
      expect(web.launch(), 'grep: the panel names the failed arm').toContain('failed and dispatch stopped there')
      expect(web.launch(), 'grep: k of N, with N the requested count').toContain('of {phase.outcome.requestedArms} requested arm(s) dispatched')
      expect(read('packages/web/src/lab/launch/launch.ts'), 'grep: N is the request\'s, stamped on the outcome').toContain('requestedArms: request.arms.length')
      expect(web.page(), 'grep: every arm after the failed one is listed as never attempted').toContain('never attempted')
      const layout = layoutCanvas({ experiment: TWO_BY_TWO, failedArms: [{ arm: 3, error: 'restore failed' }] })
      // prd-55 ruling 11 (#385) made the picture ribbons rather than organisms;
      // the claim is unchanged — the stub is drawn and it is not counted.
      expect(layout.ribbons, 'executed: the stub is not one of the ribbons').toHaveLength(4)
      expect(layout.stubs.map((s) => s.arm), 'executed: and it is drawn').toEqual([3])
      expect(read('packages/web/src/lab/compare/ComparisonSurface.tsx'), 'grep: failed arms on the surface').toMatch(/failedArms/)
    },
  },
  'comparison-surface': {
    says: /renders against the live server now[\s\S]*Scoring —\s+no source yet[\s\S]*min · median · max/,
    check: () => {
      expect(SCORING_UNAVAILABLE, 'executed').toBe('Scoring — no source yet')
      expect(read('packages/web/src/lab/compare/ComparisonSurface.tsx'), 'grep: the distribution line').toMatch(/median/)
      expect(server.api(), 'grep: the outcome is on the wire, per run').toMatch(/LabRunOutcomeDTO/)
    },
  },
  'trace-no-persistence': {
    says: /same, diverged, added, absent[\s\S]*stored nowhere/,
    check: () => {
      expect(web.trace(), 'grep: reads transcripts').toContain('labTranscriptUrl(')
      expect(web.trace(), 'grep: writes nothing').not.toMatch(/localStorage|sessionStorage|method: 'POST'/)
      expect(existsSync(path.join(HERE, 'trace', 'no-persistence-law.test.ts')), 'the law that keeps it so exists').toBe(true)
    },
  },
  'metrics-basis': {
    says: /Every figure carries its basis in the DOM/,
    check: () => {
      expect(web.metrics(), 'grep: figure and basis are DOM attributes').toMatch(/data-figure[\s\S]*data-basis/)
    },
  },
  'canvas-one-per-run': {
    // prd-55 ruling 11 (#385): the picture is ribbons painted with the scene's
    // six pure brushes, not n small organisms of the lab's own. The claim's
    // meaning is untouched — one per dispatch record, keyed by the run handle,
    // nothing synthesised, the scene reached only through public exports — so
    // the sentence and this check follow the picture rather than the reverse.
    says: /n ribbons, one per run[\s\S]*no count is ever synthesised[\s\S]*six pure brushes[\s\S]*never its fold/,
    check: () => {
      const layout = layoutCanvas({ experiment: TWO_BY_TWO, checkpoint: CHECKPOINT, width: 1000 })
      expect(layout.ribbons, 'executed').toHaveLength(4)
      expect(new Set(layout.ribbons.map((ribbon) => ribbon.id)), 'executed: keyed by the run handles').toEqual(new Set(['lane-a1', 'lane-a2', 'lane-b1', 'lane-b2']))
      expect(layout.root.at.x, 'executed: root at the axis position').toBe(markerX(CHECKPOINT, 1000))
      const organism = read('packages/web/src/lab/canvas/organism.ts')
      for (const brush of ['geometry', 'palette', 'ribbon', 'contour', 'motes', 'heart']) {
        expect(organism, `grep: the ${brush} brush, through its public export`).toContain(`from '../../scene/${brush}.js'`)
      }
      expect(organism, 'grep: and never a scene module that reads the fold').not.toMatch(/scene\/(?:retire|salience|variation|pulses|SceneView)/)
    },
  },
  'rd-explicit-act': {
    says: /same\s+second hand \(prd12 ruling 1\)[\s\S]*same shape as `lab fork --launch` reaching `workmux add`[\s\S]*no tools granted[\s\S]*runCli[\s\S]*0048-the-instrument-spawns-the-operators-own-tools-as-an-explicit-act\.md/,
    check: () => {
      const rd = server.rd()
      expect(rd, 'grep: the hand is spawned in print mode with no tools').toMatch(/'-p',\s*'--output-format',\s*'json'/)
      expect(rd, 'grep: --tools "" is the no-tools flag').toContain("'--tools', ''")
      expect(server.api(), 'grep: the route reaches the CLI in-process, the same seam as every other lab write').toContain("app.post('/api/lab/rd'")
      expect(server.cli(), 'grep: the CLI subcommand exists too').toContain('runLabRdCommand')
      expect(existsSync(path.join(REPO, 'docs', 'adr', '0048-the-instrument-spawns-the-operators-own-tools-as-an-explicit-act.md')), 'the ADR this paragraph cites exists').toBe(true)
      expect(rd, 'grep: provenance carries the CLI\'s own reported cost, never a re-derived one').toContain('total_cost_usd')
    },
  },
  'rd-no-cli': {
    says: /resolved on the server's own PATH under the name the operator\s+declares \(`lab\.agentCommand`, default `claude`\); absent, the control is\s+disabled and says so, character for character/,
    check: () => {
      expect(read('packages/web/src/settings/registry.ts'), 'grep: the operator declares the binary name').toMatch(/id: 'lab\.agentCommand'/)
      expect(web.rdTab(), 'grep: the control reads that preference and disables on the no-CLI state').toContain("readChoice('lab.agentCommand')")
      expect(web.rdTab(), 'grep: disabled tracks the same run as the sentence').toContain('const noCli =')
    },
  },
  'rd-no-cli-quote': {
    says: /no claude on this machine's PATH — the R&D hand is your CLI, installed by you/,
    check: (text) => {
      expect(server.rd(), 'grep: the server\'s own sentence, verbatim').toContain(
        "export const RD_NO_CLI_SENTENCE = \"no claude on this machine's PATH — the R&D hand is your CLI, installed by you\"",
      )
      expect(quotedText(text), 'the guide quotes the fixture already proven against the real route by the contract test').toBe(RD_NO_CLI_SENTENCE_FIXTURE)
    },
  },
  'rd-control': {
    says: /model select over this repo's own list \(`lab\.models`,\s+prd-55 ruling 5[\s\S]*hand never runs without a click[\s\S]*no effect posts to\s+`\/api\/lab\/rd` on mount or on any prop change/,
    check: () => {
      expect(web.rdTab(), 'grep: the model select reads the shared offered-models hook').toContain('useOfferedModels()')
      expect(web.rdTab(), 'grep: the corpus checkbox is the rdCorpus preference').toContain("data-testid=\"rd-corpus-tracker\"")
      expect(web.rdTab(), 'grep: the one write is behind the button\'s own click').toMatch(/data-testid="rd-read-and-propose"[\s\S]{0,200}onClick=\{\(\) => void readAndPropose\(\)\}/)
      expect(web.rdTab(), 'grep: nothing calls requestRd from an effect').not.toMatch(/useEffect\([^)]*requestRd/)
    },
  },
  'rd-corpus': {
    says: /The corpus is local first\*\* \(prd-55 ruling 2\)[\s\S]*second, separately declared act[\s\S]*`lab\.rdCorpus`, off by default, repo-scoped\s+in settings[\s\S]*refused by name rather than silently dropped[\s\S]*prints\s+which corpus produced each\s+pattern beside the pattern/,
    check: () => {
      expect(read('packages/web/src/settings/registry.ts'), 'grep: off by default, repo-scoped').toMatch(/id: 'lab\.rdCorpus'[\s\S]{0,400}scope: 'repo'[\s\S]{0,200}fallback: false/)
      expect(server.rd(), 'grep: a gh failure is refused by name, not swallowed').toContain('the tracker corpus was asked for and gh could not answer')
      expect(web.rdTab(), 'grep: the pattern-level corpus label is read off the pattern\'s own sources').toContain('function patternCorpusLabel')
      expect(web.rdTab(), 'grep: a tracker-sourced item is spelled tracker#').toContain("id.startsWith('tracker#')")
    },
  },
  'rd-pattern-floor': {
    says: /Patterns are grouped by shape, and a single occurrence is held back\*\*\s+\(prd-55 ruling 3\)/,
    check: () => {
      expect(read('packages/core/src/lab/rd.ts'), 'grep: the floor is two').toContain('RD_PATTERN_FLOOR = 2')
      expect(read('packages/core/src/lab/rd.ts'), 'grep: below it, held back').toContain('export function isHeldBack')
    },
  },
  'rd-held-back-quote': {
    says: /1 issue · not yet a pattern — testing a shape that may not recur spends real money/,
    check: (text) => {
      expect(quotedText(text), 'the guide quotes the one-row copy, verbatim').toBe(RD_HELD_BACK_ROW_COPY)
      expect(web.rdTab(), 'grep: the row copy is a live function of the count, not a retyped literal').toContain('function heldBackRowCopy')
    },
  },
  'rd-nothing-proposed-quote': {
    says: /no pattern recurs — nothing is proposed\./,
    check: (text) => {
      expect(quotedText(text), 'the guide quotes the empty-list copy, verbatim').toBe(RD_NOTHING_PROPOSED_COPY)
      expect(web.rdTab(), 'grep: rendered when every pattern is held back').toContain('run.patterns.every((pattern) => pattern.heldBack)')
    },
  },
  'rd-no-corpus-quote': {
    says: /nothing to read yet — a retro, or a measured experiment, is where a pattern comes from\./,
    check: (text) => {
      expect(quotedText(text), 'the guide quotes the no-corpus copy, verbatim').toBe(RD_NO_CORPUS_COPY)
      expect(web.rdTab(), 'grep: rendered when the corpus read nothing').toContain('run.corpus.itemCount === 0')
    },
  },
  'rd-patterns': {
    says: /A proposal names one pattern, one varying dimension, and 2–3 arms differing\s+only in that dimension[\s\S]*Zero\s+varying dimensions is a replication, not a confound, and passes clean[\s\S]*raw JSON as a download-free `<details>`[\s\S]*genuinely no raw text for that case/,
    check: () => {
      expect(read('packages/core/src/lab/rd.ts'), 'grep: zero varying dimensions passes — a replication, not a confound').toMatch(/Zero varying dimensions passes: that is a replication/)
      expect(read('packages/core/src/lab/rd.ts'), 'grep: the three refusal reasons').toContain('RD_HELD_BACK_REFUSAL')
      expect(read('packages/core/src/lab/rd.ts'), 'grep: and the wrong-dimension one').toContain('RD_WRONG_DIMENSION_REFUSAL')
      expect(web.rdTab(), 'grep: a live refusal offers the hand\'s own raw text').toContain('refusal.rawResult')
      expect(web.rdTab(), 'grep: a client-caught refusal says plainly it was caught here').toMatch(/caught here, at the surface, rather than returned by the R&D\s+route/)
    },
  },
  'rd-launch-review': {
    says: /A proposal dispatches through the launch the lab already has\*\* \(prd-55\s+ruling 4\)[\s\S]*prefilled with the proposal's\s+own checkpoint and every arm's model[\s\S]*resulting experiment's\s+`fork\.dispatched`\s+record holds `proposalId` durably[\s\S]*launch route itself records `rd\.override`, naming both checkpoints/,
    check: () => {
      expect(web.rdTab(), 'grep: the review prefills the proposal\'s arms and checkpoint').toMatch(/initialArms=\{reviewFor\.proposal\.arms/)
      expect(web.rdTab(), 'grep: and carries the proposal id to the route').toContain('proposalId={reviewFor.proposal.proposalId}')
      expect(web.launch(), 'grep: the launch body sends it, only when set').toMatch(/proposalId === undefined \? \{\} : \{ proposalId \}/)
      expect(server.api(), 'grep: the launch route looks the proposal up and records the override itself').toContain('recordOverrideIfNeeded')
      expect(server.api(), 'grep: an unknown proposal id is refused by name').toMatch(/names no proposal this repo has recorded/)
    },
  },
  'rd-override-quote': {
    says: /operator override — the choice is never re-attributed to the agent/,
    check: (text) => {
      expect(quotedText(text), 'the guide quotes the override sentence, verbatim').toBe(RD_OVERRIDE_SENTENCE)
      expect(web.rdTab(), 'grep: rendered when the launched checkpoint disagrees with the proposal\'s own pick').toContain('linked.outcome.checkpointId !== proposal.checkpointPick.chosenCheckpointId')
    },
  },
  'rd-baseline-quote': {
    says: /no measured baseline — the retro's own words/,
    check: (text) => {
      expect(quotedText(text), 'the guide quotes the no-measured-baseline sentence, verbatim').toBe(RD_NO_MEASURED_BASELINE)
      expect(web.rdTab(), 'grep: the baseline is the source item\'s own measured run, one observation').toContain('function measuredBaselineFor')
    },
  },
  'rd-keyboard': {
    says: /`↑`\/`↓` move the patterns list, `Enter` opens a pattern\s+or a proposal[\s\S]*`Tab` reaches the proposal panel in DOM order, `Esc` closes the launch\s+review/,
    check: () => {
      expect(web.rdTab(), 'grep: arrow keys move the patterns list').toContain('function onPatternsKeyDown')
      expect(web.rdTab(), 'grep: Escape closes the review').toMatch(/event\.key === 'Escape'/)
      expect(web.rdTab(), 'grep: the model field is a native select').toContain('data-testid="rd-model"')
      expect(web.rdTab(), 'grep: no title attribute anywhere in this surface').not.toMatch(/\btitle=\{/)
    },
  },
  'rd-refusals': {
    says: /Refusals from `POST \/api\/lab\/rd` itself\*\*: \*\*400\*\* for a malformed body[\s\S]*\*\*503\*\* when the\s+lab's CLI lock could not be taken[\s\S]*\*\*409\*\* on a server that is replaying a session record/,
    check: () => {
      expect(server.api(), 'grep: a bad model names the ruling').toContain('a call that spends real money does not choose its own model (prd-55 ruling 1)')
      expect(server.api(), 'grep: a bad corpus names the ruling and the two legal values').toContain('reading the tracker through your own gh is a second declared act (prd-55 ruling 2), and there is no third corpus')
      expect(server.api(), 'grep: the rd route answers 400 for a validation error').toMatch(/RdValidationError\) \{\s*return reply\.code\(400\)/)
      expect(server.api(), 'grep: and 503 for the CLI lock').toMatch(/LabCliLockCeilingError\) \{\s*return reply\.code\(503\)/)
      expect(server.api(), 'grep: and 409 while replaying').toContain('there is no record here for the R&D hand to read')
    },
  },
  'rd-cost-gap': {
    says: /not yet booked as `llm\.cost`\.\*\*[\s\S]*TELEMETRY_SOURCES`\s+still names only `sessionlog` and\s+`otel`/,
    check: () => {
      expect(read('packages/core/src/events/telemetry.ts'), 'grep: the gap this claim names is real, not stale').toContain("const TELEMETRY_SOURCES = ['sessionlog', 'otel'] as const")
      expect(server.rd(), 'grep: the cost the guide describes is on the event\'s own provenance').toContain('total_cost_usd')
    },
  },
  'windows-five': {
    says: /Five `lab\/` files fail on native Windows[\s\S]*prd-25/,
    check: () => {
      const rows = read('.windows-known-failures').split('\n').filter((line) => line.startsWith('packages/server/src/lab/'))
      expect(rows, 'executed over the file: exactly five, each with a cause class').toHaveLength(5)
      for (const row of rows) expect(row, 'a row names its cause class').toMatch(/^\S+\s+(line-endings|process-signalling|drive-letter|temp-dir)\s/)
    },
  },
  'mid-tool-call-unowned': {
    says: /Nothing in the\s+restore path looks for a tool-call boundary[\s\S]*\*\*Unowned\*\*/,
    check: () => {
      expect(server.restore(), 'grep: when someone handles the cut, this claim must be rewritten').not.toMatch(/tool_use|tool-call|toolCall/)
    },
  },
  'fork-exec-ceiling': {
    says: /bounded, by a ceiling sized to[\s\S]*what it waits for\*\*[\s\S]*FORK_EXEC_TIMEOUT_MS[\s\S]*FORK_LAUNCH_TIMEOUT_MS[\s\S]*still unowned/,
    check: () => {
      // Both ceilings, and both NUMBERS, because the sentence states both. The
      // previous shape greped only the 5 s constant, which never moved — so when
      // #408 gave `workmux add` its own 120 s ceiling the paragraph above went
      // FALSE and this claim stayed green. A claim that holds while its prose
      // lies is the one failure this law exists to prevent; grep what the
      // sentence actually says.
      expect(server.fork(), 'grep').toContain('export const FORK_EXEC_TIMEOUT_MS = 5000')
      expect(server.fork(), 'grep').toContain('export const FORK_LAUNCH_TIMEOUT_MS = 120_000')
    },
  },
  'law-itself': {
    says: /Every behavioural sentence on this page is a test[\s\S]*held to the source text, word for word/,
    check: () => {
      // The sentence is true iff no behavioural block outside a heading lacks a marker — the marker law below, restated as a claim about the page.
      const unvouched = paragraphsOf(readFileSync(GUIDE, 'utf8').replace(/\r\n/g, '\n')).filter((p) => p.kind !== 'heading' && p.claim === null && BEHAVIOURAL.test(p.text))
      expect(unvouched.map((p) => p.text.slice(0, 60)), 'executed over the document').toEqual([])
    },
  },
  'ceiling-refusal-quote': {
    says: /refusing to dispatch 9 spending lane\(s\) \(3 arm\(s\) × 3 run\(s\)\)[\s\S]*pass --ceiling-override 9/,
    check: (text) => {
      const fork = server.fork()
      // The three pieces of the template, as the source spells them — a changed word in fork.ts fails here.
      expect(fork, 'grep: the refusal template, piece 1').toContain('`refusing to dispatch ${lanes} spending lane(s) (${options.arms} arm(s) × ${runs} run(s)): the launch ceiling is ${ceiling}`')
      expect(fork, 'grep: piece 2').toContain("`${options.ceilingOverride === undefined ? ' (the default)' : ' (your override)'} — pass --ceiling-override ${lanes} to authorise `")
      expect(fork, 'grep: piece 3').toContain("'exactly this many; the override is recorded on every fork.dispatched it produces (prd53 ruling 6)'")
      expect(fork, 'grep: the default the quote names').toMatch(/LAUNCH_CEILING_LANES = 8/)
      // The quote is that template rendered for 3 arms × 3 runs against the default — a changed word in the guide fails here.
      expect(quotedText(text), 'the guide quotes the rendered refusal verbatim').toBe(
        'refusing to dispatch 9 spending lane(s) (3 arm(s) × 3 run(s)): the launch ceiling is 8 (the default) — pass --ceiling-override 9 to authorise exactly this many; the override is recorded on every fork.dispatched it produces (prd53 ruling 6)',
      )
    },
  },
  'no-launch-quote': {
    says: /No tmux window was opened and no branch was created/,
    check: (text) => {
      const cli = server.cli()
      const pieces = [
        'No tmux window was opened and no branch was created: prd12 ruling 1 confines the',
        "laboratory's writes to refs/rhizomorph/, its own worktrees and its data dir, and",
        "'workmux add' writes outside all three. Pass --launch to authorise that yourself.",
      ]
      for (const piece of pieces) expect(cli, `grep: the CLI prints "${piece.slice(0, 30)}…"`).toContain(piece)
      expect(quotedText(text), 'the guide quotes the CLI verbatim').toBe(pieces.join(' '))
    },
  },
  'rank-refusal-quote': {
    says: /arm\(s\) — runs only\. Ranking needs n >= 3/,
    check: (text) => {
      const compare = server.compare()
      expect(compare, 'grep: the refusal, line 1').toContain('`${arms} arm(s) — runs only. Ranking needs n >= ${MIN_ARMS_TO_RANK} (prd12 ruling 4:`')
      expect(compare, 'grep: line 2').toContain("'a comparison below three arms reports what happened, never which arm was better).'")
      expect(compare, 'grep: line 3').toContain('`${COUNTERFACTUAL_CLAUSE}.`')
      expect(quotedText(text), 'executed: the guide quotes the refusal rendered with core\'s own constants').toBe(
        `<n> arm(s) — runs only. Ranking needs n >= ${MIN_ARMS_TO_RANK} (prd12 ruling 4: a comparison below three arms reports what happened, never which arm was better). ${COUNTERFACTUAL_CLAUSE}.`,
      )
    },
  },
  'refusal-table': {
    says: /\| \*\*400\*\* \| arms × runs above the ceiling[\s\S]*\| \*\*400\*\* \| `runs` or `ceilingOverride`[\s\S]*\| \*\*503\*\*[\s\S]*30 s[\s\S]*\| \*\*409\*\*/,
    check: () => {
      const api = server.api()
      const start = api.indexOf("app.post('/api/lab/launch'")
      expect(start, 'the launch route is registered').toBeGreaterThan(-1)
      const launch = api.slice(start)
      for (const code of [400, 503, 409]) expect(launch, `grep: the launch route answers ${code}`).toContain(`.code(${code})`)
      expect(api, 'grep: row 1 — the ceiling refusal names the override to pass').toContain('pass "ceilingOverride": ${lanes} to authorise exactly this many')
      expect(api, 'grep: row 2 — a bad runs value names the ruling').toContain('"runs" must be a positive integer when present (prd53 ruling 1)')
      expect(api, 'grep: row 2 — a bad override names the ruling').toContain('"ceilingOverride" must be a positive integer of spending lanes when present')
      expect(api, 'grep: row 3 — the lock ceiling is thirty seconds').toContain('LAB_CLI_LOCK_CEILING_MS = 30_000')
      expect(api, 'grep: row 3 — the refusal names the holder').toContain('labCliQueueLabel')
      expect(launch, 'grep: row 4 — replay answers with the reason').toContain('there is nothing live to fork')
    },
  },
}

// --- reading the document -----------------------------------------------------

interface Paragraph {
  readonly text: string
  readonly claim: string | null
  /**
   * Prose, a blockquote and a table can all carry a claim (the marker rides the
   * quote's last line, or the line after the table's last row). A heading names a
   * section; its claims live in the blocks beneath it, and it may name a ruling
   * but never a route, a code or a flag (the heading law below).
   */
  readonly kind: 'prose' | 'quote' | 'table' | 'heading'
}

function kindOf(text: string): Paragraph['kind'] {
  if (text.startsWith('#')) return 'heading'
  if (text.startsWith('>')) return 'quote'
  if (text.startsWith('|')) return 'table'
  return 'prose'
}

/**
 * Every block outside a fence, tagged. The first draft returned only prose and
 * dropped the rest, which left a heading, a blockquote or a table free to name
 * behaviour with nothing vouching for it (review of #330: three verbatim error
 * messages and the status-code table, the shapes that rot fastest). Ruled
 * 2026-09-08: the marker's reach extends to quotes and tables, and a quoted
 * message is held to the source text word for word.
 */
function paragraphsOf(markdown: string): Paragraph[] {
  const out: Paragraph[] = []
  let fenced = false
  let current: string[] = []
  const flush = () => {
    if (current.length === 0) return
    const text = current.join('\n')
    current = []
    const marker = /<!-- claim: ([a-z0-9-]+) -->/.exec(text)
    out.push({ text, claim: marker?.[1] ?? null, kind: kindOf(text) })
  }
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) {
      fenced = !fenced
      flush()
      continue
    }
    if (fenced) continue
    if (line.trim() === '') {
      flush()
      continue
    }
    // A list item is its own paragraph — the residuals and the six sections each carry their own claim.
    if (/^(?:- |\d+\. )/.test(line)) flush()
    current.push(line)
  }
  flush()
  return out
}

const BEHAVIOURAL = /\/api\/lab\/|\b(?:400|404|409|503)\b|(?:^|\s)`?--[a-z]|ruling \d/

describe('the-lab.md — every behavioural claim is a test (prd53 ruling 9)', () => {
  /**
   * CRLF-normalised at the read (review of #342). A Windows checkout hands
   * this file back with `\r\n`, `paragraphsOf` splits on `\n`, and every
   * paragraph then carries a trailing `\r` — invisible to the two laws that
   * compare against `[]` or a `[\s\S]*` pattern, and fatal to the gap law
   * below, which compares a 72-character slice against literal text. The
   * `windows-suite` leg is the only one that sees it, and it did: this line
   * is what a red `the behavioural blocks outside prose are exactly these`
   * on Windows cost. What this law reads is prose, not bytes; `corpus-eol-law`
   * is where line endings themselves are the subject.
   */
  const guide = readFileSync(GUIDE, 'utf8').replace(/\r\n/g, '\n')
  const paragraphs = paragraphsOf(guide)
  const claimable = paragraphs.filter((p) => p.kind !== 'heading')
  const marked = claimable.filter((p) => p.claim !== null)
  const textOf = new Map(marked.map((p) => [p.claim as string, p.text]))

  it('the document marks its claims, and the ids here are exactly the ids there — neither side may drift', () => {
    const ids = marked.map((p) => p.claim as string)
    expect(new Set(ids).size, 'no id is used twice').toBe(ids.length)
    expect(ids.sort()).toEqual(Object.keys(CLAIMS).sort())
  })

  it('a prose paragraph, a quoted message or a table naming a route, a status code, a flag or a ruling carries a claim marker', () => {
    const unmarked = claimable.filter((p) => p.claim === null && BEHAVIOURAL.test(p.text)).map((p) => `${p.kind}: ${p.text.slice(0, 80)}`)
    expect(unmarked).toEqual([])
  })

  it('a heading may name a ruling, never a route, a status code or a flag — behaviour lives in the blocks beneath it', () => {
    const behaviouralHeading = /\/api\/lab\/|\b(?:400|404|409|503)\b|(?:^|\s)`?--[a-z]/
    expect(paragraphs.filter((p) => p.kind === 'heading' && behaviouralHeading.test(p.text)).map((p) => p.text)).toEqual([])
  })

  it('each marked block still says what its assertion checks', () => {
    for (const p of marked) {
      const claim = CLAIMS[p.claim as string]
      if (claim === undefined) continue // reported by the set test above
      expect(p.text, `claim "${p.claim}" no longer says what its test vouches for`).toMatch(claim.says)
    }
  })

  /**
   * THE GAP IN THE LAW ABOVE, STATED RATHER THAN LEFT SILENT (review of #330).
   * The marker law reads PROSE. A heading, a blockquote or a table is not a
   * claimable paragraph and cannot carry a marker — so behaviour written in one
   * is vouched for by nothing, and the document's own opening line says
   * "every behavioural sentence on this page is a test". EXECUTED: six blocks
   * name a route, a code, a flag or a ruling from outside the prose, three of
   * them VERBATIM ERROR MESSAGES and one a table of status codes — the two
   * shapes that rot fastest when the code moves.
   *
   * Stated as the exact gap rather than a count or a floor, the same way
   * `eras.test.ts` states its uncovered families: this list may shrink freely
   * (move a quote into marked prose, or drop it), but a NEW unvouched-for
   * behavioural block cannot join it without this test going red and someone
   * saying so out loud. It shrank to nothing on 2026-09-08, when the marker's
   * reach was extended to quotes and tables (Lachlan's ruling on this review)
   * and headings got a law of their own; it stays as the guard.
   */
  it('the behavioural blocks outside the marker law\'s reach are exactly these — none; a new one may not join silently', () => {
    // Ruled 2026-09-08 (Lachlan, on this review): the six blocks this list once named
    // — three verbatim messages, the status table, the opening quote, one heading —
    // are claims now or headings held by their own law. The list stays, empty, as
    // the guard it was built to be: a block the marker law cannot reach shows up here.
    const uncovered = paragraphs
      .filter((p) => p.kind === 'heading' && /\/api\/lab\/|\b(?:400|404|409|503)\b|(?:^|\s)`?--[a-z]/.test(p.text))
      .map((p) => (p.text.split('\n')[0] as string).slice(0, 72))
    expect(uncovered).toEqual([])
  })

  for (const [id, claim] of Object.entries(CLAIMS)) {
    // Returns `check`'s result rather than discarding it: a synchronous claim
    // returns undefined either way, and an async one (frame-five, #402) hands
    // vitest a real promise to await instead of reporting green before its
    // assertions ran.
    it(`claim "${id}" holds against the code`, () => claim.check(textOf.get(id) ?? ''))
  }
})
