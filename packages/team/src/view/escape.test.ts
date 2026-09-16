import { describe, expect, it } from 'vitest'
import { escapeHtml } from './escape.js'

describe('#557 — escapeHtml', () => {
  it('escapes the five characters that matter', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;')
  })

  it('a script tag cannot survive it', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('AMPERSANDS ARE NOT DOUBLE-ESCAPED, whatever order the table is written in', () => {
    // Not an ordering claim: `String.replace` with a global regex scans the input once and never
    // re-examines what it emitted, so no substitution can be escaped a second time. Verification
    // found the earlier "& must come first" comment unpinnable — no reordering reddens anything.
    expect(escapeHtml('a & b < c')).toBe('a &amp; b &lt; c')
    expect(escapeHtml('&amp;')).toBe('&amp;amp;')
  })

  it('leaves ordinary text and a real worktree path alone', () => {
    expect(escapeHtml('prd51-w11')).toBe('prd51-w11')
    expect(escapeHtml('/repo-wt/prd51-w11')).toBe('/repo-wt/prd51-w11')
  })

  it('REPETITION — escaping twice is not the same as escaping once, and the caller must not', () => {
    const once = escapeHtml('a & b')
    expect(once).toBe('a &amp; b')
    expect(escapeHtml(once)).toBe('a &amp;amp; b')
  })
})
