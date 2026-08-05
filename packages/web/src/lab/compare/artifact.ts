import type { Arm, ComparisonInput, Run } from './types.js'

/**
 * A FINISHED COMPARISON, SAVED AS A REOPENABLE ARTIFACT (prd14 ruling 3, law
 * 6). A pure serialise/parse pair over this subtree's own plain input — not
 * wired to prd16's recording machinery yet, so a later wave can adopt that
 * machinery around this shape without reworking the comparison logic itself.
 *
 * Parsing is defensive rather than a bare cast: a `JSON.parse` of arbitrary
 * text is `unknown`, and this is the boundary an old or hand-edited artifact
 * would need lenient handling at — real validation now, so a real chokepoint
 * exists to make lenient later (the prd17 shape) rather than a `as` that
 * silently accepts garbage today.
 */
export interface ComparisonArtifact {
  version: 1
  savedAt: string
  input: ComparisonInput
}

export class ComparisonArtifactError extends Error {}

export function serialiseComparison(input: ComparisonInput, savedAt: string): string {
  const artifact: ComparisonArtifact = { version: 1, savedAt, input }
  return `${JSON.stringify(artifact, null, 2)}\n`
}

export function parseComparisonArtifact(raw: string): ComparisonArtifact {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    throw new ComparisonArtifactError('comparison artifact is not valid JSON')
  }

  if (!isRecord(data)) {
    throw new ComparisonArtifactError('comparison artifact is not a JSON object')
  }
  if (data.version !== 1) {
    throw new ComparisonArtifactError(`unsupported comparison artifact version: ${String(data.version)}`)
  }
  if (typeof data.savedAt !== 'string') {
    throw new ComparisonArtifactError('comparison artifact is missing savedAt')
  }

  return { version: 1, savedAt: data.savedAt, input: parseComparisonInput(data.input) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseComparisonInput(value: unknown): ComparisonInput {
  if (!isRecord(value) || !Array.isArray(value.arms)) {
    throw new ComparisonArtifactError('comparison artifact is missing its arms array')
  }
  return { arms: value.arms.map(parseArm) }
}

function parseArm(value: unknown): Arm {
  if (!isRecord(value)) throw new ComparisonArtifactError('arm is not a JSON object')
  const { id, model, brief, runs } = value
  if (typeof id !== 'string' || typeof model !== 'string' || typeof brief !== 'string' || !Array.isArray(runs)) {
    throw new ComparisonArtifactError('arm is missing one of id, model, brief, runs')
  }
  return { id, model, brief, runs: runs.map(parseRun) }
}

function parseRun(value: unknown): Run {
  if (!isRecord(value)) throw new ComparisonArtifactError('run is not a JSON object')
  const { id, status } = value
  if (typeof id !== 'string') throw new ComparisonArtifactError('run is missing id')

  if (status === 'complete') {
    if (typeof value.value !== 'number') throw new ComparisonArtifactError(`complete run ${id} is missing a numeric value`)
    return { id, status: 'complete', value: value.value }
  }
  if (status === 'pending') return { id, status: 'pending' }
  if (status === 'failed') {
    return typeof value.error === 'string' ? { id, status: 'failed', error: value.error } : { id, status: 'failed' }
  }
  throw new ComparisonArtifactError(`run ${id} has an unknown status: ${String(status)}`)
}
