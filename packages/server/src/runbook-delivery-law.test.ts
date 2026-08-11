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
    // The sibling entries must still be there — otherwise this passes because
    // .gitignore was emptied, not because the rule holds.
    expect(entries).toContain('CLAUDE.md')
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

  it('the ignore-detector fires on a file that IS ignored — proving it bites', () => {
    // CLAUDE.md is per-contributor and correctly stays ignored. It is the
    // sibling of the file above, so if the detector cannot tell the two
    // apart it is not checking anything.
    expect(isIgnored('CLAUDE.md')).toBe(true)
    expect(isIgnored('node_modules')).toBe(true)
  })

  it('the tracked-detector fires negatively on a path that is not tracked — not vacuously true', () => {
    expect(isTracked('this-path-does-not-exist-in-the-repo.md')).toBe(false)
    expect(isTracked('README.md')).toBe(true)
  })

  it('the workmux post_create hook does not copy AGENTS.md — a tracked file needs no hook', () => {
    // The hook that copied it was copying a nonexistent file for two days.
    // Now that git delivers AGENTS.md, re-adding it to the hook would be
    // reintroducing the dead code path, not restoring a safety net.
    const config = readFileSync(`${REPO_ROOT}/.workmux.yaml`, 'utf8')
    const postCreate = config.slice(config.indexOf('post_create:'), config.indexOf('# prd1 telemetry'))
    expect(postCreate).toContain('CLAUDE.md')
    expect(postCreate).not.toContain('AGENTS.md"')
  })
})
