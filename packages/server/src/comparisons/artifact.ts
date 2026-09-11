/**
 * A FINISHED COMPARISON, SAVED AS A REOPENABLE ARTIFACT — the server's own
 * copy of prd14 ruling 6's shape (ADR-0049, superseding ADR-0042). This is a
 * deliberate port of `packages/web/src/lab/compare/artifact.ts`, kept
 * byte-identical in its messages, rather than an import across packages —
 * see that ADR for why. `parser-agreement-law.test.ts` (this directory, and
 * its counterpart in `packages/web/src/lab/compare/`) is the tripwire
 * ADR-0042 named as missing: both copies read the same fixture bytes under
 * `packages/contract/src/fixtures/comparison-artifact/` and must accept and
 * refuse them identically, message and all.
 *
 * An artifact whose `version` is not `1` or `2` refuses and is never
 * migrated: a migration, if one is ever written, goes through its own upcast
 * the way prd17's chokepoint prescribes (ADR-0011), and this module does not
 * write one.
 *
 * v1 carries the compare surface's own run shape — a verdict, a value that
 * may be null, and the `note`/`detail` the surface prints (prd53 ruling 2,
 * amended 2026-09-08) — not the measured outcome #324 added to `LabRunDTO`
 * (`durationMs`, `commits`, `provenance`).
 *
 * VERSION 2 (prd14 ruling 6): v1 stores `value` — whichever measure happened
 * to be selected at save time — so the measure itself is not recorded. v2
 * stores facts in the compare surface's OWN vocabulary — never
 * `LabRunOutcomeDTO`, this package's own wire type — per run `{ verdict,
 * detail?, cost, duration, commits }`, and per artifact the `measure` and the
 * gate's `provenance`. A v1 artifact is READ, not migrated: v1 → v2 is not
 * total (the measure is unrecoverable from a v1 file), so both versions parse
 * through the one discriminated `ComparisonArtifact` and version 3 and above
 * still refuse by name.
 *
 * ADR-0049 keeps the two copies deliberately, on the condition that the
 * agreement laws hold TWO kinds of coverage, not one: throw-site coverage
 * DERIVED FROM SOURCE (which is why the v1/v2 validation below shares one
 * throw site per message via a common helper rather than repeating a message
 * string in two places — two identical literal throw sites would make that
 * coverage ambiguous, see `parser-agreement-law.test.ts`'s own doc, axis B),
 * AND accepted-value coverage — the fixture must exercise every member of
 * every union v2 admits (every `MeasureV2`, every
 * `ComparisonProvenanceV2['source']`), and both the finite and non-finite form
 * of every numeric field. Site coverage is NOT value coverage: narrowing an
 * accepted union removes no throw site and adds no message, so a one-sided
 * narrowing reads as fully covered while the two copies have genuinely
 * diverged — measured on this build, ADR-0049's own Consequences record the
 * exact narrowings that passed both agreement laws before the fixture was
 * widened to catch them.
 */

export type RunV1 =
  | { id: string; status: 'complete'; verdict: 'pass' | 'fail'; value: number | null; note?: string; detail?: string }
  | { id: string; status: 'pending'; note?: string }

export interface Arm {
  id: string
  model: string
  brief: string
  runs: RunV1[]
}

export interface ComparisonInput {
  arms: Arm[]
}

export interface ComparisonArtifactV1 {
  version: 1
  savedAt: string
  input: ComparisonInput
}

/** The four measures the compare surface can read a run for (this subtree's artifact format keeps its own vocabulary, ADR-0049 — the same union as the web package's `fromExperiment.ts`, restated rather than shared across the package boundary). */
export type MeasureV2 = 'cost' | 'duration' | 'commits' | 'verified'

/** The gate's own account of how a run was judged — one per artifact, not one per run (prd14 ruling 6: every run in one experiment is ordinarily gated the same way, so the artifact records the judgement as a fact of the whole comparison). */
export interface ComparisonProvenanceV2 {
  verifyCommand: string
  source: 'measure-route' | 'compare-cli'
  measuredAt: number
}

