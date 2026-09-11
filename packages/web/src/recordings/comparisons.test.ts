import { describe, expect, it } from 'vitest'
import { fetchComparison, fetchComparisons, type FetchLike } from './comparisons.js'

const AVAILABLE_ROW = { id: '1000', sizeBytes: 512, available: true, savedAt: '2026-09-01T00:00:00.000Z', arms: 2 }
const REFUSED_ROW = { id: '2000', sizeBytes: 64, available: false, reason: 'unsupported comparison artifact version: 2' }

const ARTIFACT = {
  version: 1,
  savedAt: '2026-09-01T00:00:00.000Z',
  input: { arms: [{ id: 'a1', model: 'opus', brief: 'x', runs: [{ id: 'r1', status: 'complete', verdict: 'pass', value: 4 }] }] },
}

function answering(payload: unknown, status = 200): FetchLike {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  })) as unknown as FetchLike
}

describe('fetchComparisons', () => {
  it('parses the listing GET /api/lab/comparisons serves, both an available row and a refused one', async () => {
    const rows = await fetchComparisons(answering({ comparisons: [AVAILABLE_ROW, REFUSED_ROW] }))
    expect(rows).toEqual([AVAILABLE_ROW, REFUSED_ROW])
  })

  it('throws with the status on a non-ok response (a gate refusal), never a silently empty list', async () => {
    await expect(fetchComparisons(answering({ error: 'nope' }, 401))).rejects.toThrow('/api/lab/comparisons responded 401')
  })

  it('throws on a shape it does not recognise rather than rendering it half-formed', async () => {
    await expect(fetchComparisons(answering({ comparisons: [{ id: '1000' }] }))).rejects.toThrow(
      '/api/lab/comparisons returned a shape this library does not recognise',
    )
  })

  /**
   * Review round 2 (finding 2): a response with no `comparisons` array at
   * all used to resolve to `[]` — identical to a real, honest "nothing saved
   * yet" library. That is a worse defect than a malformed ROW (which already
   * threw), not a milder one: it hides a broken server response inside the
   * one state this issue is built around never rendering silently. Both
   * axes now agree — fail closed, exactly like a malformed row.
   */
  it('throws when the response carries no comparisons array at all — never silently read as an empty library', async () => {
    await expect(fetchComparisons(answering({}))).rejects.toThrow(
      '/api/lab/comparisons returned a shape this library does not recognise',
    )
  })

  it('a real empty library is still exactly [] — the fix above narrows malformed responses, not this one', async () => {
    await expect(fetchComparisons(answering({ comparisons: [] }))).resolves.toEqual([])
  })
})

describe('fetchComparison', () => {
  it('parses an available artifact by id', async () => {
    const result = await fetchComparison('1000', answering({ id: '1000', available: true, artifact: ARTIFACT }))
    expect(result).toEqual({ id: '1000', available: true, artifact: ARTIFACT })
  })

  it("resolves to available:false with the server's own reason — never a throw", async () => {
    const result = await fetchComparison(
      '2000',
      answering({ id: '2000', available: false, reason: 'unsupported comparison artifact version: 2' }),
    )
    expect(result).toEqual({ id: '2000', available: false, reason: 'unsupported comparison artifact version: 2' })
  })

  /**
   * The mutation this test survives, and the one it does not: a version the
   * SERVER accepted but that THIS client's own parser refuses (a client built
   * against an older shape than the server it's talking to) resolves to the
   * exact same `available: false` shape a server-side refusal does — the
   * sibling case this issue's Definition of done names, proven rather than
   * assumed. A parser that instead threw here would still pass every OTHER
   * test in this file; only this one would catch it.
   */
  it("a version this client's own parser refuses — even one the server called available — resolves the same way a server-side refusal does", async () => {
    const result = await fetchComparison('3000', answering({ id: '3000', available: true, artifact: { version: 2 } }))
    expect(result).toEqual({ id: '3000', available: false, reason: 'unsupported comparison artifact version: 2' })
  })

  it('throws with the status on a non-ok response (a gate refusal), never swallowed', async () => {
    await expect(fetchComparison('1000', answering({ error: 'nope' }, 401))).rejects.toThrow(
      '/api/lab/comparisons/1000 responded 401',
    )
  })

  it('throws on a shape it does not recognise', async () => {
    await expect(fetchComparison('1000', answering({ nope: true }))).rejects.toThrow(
      '/api/lab/comparisons/:id returned a shape this library does not recognise',
    )
  })
})
