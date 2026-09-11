import { createHash, randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { EventOf, Exec, RhizomorphEvent } from '@rhizomorph/core'
import {
  createEvent,
  createIdFactory,
  type RdPattern,
  type RdProposalContent,
  type RdProvenance,
  rdPatternSchema,
  rdProposalContentSchema,
  rdRefusalReason,
  reduceAll,
} from '@rhizomorph/core'
import { defaultDataRoot, sessionDirFor, sessionFileName } from '../log/paths.js'
import { findResumableSession, listSessions, RESUME_WINDOW_MS, readSessionEvents } from '../log/session-log.js'
import { describeExecFailure, exec as realExec, withTimeout } from '../server/exec.js'
import { SessionRecorder } from '../server/recorder.js'

/**
 * prd55 ruling 1's R&D hand: **the operator's own `claude`, spawned as an
 * explicit act.** This module reads the corpus the record already holds, hands
 * it to that CLI in print mode, validates what comes back against core's fixed
 * schema, and records `rd.patterns` / `rd.proposal` / `rd.refused` through the
 * recorder with provenance — and then books what the run cost as one
 * `llm.cost` event sourced to the lab ({@link bookHandCost}), which is ruling
 * 1's "booked as spend with its basis, like a fork's". It is a sibling of
 * `fork.ts` (dispatch) and `compare.ts` (measure) and follows their shape
 * exactly: a bounded `Exec`, a
 * `SessionRecorder` constructed on the live session, and events created with
 * `createEvent` under a `createIdFactory('lab', 0, 'rd')` — the writer tag
 * #429 added, so this hand's ids never collide with the other three that write
 * into the same session file.
 *
 * ## The instrument holds no credential (ruling 1, ADR-0048)
 *
 * Nothing here reads, writes, forwards or logs a secret. The hand is a
 * subprocess the operator already installed and already authenticated; whatever
 * it spends is spent under the operator's own login, through the operator's own
 * binary, and the egress is theirs. This module passes NO environment of its
 * own (`Exec`'s `env` option is never set here, so the child inherits the
 * server's environment unchanged and this file adds nothing to it), and the
 * only thing it ever puts on the child's command line is the corpus prompt and
 * the flags below.
 *
 * ## The exact argv (verified against `claude --version` 2.1.266, 2026-09-10)
 *
 * ```
 * <agentCommand> -p --output-format json --model <m> --tools "" --strict-mcp-config [--max-turns <n>] -- <prompt>
 * ```
 *
 * - `-p` is print mode; the prompt is the command's one positional, put after
 *   `--` so a corpus that begins with a dash can never be read as a flag (the
 *   same argument-injection discipline `api/lab.ts`'s launch argv documents —
 *   the corpus is FILE TEXT the operator's repo happens to hold, not a value
 *   this module authored).
 * - `--tools ""` is the flag that grants **no tools at all**, read off
 *   `claude --help` on the build box: *"Use \"\" to disable all tools"*.
 *   `--strict-mcp-config` rides with it so no configured MCP server can hand
 *   the hand a tool back through the side door.
 * - `--max-turns <n>` is passed only when the caller asks. **Recorded honestly:
 *   `claude --help` on 2.1.266 does not advertise `--max-turns`, and
 *   `claude --max-turns 1 --version` exits 0 rather than refusing it** — so on
 *   that version the bound cannot be verified from outside the process. The
 *   flag is passed as prd55 ruling 1 spells it; a version that does not know it
 *   is a version whose turn bound is not proven, which this comment says rather
 *   than the code pretending otherwise.
 *
 * ## No CLI is an answer, not a crash
 *
 * The binary is resolved on the SERVER's PATH under the name the operator
 * declares in settings (`lab.agentCommand`, default {@link DEFAULT_AGENT_COMMAND})
 * — never from an environment variable, which is why `process.env` appears
 * nowhere in this file. Resolution is `<agentCommand> --version`: a spawn error
 * (ENOENT and friends, which is what `ExecResult.errorMessage` means and only
 * means) is the absent case, answered with {@link RD_NO_CLI_SENTENCE} verbatim
 * and **nothing spawned after it**. A binary that runs and fails is a different
 * fact and throws with what it said, because "not installed" and "installed and
 * broken" are two different things to tell an operator.
 */

/** The operator's own agent CLI, by its default name — overridden by `lab.agentCommand` in settings. */
export const DEFAULT_AGENT_COMMAND = 'claude'

/**
 * The one sentence a surface prints when the operator's CLI is not on the
 * server's PATH (prd55 ruling 1, verbatim). Fixed, never templated per call, so
 * every surface says the identical thing — the discipline core's
 * `RD_HELD_BACK_REFUSAL` keeps for its own sentence.
 */
export const RD_NO_CLI_SENTENCE = "no claude on this machine's PATH — the R&D hand is your CLI, installed by you"

/**
 * Per-exec ceiling for the hand itself. Sibling of `compare.ts`'s
 * `COMPARE_VERIFY_TIMEOUT_MS`, not of the 5s git-plumbing ceilings: this waits
 * on a model, which is a wider thing to wait on than a `git rev-list`. Ten
 * minutes is a ceiling on operator patience — past it the call is wedged, not
 * slow.
 */
export const RD_HAND_TIMEOUT_MS = 600_000

/** Per-exec ceiling for the PATH probe (`<agentCommand> --version`) — plumbing, so the plumbing number. */
export const RD_PROBE_TIMEOUT_MS = 5000

/**
 * How many items of any one corpus source reach the prompt. A bound on the
 * PROMPT, which is money: every item is tokens the operator pays for, and an
 * unbounded corpus makes the cost of one `lab rd` a function of how long the
 * repo has existed. Items are taken newest-first, so the bound drops the
 * oldest evidence rather than a random slice of it.
 */
export const RD_CORPUS_ITEM_CEILING = 40

/** Which corpus a run read (prd55 ruling 2) — `local` is the default and the tracker is a second declared act. */
export type RdCorpusChoice = 'local' | 'local+tracker'

/** Where one corpus item came from — the fact ruling 2 requires beside every pattern. */
export type RdCorpusSource = 'measurement' | 'experiment' | 'retro' | 'review' | 'tracker'

/** One thing the hand was given to read. `id` is what a pattern's `sourceItems` names back. */
export interface RdCorpusItem {
  id: string
  source: RdCorpusSource
  /** The text handed to the hand — never a path outside the watched repo, never a credential. */
  text: string
}

export interface RdCorpus {
  choice: RdCorpusChoice
  items: RdCorpusItem[]
  /** sha256 over the items' canonical form — two calls over an unchanged corpus are provably the same read. */
  digest: string
  /** Set when `local+tracker` was asked for and `gh` could not answer — the tracker half degrades loudly, never silently. */
  trackerRefusal: string | null
}

export interface ReadRdCorpusOptions {
  /** The watched repo — where `docs/research/*-retro.md` and `docs/review/*.md` are read from, and where `gh` runs. */
  repoPath: string
  corpus?: RdCorpusChoice
  exec?: Exec
  dataRoot?: string
}

// --- the corpus (ruling 2: local first, the tracker a second declared act) ---

/** `docs/research/*-retro.md` — a retro is a written observation, which is the shape a pattern is grouped from. */
const RETRO_DIR = ['docs', 'research'] as const
const RETRO_SUFFIX = '-retro.md'
/** `docs/review/*.md` — every review in the watched repo, whatever it is named. */
const REVIEW_DIR = ['docs', 'review'] as const

/** How much of one document reaches the prompt. A retro is long; a pattern is grouped from its opening claim, not from its appendices. */
const RD_DOCUMENT_HEAD_CHARS = 4000

async function readMarkdownItems(
  repoPath: string,
  dir: readonly string[],
  source: RdCorpusSource,
  keep: (name: string) => boolean,
): Promise<RdCorpusItem[]> {
  const full = path.join(repoPath, ...dir)
  let names: string[]
  try {
    names = await readdir(full)
  } catch {
    // A repo with no `docs/review/` has no reviews. That is a corpus fact
    // ("nothing to read yet"), not an error, and ruling 9 draws it as a state.
    return []
  }
  const items: RdCorpusItem[] = []
  for (const name of names.filter(keep).sort()) {
    let text: string
    try {
      text = await readFile(path.join(full, name), 'utf8')
    } catch {
      continue
    }
    items.push({ id: `${dir.join('/')}/${name}`, source, text: text.slice(0, RD_DOCUMENT_HEAD_CHARS) })
  }
  return items.slice(-RD_CORPUS_ITEM_CEILING)
}

async function readAllEvents(sessionDir: string): Promise<RhizomorphEvent[]> {
  const sessions = await listSessions(sessionDir)
  const events: RhizomorphEvent[] = []
  for (const session of sessions) {
    events.push(...(await readSessionEvents(path.join(sessionDir, session.fileName))))
  }
  return events
}

/**
 * The tracker half (ruling 2): the operator's OWN `gh`, run in the watched
 * repo so it is repo-scoped by construction rather than by a flag this module
 * would have to get right. Never authenticated by this instrument — `gh` uses
 * whatever login the operator already has, and nothing about that login is
 * read, copied or recorded here.
 */
async function readTrackerItems(exec: Exec, repoPath: string): Promise<{ items: RdCorpusItem[]; refusal: string | null }> {
  const result = await exec(
    'gh',
    ['issue', 'list', '--state', 'closed', '--limit', String(RD_CORPUS_ITEM_CEILING), '--json', 'number,title,closedAt'],
    { cwd: repoPath },
  )
  if (result.failed) {
    return { items: [], refusal: `the tracker corpus was asked for and gh could not answer: ${describeExecFailure(result)}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    return { items: [], refusal: 'the tracker corpus was asked for and gh did not answer with JSON' }
  }
  if (!Array.isArray(parsed)) {
    return { items: [], refusal: 'the tracker corpus was asked for and gh answered with something that is not a list of issues' }
  }
  const items: RdCorpusItem[] = []
  for (const row of parsed) {
    if (typeof row !== 'object' || row === null) continue
    const { number, title, closedAt } = row as Record<string, unknown>
    if (typeof number !== 'number' || typeof title !== 'string') continue
    items.push({
      id: `tracker#${number}`,
      source: 'tracker',
      text: `closed issue #${number}: ${title}${typeof closedAt === 'string' ? ` (closed ${closedAt})` : ''}`,
    })
  }
  return { items, refusal: null }
}

