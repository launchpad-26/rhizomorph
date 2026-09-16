import type { BeaconReceivedPayload } from '@rhizomorph/core'

export type ParsedBeaconLine =
  | { kind: 'beacon'; at: number; payload: Omit<BeaconReceivedPayload, 'digest' | 'file' | 'offset'> }
  | { kind: 'malformed'; reason: string }

export function parseBeaconLine(line: string): ParsedBeaconLine {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return { kind: 'malformed', reason: 'beacon line is not valid JSON' }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { kind: 'malformed', reason: 'beacon line is not a JSON object' }
  }
  const input = value as Record<string, unknown>
  if (input.v !== 1) {
    return { kind: 'malformed', reason: `unsupported beacon version: ${String(input.v)}` }
  }
  if (!Number.isInteger(input.at) || typeof input.at !== 'number' || input.at < 0) {
    return { kind: 'malformed', reason: 'beacon has no usable "at" timestamp' }
  }
  for (const field of ['writer', 'kind'] as const) {
    const candidate = input[field]
    if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 64) {
      return { kind: 'malformed', reason: `beacon "${field}" is missing or too long` }
    }
  }
  if (input.lane !== undefined && (typeof input.lane !== 'string' || input.lane.length === 0 || input.lane.length > 256)) {
    return { kind: 'malformed', reason: 'beacon "lane" is empty or too long' }
  }
  if (input.detail !== undefined && (typeof input.detail !== 'string' || input.detail.length > 512)) {
    return { kind: 'malformed', reason: 'beacon "detail" is not a short string' }
  }
  /**
   * THE FOUR JOIN KEYS, carried rather than dropped — prd-57 ruling 3's
   * DECLARED join, and ruling 6's routing rule has nothing to route on without
   * the first of them.
   *
   * #518 added `sessionId`, `transcriptPath`, `cwd` and `pid` to the schema in
   * `packages/core/src/events/beacon.ts`, and nothing taught this function to
   * carry them: it built its payload from a fixed set and discarded everything
   * else, so a line could declare all four and the event would show none.
   *
   * That wave was green because its tests asserted the SCHEMA accepts the keys,
   * which it does. Nothing asserted anything READ them — the same shape this
   * PRD has hit three times now, an assertion that the input is well-formed
   * standing in for one that something acts on it.
   *
   * Each is validated the way its neighbours are and omitted when absent, never
   * sent as `undefined`: the schema declares them optional so an old recording
   * folds to exactly what it always folded to (ADR-0011), and a present-but-
   * undefined key is a different shape from an absent one on the wire.
   */
  for (const field of ['sessionId', 'transcriptPath', 'cwd'] as const) {
    const candidate = input[field]
    const max = field === 'sessionId' ? 256 : 4096
    if (candidate !== undefined && (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > max)) {
      return { kind: 'malformed', reason: `beacon "${field}" is empty or too long` }
    }
  }
  if (input.pid !== undefined && (!Number.isInteger(input.pid) || (input.pid as number) <= 0)) {
    return { kind: 'malformed', reason: 'beacon "pid" is not a positive integer' }
  }

  return {
    kind: 'beacon',
    at: input.at,
    payload: {
      writer: input.writer as string,
      kind: input.kind as string,
      lane: (input.lane as string | undefined) ?? null,
      ...(input.detail === undefined ? {} : { detail: input.detail as string }),
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId as string }),
      ...(input.transcriptPath === undefined ? {} : { transcriptPath: input.transcriptPath as string }),
      ...(input.cwd === undefined ? {} : { cwd: input.cwd as string }),
      ...(input.pid === undefined ? {} : { pid: input.pid as number }),
    },
  }
}
