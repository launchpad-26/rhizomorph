import { describe, expect, it } from 'vitest'
import { loadCollectors } from './collector-loader.js'

describe('loadCollectors', () => {
  it('returns an empty list when no collectors/* directories are merged yet, without warning', async () => {
    const warnings: string[] = []
    const collectors = await loadCollectors({ warn: (m) => warnings.push(m) })

    expect(collectors).toEqual([])
    expect(warnings).toEqual([])
  })
})
