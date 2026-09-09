import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * THE PARENT IS READ, NEVER COPIED (prd53 S3, acceptance: "no lab source file
 * contains transcript text"). Trace holds two transcripts in memory for as
 * long as it is mounted and writes neither anywhere: no browser storage, no
 * artifact, no serialiser. The check is over the SOURCE of this directory —
 * a persistence call that does not exist cannot be reached — and it names
 * every spelling this app has for putting bytes somewhere.
 *
 * And, since prd-55 wave 3 (#384), a second law lives here — here rather
 * than in a file of its own because trace/'s source-file count is pinned
 * (`no-live-fleet-law.test.ts`) and that pin belongs to another lane this
 * cycle: THE LAB READS ITS OWN ROUTE (prd-55 ruling 6 / S3′). Nothing under
 * `lab/` reaches the fleet's transcript tail — not its path, not the
 * drawer's URL builders for it, not the hook that follows it. Trace read
 * that tail until this wave and got NO SESSION LOG for a parent and 404 for
 * an arm that never launched (prd-55's Evidence), because the tail knows
 * only lanes the sessionlog collector attributed; the lab's own record holds
 * both, and `/api/lab/transcript` serves it. The drawer's TYPES stay
 * importable: the wire shape of a turn is one shape, and `import type`
 * reaches no route.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url))
const LAB_DIR = path.resolve(HERE, '..')

const PERSISTENCE: readonly RegExp[] = [
  /\blocalStorage\b/,
  /\bsessionStorage\b/,
  /\bindexedDB\b/,
  /\bdocument\.cookie\b/,
  /from ['"][^'"]*compare\/artifact(?:\.js)?['"]/,
  /\bserialiseComparison\b/,
  /\bwritePreference\b/,
]

/**
 * The fleet's transcript tail, in every spelling a lab source file could
 * reach it by: the route's own path (in a literal or a template — prose in
 * lab/ names it as `api/transcript.ts`, the file, for exactly this reason),
 * the drawer's three URL builders for it, and the hook that follows it.
 */
const FLEET_TRANSCRIPT_TAIL: readonly RegExp[] = [
  /\/api\/transcript(?![\w-])/,
  /\btranscriptUrl\b/,
  /\btranscriptTailUrl\b/,
  /\btranscriptBeforeUrl\b/,
  /\buseTranscript\s*\(/,
]

/**
 * A VALUE import from the drawer's transcript module. `import type { … }`
 * is the one form allowed; a mixed `import { type A, transcriptUrl }` is a
 * value import and is caught, as is a bare `import { … }` of only inline
 * `type` specifiers — the law asks for the unambiguous spelling. The span
 * between `import` and `from` may not cross another `import` or `from`: this
 * codebase writes no semicolons, so a lazy `[^;]*?` would run from one
 * statement's `import {` to the next statement's `from` and read a legal
 * `import type` as the value import before it (EXECUTED: it did, on
 * TraceDiff.tsx's own react import).
 */
const DRAWER_TRANSCRIPT_VALUE_IMPORT = /\bimport\s+(?!type\b)(?:(?!\bfrom\b|\bimport\b)[\s\S])*?\bfrom\s+['"][^'"]*drawer\/useTranscript(?:\.js)?['"]/g

function valueImportsOfDrawerTranscript(text: string): string[] {
  return [...text.matchAll(DRAWER_TRANSCRIPT_VALUE_IMPORT)].map((match) => match[0])
}

function sourceFiles(): string[] {
  return readdirSync(HERE)
    .filter((name) => /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name))
    .map((name) => path.join(HERE, name))
}

/**
 * Every non-test source file under lab/, recursively — the walk
 * `no-live-fleet-law.test.ts` proves out, restated rather than imported (a
 * test file importing another re-runs the imported suites nested under the
 * importer). Names are slash-joined so a failure reads the same on every
 * platform.
 */
function labSourceFiles(dir: string = LAB_DIR, root: string = LAB_DIR): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...labSourceFiles(full, root))
      continue
    }
    if (!/\.(ts|tsx)$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue
    out.push({ name: path.relative(root, full).split(path.sep).join('/'), text: readFileSync(full, 'utf8') })
  }
  return out
}

