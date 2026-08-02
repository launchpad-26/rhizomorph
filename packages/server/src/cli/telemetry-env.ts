import type { AgentRole } from '@rhizomorph/core'

/**
 * Renders the exact env block a lane (or the conductor) needs so its `claude`
 * process exports OTLP/HTTP JSON straight to this server's receiver
 * (`packages/server/src/api/otel.ts`, routes registered at the app root).
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is the *base* endpoint — the OTel SDK appends
 * `/v1/metrics` and `/v1/logs` itself, which is exactly where those routes
 * live. Export intervals are shortened from the SDK's 60s default so the
 * spend ticker reads as live, not stale (research note §S1 used the same
 * env vars, just shorter still, for a one-shot `-p` capture).
 *
 * Identity is declared here and nowhere else (prd2's ruling): the block names
 * the lane, its role, and — since #60 — the **instance** the telemetry belongs
 * to. The receiver refuses any export that does not carry its own instance id,
 * so an env block generated without one is telemetry that will be thrown away.
 * That is why {@link fetchInstanceId} reads it from the live server rather than
 * guessing: the running Rhizomorph is the only authority on which run this is.
 */
export interface TelemetryEnvOptions {
  lane: string
  role: AgentRole
  port: number
  /**
   * The receiving Rhizomorph's instance id — its session id, as published on
   * `/api/meta`. Required, not defaulted: a block without it is refused.
   */
  instance: string
}

const METRIC_EXPORT_INTERVAL_MS = 5000
const LOGS_EXPORT_INTERVAL_MS = 2000

export function otlpEndpoint(port: number): string {
  return `http://127.0.0.1:${port}`
}

/** Where the instance id lives. Same host and port as the receiver itself. */
export function metaUrl(port: number): string {
  return `${otlpEndpoint(port)}/api/meta`
}

export function renderTelemetryEnv({ lane, role, port, instance }: TelemetryEnvOptions): string {
  const vars: Array<[string, string]> = [
    ['CLAUDE_CODE_ENABLE_TELEMETRY', '1'],
    ['OTEL_METRICS_EXPORTER', 'otlp'],
    ['OTEL_LOGS_EXPORTER', 'otlp'],
    ['OTEL_EXPORTER_OTLP_PROTOCOL', 'http/json'],
    ['OTEL_EXPORTER_OTLP_ENDPOINT', otlpEndpoint(port)],
    ['OTEL_METRIC_EXPORT_INTERVAL', String(METRIC_EXPORT_INTERVAL_MS)],
    ['OTEL_LOGS_EXPORT_INTERVAL', String(LOGS_EXPORT_INTERVAL_MS)],
    ['OTEL_RESOURCE_ATTRIBUTES', `lane=${lane},role=${role},instance=${instance}`],
  ]

  return `${vars.map(([key, value]) => `export ${key}=${value}`).join('\n')}\n`
}

export interface FetchInstanceIdOptions {
  /** Injectable `fetch`, so a unit test needs no socket. Defaults to the global. */
  fetch?: typeof globalThis.fetch
}

/**
 * The instance id of the Rhizomorph listening on `port`, read from its
 * `/api/meta`.
 *
 * **The server must be running when env is generated.** That is not a
 * limitation worth working around: at dispatch time it always is (a lane is
 * started to be watched), and the alternative — inventing an id locally — is
 * precisely the guessed identity prd2 exists to remove. If nothing answers,
 * this throws with a message saying what to start, because a lane dispatched
 * with no instance id would export telemetry the receiver then refuses.
 */
export async function fetchInstanceId(
  port: number,
  options: FetchInstanceIdOptions = {},
): Promise<string> {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const url = metaUrl(port)

  let response: Response
  try {
    response = await fetchImpl(url)
  } catch (err) {
    throw new Error(unreachable(port, err instanceof Error ? err.message : String(err)))
  }
  if (!response.ok) {
    throw new Error(unreachable(port, `${url} answered HTTP ${response.status}`))
  }

  let body: unknown
  try {
    body = await response.json()
  } catch (err) {
    throw new Error(unreachable(port, `${url} did not answer JSON: ${err instanceof Error ? err.message : String(err)}`))
  }

  const sessionId = typeof body === 'object' && body !== null ? (body as { sessionId?: unknown }).sessionId : undefined
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error(unreachable(port, `${url} reported no session id — is an Rhizomorph really listening there?`))
  }
  return sessionId
}

function unreachable(port: number, detail: string): string {
  return `cannot read this Rhizomorph's instance id on port ${port}: ${detail}
Start the server first (\`npm start -- --port ${port}\`) — \`rhizomorph env\` reads the id from its /api/meta, and the receiver refuses telemetry that doesn't carry it.`
}
