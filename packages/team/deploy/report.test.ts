import { describe, expect, it } from 'vitest'
import { formatBootReport } from './report.js'

describe('formatBootReport', () => {
  it('happy path (first boot): names what applied, and never claims nothing to do', () => {
    const line = formatBootReport({ applied: ['0001_events'], alreadyApplied: [] })
    expect(line).toContain('1 applied (0001_events)')
    expect(line).not.toContain('nothing to do')
  })

  it("the DoD's actual claim (second boot): a no-op run says so, by name", () => {
    const line = formatBootReport({
      applied: [],
      alreadyApplied: ['0001_events', '0002_projections', '0003_roles_rls', '0004_events_dedup'],
    })
    expect(line).toContain('0 applied')
    expect(line).toContain('nothing to do')
    expect(line).toContain('0001_events')
    expect(line).toContain('0002_projections')
    expect(line).toContain('0003_roles_rls')
    expect(line).toContain('0004_events_dedup')
  })

  it('failure/edge path: zero migrations either way still renders a sane line', () => {
    const line = formatBootReport({ applied: [], alreadyApplied: [] })
    expect(line).toBe('migrations: 0 applied, 0 already applied — nothing to do')
  })

  it('repetition: calling it twice with the same input returns the identical string', () => {
    const report = { applied: [], alreadyApplied: ['0001_events'] }
    expect(formatBootReport(report)).toBe(formatBootReport(report))
  })
})