describe('lab/trace persists nothing (prd53 S3)', () => {
  it('the sweep sees the surface, the diff and the steps — not an empty directory', () => {
    const names = sourceFiles().map((file) => path.basename(file))
    expect(names).toEqual(expect.arrayContaining(['TraceDiff.tsx', 'diff.ts', 'steps.ts']))
  })

  it('no source file in lab/trace reaches for browser storage, the comparison artifact, or a preference write', () => {
    for (const file of sourceFiles()) {
      const source = readFileSync(file, 'utf8')
      for (const pattern of PERSISTENCE) {
        expect(source, `${path.basename(file)} matches ${pattern}`).not.toMatch(pattern)
      }
    }
  })

  it('bites: a fixture that stores a transcript entry is caught', () => {
    const offending = "const remembered = localStorage.setItem('trace', JSON.stringify(entries))"
    expect(PERSISTENCE.some((pattern) => pattern.test(offending))).toBe(true)
  })
})

describe("lab/ reads the lab's own transcript route, never the fleet's tail (prd-55 ruling 6 / S3′, #384)", () => {
  it('the walk reaches the root, the frame and this directory — a shallow walk proves nothing', () => {
    const names = labSourceFiles().map((file) => file.name)
    expect(names).toEqual(expect.arrayContaining(['LabPage.tsx', 'frame/Frame.tsx', 'trace/TraceDiff.tsx', 'trace/steps.ts']))
  })

  it('no source file under lab/ names the fleet transcript route, its URL builders, or the hook that follows it', () => {
    for (const file of labSourceFiles()) {
      for (const pattern of FLEET_TRANSCRIPT_TAIL) {
        expect(file.text, `${file.name} reaches the fleet transcript tail: ${pattern}`).not.toMatch(pattern)
      }
    }
  })

  it("no source file under lab/ imports a VALUE from the drawer's transcript module — its types are the one thing lab/ may take from it", () => {
    for (const file of labSourceFiles()) {
      expect(valueImportsOfDrawerTranscript(file.text), `${file.name} imports a value from drawer/useTranscript`).toEqual([])
    }
  })

  it('bites: every spelling the fleet tail could be reached by is caught, and the type import is not', () => {
    const reaches = [
      'const response = await fetchImpl(`/api/transcript/${encodeURIComponent(lane)}?offset=0`)',
      "fetch('/api/transcript/main?tail=1')",
      'fetchImpl(transcriptUrl(lane, 0))',
      'transcriptTailUrl(lane)',
      'transcriptBeforeUrl(lane, before)',
      'const tail = useTranscript(lane, { pollMs: 0 })',
    ]
    for (const probe of reaches) {
      expect(FLEET_TRANSCRIPT_TAIL.some((pattern) => pattern.test(probe)), probe).toBe(true)
    }
    // The lab's own route is not the fleet's; a sibling path that merely shares a prefix is not either.
    expect(FLEET_TRANSCRIPT_TAIL.some((pattern) => pattern.test("fetchImpl('/api/lab/transcript?lane=feature')"))).toBe(false)
    expect(FLEET_TRANSCRIPT_TAIL.some((pattern) => pattern.test("fetch('/api/transcripts-index')"))).toBe(false)

    expect(valueImportsOfDrawerTranscript("import { type TranscriptEntry, transcriptUrl } from '../../drawer/useTranscript.js'")).toHaveLength(1)
    expect(valueImportsOfDrawerTranscript("import { type TranscriptEntry } from '../../drawer/useTranscript.js'")).toHaveLength(1)
    expect(valueImportsOfDrawerTranscript("import type { TranscriptBlock, TranscriptEntry } from '../../drawer/useTranscript.js'")).toEqual([])
    // Two statements, no semicolons: a value import of something ELSE followed by the legal type import is not a hit.
    expect(
      valueImportsOfDrawerTranscript(
        "import { useState } from 'react'\nimport type { TranscriptEntry } from '../../drawer/useTranscript.js'",
      ),
    ).toEqual([])
  })
})