/**
 * sha256 over the items' ids, sources and text — the whole read, in order,
 * and nothing about the machine that made it. Canonicalised through
 * `JSON.stringify` rather than by joining on a separator: a separator has to
 * be a character no corpus item can contain, and every such character is a
 * control byte that would then live in this file's own source. JSON's quoting
 * is unambiguous without one.
 */
function digestCorpus(items: readonly RdCorpusItem[]): string {
  const canonical = JSON.stringify(items.map((item) => [item.source, item.id, item.text]))
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

/**
 * The corpus, local first (ruling 2). Local is four things the record already
 * holds — the measured verdicts and their details, the lab's own experiments,
 * the repo's retros and its reviews — and the tracker is a fifth that only ever
 * appears when the caller declares it.
 */
export async function readRdCorpus(options: ReadRdCorpusOptions): Promise<RdCorpus> {
  const choice: RdCorpusChoice = options.corpus ?? 'local'
  const repoPath = path.resolve(options.repoPath)
  const dataRoot = options.dataRoot ?? defaultDataRoot()

  const events = await readAllEvents(sessionDirFor(repoPath, dataRoot))
  const state = reduceAll(events)

  const measurements: RdCorpusItem[] = state.forks.measurements.slice(-RD_CORPUS_ITEM_CEILING).map((measured) => ({
    id: `fork.measured/${measured.laneHandle}@${measured.ts}`,
    source: 'measurement',
    text:
      `arm ${measured.arm} run ${measured.run} of fork ${measured.forkId} (${measured.laneHandle}) — ` +
      `${measured.verified} under "${measured.verifyCommand}"` +
      (measured.verifiedDetail === null ? '' : `: ${measured.verifiedDetail}`),
  }))

  const experiments: RdCorpusItem[] = state.forks.dispatches.slice(-RD_CORPUS_ITEM_CEILING).map((dispatch) => ({
    id: `fork.dispatched/${dispatch.laneHandle}`,
    source: 'experiment',
    text:
      `fork ${dispatch.forkId} arm ${dispatch.arm} run ${dispatch.run} of lane "${dispatch.parentLane}" ` +
      `at checkpoint ${dispatch.checkpointId} — model ${dispatch.model ?? 'default'}, ` +
      `brief ${dispatch.promptDigest === null ? 'none' : dispatch.promptDigest.slice(0, 12)}`,
  }))

  const retros = await readMarkdownItems(repoPath, RETRO_DIR, 'retro', (name) => name.endsWith(RETRO_SUFFIX))
  const reviews = await readMarkdownItems(repoPath, REVIEW_DIR, 'review', (name) => name.endsWith('.md'))

  let tracker: RdCorpusItem[] = []
  let trackerRefusal: string | null = null
  if (choice === 'local+tracker') {
    const read = await readTrackerItems(withTimeout(options.exec ?? realExec, RD_PROBE_TIMEOUT_MS), repoPath)
    tracker = read.items
    trackerRefusal = read.refusal
  }

  const items = [...measurements, ...experiments, ...retros, ...reviews, ...tracker]
  return { choice, items, digest: digestCorpus(items), trackerRefusal }
}

// --- the prompt ------------------------------------------------------------------

/**
 * The instruction handed to the hand, with the corpus in it. Pure, so a test —
 * and a reader — can see exactly what is spent on without a process being
 * spawned. It states the schema in words because the schema is what the answer
 * is validated against: a hand told the shape produces refusals about
 * CONTENT (a held-back pattern, a two-dimension proposal), which is what ruling
 * 3 wants recorded, rather than refusals about punctuation.
 */
export function rdPrompt(corpus: RdCorpus): string {
  const items =
    corpus.items.length === 0
      ? '(the corpus is empty — a repo with no retros, no reviews and no measured experiment)'
      : corpus.items.map((item) => `--- ${item.id} [${item.source}]\n${item.text}`).join('\n\n')

  return [
    'You are reading one repository\'s own record of what its coding agents did, and grouping it into',
    'PATTERNS — shapes that recur — and then proposing at most one experiment per pattern.',
    '',
    'Answer with ONE JSON object and nothing else. No prose, no code fence. Its shape is exactly:',
    '',
    '{"patterns":[{"patternId":"...","shape":"one sentence: what these items have in common",',
    '  "sourceItems":["the --- ids above that this pattern groups"],"count":<how many>,"heldBack":<count < 2>}],',
    ' "proposals":[{"proposalId":"...","patternId":"...","varies":"model|brief|checkpoint|gate",',
    '  "arms":[{"model":null,"briefDigest":null,"checkpointId":null,"gateCommand":null}],',
    '  "checkpointPick":{"chosenCheckpointId":"...","rejected":[{"checkpointId":"...","reason":"..."}]}}]}',
    '',
    'Rules the answer is validated against, and which you cannot talk your way past:',
    '- `heldBack` MUST equal `count < 2`. A single occurrence is not yet a pattern.',
    '- A proposal has 2 or 3 arms, and its arms may differ in EXACTLY ONE of the four dimensions',
    '  (model, briefDigest, checkpointId, gateCommand). Arms that differ in two are refused whole.',
    '- Propose nothing at all against a held-back pattern.',
    '- `briefDigest` is a sha256 hex digest or null; never a brief\'s text.',
    '- Every `sourceItems` entry is one of the `---` ids below, spelled exactly.',
    '',
    'The corpus:',
    '',
    items,
  ].join('\n')
}

/** sha256 of the prompt handed to the CLI — never the prompt text itself, the rule `forkTreatmentSchema.promptDigest` already keeps. */
function digestPrompt(prompt: string): string {
  return createHash('sha256').update(prompt, 'utf8').digest('hex')
}

// --- the spawn --------------------------------------------------------------------

/**
 * The hand's argv, as a pure function so a test — and a reader — can see the
 * exact command line without a process being spawned, exactly as
 * `fork.ts`'s `workmuxAddArgv` does for the launcher. See this module's own doc
 * for what each flag is and how it was verified.
 */
export function rdAgentArgv(model: string, prompt: string, maxTurns?: number): string[] {
  const argv = ['-p', '--output-format', 'json', '--model', model, '--tools', '', '--strict-mcp-config']
  if (maxTurns !== undefined) argv.push('--max-turns', String(maxTurns))
  argv.push('--', prompt)
  return argv
}

/** Refuses a model that could not name anything — argv-only here, so the SHELL grammar `fork.ts` enforces does not apply and is deliberately not restated. */
function assertModelIsNamed(model: string): void {
  if (model.trim().length === 0 || /\s/.test(model)) {
    throw new Error(`invalid model: "${model}" (a model is one word, and the hand is told exactly which one to run)`)
  }
}

/** What `claude -p --output-format json` returns, as this module reads it back. */
interface AgentJsonResult {
  result: string
  total_cost_usd: number
  duration_ms: number
  num_turns: number
  session_id: string
}

function parseAgentJson(stdout: string): AgentJsonResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.trim())
  } catch {
    throw new Error('the R&D hand did not answer with JSON — it was asked for --output-format json and printed something else')
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('the R&D hand answered with JSON that is not an object')
  }
  const { result, total_cost_usd, duration_ms, num_turns, session_id } = parsed as Record<string, unknown>
  if (typeof result !== 'string') throw new Error('the R&D hand\'s JSON carries no "result" string')
  if (typeof total_cost_usd !== 'number' || !(total_cost_usd >= 0)) {
    throw new Error('the R&D hand\'s JSON carries no "total_cost_usd" — a spend with no figure is not a spend this instrument will record')
  }
  if (typeof duration_ms !== 'number' || !Number.isInteger(duration_ms) || duration_ms < 0) {
    throw new Error('the R&D hand\'s JSON carries no "duration_ms"')
  }
  return {
    result,
    total_cost_usd,
    duration_ms,
    num_turns: typeof num_turns === 'number' ? num_turns : 0,
    session_id: typeof session_id === 'string' ? session_id : '',
  }
}

