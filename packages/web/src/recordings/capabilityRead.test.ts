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

  it('does not clobber a caller-supplied init when it adds the header', async () => {
    setToken('tok')
    const spy = stubFetch()

    await capabilityRead('/api/sessions', { cache: 'no-store' })

    const init = spy.mock.calls[0]?.[1]
    expect(init?.cache).toBe('no-store')
    expect(headerOf(spy, 0)).toBe('tok')
  })
})
