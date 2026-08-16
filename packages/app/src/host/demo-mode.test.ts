import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEMO_LABEL, STREAM_SOURCE_KEY, type DemoSource } from './demo-mode.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const STREAM_CONTEXT = path.join(REPO_ROOT, 'packages', 'web', 'src', 'app', 'StreamContext.tsx')

/**
 * THE HONESTY LAW for a second statement of a fact the page owns. The tray
 * drives demo mode by pressing the page's own key; if the page ever rebinds
 * them, this map becomes three menu items that do nothing — a silent failure,
 * on the one surface prd-34 ruling 5 puts a stranger's first impression on.
 */
describe('the keys are the page\'s own (#564)', () => {
  const source = readFileSync(STREAM_CONTEXT, 'utf8')
  const declaration = /export const STREAM_SOURCE_KEYS: Record<string, StreamSource> = \{([^}]*)\}/.exec(source)

  it('found the page\'s binding to read', () => {
    expect(declaration).not.toBeNull()
    expect(declaration?.[1]).toContain("'live'")
  })

  it('binds each source to the key the page binds it to', () => {
    const bindings = new Map<string, string>()
    for (const match of (declaration?.[1] ?? '').matchAll(/'(\d)':\s*'([a-z0-9]+)'/g)) {
      const [, key, sourceId] = match
      if (key !== undefined && sourceId !== undefined) bindings.set(sourceId, key)
    }

    expect(bindings.size).toBe(3)
    for (const [sourceId, key] of bindings) {
      expect(STREAM_SOURCE_KEY[sourceId as DemoSource]).toBe(key)
    }
  })

  it('knows the same three sources the page knows, and no fourth', () => {
    expect(Object.keys(STREAM_SOURCE_KEY).sort()).toEqual(['fleet20', 'live', 'pathology'])
  })

  it('would fail if the page rebound a key', () => {
    // The mutation, stated: were the page to bind `fleet20` to `4`, the loop
    // above would compare `'2'` against `'4'` and go red naming it. Nothing
    // here is asserted against a constant of this file's own choosing.
    expect(STREAM_SOURCE_KEY.fleet20).toBe('2')
    expect(source).toContain("'2': 'fleet20'")
  })
})

describe('the page still listens for those keys', () => {
  const source = readFileSync(STREAM_CONTEXT, 'utf8')

  it('binds them to a keydown listener on the window, which is what a synthetic key reaches', () => {
    expect(source).toContain("window.addEventListener('keydown', onKeyDown)")
    expect(source).toContain('STREAM_SOURCE_KEYS[event.key]')
  })

  it('ignores a modified keypress — so the shell must send an unmodified one', () => {
    expect(source).toContain('if (event.altKey || event.ctrlKey || event.metaKey) return')
  })
})

describe('the labels', () => {
  it('name each source without ranking them, and say which are simulated', () => {
    expect(DEMO_LABEL.fleet20).toMatch(/lanes/i)
    expect(DEMO_LABEL.pathology).toMatch(/staged/i)
    expect(DEMO_LABEL.live).toMatch(/live/i)
  })
})
