import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Exec, ExecOptions, ExecResult, RhizomorphEvent } from '@rhizomorph/core'
import { RD_HELD_BACK_REFUSAL, RD_MULTI_DIMENSION_REFUSAL, RD_WRONG_DIMENSION_REFUSAL } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sessionDirFor } from '../log/paths.js'
import { readSessionEvents } from '../log/session-log.js'
import {
  DEFAULT_AGENT_COMMAND,
  RD_NO_CLI_SENTENCE,
  rdAgentArgv,
  rdPrompt,
  readRdCorpus,
  recordRdOverride,
  runRdHand,
} from './rd.js'

/**
 * prd55 ruling 1–4, the server half. Hermetic under 4x concurrency: one
 * `mkdtemp` root per test, pid+uuid ids, and an injected `Exec` — nothing here
 * ever spawns the operator's real CLI, which is the point: a test suite that
 * spent money would be a test suite nobody runs.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(HERE, '__fixtures__')
// packages/server/src/lab -> repo root
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..')
const SERVER_SRC = path.join(REPO_ROOT, 'packages', 'server', 'src')

let root: string
let repoDir: string
let dataRoot: string

function uniqueId(label: string): string {
  return `${label}-${process.pid}-${randomUUID()}`
}

function fixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), 'utf8')
}

const OK: ExecResult = { stdout: '', stderr: '', code: 0, failed: false }
/** What `Exec` reports when the binary itself could not be run — the ONE shape that means "not on PATH". */
const NOT_ON_PATH: ExecResult = {
  stdout: '',
  stderr: '',
  code: null,
  failed: true,
  errorMessage: 'spawn claude ENOENT',
}

interface Call {
  command: string
  args: readonly string[]
  options: ExecOptions | undefined
}

/** An `Exec` that records every call and answers from `answer`, so a test can assert what was and was NOT spawned. */
function stubExec(answer: (call: Call) => ExecResult): { exec: Exec; calls: Call[] } {
  const calls: Call[] = []
  const exec: Exec = async (command, args, options) => {
    const call: Call = { command, args, options }
    calls.push(call)
    return answer(call)
  }
  return { exec, calls }
}

/** The envelope `claude -p --output-format json` prints, wrapped around one R&D result document. */
function agentAnswer(document: string, overrides: Record<string, unknown> = {}): ExecResult {
  return {
    ...OK,
    stdout: JSON.stringify({
      type: 'result',
      result: document,
      total_cost_usd: 0.0421,
      duration_ms: 8123,
      num_turns: 1,
      session_id: 'session-under-test',
      ...overrides,
    }),
  }
}

/** A hand that answers `--version` and then the one print-mode call, and nothing else. */
function handExec(document: string, options: { version?: string; gh?: ExecResult } = {}) {
  return stubExec((call) => {
    if (call.args[0] === '--version') return { ...OK, stdout: `${options.version ?? '2.1.266 (Claude Code)'}\n` }
    if (call.command === 'gh') return options.gh ?? { ...OK, stdout: '[]' }
    return agentAnswer(document)
  })
}

async function recordedEvents(): Promise<RhizomorphEvent[]> {
  const sessionDir = sessionDirFor(repoDir, dataRoot)
  const events: RhizomorphEvent[] = []
  let names: string[]
  try {
    names = readdirSync(sessionDir)
  } catch {
    return []
  }
  for (const name of names.sort()) {
    events.push(...(await readSessionEvents(path.join(sessionDir, name))))
  }
  return events
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'rhizomorph-rd-test-'))
  repoDir = path.join(root, 'repo')
  dataRoot = path.join(root, 'data')
  await mkdir(path.join(repoDir, 'docs', 'research'), { recursive: true })
  await mkdir(path.join(repoDir, 'docs', 'review'), { recursive: true })
  await writeFile(path.join(repoDir, 'docs', 'research', 'a-retro.md'), '# a retro\n\nthe gate was the slow step.\n')
  await writeFile(path.join(repoDir, 'docs', 'review', 'one.md'), '# a review\n\nthe gate was the slow step here too.\n')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