/**
 * The hand's `result` text, read as the fixed R&D document. A model that wraps
 * its JSON in a fence has still answered — the fence is stripped rather than
 * refused, because refusing punctuation would spend the operator's money to
 * report a formatting opinion.
 */
function parseResultDocument(text: string): { patterns: unknown[]; proposals: unknown[] } {
  const unfenced = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  let parsed: unknown
  try {
    parsed = JSON.parse(unfenced)
  } catch {
    throw new Error("the R&D hand's result is not the fixed JSON document prd55 ruling 3 fixes — nothing is recorded and nothing is patched")
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error("the R&D hand's result is not an object")
  }
  const { patterns, proposals } = parsed as Record<string, unknown>
  if (!Array.isArray(patterns) || !Array.isArray(proposals)) {
    throw new Error('the R&D hand\'s result carries no "patterns" and "proposals" arrays')
  }
  return { patterns, proposals }
}

// --- running the hand ---------------------------------------------------------------

export interface RunRdOptions {
  /** The lane this run is booked to — every rd.* payload carries it. */
  lane: string
  /** The watched repo: where the corpus is read and where the events are recorded. */
  repoPath: string
  /** The model the hand runs (prd55 ruling 5's list is a convenience; the CLI takes any name). */
  model: string
  corpus?: RdCorpusChoice
  maxTurns?: number
  /** The operator's declared binary name (`lab.agentCommand`). Never from an environment variable. */
  agentCommand?: string
  exec?: Exec
  now?: () => number
  dataRoot?: string
}

