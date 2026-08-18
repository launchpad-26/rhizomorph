import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  CLAUDE_METRIC_PROFILE,
  GEMINI_METRIC_PROFILE,
  resolveMetricProfile,
} from './harness-profiles.js'
import type { OtlpKeyValue } from './types.js'

function attrs(pairs: Record<string, string>): OtlpKeyValue[] {
  return Object.entries(pairs).map(([key, stringValue]) => ({ key, value: { stringValue } }))
}

describe('resolveMetricProfile', () => {
  it('resolves claude-code by service.name', () => {
    const result = resolveMetricProfile(attrs({ 'service.name': 'claude-code' }))
    expect(result).toEqual({ profile: CLAUDE_METRIC_PROFILE, recognized: true })
  })

  it('resolves gemini-cli by service.name', () => {
    const result = resolveMetricProfile(attrs({ 'service.name': 'gemini-cli' }))
    expect(result).toEqual({ profile: GEMINI_METRIC_PROFILE, recognized: true })
  })

  it('defaults to claude\'s profile, unrecognised, when service.name is absent', () => {
    const result = resolveMetricProfile(undefined)
    expect(result).toEqual({ profile: CLAUDE_METRIC_PROFILE, recognized: false })
  })

  it('defaults to claude\'s profile, unrecognised, for a service.name no row matches', () => {
    const result = resolveMetricProfile(attrs({ 'service.name': 'some-future-cli' }))
    expect(result).toEqual({ profile: CLAUDE_METRIC_PROFILE, recognized: false })
  })
})

/**
 * ADR-0025's own done-when: a harness's records must not be recognised by
 * name without a fixture proving that name exists. Grep-law style, over the
 * real fixture bytes on disk — the same posture `fixture-hygiene-law.test.ts`
 * takes — so a profile row invented from documentation rather than a capture
 * fails this test, not just a human's review.
 */
describe('law: every profile row is backed by a real fixture', () => {
  const FIXTURES_DIR = fileURLToPath(new URL('./fixtures', import.meta.url))

  function fixtureServiceNamesAndMetrics(): Array<{ serviceName: string | undefined; metricNames: string[] }> {
    const rows: Array<{ serviceName: string | undefined; metricNames: string[] }> = []
    for (const name of readdirSync(FIXTURES_DIR)) {
      if (!name.endsWith('.json')) continue
      const parsed: unknown = JSON.parse(readFileSync(`${FIXTURES_DIR}/${name}`, 'utf8'))
      if (typeof parsed !== 'object' || parsed === null || !('resourceMetrics' in parsed)) continue
      const resourceMetrics = (parsed as { resourceMetrics: unknown }).resourceMetrics
      if (!Array.isArray(resourceMetrics)) continue
      for (const rm of resourceMetrics) {
        const resourceAttrs = (rm as { resource?: { attributes?: OtlpKeyValue[] } }).resource?.attributes
        const serviceName = resourceAttrs?.find((a) => a.key === 'service.name')?.value?.stringValue
        const metricNames: string[] = []
        for (const sm of (rm as { scopeMetrics?: Array<{ metrics?: Array<{ name: string }> }> }).scopeMetrics ?? []) {
          for (const m of sm.metrics ?? []) metricNames.push(m.name)
        }
        rows.push({ serviceName, metricNames })
      }
    }
    return rows
  }

  it('the fixtures directory actually has metrics bodies to check — the sweep below would pass vacuously otherwise', () => {
    expect(fixtureServiceNamesAndMetrics().length).toBeGreaterThan(0)
  })

  it.each([CLAUDE_METRIC_PROFILE, GEMINI_METRIC_PROFILE])(
    '$serviceName: a real fixture declares this service.name and sends its tokenUsageMetric',
    (profile) => {
      const rows = fixtureServiceNamesAndMetrics()
      const backing = rows.find(
        (row) => row.serviceName === profile.serviceName && row.metricNames.includes(profile.tokenUsageMetric),
      )
      expect(backing).toBeDefined()
    },
  )
})