// --- ruling 1: the argv, and what it does and does not grant ---------------------

describe("the R&D hand's argv (prd55 ruling 1)", () => {
  it('grants no tools, asks for JSON, and puts the prompt after -- so a corpus can never be read as a flag', () => {
    expect(rdAgentArgv('opus', 'the corpus')).toEqual([
      '-p',
      '--output-format',
      'json',
      '--model',
      'opus',
      '--tools',
      '',
      '--strict-mcp-config',
      '--',
      'the corpus',
    ])
  })

  it('--max-turns rides only when the caller bounds the run', () => {
    expect(rdAgentArgv('opus', 'x')).not.toContain('--max-turns')
    const bounded = rdAgentArgv('opus', 'x', 3)
    expect(bounded[bounded.indexOf('--max-turns') + 1]).toBe('3')
  })

  it('a corpus whose first characters are a flag still arrives as the prompt — the -- separator is load-bearing', () => {
    // A `docs/review/*.md` beginning with `--help` is a document, not an
    // instruction to the command line. The separator is what makes that
    // structural rather than a matter of what the repo happens to contain.
    const argv = rdAgentArgv('opus', '--help please')
    expect(argv[argv.length - 1]).toBe('--help please')
    expect(argv.indexOf('--')).toBe(argv.length - 2)
  })

  it('the prompt carries the schema the answer is validated against, and the corpus items by id', async () => {
    const corpus = await readRdCorpus({ repoPath: repoDir, dataRoot, exec: stubExec(() => OK).exec })
    const prompt = rdPrompt(corpus)
    expect(prompt).toContain('docs/research/a-retro.md')
    expect(prompt).toContain('docs/review/one.md')
    expect(prompt).toContain('`heldBack` MUST equal `count < 2`')
    expect(prompt).toContain('EXACTLY ONE of the four dimensions')
  })
})

// --- ruling 1: no CLI is an answer, not a crash ------------------------------------

describe('no claude on this machine (prd55 ruling 1, ruling 9\'s first state)', () => {
  it('answers with the exact sentence, spawns nothing after the probe, and records nothing', async () => {
    const { exec, calls } = stubExec(() => NOT_ON_PATH)

    const result = await runRdHand({ lane: uniqueId('lane'), repoPath: repoDir, model: 'opus', exec, dataRoot })

    expect(result.available).toBe(false)
    expect(result.reason).toBe(RD_NO_CLI_SENTENCE)
    expect(result.reason).toBe("no claude on this machine's PATH — the R&D hand is your CLI, installed by you")
    // The probe, and NOTHING else: no corpus read through gh, no print-mode call.
    expect(calls).toHaveLength(1)
    expect(calls[0]?.args).toEqual(['--version'])
    expect(result.recordedTo).toBeNull()
    expect(await recordedEvents()).toEqual([])
  })

  it('resolves the binary under the name the operator declared, never a hard-coded one', async () => {
    const { exec, calls } = stubExec(() => NOT_ON_PATH)
    await runRdHand({
      lane: uniqueId('lane'),
      repoPath: repoDir,
      model: 'opus',
      agentCommand: 'my-own-claude',
      exec,
      dataRoot,
    })
    expect(calls[0]?.command).toBe('my-own-claude')
    expect(DEFAULT_AGENT_COMMAND).toBe('claude')
  })

  it('a binary that runs and fails is a different fact — installed-and-broken is not missing', async () => {
    const { exec } = stubExec(() => ({ stdout: '', stderr: 'permission denied', code: 126, failed: true }))
    await expect(
      runRdHand({ lane: uniqueId('lane'), repoPath: repoDir, model: 'opus', exec, dataRoot }),
    ).rejects.toThrow(/broken install, not a missing one/)
  })
})

// --- ruling 2: the corpus is local first ------------------------------------------

