/**
 * A FINISHED COMPARISON, SAVED AS A REOPENABLE ARTIFACT — the server's own
 * copy of prd14 ruling 5's shape (ADR-0042). This is a deliberate port of
 * `packages/web/src/lab/compare/artifact.ts`, kept byte-identical in its
 * messages, rather than an import across packages — see that ADR for why.
 *
 * An artifact whose `version` is not `1` refuses and is never migrated: a
 * migration, if one is ever written, goes through its own upcast the way
 * prd17's chokepoint prescribes (ADR-0011), and this module does not write
 * one.
 *
 * v1 carries only the compare surface's own `value` per run — the measured
 * outcome #324 added to `LabRunDTO` (`verified`, `durationMs`, `commits`,
 * `provenance`) is deliberately not in this version. Carrying it is a
 * `version: 2` decision with its own record, not an oversight in this one.
 */

export type Run =
  | { id: string; status: 'complete'; value: number }
  | { id: string; status: 'pending' }
  | { id: string; status: 'failed'; error?: string }

export interface Arm {
  id: string
  model: string
  brief: string
  runs: Run[]
}

export interface ComparisonInput {
  arms: Arm[]
}

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

export function parseComparisonInput(value: unknown): ComparisonInput {
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
