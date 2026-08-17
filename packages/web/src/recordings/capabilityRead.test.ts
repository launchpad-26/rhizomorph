import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CAPABILITY_META_NAME } from './capability.js'
import { capabilityRead } from './capabilityRead.js'

/**
 * `capabilityRead` is the one place the SPA's reads attach the capability
 * token (prd-29 ruling 1 / ADR-0024). It reads the token off the page's meta
 * tag (`recordings/capability.ts`) and calls the real `globalThis.fetch`, so
 * these tests stub `globalThis.fetch` and assert what header it was handed.
 */
describe('capabilityRead — the shared read header (prd-29)', () => {
  const realFetch = globalThis.fetch

  function stubFetch() {
    const spy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: 200 }))
    globalThis.fetch = spy as unknown as typeof fetch
    return spy
  }

  function setToken(value: string | null) {
    document.head.innerHTML = ''
    if (value !== null) {
      const meta = document.createElement('meta')
      meta.setAttribute('name', CAPABILITY_META_NAME)
      meta.setAttribute('content', value)
      document.head.appendChild(meta)
    }
  }

  function headerOf(spy: ReturnType<typeof stubFetch>, call: number): string | null {
    const init = spy.mock.calls[call]?.[1]
    return new Headers(init?.headers).get('x-rhizomorph-capability')
  }

  beforeEach(() => setToken(null))
  afterEach(() => {
    globalThis.fetch = realFetch
    document.head.innerHTML = ''
  })

  it('sends the capability header carrying the page token when the meta tag is present', async () => {
    setToken('deadbeef')
    const spy = stubFetch()

    await capabilityRead('/api/sessions')

    expect(spy).toHaveBeenCalledOnce()
    expect(spy.mock.calls[0]?.[0]).toBe('/api/sessions')
    expect(headerOf(spy, 0)).toBe('deadbeef')
  })

  it('sends the request bare when the page carries no token — the server answers its own 401 (ADR-0012 dev gap)', async () => {
    // No meta tag (beforeEach cleared it) — vite dev serves index.html this way.
    const spy = stubFetch()

    await capabilityRead('/api/lanes')

    expect(spy).toHaveBeenCalledOnce()
    expect(headerOf(spy, 0)).toBeNull()
  })

  it('carries the header on every call, not just the first — a polled read stays gated (repetition)', async () => {
    setToken('token-1234')
    const spy = stubFetch()

    await capabilityRead('/api/transcript/lane-a')
    await capabilityRead('/api/transcript/lane-a')
    await capabilityRead('/api/lab/estimate?lane=x&arms=2')

    expect(spy).toHaveBeenCalledTimes(3)
    expect(headerOf(spy, 0)).toBe('token-1234')
    expect(headerOf(spy, 1)).toBe('token-1234')
    expect(headerOf(spy, 2)).toBe('token-1234')
  })

  it('keeps a caller-supplied init field that is not `headers` when it adds the header', async () => {
    setToken('tok')
    const spy = stubFetch()

    await capabilityRead('/api/sessions', { cache: 'no-store' })

    const init = spy.mock.calls[0]?.[1]
    expect(init?.cache).toBe('no-store')
    expect(headerOf(spy, 0)).toBe('tok')
  })

  it('REPLACES a caller-supplied headers block rather than merging it — the law forbids the merge', async () => {
    // The narrow claim above ("keeps a caller-supplied init field") is true of
    // every field EXCEPT `headers`, and the test proving it used `cache`, which
    // passes whether headers are merged or replaced. So the one field with
    // surprising behaviour was the one field unpinned.
    //
    // Replacement is deliberate: `replay/mutating-calls-law.test.ts`'s
    // `assertHeaderBlocksExact` refuses a spread inside a `headers:` block
    // outright, so merging the caller's headers here is the exact shape that
    // law forbids. This test pins the consequence, so that a future seam
    // needing its own header meets a red test rather than a header that
    // silently vanished on the wire.
    setToken('tok')
    const spy = stubFetch()

    await capabilityRead('/api/sessions', { headers: { Accept: 'application/json' } })

    const sent = new Headers(spy.mock.calls[0]?.[1]?.headers)
    expect(sent.get('x-rhizomorph-capability')).toBe('tok')
    expect(sent.get('Accept')).toBeNull()
  })

  it('no read seam relies on passing its own header — the constraint above costs nothing today', () => {
    // The pin is only harmless while nothing needs it. Every read seam calls
    // its `fetchImpl` with a URL and no `init` at all; this asserts that, so
    // the day a seam grows a second argument, this says so.
    const seams = [
      'lab/api.ts',
      'lab/launch/estimate.ts',
      'recordings/api.ts',
      'recordings/export.ts',
      'replay/api.ts',
      'drawer/useTranscript.ts',
      'fleet/manifest.ts',
      'lane-page/LanePage.tsx',
    ]
    const webSrc = path.resolve(__dirname, '..')
    const offenders = seams.filter((seam) => {
      const text = readFileSync(path.join(webSrc, seam), 'utf8')
      // A `fetchImpl(...)`/`fetchTranscript(...)` call carrying a second argument.
      return /\bfetch(?:Impl|Transcript)\s*\([^)]*,/.test(text)
    })
    expect(offenders).toEqual([])
  })
})
