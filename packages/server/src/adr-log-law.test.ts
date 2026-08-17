import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * #605's law — the ADR log stays navigable.
 *
 * Records are cited BY NUMBER from code and tests (`ADR-0019` appears in
 * `concierge/paths.ts`, `clone.ts` and several `*-law.test.ts` files), and the
 * log is append-only, so a filing error compounds instead of ageing out. Two
 * ways it had already gone wrong on `main`, both silently:
 *
 *   * **0021 named two different decisions.** Two branches each picked "the
 *     next free number" against a `main` that did not yet have the other, and
 *     merged a day apart. Every later citation of `ADR-0021` was ambiguous.
 *   * **Neither 0021 was in the index**, and 0017 and 0018 had landed rowless
 *     before them and been backfilled by hand. `README.md` is the log's only
 *     discovery surface, so a record missing from it is a record nobody finds.
 *
 * Nothing failed in either case. That is the point: an ADR is prose, no build
 * step reads it, and the only thing that can notice a filing error is a check
 * written to look for one.
 *
 * The third assertion — that every link in the index resolves — is here
 * because writing this law's own fix produced exactly that defect: the row
 * added for 0021 linked `0006-the-scene-is-drawn-in-canvas-2d.md`, a plausible
 * name for a record actually filed as `0006-canvas-2d-over-webgl.md`. Caught by
 * hand, once. A dead link in the index is the same failure as a missing row —
 * the reader does not reach the record — so the law covers both.
 *
 * This lives under `packages/server/` rather than at the repo root for the
 * reason `runbook-delivery-law.test.ts` records beside it: the root vitest
 * config globs `packages/*`, so a root-level test would never run and would be
 * its own vacuous law.
 */

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const ADR_DIR = path.join(REPO_ROOT, 'docs', 'adr')

/** `0019-the-fourth-hand.md` -> `{ number: '0019', file: '0019-the-fourth-hand.md' }` */
const RECORD_RE = /^(\d{4})-.+\.md$/

function records(): { number: string; file: string }[] {
  return readdirSync(ADR_DIR)
    .map((file) => ({ file, match: RECORD_RE.exec(file) }))
    .filter((r): r is { file: string; match: RegExpExecArray } => r.match !== null)
    .map((r) => ({ number: r.match[1]!, file: r.file }))
    .sort((a, b) => a.number.localeCompare(b.number))
}

function indexText(): string {
  return readFileSync(path.join(ADR_DIR, 'README.md'), 'utf8')
}

/** Every `[NNNN](target.md)` link anywhere in the index, as `[number, target]` pairs. */
function indexLinks(text: string): [string, string][] {
  return [...text.matchAll(/\[(\d{4})\]\(([^)]+)\)/g)].map((m) => [m[1]!, m[2]!])
}

/**
 * Only the links in the FIRST cell of a table row — the index proper.
 *
 * Membership was originally read from {@link indexLinks}, i.e. from any
 * `[NNNN](…)` anywhere in the file. Two ways that certified a record as listed
 * when the table could not reach it, both EXECUTED in the verify pass on #605:
 * deleting a record's table row while any prose elsewhere linked its number
 * still passed 5/5, and so did a row whose label read `[0023]` while its target
 * was 0022's file. The prose in this README genuinely does cite records by
 * number — the paragraph about ADR-0003 does — so "a link exists" was never the
 * same question as "the table lists it".
 */
function indexRows(text: string): [string, string][] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .map((line) => /^\|\s*\[(\d{4})\]\(([^)]+)\)/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => [m[1]!, m[2]!])
}

/**
 * The four checks, as functions over data rather than assertions inline in an
 * `it`. Each returns the offenders it found, so both the live tests below AND
 * the detector-bite test call the SAME code — the bite test previously
 * re-implemented the matching over synthetic fixtures, which meant inverting a
 * production check would not have reddened it. A bite test that cannot observe
 * the thing it vouches for is the second defect shape this repo names.
 */
type Record_ = { number: string; file: string }

function duplicateNumbers(recs: Record_[]): string[] {
  const byNumber = new Map<string, string[]>()
  for (const r of recs) byNumber.set(r.number, [...(byNumber.get(r.number) ?? []), r.file])
  return [...byNumber.entries()].filter(([, files]) => files.length > 1).map(([n]) => n)
}

function recordsMissingRow(recs: Record_[], text: string): string[] {
  const rowed = new Set(indexRows(text).map(([n]) => n))
  return recs.filter((r) => !rowed.has(r.number)).map((r) => r.file)
}

function mislinkedRows(text: string): string[] {
  return indexRows(text)
    .filter(([number, target]) => !path.basename(target).startsWith(`${number}-`))
    .map(([number, target]) => `${number} -> ${target}`)
}

function deadLinks(recs: Record_[], text: string): string[] {
  const present = new Set(recs.map((r) => r.file))
  return indexLinks(text)
    .filter(([, target]) => !target.startsWith('http'))
    .filter(([, target]) => !present.has(target))
    .map(([n, target]) => `${n} -> ${target}`)
}

describe('the ADR log is navigable (#605)', () => {
  it('has records to check at all — an empty directory would prove nothing', () => {
    expect(records().length).toBeGreaterThan(20)
  })

  it('no number names two records', () => {
    expect(duplicateNumbers(records())).toEqual([])
  })

  it('every record has a TABLE ROW in the index — the log has no other discovery surface', () => {
    expect(recordsMissingRow(records(), indexText())).toEqual([])
  })

  it('every row points at its own record — a row labelled N linking to M reaches the wrong decision', () => {
    expect(mislinkedRows(indexText())).toEqual([])
  })

  it('every index link resolves to a record that exists', () => {
    expect(deadLinks(records(), indexText())).toEqual([])
  })

  it('the detectors bite — each failure this law exists to catch, run through the same code the checks above use', () => {
    const recs = records()
    const text = indexText()
    const first = recs[0]!

    // A duplicate number, as 0021 was.
    expect(duplicateNumbers([...recs, { number: first.number, file: `${first.number}-a-second-record.md` }])).not.toEqual([])

    // A record whose table row is gone, as both 0021s were — even though a
    // prose link to that number still exists elsewhere in the file. This is
    // the case the original membership check could not see.
    const rowGone = text.replace(new RegExp(`^\\|\\s*\\[${first.number}\\].*$`, 'm'), `see [${first.number}](${first.file}) in prose`)
    expect(recordsMissingRow(recs, rowGone)).toEqual([first.file])

    // A row labelled N pointing at another record's file. Its target EXISTS,
    // so the dead-link check passes it; only the label/target agreement catches it.
    const second = recs[1]!
    const crossed = text.replace(`[${first.number}](${first.file})`, `[${first.number}](${second.file})`)
    expect(mislinkedRows(crossed)).not.toEqual([])
    expect(deadLinks(recs, crossed)).toEqual([])

    // A row whose target does not exist, as the 0021 row first did.
    expect(deadLinks(recs, text.replace(first.file, '0006-the-scene-is-drawn-in-canvas-2d.md'))).not.toEqual([])
  })
})