/**
 * How much of the hand's raw result text a refusal carries (prd-55 ruling 9,
 * wave 6 widening: the tab's `<details>` shows it, not an honest-gap
 * placeholder). Bounded for the same reason `RD_CORPUS_ITEM_CEILING`/
 * `RD_DOCUMENT_HEAD_CHARS` are: the raw text is the WHOLE JSON document the
 * hand answered with, patterns and proposals and all, and an unbounded
 * refusal would make one malformed answer's HTTP response as large as the
 * hand's own output — a UI affordance is not a reason to skip the same
 * discipline every other size here already keeps.
 */
export const RD_REFUSAL_RAW_RESULT_CHARS = 8_000

/** The hand's raw result text, bounded — never the whole unbounded document. */
function boundedRawResult(text: string): string {
  return text.length > RD_REFUSAL_RAW_RESULT_CHARS ? `${text.slice(0, RD_REFUSAL_RAW_RESULT_CHARS)}…` : text
}

/**
 * One proposal the pure laws refused — the reason, verbatim, beside the
 * pattern it was drawn from, and the hand's own raw result text (bounded by
 * {@link RD_REFUSAL_RAW_RESULT_CHARS}) so a surface can show what was
 * actually said rather than an honest gap. Every refusal from ONE hand call
 * carries the SAME raw text — there is one JSON document per call, however
 * many patterns or proposals it named.
 */