describe('the corpus (prd55 ruling 2)', () => {
  it('reads the repo\'s own retros and reviews, and digests exactly what it read', async () => {
    const { exec } = stubExec(() => OK)
    const first = await readRdCorpus({ repoPath: repoDir, dataRoot, exec })

    expect(first.choice).toBe('local')
    expect(first.items.map((item) => item.id)).toEqual(['docs/research/a-retro.md', 'docs/review/one.md'])
    expect(first.items.map((item) => item.source)).toEqual(['retro', 'review'])

    // Two reads of an unchanged corpus are provably the same read…
    const second = await readRdCorpus({ repoPath: repoDir, dataRoot, exec })
    expect(second.digest).toBe(first.digest)

    // …and a changed one is provably a different read.
    await writeFile(path.join(repoDir, 'docs', 'review', 'one.md'), '# a review\n\nsomething else entirely.\n')
    const third = await readRdCorpus({ repoPath: repoDir, dataRoot, exec })
    expect(third.digest).not.toBe(first.digest)
  })

  it('a repo with no retros and no reviews is an empty corpus, not an error (ruling 9\'s "no corpus" state)', async () => {
    await rm(path.join(repoDir, 'docs'), { recursive: true, force: true })
    const { exec } = stubExec(() => OK)
    const corpus = await readRdCorpus({ repoPath: repoDir, dataRoot, exec })
    expect(corpus.items).toEqual([])
    expect(rdPrompt(corpus)).toContain('the corpus is empty')
  })

  it('never runs gh for a local corpus — the tracker is a second declared act', async () => {
    const { exec, calls } = stubExec(() => OK)
    await readRdCorpus({ repoPath: repoDir, dataRoot, exec })
    expect(calls.filter((call) => call.command === 'gh')).toEqual([])
  })

  it('runs the operator\'s own gh, repo-scoped, only when local+tracker is declared', async () => {
    const { exec, calls } = stubExec((call) =>
      call.command === 'gh'
        ? { ...OK, stdout: JSON.stringify([{ number: 7, title: 'the gate was slow', closedAt: '2026-09-01T00:00:00Z' }]) }
        : OK,
    )
    const corpus = await readRdCorpus({ repoPath: repoDir, dataRoot, corpus: 'local+tracker', exec })

    const gh = calls.filter((call) => call.command === 'gh')
    expect(gh).toHaveLength(1)
    expect(gh[0]?.args.slice(0, 4)).toEqual(['issue', 'list', '--state', 'closed'])
    // Repo-scoped by where it runs, not by a flag this module has to get right.
    expect(gh[0]?.options?.cwd).toBe(path.resolve(repoDir))
    expect(corpus.items.some((item) => item.id === 'tracker#7')).toBe(true)
    expect(corpus.trackerRefusal).toBeNull()
  })

  it('a tracker corpus gh cannot answer degrades loudly — it says so rather than quietly reading local', async () => {
    const { exec } = stubExec((call) =>
      call.command === 'gh' ? { stdout: '', stderr: '', code: null, failed: true, errorMessage: 'spawn gh ENOENT' } : OK,
    )
    const corpus = await readRdCorpus({ repoPath: repoDir, dataRoot, corpus: 'local+tracker', exec })
    expect(corpus.trackerRefusal).toContain('gh could not answer')
    expect(corpus.items.some((item) => item.source === 'tracker')).toBe(false)
  })

  it('records which corpus produced the run, on every event (ruling 2)', async () => {
    const { exec } = handExec(fixture('rd-result-clean.json'), {
      gh: { ...OK, stdout: JSON.stringify([{ number: 7, title: 'the gate was slow' }]) },
    })
    await runRdHand({ lane: uniqueId('lane'), repoPath: repoDir, model: 'opus', corpus: 'local+tracker', exec, dataRoot })

    const events = await recordedEvents()
    expect(events.length).toBeGreaterThan(0)
    for (const event of events) {
      expect((event.payload as { provenance: { corpus: string } }).provenance.corpus).toBe('local+tracker')
    }
  })
})

// --- ruling 3: validation, and a refusal that is never a patched proposal ------------

