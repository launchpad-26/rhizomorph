import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fetchComparisons } from '@rhizomorph/web/recordings/comparisons'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildContractHarness,
  type ContractHarness,
  routeGlobalFetchThroughHarness,
  stripCapabilityToken,
  tamperCapabilityToken,
} from './harness.js'

/**
 * `/api/lab/comparisons`'s (the LIST) contract test (prd-14 ruling 5, #214).
 * The REAL served page, the REAL `capabilityRead`, the REAL
 * `fetchComparisons`, the REAL gate, the REAL `comparisons/` directory the
 * server's own store reads (`packages/server/src/comparisons/store.ts`) —
 * `h.fetch` routed in as `globalThis.fetch`.
 *
 * A refused row is exercised too, not only the happy path: an unknown
 * `version` on disk is exactly what an artifact from an older format would
 * carry, and this proves the list's own refusal reaches the client as
 * `{ available: false, reason }` rather than being dropped from the array.
 */
describe('contract: the saved-comparisons listing is gated (prd-14 ruling 5)', () => {
  let h: ContractHarness
  let restoreFetch: () => void

  beforeEach(async () => {
    h = await buildContractHarness()
    restoreFetch = routeGlobalFetchThroughHarness(h.fetch)
  })

  afterEach(async () => {
    restoreFetch()
    await h.close()
  })

  it('succeeds end to end: the token the server stamped is the token the client sends and the gate accepts', async () => {
    // No comparison has ever been saved in this harness's fresh session
    // dir — a real, honest empty list is exactly what the real route folds
    // to, and this proves the request reached it rather than being refused.
    const comparisons = await fetchComparisons()

    expect(comparisons).toEqual([])
  })

  it('an available comparison and a refused one are both listed, each in the shape the client expects', async () => {
    const dir = path.join(h.sessionDir, 'comparisons')
    await mkdir(dir, { recursive: true })
    const artifact = {
      version: 1,
      savedAt: '2026-09-01T00:00:00.000Z',
      input: { arms: [{ id: 'a1', model: 'opus', brief: 'x', runs: [{ id: 'r1', status: 'complete', verdict: 'pass', value: 4 }] }] },
    }
    await writeFile(
      path.join(dir, 'comparison-00000000-0000-4000-8000-000000000001.json'),
      `${JSON.stringify(artifact, null, 2)}\n`,
      'utf8',
    )
    await writeFile(
      path.join(dir, 'comparison-00000000-0000-4000-8000-000000000002.json'),
      JSON.stringify({ version: 2 }),
      'utf8',
    )

    const comparisons = await fetchComparisons()

    expect(comparisons).toEqual([
      { id: '00000000-0000-4000-8000-000000000001', sizeBytes: expect.any(Number), available: true, savedAt: '2026-09-01T00:00:00.000Z', arms: 1 },
      {
        id: '00000000-0000-4000-8000-000000000002',
        sizeBytes: expect.any(Number),
        available: false,
        reason: 'unsupported comparison artifact version: 2',
      },
    ])
  })

  it('a tampered token is refused by the real gate', async () => {
    tamperCapabilityToken()

    await expect(fetchComparisons()).rejects.toThrow(/responded 401/)
  })

  it('a page served without the token still reaches the wire bare, and the server answers its own honest 401 (ADR-0012 dev gap)', async () => {
    stripCapabilityToken()

    await expect(fetchComparisons()).rejects.toThrow(/responded 401/)
  })
})