export interface RdRefusal {
  patternId: string
  reason: string
  rawResult: string
}

export interface RunRdResult {
  lane: string
  /**
   * False means the operator's CLI is not on the server's PATH. Then
   * {@link RunRdResult.reason} is {@link RD_NO_CLI_SENTENCE}, nothing was
   * spawned, and nothing was recorded.
   */
  available: boolean
  reason: string | null
  corpus: RdCorpus
  patterns: RdPattern[]
  proposals: RdProposalContent[]
  refusals: RdRefusal[]
  provenance: RdProvenance | null
  /** How many turns the CLI reported — the S5 provenance line's `turns`, which core's provenance schema does not carry. */
  turns: number
  /** Every event this run appended, in order. */
  events: RhizomorphEvent[]
  /** The rhizomorph event log they were appended to, or null when nothing was recorded. */
  recordedTo: string | null
}

/**
 * Is the operator's CLI on the server's PATH? Answered by asking the binary
 * itself for its version — which is also where `claudeVersion` comes from, so
 * the probe is not a second question with its own answer. A spawn error is the
 * absent case and only that: `ExecResult.errorMessage` is set exactly when the
 * binary could not be run at all.
 */
async function probeAgent(exec: Exec, agentCommand: string): Promise<{ version: string } | null> {
  const result = await exec(agentCommand, ['--version'], {})
  if (result.errorMessage !== undefined) return null
  if (result.failed) {
    throw new Error(
      `"${agentCommand} --version" is on this machine's PATH but did not answer: ${describeExecFailure(result)} — ` +
        'that is a broken install, not a missing one',
    )
  }
  const version = result.stdout.trim()
  if (version.length === 0) {
    throw new Error(`"${agentCommand} --version" answered with nothing — the provenance of an R&D run names the version that produced it`)
  }
  return { version }
}

/**
 * ONE R&D run (prd55 ruling 1): resolve the operator's CLI, read the corpus,
 * spawn the hand with no tools, validate what came back against core's schema,
 * and record it.
 *
 * Every proposal is judged by core's own `rdRefusalReason` — held back first,
 * then more than one varying dimension — and a refused proposal is recorded as
 * `rd.refused` with that exact sentence. **Nothing is ever patched**: this
 * module has no code path that edits a proposal into a legal one, which is what
 * ruling 3 means by "never a patched proposal".
 */