describe('the schema decides what is recorded (prd55 ruling 3)', () => {
  it('a clean result records the patterns and the proposal, and refuses nothing', async () => {
    const lane = uniqueId('lane')
    const { exec, calls } = handExec(fixture('rd-result-clean.json'))

    const result = await runRdHand({ lane, repoPath: repoDir, model: 'opus', exec, dataRoot })

    expect(result.available).toBe(true)
    expect(result.patterns.map((pattern) => pattern.patternId)).toEqual(['pattern-slow-gate'])
    expect(result.proposals.map((proposal) => proposal.proposalId)).toEqual(['proposal-slow-gate-1'])
    expect(result.refusals).toEqual([])

    const events = await recordedEvents()
    expect(events.map((event) => event.type)).toEqual(['rd.patterns', 'rd.proposal'])
    expect(events.every((event) => (event.payload as { lane: string }).lane === lane)).toBe(true)

    // The hand really was spawned with no tools — read off the recorded argv,
    // not off the argv builder a second time.
    const spawn = calls.find((call) => call.args.includes('--output-format'))
    expect(spawn?.args).toContain('--tools')
    expect(spawn?.args[spawn.args.indexOf('--tools') + 1]).toBe('')
  })

  /**
   * TWO INDEPENDENT GATES, measured rather than assumed. A two-dimension
   * proposal is stopped twice on the way through `runRdHand`: by
   * `rdProposalContentSchema`'s own `.refine` (whose message IS
   * `RD_MULTI_DIMENSION_REFUSAL`), and again by `rdRefusalReason`'s dimension
   * count. EXECUTED: removing either one alone leaves this test GREEN, because
   * the other catches it and says the identical sentence; removing BOTH turns
   * it red. That is defence in depth working as core's own doc comment says it
   * should — and it is written down here because a reader mutating one gate and
   * seeing green would otherwise conclude this law was vacuous.
   */
  it('a proposal whose arms differ in two dimensions is refused in core\'s own words, and never recorded as a proposal', async () => {
    const document = fixture('rd-result-two-dimensions.json')
    const { exec } = handExec(document)

    const result = await runRdHand({ lane: uniqueId('lane'), repoPath: repoDir, model: 'opus', exec, dataRoot })

    expect(result.proposals).toEqual([])
    // prd-55 ruling 9 (wave 6 widening): the refusal also carries the hand's
    // own raw result text — bounded, but this fixture is well under the bound,
    // so it is exactly the document the hand answered with.
    expect(result.refusals).toEqual([{ patternId: 'pattern-slow-gate', reason: RD_MULTI_DIMENSION_REFUSAL, rawResult: document }])

    const events = await recordedEvents()
    expect(events.map((event) => event.type)).toEqual(['rd.patterns', 'rd.refused'])
    const refused = events[1]?.payload as { reason: string; rawResultDigest: string }
    expect(refused.reason).toBe(RD_MULTI_DIMENSION_REFUSAL)
    expect(refused.rawResultDigest).toMatch(/^[0-9a-f]{64}$/)
    // Nothing was patched into legality on the way through.
    expect(events.some((event) => event.type === 'rd.proposal')).toBe(false)
  })

  /**
   * THE SIBLING OF THE TWO-DIMENSION CASE, and the one a count cannot reach.
   * `rd-result-wrong-dimension.json` declares `varies: "model"` while its two
   * arms hold the SAME model and differ in `gateCommand` — exactly one
   * dimension varies, so every count-based gate passes it and the run would
   * record a clean `rd.proposal` whose gate difference is booked against the
   * model. Refused now by `variesOnlyTheDeclaredDimension` in the schema and
   * by `rdRefusalReason`'s declared-dimension arm, in core's own sentence.
   *
   * TWO INDEPENDENT GATES, EXECUTED — the same shape the two-dimension test
   * above records, and written down for the same reason. Removing the schema
   * refine alone left this test GREEN (33/33); removing `rdRefusalReason`'s
   * declared-dimension arm alone also left it GREEN (33/33); removing BOTH
   * turned exactly this test red. So a reader who mutates one gate and sees
   * green has not shown this law is vacuous — they have shown the other gate
   * held.
   */
  it('a proposal that varies one dimension but declares another is refused, and never recorded as a proposal', async () => {
    const document = fixture('rd-result-wrong-dimension.json')
    const { exec } = handExec(document)

    const result = await runRdHand({ lane: uniqueId('lane'), repoPath: repoDir, model: 'opus', exec, dataRoot })

    expect(result.proposals).toEqual([])
    expect(result.refusals).toEqual([{ patternId: 'pattern-slow-gate', reason: RD_WRONG_DIMENSION_REFUSAL, rawResult: document }])

    const events = await recordedEvents()
    expect(events.map((event) => event.type)).toEqual(['rd.patterns', 'rd.refused'])
    const refused = events[1]?.payload as { reason: string; rawResultDigest: string }
    expect(refused.reason).toBe(RD_WRONG_DIMENSION_REFUSAL)
    expect(refused.rawResultDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(events.some((event) => event.type === 'rd.proposal')).toBe(false)
  })

  it('a proposal against a held-back pattern is refused for THAT reason — a single occurrence is not yet a pattern', async () => {
    const document = fixture('rd-result-held-back.json')
    const { exec } = handExec(document)

    const result = await runRdHand({ lane: uniqueId('lane'), repoPath: repoDir, model: 'opus', exec, dataRoot })

    expect(result.patterns[0]?.heldBack).toBe(true)
    expect(result.proposals).toEqual([])
    expect(result.refusals).toEqual([{ patternId: 'pattern-one-off', reason: RD_HELD_BACK_REFUSAL, rawResult: document }])
    expect((await recordedEvents()).map((event) => event.type)).toEqual(['rd.patterns', 'rd.refused'])
  })

  it('a pattern whose heldBack disagrees with its own count stops the run — there is no patternId to file a refusal against', async () => {
    const lying = JSON.stringify({
      patterns: [{ patternId: 'p', shape: 's', sourceItems: ['one'], count: 1, heldBack: false }],
      proposals: [],
    })
    const { exec } = handExec(lying)

    await expect(runRdHand({ lane: uniqueId('lane'), repoPath: repoDir, model: 'opus', exec, dataRoot })).rejects.toThrow(
      /heldBack must equal count < 2/,
    )
    expect(await recordedEvents()).toEqual([])
  })

  it('a result that is not the fixed document records nothing and patches nothing', async () => {
    const { exec } = handExec('I had a think about it and here are my ideas.')
    await expect(runRdHand({ lane: uniqueId('lane'), repoPath: repoDir, model: 'opus', exec, dataRoot })).rejects.toThrow(
      /not the fixed JSON document/,
    )
    expect(await recordedEvents()).toEqual([])
  })

  it('a hand that answers with no cost figure is refused — a spend with no figure is not a spend this instrument records', async () => {
    const { exec } = stubExec((call) => {
      if (call.args[0] === '--version') return { ...OK, stdout: '2.1.266\n' }
      return agentAnswer(fixture('rd-result-clean.json'), { total_cost_usd: undefined })
    })
    await expect(runRdHand({ lane: uniqueId('lane'), repoPath: repoDir, model: 'opus', exec, dataRoot })).rejects.toThrow(
      /total_cost_usd/,
    )
  })
})

// --- ruling 1: provenance, copied from the CLI's own result and never re-derived -------

describe('provenance (prd55 ruling 1)', () => {
  it('carries the CLI\'s own cost and duration, the two digests, and the version that produced them', async () => {
    const { exec } = handExec(fixture('rd-result-clean.json'), { version: '9.9.9 (Claude Code)' })

    const result = await runRdHand({ lane: uniqueId('lane'), repoPath: repoDir, model: 'opus', exec, dataRoot })

    expect(result.provenance).toEqual({
      model: 'opus',
      total_cost_usd: 0.0421,
      duration_ms: 8123,
      promptDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      corpusDigest: result.corpus.digest,
      claudeVersion: '9.9.9 (Claude Code)',
      corpus: 'local',
    })
    expect(result.turns).toBe(1)

    // …and the recorded event says the same thing, so the surface's provenance
    // line and the record cannot disagree.
    const events = await recordedEvents()
    expect((events[0]?.payload as { provenance: unknown }).provenance).toEqual(result.provenance)
  })

  it('appends through the recorder to the lane\'s own live session file', async () => {
    const { exec } = handExec(fixture('rd-result-clean.json'))
    const result = await runRdHand({ lane: uniqueId('lane'), repoPath: repoDir, model: 'opus', exec, dataRoot })

    expect(result.recordedTo).not.toBeNull()
    expect(statSync(result.recordedTo as string).size).toBeGreaterThan(0)
    expect((await readSessionEvents(result.recordedTo as string)).map((event) => event.type)).toEqual([
      'rd.patterns',
      'rd.proposal',
    ])
  })
})

// --- ruling 4: the override is never re-attributed --------------------------------

describe('the override (prd55 ruling 4)', () => {
  const provenance = {
    model: 'opus',
    total_cost_usd: 0.01,
    duration_ms: 100,
    promptDigest: 'a'.repeat(64),
    corpusDigest: 'b'.repeat(64),
    claudeVersion: '2.1.266',
    corpus: 'local' as const,
  }

  it('names both checkpoints, so the operator\'s choice can never be read as the agent\'s', async () => {
    const lane = uniqueId('lane')
    const { event } = await recordRdOverride({
      lane,
      repoPath: repoDir,
      proposalId: 'proposal-slow-gate-1',
      agentCheckpointId: 'ckpt-agent',
      operatorCheckpointId: 'ckpt-operator',
      provenance,
      dataRoot,
    })

    expect(event.type).toBe('rd.override')
    expect(event.payload.agentCheckpointId).toBe('ckpt-agent')
    expect(event.payload.operatorCheckpointId).toBe('ckpt-operator')
    expect((await recordedEvents()).map((e) => e.type)).toEqual(['rd.override'])
  })

  it('refuses an override that changed nothing — a record of a decision nobody made is worse than none', async () => {
    await expect(
      recordRdOverride({
        lane: uniqueId('lane'),
        repoPath: repoDir,
        proposalId: 'p',
        agentCheckpointId: 'ckpt-1',
        operatorCheckpointId: 'ckpt-1',
        provenance,
        dataRoot,
      }),
    ).rejects.toThrow(/changed nothing/)
  })
})

// --- this wave's greps over packages/server/src ------------------------------------

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx'])

/**
 * Both laws below sweep what SHIPS — every `.ts`/`.tsx` under
 * `packages/server/src` that is not a test file — and that boundary is the
 * claim, not a convenience.
 *
 * A test legitimately does both of the things production may not. EXECUTED,
 * which is why this is written down rather than assumed: swept whole, the env
 * law returns twenty-two names instead of two (`log/paths.test.ts` and
 * `cli/telemetry-env.test.ts` set and restore the two real overrides;
 * `api/lab-ceiling-law.test.ts` carries `RHIZOMORPH_LAB_LOCK_MS` and
 * `RHIZOMORPH_LAB_LOCK_SCALE` inside the mutation fixtures that prove IT
 * bites) and the credential law returns one offender —
 * `shipper/hand-law.test.ts`'s inline GitHub-shaped key, a fixture proving
 * ADR-0034's own key law recognises one. Every one of those is a test doing
 * its job. What prd55 ruling 1 says about the instrument is a claim about the
 * instrument, and the two bite tests further down point each detector at those
 * very files, so the exclusion is doing work rather than hiding a real hit.
 */
function isProductionSource(file: string): boolean {
  return !/\.test\.tsx?$/.test(file)
}

function walkSourceFiles(dir: string): string[] {
  const out: string[] = []
  const visit = (current: string) => {
    for (const entry of readdirSync(current)) {
      if (entry === 'node_modules' || entry === 'dist') continue
      const full = path.join(current, entry)
      if (statSync(full).isDirectory()) visit(full)
      else if (SOURCE_EXTENSIONS.has(path.extname(full))) out.push(full)
    }
  }
  visit(dir)
  return out
}

/**
 * Every environment variable `packages/server/src` reads BY NAME, resolved
 * through the constant that names it. Deliberately not "every `process.env`
 * mention": the whole object is legitimately passed on in four places (the two
 * doctors' telemetry check, the harness detector's default, and `exec.ts`
 * merging a caller's overrides onto it), and none of those is a name this
 * instrument reads for itself. What prd55's acceptance line counts is the
 * second kind, and it is two.
 */
function environmentNamesRead(files: readonly string[]): string[] {
  const names = new Set<string>()
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
      names.add(match[1] as string)
    }
    for (const match of source.matchAll(/process\.env\[\s*([A-Za-z_][A-Za-z0-9_]*)\s*\]/g)) {
      const identifier = match[1] as string
      // The bracket form names a CONSTANT; the constant names the variable.
      // Resolved rather than reported as the identifier, so the law states the
      // env vars this package reads and not the local spellings of them.
      const declaration = new RegExp(`\\b${identifier}\\s*=\\s*'([^']+)'`).exec(source)
      names.add(declaration?.[1] ?? identifier)
    }
  }
  return [...names].sort()
}

