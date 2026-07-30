import type { AgentRole } from '@observatory/core'

/**
 * Renders the exact env block a lane (or the conductor) needs so its `claude`
 * process exports OTLP/HTTP JSON straight to this server's receiver
 * (`packages/server/src/api/otel.ts`, routes registered at the app root).
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is the *base* endpoint — the OTel SDK appends
 * `/v1/metrics` and `/v1/logs` itself, which is exactly where those routes
 * live. Export intervals are shortened from the SDK's 60s default so the
 * spend ticker reads as live, not stale (research note §S1 used the same
 * env vars, just shorter still, for a one-shot `-p` capture).
 */
export interface TelemetryEnvOptions {
  lane: string
  role: AgentRole
  port: number
}

const METRIC_EXPORT_INTERVAL_MS = 5000
const LOGS_EXPORT_INTERVAL_MS = 2000

export function otlpEndpoint(port: number): string {
  return `http://127.0.0.1:${port}`
}

export function renderTelemetryEnv({ lane, role, port }: TelemetryEnvOptions): string {
  const vars: Array<[string, string]> = [
    ['CLAUDE_CODE_ENABLE_TELEMETRY', '1'],
    ['OTEL_METRICS_EXPORTER', 'otlp'],
    ['OTEL_LOGS_EXPORTER', 'otlp'],
    ['OTEL_EXPORTER_OTLP_PROTOCOL', 'http/json'],
    ['OTEL_EXPORTER_OTLP_ENDPOINT', otlpEndpoint(port)],
    ['OTEL_METRIC_EXPORT_INTERVAL', String(METRIC_EXPORT_INTERVAL_MS)],
    ['OTEL_LOGS_EXPORT_INTERVAL', String(LOGS_EXPORT_INTERVAL_MS)],
    ['OTEL_RESOURCE_ATTRIBUTES', `lane=${lane},role=${role}`],
  ]

  return `${vars.map(([key, value]) => `export ${key}=${value}`).join('\n')}\n`
}