export async function runRdHand(options: RunRdOptions): Promise<RunRdResult> {
  const rawExec = options.exec ?? realExec
  const probeExec = withTimeout(rawExec, RD_PROBE_TIMEOUT_MS)
  const handExec = withTimeout(rawExec, RD_HAND_TIMEOUT_MS)
  const now = options.now ?? Date.now
  const dataRoot = options.dataRoot ?? defaultDataRoot()
  const repoPath = path.resolve(options.repoPath)
  const agentCommand = options.agentCommand ?? DEFAULT_AGENT_COMMAND

  if (options.lane.trim().length === 0) throw new Error('invalid lane: an R&D run is booked to a lane, and this one has no name')
  assertModelIsNamed(options.model)
  if (options.maxTurns !== undefined && (!Number.isInteger(options.maxTurns) || options.maxTurns < 1)) {
    throw new Error(`invalid max turns: ${options.maxTurns} (must be a positive integer)`)
  }

  // The PATH answer comes FIRST, before the corpus is read: a machine with no
  // CLI must not pay for a corpus read it can do nothing with, and ruling 9
  // draws "no CLI" as a state of the control rather than as a failed run.
  const probe = await probeAgent(probeExec, agentCommand)
  if (probe === null) {
    return {
      lane: options.lane,
      available: false,
      reason: RD_NO_CLI_SENTENCE,
      corpus: { choice: options.corpus ?? 'local', items: [], digest: digestCorpus([]), trackerRefusal: null },
      patterns: [],
      proposals: [],
      refusals: [],
      provenance: null,
      turns: 0,
      events: [],
      recordedTo: null,
    }
  }

  const corpus = await readRdCorpus({
    repoPath,
    ...(options.corpus === undefined ? {} : { corpus: options.corpus }),
    exec: rawExec,
    dataRoot,
  })
  const prompt = rdPrompt(corpus)
  const argv = rdAgentArgv(options.model, prompt, options.maxTurns)

  const spawned = await handExec(agentCommand, argv, { cwd: repoPath })
  if (spawned.failed) {
    throw new Error(`the R&D hand ("${agentCommand}") failed: ${describeExecFailure(spawned)}`)
  }
  const answer = parseAgentJson(spawned.stdout)

  const provenance: RdProvenance = {
    model: options.model,
    total_cost_usd: answer.total_cost_usd,
    duration_ms: Math.trunc(answer.duration_ms),
    promptDigest: digestPrompt(prompt),
    corpusDigest: corpus.digest,
    claudeVersion: probe.version,
    corpus: corpus.choice,
  }

  const document = parseResultDocument(answer.result)
  const rawResultDigest = createHash('sha256').update(answer.result, 'utf8').digest('hex')

  // Patterns first, and strictly: `rdPatternSchema` refuses a `heldBack` that
  // disagrees with `isHeldBack(count)`, which is the law core owns. A pattern
  // that fails it is not a pattern this instrument can record a refusal
  // AGAINST either — `rd.refused` names a `patternId`, and an unreadable
  // pattern has none to name — so the run stops here rather than inventing one.
  const patterns: RdPattern[] = []
  for (const candidate of document.patterns) {
    const parsed = rdPatternSchema.safeParse(candidate)
    if (!parsed.success) {
      throw new Error(
        `the R&D hand's patterns do not match prd55 ruling 3's schema: ${parsed.error.issues[0]?.message ?? 'invalid pattern'} — ` +
          'nothing is recorded and nothing is patched',
      )
    }
    patterns.push(parsed.data)
  }
  const heldBackById = new Map(patterns.map((pattern) => [pattern.patternId, pattern.heldBack]))

  const accepted: RunRdResult['proposals'] = []
  const refusals: RdRefusal[] = []
  for (const candidate of document.proposals) {
    const patternId = readPatternId(candidate)
    const parsed = rdProposalContentSchema.safeParse(candidate)
    if (!parsed.success) {
      // The schema's own refusal message is core's sentence for a two-dimension
      // proposal (`RD_MULTI_DIMENSION_REFUSAL`, set as the refine's message), so
      // a proposal refused here reads identically to one refused below.
      refusals.push({
        patternId,
        reason: parsed.error.issues[0]?.message ?? 'this proposal is not the shape prd55 ruling 3 fixes',
        rawResult: boundedRawResult(answer.result),
      })
      continue
    }
    const reason = rdRefusalReason({
      patternHeldBack: heldBackById.get(parsed.data.patternId) ?? true,
      varies: parsed.data.varies,
      arms: parsed.data.arms.map((arm) => ({
        model: arm.model,
        brief: arm.briefDigest,
        checkpoint: arm.checkpointId,
        gate: arm.gateCommand,
      })),
    })
    if (reason !== null) {
      refusals.push({ patternId: parsed.data.patternId, reason, rawResult: boundedRawResult(answer.result) })
      continue
    }
    accepted.push(parsed.data)
  }

  const { recorder, logFilePath, nextId } = await openRecorder(repoPath, dataRoot, now())
  const events: RhizomorphEvent[] = []

  const patternsEvent = createEvent(
    'rd.patterns',
    { lane: options.lane, patterns, provenance },
    { id: nextId(), ts: now() },
  )
  await recorder.record(patternsEvent)
  events.push(patternsEvent)

  for (const proposal of accepted) {
    const event = createEvent('rd.proposal', { ...proposal, lane: options.lane, provenance }, { id: nextId(), ts: now() })
    await recorder.record(event)
    events.push(event)
  }

  for (const refusal of refusals) {
    const event = createEvent(
      'rd.refused',
      { lane: options.lane, patternId: refusal.patternId, reason: refusal.reason, rawResultDigest, provenance },
      { id: nextId(), ts: now() },
    )
    await recorder.record(event)
    events.push(event)
  }

  // The bill, last: prd55 ruling 1's "the R&D hand's cost is booked as spend
  // with its basis, like a fork's". See {@link bookHandCost} for why it is the
  // last line of a run and not the first.
  const costEvent = bookHandCost(options, provenance, nextId, now)
  if (costEvent !== null) {
    await recorder.record(costEvent)
    events.push(costEvent)
  }

  return {
    lane: options.lane,
    available: true,
    reason: corpus.trackerRefusal,
    corpus,
    patterns,
    proposals: accepted,
    refusals,
    provenance,
    turns: answer.num_turns,
    events,
    recordedTo: logFilePath,
  }
}