/**
 * Credential SHAPES, never credential WORDS. A ban on the word "token" would
 * redden on `requireCapabilityToken` — this instrument's own, deliberately
 * in-band capability token (ADR-0012) — on the day it landed, which is how a
 * law like this gets weakened until it means nothing. Each pattern below is a
 * published, unmistakable secret format, and each is proven to fire.
 */
const CREDENTIAL_SHAPES: ReadonlyArray<{ name: string; pattern: RegExp; fires: string }> = [
  { name: 'an Anthropic API key', pattern: /sk-ant-[A-Za-z0-9_-]{16,}/, fires: `sk-ant-${'A'.repeat(20)}` },
  { name: 'an OpenAI-style secret key', pattern: /\bsk-[A-Za-z0-9]{24,}\b/, fires: `sk-${'B'.repeat(30)}` },
  { name: 'a GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, fires: `ghp_${'C'.repeat(36)}` },
  { name: 'a GitHub fine-grained token', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/, fires: `github_pat_${'D'.repeat(22)}` },
  { name: 'an AWS access key id', pattern: /\bAKIA[0-9A-Z]{16}\b/, fires: `AKIA${'E'.repeat(16)}` },
  { name: 'a PEM private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, fires: '-----BEGIN RSA PRIVATE KEY-----' },
]

describe("the instrument holds no credential, and reads two environment names (prd55 ruling 1's acceptance lines)", () => {
  const files = walkSourceFiles(SERVER_SRC).filter(isProductionSource)

  it('has a package to sweep — an empty file list would pass both laws vacuously', () => {
    expect(files.length).toBeGreaterThan(50)
  })

  it('reads exactly two environment names, and they are the two the instrument declares', () => {
    expect(environmentNamesRead(files)).toEqual(['RHIZOMORPH_DATA_DIR', 'RHIZOMORPH_JUDGE_CADENCE_MS'])
  })

  it('bites: a third env read anywhere in the package would be caught, in either spelling', () => {
    // Runs the REAL extractor the sweep above uses, over synthetic sources
    // written into this test's own mkdtemp root — never a re-implementation of
    // it, so what is proven able to fail is the mechanism that guards the tree.
    expect(environmentNamesRead([])).toEqual([])
    const probe = (source: string): string[] => {
      const file = path.join(root, `${uniqueId('probe')}.ts`)
      writeFileSync(file, source, 'utf8')
      return environmentNamesRead([file])
    }
    expect(probe('const x = process.env.RHIZOMORPH_SOMETHING_NEW\n')).toEqual(['RHIZOMORPH_SOMETHING_NEW'])
    expect(probe("const KEY = 'RHIZOMORPH_ANOTHER'\nconst x = process.env[KEY]\n")).toEqual(['RHIZOMORPH_ANOTHER'])
    // …and the four legitimate whole-env hand-ons stay invisible to it.
    expect(probe('checkTelemetryEnv(options.env ?? process.env, platform)\n')).toEqual([])
  })

  it('bites: the extractor really does see the env names the excluded tests set, when pointed at them', () => {
    // The other half of the ships-only scope, proven against a real file rather
    // than a fixture — the same way the credential exclusion is.
    expect(environmentNamesRead([path.join(SERVER_SRC, 'api', 'lab-ceiling-law.test.ts')])).toContain(
      'RHIZOMORPH_LAB_LOCK_SCALE',
    )
  })

  function credentialOffenders(candidates: readonly string[]): string[] {
    const offenders: string[] = []
    for (const file of candidates) {
      const source = readFileSync(file, 'utf8')
      for (const shape of CREDENTIAL_SHAPES) {
        if (shape.pattern.test(source)) offenders.push(`${path.relative(REPO_ROOT, file)}: ${shape.name}`)
      }
    }
    return offenders
  }

  it('carries no credential-shaped string in anything packages/server/src ships', () => {
    expect(credentialOffenders(files)).toEqual([])
  })

  it('bites: the sweep really does see a credential-shaped literal in a file it is pointed at', () => {
    // Not a synthetic fixture. `shipper/hand-law.test.ts` genuinely carries an
    // inline GitHub-shaped key, deliberately, to prove ADR-0034's own key law
    // recognises one. Pointing this law's detector at that real file is what
    // makes the ships-only scope an exclusion rather than a blind spot — the
    // mechanism is shown finding the very thing it excludes.
    const handLaw = path.join(SERVER_SRC, 'shipper', 'hand-law.test.ts')
    expect(credentialOffenders([handLaw])).toEqual([`${path.relative(REPO_ROOT, handLaw)}: a GitHub token`])
  })

  it('bites: every shape this law recognises really does fire on its own example', () => {
    for (const shape of CREDENTIAL_SHAPES) {
      expect(shape.pattern.test(shape.fires), shape.name).toBe(true)
    }
    // …and none of them fires on the instrument's own, deliberately in-band
    // capability token, which is the false positive a word-ban would have.
    for (const shape of CREDENTIAL_SHAPES) {
      expect(shape.pattern.test('requireCapabilityToken(ctx.capabilityToken ?? \'\')'), shape.name).toBe(false)
    }
  })
})

/**
 * The R&D engine is reachable from the laboratory's own CLI wiring point and
 * nowhere else — prd12 ruling 1's "never runs without a human's explicit
 * command", stated for this hand specifically. `lab/namespace-law.test.ts`
 * proves no observer module imports anything under `lab/`; this proves the
 * narrower thing about the one function that spends money.
 */
describe('the hand never runs without being invoked (prd12 ruling 1, prd55 ruling 1)', () => {
  const ALLOWED = new Set(
    [
      path.join(SERVER_SRC, 'lab', 'rd.ts'),
      path.join(SERVER_SRC, 'lab', 'rd.test.ts'),
      // The one wiring point the namespace law admits — `rhizomorph lab rd`.
      path.join(SERVER_SRC, 'cli', 'index.ts'),
    ].map((file) => path.resolve(file)),
  )

  it('is named by the engine, its test, and the CLI wiring point — by nothing else', () => {
    const namers = walkSourceFiles(SERVER_SRC).filter((file) => readFileSync(file, 'utf8').includes('runRdHand'))
    expect(namers.length).toBeGreaterThan(0)
    expect(namers.filter((file) => !ALLOWED.has(path.resolve(file))).map((file) => path.relative(REPO_ROOT, file))).toEqual([])
  })

  it('the engine schedules nothing — no clock of its own, so it cannot run itself', () => {
    const source = readFileSync(path.join(SERVER_SRC, 'lab', 'rd.ts'), 'utf8')
    expect(/\b(setInterval|setTimeout|setImmediate)\s*\(/.test(source)).toBe(false)
  })
})