export type RunV2 =
  | { id: string; status: 'complete'; verdict: 'pass' | 'fail'; detail?: string; cost: number | null; duration: number | null; commits: number | null }
  | { id: string; status: 'pending'; note?: string }

export interface ArmV2 {
  id: string
  model: string
  brief: string
  runs: RunV2[]
}

export interface ComparisonInputV2 {
  arms: ArmV2[]
}

export interface ComparisonArtifactV2 {
  version: 2
  savedAt: string
  /**
   * Absent when a v2 artifact was written, or later corrupted, without
   * recording which measure was showing — the reopened surface then falls
   * back to the same "measure not recorded" path a v1 artifact takes (prd14
   * ruling 6's second certified mutation: a v2 file with the measure dropped
   * reads successfully and the SURFACE is what refuses to guess a basis, not
   * this parser).
   */
  measure?: MeasureV2
  /** `null` when nothing had been judged yet at save time — never invented. Absent has the same meaning as `null`; the parser accepts either. */
  provenance?: ComparisonProvenanceV2 | null
  input: ComparisonInputV2
}

export type ComparisonArtifact = ComparisonArtifactV1 | ComparisonArtifactV2

export class ComparisonArtifactError extends Error {}

export function serialiseComparison(input: ComparisonInput, savedAt: string): string {
  const artifact: ComparisonArtifactV1 = { version: 1, savedAt, input }
  return `${JSON.stringify(artifact, null, 2)}\n`
}

export function serialiseComparisonV2(
  input: ComparisonInputV2,
  measure: MeasureV2 | undefined,
  provenance: ComparisonProvenanceV2 | null | undefined,
  savedAt: string,
): string {
  const artifact: ComparisonArtifactV2 = {
    version: 2,
    savedAt,
    ...(measure === undefined ? {} : { measure }),
    ...(provenance === undefined ? {} : { provenance }),
    input,
  }
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
  if (data.version === 1) {
    return { version: 1, savedAt: requireSavedAt(data), input: parseComparisonInput(data.input) }
  }
  if (data.version === 2) {
    const savedAt = requireSavedAt(data)
    const measure = data.measure === undefined ? undefined : parseMeasureV2(data.measure)
    const provenance = data.provenance === undefined ? undefined : parseProvenanceV2(data.provenance)
    return {
      version: 2,
      savedAt,
      ...(measure === undefined ? {} : { measure }),
      ...(provenance === undefined ? {} : { provenance }),
      input: parseComparisonInputV2(data.input),
    }
  }
  throw new ComparisonArtifactError(`unsupported comparison artifact version: ${String(data.version)}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function requireSavedAt(data: Record<string, unknown>): string {
  if (typeof data.savedAt !== 'string') throw new ComparisonArtifactError('comparison artifact is missing savedAt')
  return data.savedAt
}

export function parseMeasureV2(value: unknown): MeasureV2 {
  if (value === 'cost' || value === 'duration' || value === 'commits' || value === 'verified') return value
  throw new ComparisonArtifactError(`comparison artifact has an unrecognised measure: ${String(value)}`)
}

export function parseProvenanceV2(value: unknown): ComparisonProvenanceV2 | null {
  if (value === null) return null
  if (!isRecord(value)) throw new ComparisonArtifactError('comparison artifact provenance is not null and not a JSON object')
  const { verifyCommand, source, measuredAt } = value
  if (typeof verifyCommand !== 'string') throw new ComparisonArtifactError('comparison artifact provenance is missing verifyCommand')
  if (source !== 'measure-route' && source !== 'compare-cli') {
    throw new ComparisonArtifactError(`comparison artifact provenance has an unrecognised source: ${String(source)}`)
  }
  if (typeof measuredAt !== 'number' || !Number.isFinite(measuredAt)) {
    throw new ComparisonArtifactError('comparison artifact provenance has a measuredAt that is not a finite number')
  }
  return { verifyCommand, source, measuredAt }
}

/** Shared by both format versions — an arm's own shape (id, model, brief, runs) never changed between them, only what a RUN carries did. One call site per message keeps the agreement laws' throw-site coverage unambiguous (see the file doc, and `parser-agreement-law.test.ts`'s axis B). */
function parseArms<TRun>(value: unknown, parseRun: (run: unknown) => TRun): Array<{ id: string; model: string; brief: string; runs: TRun[] }> {
  if (!isRecord(value) || !Array.isArray(value.arms)) {
    throw new ComparisonArtifactError('comparison artifact is missing its arms array')
  }
  return value.arms.map((arm) => parseArm(arm, parseRun))
}

function parseArm<TRun>(value: unknown, parseRun: (run: unknown) => TRun): { id: string; model: string; brief: string; runs: TRun[] } {
  if (!isRecord(value)) throw new ComparisonArtifactError('arm is not a JSON object')
  const { id, model, brief, runs } = value
  if (typeof id !== 'string' || typeof model !== 'string' || typeof brief !== 'string' || !Array.isArray(runs)) {
    throw new ComparisonArtifactError('arm is missing one of id, model, brief, runs')
  }
  return { id, model, brief, runs: runs.map(parseRun) }
}

/** Shared id/status/verdict extraction, one call site per message, for both a v1 run and a v2 run — only what a COMPLETE run carries beyond its verdict differs between the two (`parseComplete`). */
function parseRunCommon<T>(
  record: unknown,
  parseComplete: (record: Record<string, unknown>, id: string, verdict: 'pass' | 'fail') => T,
): T | { id: string; status: 'pending'; note?: string } {
  if (!isRecord(record)) throw new ComparisonArtifactError('run is not a JSON object')
  const { id, status } = record
  if (typeof id !== 'string') throw new ComparisonArtifactError('run is missing id')

  if (status === 'complete') {
    const { verdict } = record
    if (verdict !== 'pass' && verdict !== 'fail') throw new ComparisonArtifactError(`complete run ${id} is missing its verdict (pass or fail)`)
    return parseComplete(record, id, verdict)
  }
  if (status === 'pending') return typeof record.note === 'string' ? { id, status: 'pending', note: record.note } : { id, status: 'pending' }
  if (status === 'failed') {
    throw new ComparisonArtifactError(
      `run ${id} carries the retired status "failed" — since prd53 ruling 2's amendment a failed gate is a completed run with verdict "fail"`,
    )
  }
  throw new ComparisonArtifactError(`run ${id} has an unknown status: ${String(status)}`)
}

