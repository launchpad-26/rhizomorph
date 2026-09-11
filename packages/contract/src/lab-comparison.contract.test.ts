import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fetchComparison } from '@rhizomorph/web/recordings/comparisons'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildContractHarness,
  type ContractHarness,
  routeGlobalFetchThroughHarness,
  stripCapabilityToken,
  tamperCapabilityToken,
} from './harness.js'

const ID = '00000000-0000-4000-8000-000000000001'

/**
 * `/api/lab/comparisons/:id`'s (the READ) contract test (prd-14 ruling 5,
 * #214). The REAL served page, the REAL `capabilityRead`, the REAL
 * `fetchComparison`, the REAL gate, the REAL artifact on disk — `h.fetch`
 * routed in as `globalThis.fetch`.
 *
 * This is the route this issue's third Definition-of-done bullet names: an
 * artifact from an older format version must answer with the parser's own
 * refusal, by name, as `{ available: false, reason }` rather than a thrown
 * error or a 404 — proven here against a REAL on-disk artifact with an
 * unsupported version, not a mocked response.
 */
describe('contract: a saved comparison, read by id, is gated (prd-14 ruling 5)', () => {
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

  async function writeArtifact(raw: string): Promise<void> {
    const dir = path.join(h.sessionDir, 'comparisons')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, `comparison-${ID}.json`), raw, 'utf8')
  }

  it('succeeds end to end: the token the server stamped is the token the client sends and the gate accepts', async () => {
    const artifact = {
      version: 1,
      savedAt: '2026-09-01T00:00:00.000Z',
      input: { arms: [{ id: 'a1', model: 'opus', brief: 'x', runs: [{ id: 'r1', status: 'complete', verdict: 'pass', value: 4 }] }] },
    }
    await writeArtifact(`${JSON.stringify(artifact, null, 2)}\n`)

    const result = await fetchComparison(ID)

    expect(result).toEqual({ id: ID, available: true, artifact })
  })

  it("an older format version reaches the screen as the parser's own refusal, by name — never a throw, never an empty state", async () => {
    await writeArtifact(JSON.stringify({ version: 3 }))

    const result = await fetchComparison(ID)

    expect(result).toEqual({ id: ID, available: false, reason: 'unsupported comparison artifact version: 3' })
  })

  it('a v2 artifact reads back with its measure, provenance and per-run facts intact (prd14 ruling 6)', async () => {
    const artifact = {
      version: 2,
      savedAt: '2026-09-11T00:00:00.000Z',
      measure: 'cost',
      provenance: { verifyCommand: 'npm test', source: 'compare-cli', measuredAt: 1000 },
      input: { arms: [{ id: 'a1', model: 'opus', brief: 'x', runs: [{ id: 'r1', status: 'complete', verdict: 'pass', cost: 4, duration: 900, commits: 2 }] }] },
    }
    await writeArtifact(`${JSON.stringify(artifact, null, 2)}\n`)

    const result = await fetchComparison(ID)

    expect(result).toEqual({ id: ID, available: true, artifact })
  })

  it('a tampered token is refused by the real gate', async () => {
    tamperCapabilityToken()

    await expect(fetchComparison(ID)).rejects.toThrow(/responded 401/)
  })

  it('a page served without the token still reaches the wire bare, and the server answers its own honest 401 (ADR-0012 dev gap)', async () => {
    stripCapabilityToken()

    await expect(fetchComparison(ID)).rejects.toThrow(/responded 401/)
  })
})
