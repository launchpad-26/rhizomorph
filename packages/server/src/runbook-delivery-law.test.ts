import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * #399's law — the shared runbook stays deliverable.
 *
 * `AGENTS.md` is the only mechanism by which four contributors' agents share
 * conventions: every issue brief cites it, and `CLAUDE.md` carries the
 * `@AGENTS.md` import that auto-loads it. It was gitignored in `2d77e5b` on
 * the reasoning that "nothing in the tree cites either file" — a test run
 * against *tracked* files only, which is exactly the blind spot this law
 * closes.
 *
 * The failure was silent for two days and survived one attempted fix.
 * `#379` added a `.workmux.yaml` `post_create` hook copying `AGENTS.md` into
 * each new worktree from the main checkout — but with the file ignored
 * repo-wide the main checkout had no copy to hand out, so the hook spent its
 * whole life copying a file that did not exist. Nothing failed; lanes just
 * ran without a runbook. A structural check is the only thing that catches
 * an absence nobody's build ever trips over.
 *
 * This law lives under `packages/server/` rather than at the repo root
 * because the root vitest config globs `packages/*` — a root-level test
 * would never run, which would be its own vacuous law.
 *
 * Grep-law style, matching the laws it sits beside: real `git` output, no
 * mocks. Half of the tests below exist to prove the detector bites, since a
 * law asserting a file's presence is exactly the shape that passes
 * vacuously when its own probe is broken.
 */

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()

/** `git check-ignore` exits 1 when a path is NOT ignored — an exit code, not an error. */
function isIgnored(relPath: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', '--', relPath], { cwd: REPO_ROOT, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function isTracked(relPath: string): boolean {
  const out = execFileSync('git', ['ls-files', '--', relPath], { cwd: REPO_ROOT, encoding: 'utf8' })
  return out.trim().length > 0
}

/**
 * Step names in `ci.yml` whose `if:` mentions `!cancelled()` — i.e. the steps
 * that still run when an earlier step went red. Derived by parsing, never by a
 * maintained list: a list is what went stale in AGENTS.md in the first place.
 *
 * Deliberately a small text parse rather than a YAML dependency. It only has
 * to see `- name:` and the `if:` that follows it before the next `- name:`,
 * and the rigged-workflow test below proves it distinguishes a gated step from
 * an ungated one.
 */
