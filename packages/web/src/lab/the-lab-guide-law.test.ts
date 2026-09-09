import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONFOUND_VOICE, COUNTERFACTUAL_CLAUSE, isCompletedVerdict, MIN_ARMS_TO_RANK, MIN_COMPLETED_RUNS_TO_SUMMARISE } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import { NOT_MEASURED_VOICE, runOutcomeVoice } from './adapters.js'
import { markerX, sessionFraction } from './axis/position.js'
import { layoutCanvas } from './canvas/organism.js'
import { NOT_MEASURED, SCORING_UNAVAILABLE } from './compare/fromExperiment.js'
import { POSITIONS } from './frame/Frame.js'
import { MEASURE_URL } from './measure.js'
import { EMPTY_COPY } from './metrics/Metrics.js'
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
  coreEvents: () => read('packages/core/src/events/lab.ts'),
}
const web = {
  nav: () => read('packages/web/src/app/Nav.tsx'),
  page: () => read('packages/web/src/lab/LabPage.tsx'),
  launch: () => read('packages/web/src/lab/launch/LaunchPanel.tsx'),
  frame: () => read('packages/web/src/lab/frame/Frame.tsx'),
  metrics: () => read('packages/web/src/lab/metrics/Metrics.tsx'),
  trace: () => read('packages/web/src/lab/trace/TraceDiff.tsx'),
  api: () => read('packages/web/src/lab/api.ts'),
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
  /** The assertion, handed the block's own text. `grep` in the name means source text was read, not code executed. */
  check: (text: string) => void
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
      expect(web.launch(), 'grep: the panel takes a model per arm row').toMatch(/arm\.model|model:/)
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
    says: /telemetry, cost, scene, divergence, footprint \(keys 1–5\)[\s\S]*state that gap/,
    check: () => {
      expect(POSITIONS.map((p) => p.label), 'executed').toEqual(['telemetry', 'cost', 'scene', 'divergence', 'footprint'])
      const frame = web.frame()
      expect(frame, 'grep: telemetry states its gap').toContain('no lab route carries them yet')
      expect(frame, 'grep: footprint states its gap').toContain('neither on a lab route yet')
      expect(frame, 'grep: the scene position mounts the canvas').toContain('<LaneCanvas')
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
  'launch-panel-gap': {
    says: /launches one run per arm\s+and sends no ceiling override today/,
    check: () => {
      const launch = web.launch()
      expect(launch, 'grep: when the panel learns the override, rewrite the guide').not.toContain('ceilingOverride')
      expect(launch, 'grep: the estimate is asked for arms alone').toContain('fetchLabEstimate(selectedCheckpoint.lane, arms.length, fetchImpl)')
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
    says: /n sequential CLI calls with no atomicity[\s\S]*names the arm that failed[\s\S]*present and excluded[\s\S]*stub — named, and never counted/,
    check: () => {
      expect(web.launch(), 'grep: the panel names the failed arm').toContain('failed and dispatch stopped there')
      const layout = layoutCanvas({ experiment: TWO_BY_TWO, failedArms: [{ arm: 3, error: 'restore failed' }] })
      expect(layout.organisms, 'executed: the stub is not an organism').toHaveLength(4)
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
    says: /n organisms, one per run[\s\S]*no count is ever synthesised[\s\S]*palette only through public exports/,
    check: () => {
      const layout = layoutCanvas({ experiment: TWO_BY_TWO, checkpoint: CHECKPOINT, width: 1000 })
      expect(layout.organisms, 'executed').toHaveLength(4)
      expect(new Set(layout.organisms.map((o) => o.id)), 'executed: keyed by the run handles').toEqual(new Set(['lane-a1', 'lane-a2', 'lane-b1', 'lane-b2']))
      expect(layout.root.at.x, 'executed: root at the axis position').toBe(markerX(CHECKPOINT, 1000))
      expect(read('packages/web/src/lab/canvas/organism.ts'), 'grep: the only scene import is the palette').toMatch(/from '\.\.\/\.\.\/scene\/palette\.js'/)
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
    says: /bounded at 5 s\*\*[\s\S]*FORK_EXEC_TIMEOUT_MS[\s\S]*still unowned/,
    check: () => {
      expect(server.fork(), 'grep').toContain('export const FORK_EXEC_TIMEOUT_MS = 5000')
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
    it(`claim "${id}" holds against the code`, () => {
      claim.check(textOf.get(id) ?? '')
    })
  }
})
