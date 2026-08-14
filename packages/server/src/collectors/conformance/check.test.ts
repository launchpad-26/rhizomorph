import { SIGNALS, findUnbackedProvidedSignals, type AdapterCapabilities, type SignalObservations } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'

function allObserved(emitted: boolean): SignalObservations {
  const observed = {} as SignalObservations
  for (const signal of SIGNALS) observed[signal] = { emitted, detail: emitted ? 'seen' : 'never seen' }
  return observed
}

function allDeclared(level: 'provided' | 'partial' | 'absent'): AdapterCapabilities {
  const capabilities = {} as AdapterCapabilities
  for (const signal of SIGNALS) {
    capabilities[signal] = level === 'provided' ? { level } : { level, reason: 'test fixture' }
  }
  return capabilities
}

describe('findUnbackedProvidedSignals — ADR-0010\'s declared-vs-emitted check', () => {
  it('finds nothing when every "provided" signal was observed', () => {
    expect(findUnbackedProvidedSignals(allDeclared('provided'), allObserved(true))).toEqual([])
  })

  it('names every "provided" signal with no observed evidence', () => {
    const result = findUnbackedProvidedSignals(allDeclared('provided'), allObserved(false))
    expect(result).toHaveLength(SIGNALS.length)
    expect(result).toContain('cost: declared provided, but never seen')
  })

  it('never flags a "partial" or "absent" declaration, however little evidence exists — those levels are not this law\'s to grade', () => {
    expect(findUnbackedProvidedSignals(allDeclared('partial'), allObserved(false))).toEqual([])
    expect(findUnbackedProvidedSignals(allDeclared('absent'), allObserved(false))).toEqual([])
  })

  it('is precise about which signal lied when only one is unbacked', () => {
    const capabilities = allDeclared('provided')
    const observed = allObserved(true)
    observed.cost = { emitted: false, detail: 'no llm.cost event was observed' }

    expect(findUnbackedProvidedSignals(capabilities, observed)).toEqual([
      'cost: declared provided, but no llm.cost event was observed',
    ])
  })
})
