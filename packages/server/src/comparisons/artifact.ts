/**
 * A FINISHED COMPARISON, SAVED AS A REOPENABLE ARTIFACT — the server's own
 * copy of prd14 ruling 5's shape (ADR-0042). This is a deliberate port of
 * `packages/web/src/lab/compare/artifact.ts`, kept byte-identical in its
 * messages, rather than an import across packages — see that ADR for why.
 * `parser-agreement-law.test.ts` (this directory, and its counterpart in
 * `packages/web/src/lab/compare/`) is the tripwire ADR-0042 named as missing:
 * both copies read the same fixture bytes under
 * `packages/contract/src/fixtures/comparison-artifact/` and must accept and
 * refuse them identically, message and all.
 *
 * An artifact whose `version` is not `1` refuses and is never migrated: a
 * migration, if one is ever written, goes through its own upcast the way
 * prd17's chokepoint prescribes (ADR-0011), and this module does not write
 * one.
 *
 * v1 carries the compare surface's own run shape — a verdict, a value that
 * may be null, and the `note`/`detail` the surface prints (prd53 ruling 2,
 * amended 2026-09-08) — not the measured outcome #324 added to `LabRunDTO`
 * (`durationMs`, `commits`, `provenance`). Carrying that is a `version: 2`
 * decision with its own record, not an oversight in this one.
 */

export type Run =
  | { id: string; status: 'complete'; verdict: 'pass' | 'fail'; value: number | null; note?: string; detail?: string }
  | { id: string; status: 'pending'; note?: string }

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

function parseRun(record: unknown): Run {
  if (!isRecord(record)) throw new ComparisonArtifactError('run is not a JSON object')
  const { id, status } = record
  if (typeof id !== 'string') throw new ComparisonArtifactError('run is missing id')

  if (status === 'complete') {
    const { verdict, value } = record
    if (verdict !== 'pass' && verdict !== 'fail') throw new ComparisonArtifactError(`complete run ${id} is missing its verdict (pass or fail)`)
    if (typeof value !== 'number' && value !== null) throw new ComparisonArtifactError(`complete run ${id} has a value that is neither a number nor null`)
    if (typeof value === 'number' && !Number.isFinite(value)) throw new ComparisonArtifactError(`complete run ${id} has a value that is not finite`)
    return {
      id,
      status: 'complete',
      verdict,
      value,
      ...(typeof record.note === 'string' ? { note: record.note } : {}),
      ...(typeof record.detail === 'string' ? { detail: record.detail } : {}),
    }
  }
  if (status === 'pending') return typeof record.note === 'string' ? { id, status: 'pending', note: record.note } : { id, status: 'pending' }
  if (status === 'failed') {
    throw new ComparisonArtifactError(
      `run ${id} carries the retired status "failed" — since prd53 ruling 2's amendment a failed gate is a completed run with verdict "fail"`,
    )
  }
  throw new ComparisonArtifactError(`run ${id} has an unknown status: ${String(status)}`)
}