function stepsGatedOnNotCancelled(workflow: string): string[] {
  const gated: string[] = []
  let current: string | null = null
  for (const raw of workflow.split('\n')) {
    // `noUncheckedIndexedAccess` is on: a capture group is `string | undefined`
    // even when the match succeeded, so read it through `?.[1]` and test for
    // undefined rather than indexing a match object.
    const name = raw.match(/^\s*-\s+name:\s*(.+?)\s*$/)?.[1]
    if (name !== undefined) {
      current = name.replace(/^["']|["']$/g, '')
      continue
    }
    if (current === null) continue
    const gate = raw.match(/^\s*if:\s*(.+?)\s*$/)?.[1]
    if (gate !== undefined && gate.includes('!cancelled()')) {
      // The runbook names the two long steps by their first two words.
      const head = current.split(' —')[0] ?? current
      gated.push(head.split(' -')[0]?.trim().split(/\s+/).slice(0, 2).join(' ') ?? current)
      current = null
    }
  }
  return gated
}

describe('runbook delivery law: AGENTS.md reaches every checkout and worktree', () => {
  it('AGENTS.md is tracked — git itself delivers it, with no copy hook to go stale', () => {
    expect(isTracked('AGENTS.md')).toBe(true)
  })

  it('.gitignore carries no AGENTS.md entry — the line whose return would precede the next untracking', () => {
    // Deliberately a TEXTUAL check, not `git check-ignore`. Git never reports
    // a tracked file as ignored — gitignore applies to untracked paths only —
    // so `check-ignore('AGENTS.md')` returns false no matter what .gitignore
    // says, and asserting on it is vacuous by construction. The first draft of
    // this law did exactly that and survived the mutation of re-adding the
    // line, which is the defect shape AGENTS.md now names in the PR template.
    const entries = readFileSync(`${REPO_ROOT}/.gitignore`, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
    expect(entries).not.toContain('AGENTS.md')
    expect(entries).not.toContain('CLAUDE.md')
    // The sibling entries must still be there — otherwise this passes because
    // .gitignore was emptied, not because the rule holds.
    expect(entries).toContain('CLAUDE.local.md')
    expect(entries).toContain('.claude/')
  })

  it('the runbook is substantive, not a placeholder that satisfies the check above', () => {
    const contents = readFileSync(`${REPO_ROOT}/AGENTS.md`, 'utf8')
    expect(contents.split('\n').length).toBeGreaterThan(50)
    // The conventions an agent is expected to follow unattended. If a rewrite
    // drops one of these headings, this law should be revisited deliberately
    // rather than silently losing the section.
    expect(contents).toContain('## Review')
    expect(contents).toContain('Waves and the bundle unit')
    expect(contents).toContain('One commit per issue')
  })

  it('CLAUDE.md is tracked and imports AGENTS.md — Claude Code reads this file, not the runbook', () => {
    // Claude Code reads CLAUDE.md and NOT AGENTS.md
    // (code.claude.com/docs/en/memory). A tracked runbook that no Claude
    // session loads is the same outage in a new costume, so the import is
    // part of the delivery chain and is checked here rather than trusted.
    expect(isTracked('CLAUDE.md')).toBe(true)
    const claudeMd = readFileSync(`${REPO_ROOT}/CLAUDE.md`, 'utf8')
    // Must be outside a code span/fence to be a real import — backticked
    // text is documentation, not an import, per the same docs.
    const importLine = claudeMd
      .split('\n')
      .find((line) => line.trim() === '@AGENTS.md')
    expect(importLine, 'CLAUDE.md must contain a bare `@AGENTS.md` import line').toBeDefined()
  })

  it('the ignore-detector fires on a file that IS ignored — proving it bites', () => {
    // CLAUDE.local.md is per-contributor and correctly stays ignored. It is
    // the sibling of the two tracked files above, so if the detector cannot
    // tell them apart it is not checking anything.
    expect(isIgnored('CLAUDE.local.md')).toBe(true)
    expect(isIgnored('node_modules')).toBe(true)
  })

  it('the tracked-detector fires negatively on a path that is not tracked — not vacuously true', () => {
    expect(isTracked('this-path-does-not-exist-in-the-repo.md')).toBe(false)
    expect(isTracked('README.md')).toBe(true)
  })

  it('the runbook cites CI by job and step name, never by a line number that rots', () => {
    // Both citations this section used to carry had rotted by 2026-09-02:
    // `pack-smoke` was named 31 lines off, and the `Build` one was wrong and
    // then drifted BACK into correctness when an unrelated PR moved the file —
    // the worse failure, because spot-checking it says "fine". Same lesson
    // .swarm/coupling.txt already records for scripts/gate.sh.
    const runbook = readFileSync(`${REPO_ROOT}/AGENTS.md`, 'utf8')
    const lineCitations = runbook.match(/\b[\w.-]+\.ya?ml:\d+/g) ?? []
    expect(lineCitations).toEqual([])
  })

  it('the line-number detector fires on rigged text — proving it bites', () => {
    // Without this, the assertion above passes on a typo'd regex, on an empty
    // file, and on a runbook that stopped mentioning CI at all.
    const rigged = 'A second job, `pack-smoke` (`.github/workflows/ci.yml:166`), packs the tarball.'
    expect(rigged.match(/\b[\w.-]+\.ya?ml:\d+/g)).toEqual(['ci.yml:166'])
  })

  it('the runbook names exactly the steps the workflow still runs after a red Test', () => {
    // The claim this law exists to stop: AGENTS.md said "a failing step skips
    // every later step on its leg: if `Test` fails, typecheck, lint, packaging
    // and boot smoke silently do not run." That has not been true since those
    // steps were gated on !cancelled(), and prd-24's closing amendment booked
    // the same stale fact as future work. A doc claim about a gate is only
    // worth what re-derives it from the gate.
    //
    // Pinned as an equality against a DERIVED set, in the shape
    // api/route-class-law.test.ts uses: removing a gate from ci.yml shrinks the
    // derived set and turns this red, which is the point — the runbook would
    // then be describing steps that no longer run.
    const workflow = readFileSync(`${REPO_ROOT}/.github/workflows/ci.yml`, 'utf8')
    const gated = stepsGatedOnNotCancelled(workflow)

    expect(gated, 'no gated steps parsed — the parser, not the workflow, is what broke').not.toEqual([])
    expect(gated).toEqual(['Typecheck', 'Lint', 'Packaging guard', 'Boot smoke'])

    const runbook = readFileSync(`${REPO_ROOT}/AGENTS.md`, 'utf8')
    for (const step of gated) {
      expect(runbook.toLowerCase(), `AGENTS.md must say ${step} still runs`).toContain(step.toLowerCase())
    }
    // The exact sentences that were false. Their return is the regression.
    expect(runbook).not.toContain('skips every later')
    expect(runbook).not.toContain('silently do not run')
    // ...and the gate that makes them false is named, so a reader can check.
    expect(runbook).toContain('!cancelled()')
  })

  it('the gate parser fires on a rigged workflow — proving the equality above is not vacuous', () => {
    const rigged = [
      'jobs:',
      '  demo:',
      '    steps:',
      '      - name: Test',
      '        run: npm test',
      '      - name: Typecheck',
      '        if: "!cancelled()"',
      '        run: npm run typecheck',
      '      - name: Never Runs',
      '        run: echo no gate',
    ].join('\n')
    expect(stepsGatedOnNotCancelled(rigged)).toEqual(['Typecheck'])
    expect(stepsGatedOnNotCancelled('steps:\n      - name: Ungated\n        run: true')).toEqual([])
  })

  it('the workmux post_create hook does not copy AGENTS.md — a tracked file needs no hook', () => {
    // The hook that copied it was copying a nonexistent file for two days.
    // Now that git delivers AGENTS.md, re-adding it to the hook would be
    // reintroducing the dead code path, not restoring a safety net.
    const config = readFileSync(`${REPO_ROOT}/.workmux.yaml`, 'utf8')
    const postCreate = config.slice(config.indexOf('post_create:'), config.indexOf('# prd1 telemetry'))
    expect(postCreate).toContain('CLAUDE.local.md"')
    expect(postCreate).not.toContain('AGENTS.md"')
    expect(postCreate).not.toContain('CLAUDE.md"')
  })
})
