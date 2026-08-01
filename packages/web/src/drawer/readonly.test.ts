import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * THE READ-ONLY CONSTITUTION, ASSERTED AT THE LEVEL OF THE SOURCE TEXT.
 *
 * "The Observatory never sends keys" (ruling 17) is not a property any single
 * behavioural test can prove — a POST added tomorrow in a branch nothing
 * renders would pass every one of them. So this file greps its own directory
 * instead: whatever the drawer grows into, it may issue GETs and nothing else,
 * and it may not reach for a way to run a command.
 *
 * The check is deliberately crude and deliberately loud. A future issue that
 * legitimately needs a POST will fail here and have to say so in a diff a
 * reviewer reads — which is exactly the conversation the constitution deserves.
 */

const DRAWER_DIR = path.dirname(fileURLToPath(import.meta.url))

function sourceFiles(): { name: string; text: string }[] {
  return readdirSync(DRAWER_DIR)
    .filter((name) => /\.(ts|tsx)$/.test(name))
    .filter((name) => !name.endsWith('.test.ts') && !name.endsWith('.test.tsx'))
    .map((name) => ({ name, text: readFileSync(path.join(DRAWER_DIR, name), 'utf8') }))
}

describe('the drawer sends only GETs', () => {
  it('has source files to check at all — an empty grep proves nothing', () => {
    expect(sourceFiles().length).toBeGreaterThan(4)
  })

  it('names no HTTP verb but GET', () => {
    for (const file of sourceFiles()) {
      expect(file.text, `${file.name} names a mutating HTTP verb`).not.toMatch(
        /\b(?:POST|PUT|PATCH|DELETE)\b/,
      )
    }
  })

  it('builds no request init at all — `fetch(url)` and nothing more', () => {
    // No init object means no `method`, and therefore no way to be anything but
    // a GET; it also means no body, no headers and no credentials to attach.
    for (const file of sourceFiles()) {
      expect(file.text, `${file.name} builds a request init`).not.toMatch(
        /\b(?:method|headers|credentials)\s*:/,
      )
      expect(file.text, `${file.name} builds a request body`).not.toMatch(
        /FormData|URLSearchParams|JSON\.stringify\(|new Request\(/,
      )
    }
  })

  it('touches no request path but the transcript tail', () => {
    const paths = sourceFiles()
      .flatMap((file) => [...file.text.matchAll(/`?\/api\/[a-z/:${}\-.[\]]+/gi)].map((m) => m[0]))
      .map((match) => match.replace(/^`/, ''))

    expect(paths.length).toBeGreaterThan(0)
    for (const found of paths) {
      expect(found.startsWith('/api/transcript/')).toBe(true)
    }
  })

  it('reaches for no way to execute anything', () => {
    for (const file of sourceFiles()) {
      expect(file.text, `${file.name} reaches for an execution channel`).not.toMatch(
        /child_process|\bexec\s*\(|\bspawn\s*\(|WebSocket|EventSource|sendBeacon|XMLHttpRequest|new Function|\beval\s*\(/,
      )
    }
  })

  it('holds no credential of any kind', () => {
    for (const file of sourceFiles()) {
      expect(file.text, `${file.name} mentions a credential`).not.toMatch(
        /apiKey|api_key|ANTHROPIC_API_KEY|Authorization|Bearer\s/i,
      )
    }
  })

  it('never runs the attach command — it only ever copies the string', () => {
    const attachButton = readFileSync(path.join(DRAWER_DIR, 'AttachButton.tsx'), 'utf8')

    expect(attachButton).toMatch(/clipboard/)
    expect(attachButton).not.toMatch(/tmux|workmux/)
  })
})