/**
 * The role a hand's spend is booked under (prd55 ruling 1, #430).
 *
 * `auxiliary` — the CLI's own traffic riding alongside a lane, which is
 * precisely what an R&D run is: the operator asked the instrument to read the
 * corpus FOR a lane, and the answer is not that lane's agent doing that lane's
 * work. `worker` was the alternative and is rejected on the ledger's own
 * terms: a lane's worker spend is what a reader compares an arm against, and
 * mixing the instrument's research money into it would make every such
 * comparison quietly wrong — the same undercount `agentRoleSchema`'s own
 * comment says `role` exists to prevent, running the other way.
 * `unattributed` is refused because somebody DID say: the operator named the
 * lane on the command line.
 */
const RD_COST_ROLE = 'auxiliary'

/**
 * The hand's cost, booked as spend — prd55 ruling 1: *"The R&D hand's cost is
 * booked as spend with its basis, like a fork's."*
 *
 * **The figure is the one the provenance already carries** — `total_cost_usd`,
 * copied from `claude -p --output-format json`'s own result and never
 * re-derived here or anywhere downstream — so the R&D tab's provenance line
 * and the ledger's total are the same number by construction rather than by
 * two agreeing arithmetics. `authoritative: true` is the basis: the CLI
 * computed the dollars, no pricing table of ours was consulted, and the spend
 * surfaces render exactly that without being taught anything about the lab.
 *
 * **`source: 'lab'`, and that is the whole point of it.** Signing this
 * `sessionlog` or `otel` would be a false provenance — no transcript was
 * tailed for this call and no OTLP receiver saw it — and it is the same lie,
 * pointed the other way, that ruling 1's "the instrument holds no credential
 * and forwards nothing" is careful about. `'lab'` is the literal
 * `events/lab.ts` already uses for this same second hand, deliberately outside
 * the collector enum; `events/telemetry.ts` carries the full reasoning.
 *
 * **A run that reports no cost books nothing and says nothing.** Returning
 * `null` rather than an event with `costUsd: 0` is deliberate: a zero-dollar
 * row is a claim that the run was free, which is a different fact from the CLI
 * not having reported a figure, and the ledger would carry it as spend either
 * way. (`parseAgentJson` already refuses an answer with no `total_cost_usd`
 * at all, so the reachable case here is a reported zero.)
 *
 * **Called last, from the one place that has a recorder open.** So the two
 * paths that record nothing book nothing without needing to be told: the
 * no-CLI answer returns before the corpus is even read, and every refusal of
 * the hand's own answer — not the fixed document, a pattern whose `heldBack`
 * disagrees with its count, no cost figure — throws before `openRecorder`
 * runs. A run that got far enough to record `rd.patterns` is a run that spent
 * the operator's money, and it is the only kind that books any.
 *
 * **No `sessionId`.** The CLI reports its own `session_id`, and carrying it
 * would be the one dishonest-looking field on an otherwise honest record: the
 * fold reads `sessionId` as the join key to a session the OBSERVER can see,
 * and nothing observes a `-p` call the operator's own binary made. A session
 * id no collector will ever corroborate reads downstream as a session running
 * without instrumentation — a setup gap that does not exist. The lane is what
 * places this spend, and the lane is on the payload.
 */
