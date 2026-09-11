/**
 * THE APP'S EIGHTH MUTATING CALL (prd-55 ruling 1 — the R&D hand is the
 * operator's own agent CLI, spawned as an explicit act; ADR-0048).
 *
 * `lab/launch/launch.ts` is the third, `lab/measure.ts` the sixth,
 * `lab/compare/save.ts` the seventh (`replay/mutating-calls-law.test.ts`
 * enumerates all seven by file); this module is the eighth, and the same
 * three-reason bar every sibling argues in its own header applies here too:
 *
 * - it writes only `rd.patterns` / `rd.proposal` / `rd.refused` — additive
 *   events on the laboratory's own log, never the watched repo's working
 *   tree (prd-55 ruling 1, ADR-0048);
 * - it is triggered only by the R&D control's *read and propose* button — an
 *   EXPLICIT OPERATOR ACT, never a background poll or a timer (a mutation
 *   test in `RdTab.test.tsx` proves no effect posts to this route on mount);
 * - it holds no credential of its own: the operator's ALREADY-authenticated
 *   `claude` spends under their own login, and this module carries nothing
 *   but the per-process capability token every gated mutation already needs.
 *
 * Read back through `../types.js`'s `LabRdRun` and friends — a shape the
 * route does not send (the hand's raw result text, an experiment's
 * `proposalId`) is a shape this module does not invent; see this wave's
 * report for the two widenings that fact draws.
 */

import { CAPABILITY_TOKEN_HEADER, readCapabilityToken } from '../../recordings/capability.js'
import { missingTokenMessage, staleTokenMessage } from '../../recordings/capability-guidance.js'
import type {
  LabRdArm,
  LabRdCheckpointConsideration,
  LabRdCheckpointPick,
  LabRdCorpusChoice,
  LabRdCorpusSummary,
  LabRdPattern,
  LabRdProposal,
  LabRdProvenance,
  LabRdRefusal,
  LabRdRun,
  LabRdVariesDimension,
} from '../types.js'

export const RD_URL = '/api/lab/rd'

export interface RdRunRequest {
  lane: string
  model: string
  /** prd-55 ruling 2. The server treats an absent key as `'local'`; this module always sends the operator's actual choice. */
  corpus: LabRdCorpusChoice
  maxTurns?: number
  /** The operator's declared binary name (`lab.agentCommand`), carried from settings by the caller — never read here. */
  agentCommand?: string
}

