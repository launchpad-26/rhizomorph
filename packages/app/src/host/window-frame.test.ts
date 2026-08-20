import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { startsHidden, windowFrame, WINDOW_DEFAULT, WINDOW_GROUND, WINDOW_MINIMUM } from './window-frame.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

describe('the frame', () => {
  it('opens at S5\'s primary size and refuses to go below its comfortable floor', () => {
    const frame = windowFrame()
    expect(frame.width).toBe(1440)
    expect(frame.height).toBe(900)
    expect(frame.minWidth).toBe(1100)
    expect(frame.minHeight).toBe(700)
  })

  it('opens hidden, on the instrument\'s own ground — no white frame while the SPA boots', () => {
    const frame = windowFrame()
    expect(frame.show).toBe(false)
    expect(frame.backgroundColor).toBe(WINDOW_GROUND)
  })

  it('lets a caller override without losing the floor it did not mention', () => {
    const frame = windowFrame({ width: 1600 })
    expect(frame.width).toBe(1600)
    expect(frame.minWidth).toBe(WINDOW_MINIMUM.width)
  })

  it('never opens below its own minimum', () => {
    expect(WINDOW_DEFAULT.width).toBeGreaterThanOrEqual(WINDOW_MINIMUM.width)
    expect(WINDOW_DEFAULT.height).toBeGreaterThanOrEqual(WINDOW_MINIMUM.height)
  })
})

/**
 * #563: "the window's minimum size matches prd-32 **S5**'s floor". The only way
 * to make that checkable rather than claimed is to read S5 itself — a copied
 * number in a comment is exactly the drift this repo keeps catching, and a test
 * asserting `1100 === 1100` would survive prd-32 changing its mind.
 */
describe('the floor is prd-32 S5\'s own, read from S5 (#563)', () => {
  const prd = readFileSync(path.join(REPO_ROOT, 'docs', 'prds', 'prd-32-the-readable-instrument.md'), 'utf8')
  const section = prd.slice(prd.indexOf('### S5 — the window'))

  it('found S5 to read', () => {
    expect(section.startsWith('### S5 — the window')).toBe(true)
    expect(section).toContain('below minimum')
  })

  it('takes the comfortable floor from the PRD\'s own prose', () => {
    const match = /comfortable\*?\s*\(≥(\d+)×(\d+)/.exec(section)
    expect(match).not.toBeNull()
    expect(Number(match?.[1])).toBe(WINDOW_MINIMUM.width)
    expect(Number(match?.[2])).toBe(WINDOW_MINIMUM.height)
  })

  it('takes the primary size from the PRD\'s own prose', () => {
    const match = /primary\*?\s*\(≥(\d+)×(\d+)/.exec(section)
    expect(match).not.toBeNull()
    expect(Number(match?.[1])).toBe(WINDOW_DEFAULT.width)
    expect(Number(match?.[2])).toBe(WINDOW_DEFAULT.height)
  })
})

describe('the ground is the instrument\'s own token, not a shell invention', () => {
  it('is `--color-ice-1000` from the web theme, verbatim', () => {
    const theme = readFileSync(path.join(REPO_ROOT, 'packages', 'web', 'src', 'theme', 'theme.css'), 'utf8')
    const match = /--color-ice-1000:\s*(#[0-9a-fA-F]{3,8})/.exec(theme)
    expect(match).not.toBeNull()
    expect(match?.[1]?.toLowerCase()).toBe(WINDOW_GROUND.toLowerCase())
  })
})

describe('a login-item launch comes up to the tray', () => {
  it('honours --hidden', () => {
    expect(startsHidden(['/usr/bin/rhizomorph', '--hidden'])).toBe(true)
  })

  it('shows a window for every ordinary launch', () => {
    expect(startsHidden(['/usr/bin/rhizomorph'])).toBe(false)
    expect(startsHidden(['electron', 'dist/main.js'])).toBe(false)
  })

  it('matches a whole argument, so a path containing the characters does not suppress the window', () => {
    // The failure this prevents: someone keeps a worktree at
    // `/home/operator/repos/--hidden-work` and the app silently stops opening.
    expect(startsHidden(['/usr/bin/rhizomorph', '/home/operator/--hidden-work'])).toBe(false)
    expect(startsHidden(['/usr/bin/rhizomorph', '--hidden-extra'])).toBe(false)
  })

  it('is the same flag the autostart entry writes — the two are one edit', () => {
    // `login-item.ts` puts `--hidden` in the `.desktop` file's Exec line. If
    // these two ever disagree, the login item launches a window at someone who
    // just logged in, and nothing fails.
    const loginItem = readFileSync(path.join(REPO_ROOT, 'packages', 'app', 'src', 'host', 'login-item.ts'), 'utf8')
    expect(loginItem).toContain('--hidden')
  })
})
