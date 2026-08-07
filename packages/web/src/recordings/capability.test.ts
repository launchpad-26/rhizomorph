import { afterEach, describe, expect, it } from 'vitest'
import { CAPABILITY_META_NAME, readCapabilityToken } from './capability.js'

/**
 * The one place the browser reads the token `server/static.ts` stamps into
 * `index.html` (issue #249). No real fetch is involved here — just the DOM
 * read — so `label.test.ts` covers what happens once a token is or isn't
 * found.
 */
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