function bookHandCost(
  options: RunRdOptions,
  provenance: RdProvenance,
  nextId: () => string,
  now: () => number,
): EventOf<'llm.cost'> | null {
  if (!(provenance.total_cost_usd > 0)) return null
  return createEvent(
    'llm.cost',
    {
      lane: options.lane,
      role: RD_COST_ROLE,
      model: provenance.model,
      costUsd: provenance.total_cost_usd,
      authoritative: true,
    },
    { id: nextId(), ts: now(), source: 'lab' },
  )
}

/**
 * A refused proposal's `patternId`, read defensively. `rd.refused` names the
 * pattern the refusal belongs to, so a proposal that does not even say which
 * pattern it is about cannot be filed beside one — that is a fact about the
 * hand's answer, and it is said rather than guessed at.
 */
function readPatternId(candidate: unknown): string {
  if (typeof candidate === 'object' && candidate !== null) {
    const { patternId } = candidate as Record<string, unknown>
    if (typeof patternId === 'string' && patternId.trim().length > 0) return patternId
  }
  throw new Error(
    "the R&D hand proposed something that names no pattern — a refusal is recorded beside the pattern it refuses, and this one has none to name",
  )
}

// --- the override (ruling 4: the choice is never re-attributed) ----------------------

export interface RecordRdOverrideOptions {
  lane: string
  repoPath: string
  proposalId: string
  /** The checkpoint the AGENT picked — kept, so the record can never re-attribute the change. */
  agentCheckpointId: string
  /** The checkpoint the OPERATOR chose instead. */
  operatorCheckpointId: string
  /** The provenance of the run that produced the proposal — carried forward unchanged, never re-derived. */
  provenance: RdProvenance
  now?: () => number
  dataRoot?: string
}

/**
 * Records the operator changing a proposal's checkpoint pick before launching
 * (prd55 ruling 4). The event names BOTH checkpoints — the agent's and the
 * operator's — so no later reader can attribute the operator's choice to the
 * hand. Refuses an "override" that changed nothing: a record of a decision
 * nobody made is worse than no record.
 */
export async function recordRdOverride(options: RecordRdOverrideOptions): Promise<{ event: EventOf<'rd.override'>; recordedTo: string }> {
  if (options.agentCheckpointId === options.operatorCheckpointId) {
    throw new Error(
      `refusing to record an override that changed nothing: the agent picked ${options.agentCheckpointId} and so did you — ` +
        'an override names two different checkpoints (prd55 ruling 4)',
    )
  }
  const now = options.now ?? Date.now
  const dataRoot = options.dataRoot ?? defaultDataRoot()
  const repoPath = path.resolve(options.repoPath)
  const { recorder, logFilePath, nextId } = await openRecorder(repoPath, dataRoot, now())

  const event = createEvent(
    'rd.override',
    {
      lane: options.lane,
      proposalId: options.proposalId,
      agentCheckpointId: options.agentCheckpointId,
      operatorCheckpointId: options.operatorCheckpointId,
      provenance: options.provenance,
    },
    { id: nextId(), ts: now() },
  )
  await recorder.record(event)
  return { event, recordedTo: logFilePath }
}

/**
 * A `SessionRecorder` on the live session, exactly as `fork.ts` constructs one:
 * resume the session inside `RESUME_WINDOW_MS` if there is one, else start a
 * new file named for now. Shared by both recording entry points here so the two
 * cannot drift into writing to two different logs.
 */
async function openRecorder(
  repoPath: string,
  dataRoot: string,
  ts: number,
): Promise<{ recorder: SessionRecorder; logFilePath: string; nextId: () => string }> {
  const sessionDir = sessionDirFor(repoPath, dataRoot)
  const resumed = await findResumableSession(sessionDir, ts, RESUME_WINDOW_MS)
  const logFilePath = resumed?.filePath ?? path.join(sessionDir, sessionFileName(ts))
  const recorder = new SessionRecorder(
    resumed?.sessionId ?? String(ts),
    logFilePath,
    resumed ? { resumeFrom: resumed.events } : {},
  )
  // Tagged `rd` (#429): the CLI verb this module is invoked as
  // (`rhizomorph lab rd`), the same word every `rd.*` event type already carries.
  return { recorder, logFilePath, nextId: createIdFactory('lab', 0, 'rd') }
}

/** A proposal id for a hand that did not mint one — never a silent rename of one it did. */
export function mintProposalId(): string {
  return `proposal-${randomUUID()}`
}
