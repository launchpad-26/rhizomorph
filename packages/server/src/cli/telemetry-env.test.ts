import { describe, expect, it } from 'vitest'
import { otlpEndpoint, renderTelemetryEnv } from './telemetry-env.js'

describe('renderTelemetryEnv', () => {
  it('emits an exportable env block pointed at this server\'s OTLP receiver', () => {
    const block = renderTelemetryEnv({ lane: 'test-lane', role: 'worker', port: 4321 })

    expect(block).toContain('export CLAUDE_CODE_ENABLE_TELEMETRY=1')
    expect(block).toContain('export OTEL_METRICS_EXPORTER=otlp')
    expect(block).toContain('export OTEL_LOGS_EXPORTER=otlp')
    expect(block).toContain('export OTEL_EXPORTER_OTLP_PROTOCOL=http/json')
    expect(block).toContain('export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4321')
    expect(block).toContain('export OTEL_RESOURCE_ATTRIBUTES=lane=test-lane,role=worker')
  })

  it('carries the role through for a conductor', () => {
    const block = renderTelemetryEnv({ lane: 'conductor', role: 'conductor', port: 9000 })
    expect(block).toContain('export OTEL_RESOURCE_ATTRIBUTES=lane=conductor,role=conductor')
    expect(block).toContain('export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:9000')
  })
})

describe('otlpEndpoint', () => {
  it('builds the base endpoint the OTel SDK appends /v1/metrics and /v1/logs to', () => {
    expect(otlpEndpoint(4321)).toBe('http://127.0.0.1:4321')
  })
})
