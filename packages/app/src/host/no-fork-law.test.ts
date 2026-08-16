import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  auditShell,
  copiedFiles,
  describeFinding,
  forbiddenImports,
  importedModules,
  renderingFiles,
  servingFiles,
  type SourceFile,
} from './no-fork.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

function tracked(prefix: string): string[] {
  const listing = execFileSync('git', ['ls-files', '-z', '--', prefix], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return listing.split('\0').filter((entry) => entry !== '')
}

function read(paths: readonly string[]): SourceFile[] {
  return paths
    .filter((entry) => /\.(m|c)?[jt]sx?$/.test(entry))
    .map((entry) => ({ path: entry, source: readFileSync(path.join(REPO_ROOT, entry), 'utf8') }))
}

const isTest = (file: SourceFile) => /\.test\.[jt]sx?$/.test(file.path)

const SHELL_FILES = read(tracked('packages/app'))
/**
 * The audited set excludes this package's own tests, for one reason and with
 * one consequence stated. The reason: the rigged inputs below are *deliberate*
 * forks — a React import, a Fastify app, a copied file — and a law that audited
 * its own proof would be a law that cannot be proven. The consequence: a fork
 * hidden inside a `.test.ts` file would pass these three detectors. The fourth,
 * {@link renderingFiles}, therefore runs over EVERY file including tests, and
 * it is the one that catches the shape a hidden UI actually takes.
 */
const AUDITED = SHELL_FILES.filter((file) => !isTest(file))
const INSTRUMENT_FILES = read([...tracked('packages/server/src'), ...tracked('packages/web/src')])

describe('the walk reaches the packages it claims to', () => {
  it('reads the whole shell package and the whole instrument', () => {
    // Every assertion below passes on an empty list, so the lists come first.
    expect(SHELL_FILES.length).toBeGreaterThan(5)
    expect(AUDITED.length).toBeGreaterThan(3)
    expect(INSTRUMENT_FILES.length).toBeGreaterThan(200)
    expect(SHELL_FILES.map((file) => file.path)).toContain('packages/app/src/host/spawn-contract.ts')
    expect(INSTRUMENT_FILES.map((file) => file.path)).toContain('packages/web/src/App.tsx')
  })
})

describe('no forked server or web code exists in the app package (#563)', () => {
  it('holds', () => {
    const findings = auditShell(AUDITED, INSTRUMENT_FILES)
    expect(findings.map(describeFinding)).toEqual([])
  })

  it('holds for rendering across every file, tests included', () => {
    expect(renderingFiles(SHELL_FILES).map(describeFinding)).toEqual([])
  })
})

describe('each detector is proven able to fail', () => {
  it('names a shell file that imports React', () => {
    const rigged: SourceFile[] = [{ path: 'packages/app/src/main/panel.ts', source: "import React from 'react'\n" }]
    expect(forbiddenImports(rigged)).toHaveLength(1)
    expect(forbiddenImports(rigged)[0]?.evidence).toBe('react')
  })

  it('names a deep import of a forbidden package, not only the bare specifier', () => {
    const rigged: SourceFile[] = [
      { path: 'packages/app/src/main/x.ts', source: "import { buildApp } from '@rhizomorph/server/server/build-app'\n" },
    ]
    expect(forbiddenImports(rigged)).toHaveLength(1)
  })

  it('names a dynamic import too — a fork behind `await import()` is still a fork', () => {
    const rigged: SourceFile[] = [{ path: 'packages/app/src/main/x.ts', source: "await import('react-dom')\n" }]
    expect(forbiddenImports(rigged)).toHaveLength(1)
  })

  it('leaves the shell\'s legitimate imports alone', () => {
    const fine: SourceFile[] = [
      { path: 'packages/app/src/main/x.ts', source: "import { app } from 'electron'\nimport { reduceAll } from '@rhizomorph/core'\n" },
    ]
    expect(forbiddenImports(fine)).toEqual([])
  })

  it('names a `.tsx` file in the shell', () => {
    const rigged: SourceFile[] = [{ path: 'packages/app/src/main/Panel.tsx', source: 'export const x = 1\n' }]
    expect(renderingFiles(rigged)).toHaveLength(1)
  })

  it('names a shell file that serves', () => {
    const rigged: SourceFile[] = [
      { path: 'packages/app/src/main/x.ts', source: "server.get('/api/meta', () => ({}))\n" },
      { path: 'packages/app/src/main/y.ts', source: 'const server = createServer((req, res) => res.end())\n' },
    ]
    expect(servingFiles(rigged)).toHaveLength(2)
  })

  it('names a copied file, and names what it is a copy of', () => {
    const original = INSTRUMENT_FILES.find((file) => file.source.length > 2000)
    expect(original).toBeDefined()
    const rigged: SourceFile[] = [{ path: 'packages/app/src/main/copy.ts', source: original?.source ?? '' }]
    const findings = copiedFiles(rigged, INSTRUMENT_FILES)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.evidence).toBe(original?.path)
  })

  it('catches a copy that was reformatted on the way in', () => {
    const original = INSTRUMENT_FILES.find((file) => file.source.length > 2000)
    const reflowed = (original?.source ?? '').replace(/\n/g, '\n\n')
    const findings = copiedFiles([{ path: 'packages/app/src/main/copy.ts', source: reflowed }], INSTRUMENT_FILES)
    expect(findings).toHaveLength(1)
  })

  it('does not call two short files a fork of each other', () => {
    const findings = copiedFiles(
      [{ path: 'packages/app/src/main/x.ts', source: 'export const x = 1\n' }],
      [{ path: 'packages/web/src/y.ts', source: 'export const x = 1\n' }],
    )
    expect(findings).toEqual([])
  })
})

describe('the import reader', () => {
  it('reads static, side-effect, dynamic and re-export forms', () => {
    const source = [
      "import { a } from './a.js'",
      "import 'side-effect'",
      "export { b } from './b.js'",
      "const c = await import('dynamic-one')",
      "const d = require('legacy-one')",
    ].join('\n')
    expect(importedModules(source)).toEqual(['./a.js', './b.js', 'dynamic-one', 'legacy-one'])
  })
})

describe('the shell declares no dependency on a surface', () => {
  const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, 'packages', 'app', 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }

  it('depends on neither package, and on neither framework', () => {
    const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
    expect(declared).not.toContain('@rhizomorph/server')
    expect(declared).not.toContain('@rhizomorph/web')
    expect(declared).not.toContain('react')
    expect(declared).not.toContain('fastify')
  })

  it('does depend on core — one derivation, shared, is the opposite of a fork', () => {
    expect(Object.keys(manifest.dependencies ?? {})).toContain('@rhizomorph/core')
  })
})
