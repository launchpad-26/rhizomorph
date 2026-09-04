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
  return {
    kind: 'beacon',
    at: input.at,
    payload: {
      writer: input.writer as string,
      kind: input.kind as string,
      lane: (input.lane as string | undefined) ?? null,
      ...(input.detail === undefined ? {} : { detail: input.detail as string }),
    },
  }
}