/** The narrowest shape this module needs of `fetch` — see `lab/launch/launch.ts` for why it is not `typeof fetch`. */
export type RdFetchLike = (
  input: string,
  init: {
    method: 'POST'
    headers: { 'Content-Type': 'application/json'; 'x-rhizomorph-capability': string }
    body: string
  },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

const VARIES_DIMENSIONS: readonly LabRdVariesDimension[] = ['model', 'brief', 'checkpoint', 'gate']
const CORPUS_CHOICES: readonly LabRdCorpusChoice[] = ['local', 'local+tracker']

function isVariesDimension(value: unknown): value is LabRdVariesDimension {
  return typeof value === 'string' && (VARIES_DIMENSIONS as readonly string[]).includes(value)
}

function isCorpusChoice(value: unknown): value is LabRdCorpusChoice {
  return typeof value === 'string' && (CORPUS_CHOICES as readonly string[]).includes(value)
}

function isLabRdPattern(value: unknown): value is LabRdPattern {
  return (
    isRecord(value) &&
    typeof value.patternId === 'string' &&
    typeof value.shape === 'string' &&
    Array.isArray(value.sourceItems) &&
    value.sourceItems.every((item) => typeof item === 'string') &&
    typeof value.count === 'number' &&
    typeof value.heldBack === 'boolean'
  )
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isLabRdArm(value: unknown): value is LabRdArm {
  return (
    isRecord(value) &&
    isNullableString(value.model) &&
    isNullableString(value.briefDigest) &&
    isNullableString(value.checkpointId) &&
    isNullableString(value.gateCommand)
  )
}

function isLabRdCheckpointConsideration(value: unknown): value is LabRdCheckpointConsideration {
  return isRecord(value) && typeof value.checkpointId === 'string' && typeof value.reason === 'string'
}

function isLabRdCheckpointPick(value: unknown): value is LabRdCheckpointPick {
  return (
    isRecord(value) &&
    typeof value.chosenCheckpointId === 'string' &&
    Array.isArray(value.rejected) &&
    value.rejected.every(isLabRdCheckpointConsideration)
  )
}

function isLabRdProposal(value: unknown): value is LabRdProposal {
  return (
    isRecord(value) &&
    typeof value.proposalId === 'string' &&
    typeof value.patternId === 'string' &&
    isVariesDimension(value.varies) &&
    Array.isArray(value.arms) &&
    value.arms.length >= 2 &&
    value.arms.every(isLabRdArm) &&
    isLabRdCheckpointPick(value.checkpointPick)
  )
}

function isLabRdRefusal(value: unknown): value is LabRdRefusal {
  return (
    isRecord(value) &&
    typeof value.patternId === 'string' &&
    typeof value.reason === 'string' &&
    typeof value.rawResult === 'string'
  )
}

function isLabRdProvenance(value: unknown): value is LabRdProvenance {
  return (
    isRecord(value) &&
    typeof value.model === 'string' &&
    typeof value.total_cost_usd === 'number' &&
    typeof value.duration_ms === 'number' &&
    typeof value.promptDigest === 'string' &&
    typeof value.corpusDigest === 'string' &&
    typeof value.claudeVersion === 'string' &&
    isCorpusChoice(value.corpus)
  )
}

function isLabRdCorpusSummary(value: unknown): value is LabRdCorpusSummary {
  return (
    isRecord(value) &&
    isCorpusChoice(value.choice) &&
    typeof value.digest === 'string' &&
    typeof value.itemCount === 'number' &&
    (value.trackerRefusal === null || typeof value.trackerRefusal === 'string')
  )
}

/**
 * The route's own JSON, read defensively — every field validated rather than
 * cast, the same discipline `../api.js`'s two GET parsers keep: a server that
 * answers something malformed reads as "the hand's answer made no sense",
 * never as a silently half-populated run.
 */
function parseRdRun(answer: unknown): LabRdRun | null {
  if (!isRecord(answer)) return null
  const { lane, available, reason, corpus, patterns, proposals, refusals, provenance, turns } = answer
  if (typeof lane !== 'string' || typeof available !== 'boolean') return null
  if (reason !== null && typeof reason !== 'string') return null
  if (!isLabRdCorpusSummary(corpus)) return null
  if (!Array.isArray(patterns) || !patterns.every(isLabRdPattern)) return null
  if (!Array.isArray(proposals) || !proposals.every(isLabRdProposal)) return null
  if (!Array.isArray(refusals) || !refusals.every(isLabRdRefusal)) return null
  if (provenance !== null && !isLabRdProvenance(provenance)) return null
  if (typeof turns !== 'number') return null

  return { lane, available, reason, corpus, patterns, proposals, refusals, provenance, turns }
}

/** The server's own `{ error }` when it sent one — a refusal explains itself. */
async function refusalDetail(response: { status: number; json: () => Promise<unknown> }): Promise<string> {
  try {
    const answer: unknown = await response.json()
    const error = isRecord(answer) ? answer.error : undefined
    if (typeof error === 'string' && error.length > 0) return error
  } catch {
    // fall through to the status
  }
  return `the server answered ${response.status}`
}

/**
 * Runs ONE R&D hand (prd-55 ruling 1) — the *read and propose* button's one
 * write. Throws with a sentence the control can show — never a bare status
 * code, and never a half-believed answer. A 200 carrying `available: false`
 * (no `claude` on the server's PATH) is not thrown: ruling 9 draws that as a
 * state of the control, not a failure of this call.
 */
export async function requestRd(request: RdRunRequest, fetchImpl?: RdFetchLike): Promise<LabRdRun> {
  const impl = fetchImpl ?? (globalThis.fetch as unknown as RdFetchLike | undefined)
  if (impl === undefined) throw new Error('this browser has no fetch — cannot read and propose from here')

  const capabilityToken = readCapabilityToken()
  if (capabilityToken === null) {
    throw new Error(missingTokenMessage('read and propose'))
  }

  let response: Awaited<ReturnType<RdFetchLike>>
  try {
    response = await impl(RD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [CAPABILITY_TOKEN_HEADER]: capabilityToken },
      body: JSON.stringify(request),
    })
  } catch (err) {
    throw new Error(`could not reach the instrument: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (response.status === 401) {
    throw new Error(staleTokenMessage('read and propose', await refusalDetail(response)))
  }

  if (!response.ok) throw new Error(`could not read and propose — ${await refusalDetail(response)}`)

  let answer: unknown
  try {
    answer = await response.json()
  } catch {
    throw new Error('the instrument answered something other than an R&D result')
  }

  const run = parseRdRun(answer)
  if (run === null) throw new Error('the instrument answered something other than an R&D result')
  return run
}