export function parseComparisonInput(value: unknown): ComparisonInput {
  return { arms: parseArms(value, parseRunV1) }
}

function parseRunV1(record: unknown): RunV1 {
  return parseRunCommon(record, (record, id, verdict) => {
    const { value } = record
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
  })
}

export function parseComparisonInputV2(value: unknown): ComparisonInputV2 {
  return { arms: parseArms(value, parseRunV2) }
}

/** One throw site for all three of cost/duration/commits — `key` is always a literal from `parseRunV2` below, never attacker/caller-controlled, and keeping it one site (rather than one per field) is what keeps it distinguishable from v1's own `value`-shaped messages under the agreement laws' axis B (see the file doc). */
function parseNumberOrNullField(record: Record<string, unknown>, key: 'cost' | 'duration' | 'commits', id: string): number | null {
  const value = record[key]
  if (typeof value !== 'number' && value !== null) throw new ComparisonArtifactError(`complete run ${id} has a ${key} field that is neither a number nor null`)
  if (typeof value === 'number' && !Number.isFinite(value)) throw new ComparisonArtifactError(`complete run ${id} has a ${key} field that is not finite`)
  return value
}

function parseRunV2(record: unknown): RunV2 {
  return parseRunCommon(record, (record, id, verdict) => ({
    id,
    status: 'complete',
    verdict,
    cost: parseNumberOrNullField(record, 'cost', id),
    duration: parseNumberOrNullField(record, 'duration', id),
    commits: parseNumberOrNullField(record, 'commits', id),
    ...(typeof record.detail === 'string' ? { detail: record.detail } : {}),
  }))
}
