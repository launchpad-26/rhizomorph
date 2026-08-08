import { afterEach, describe, expect, it } from 'vitest'
import { CAPABILITY_META_NAME, CAPABILITY_TOKEN_HEADER, readCapabilityToken } from './capability.js'

/**
 * The one place the browser reads the token `server/static.ts` stamps into
 * `index.html` (issue #249). No real fetch is involved here — just the DOM
 * read — so `label.test.ts` covers what happens once a token is or isn't
 * found.
 */
describe('the two constants duplicated across the browser-safe boundary', () => {
  /**
   * `CAPABILITY_META_NAME` here and `static.ts`'s own copy, and
   * `CAPABILITY_TOKEN_HEADER` here and `api/security.ts`'s own copy, are
   * genuinely two separate constants — there is no shared package to import
   * a single one from (docs/adr/0012's Consequences names this cost
   * explicitly). Editing one side alone would otherwise fail silently: every
   * test in this file still passes, `readCapabilityToken()` just returns
   * null on every real boot, and #249 is back. Pinning both literal strings
   * here — and their mirror in `api/security.test.ts` /
   * `server/static.test.ts` — turns that silent drift into a failing test on
   * whichever side changed.
   */
  it('pins the exact literal strings the server side must independently match', () => {
    expect(CAPABILITY_META_NAME).toBe('rhizomorph-capability')
    expect(CAPABILITY_TOKEN_HEADER).toBe('x-rhizomorph-capability')
  })
})

describe('readCapabilityToken', () => {
  afterEach(() => {
    for (const meta of document.querySelectorAll(`meta[name="${CAPABILITY_META_NAME}"]`)) {
      meta.remove()
    }
  })

  it('reads the token off a meta tag shaped exactly as static.ts writes it', () => {
    const meta = document.createElement('meta')
    meta.setAttribute('name', CAPABILITY_META_NAME)
    meta.setAttribute('content', 'abc123')
    document.head.appendChild(meta)

    expect(readCapabilityToken()).toBe('abc123')
  })

  it('returns null when the page never got a token — no meta tag at all', () => {
    expect(readCapabilityToken()).toBeNull()
  })

  it('returns null for a meta tag with an empty content attribute', () => {
    const meta = document.createElement('meta')
    meta.setAttribute('name', CAPABILITY_META_NAME)
    meta.setAttribute('content', '')
    document.head.appendChild(meta)

    expect(readCapabilityToken()).toBeNull()
  })

  it('accepts an injected document, not only the global one', () => {
    const doc = document.implementation.createHTMLDocument('test')
    const meta = doc.createElement('meta')
    meta.setAttribute('name', CAPABILITY_META_NAME)
    meta.setAttribute('content', 'injected-token')
    doc.head.appendChild(meta)

    expect(readCapabilityToken(doc)).toBe('injected-token')
  })
})
