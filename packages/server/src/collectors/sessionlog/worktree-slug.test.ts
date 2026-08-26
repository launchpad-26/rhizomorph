import { describe, expect, it } from 'vitest'
import { worktreePathToProjectSlug } from './worktree-slug.js'

describe('worktreePathToProjectSlug', () => {
  it('matches the real ~/.claude/projects dir for the main worktree', () => {
    expect(worktreePathToProjectSlug('/home/operator/worktrees-challenge')).toBe(
      '-home-operator-worktrees-challenge',
    )
  })

  it('matches the real ~/.claude/projects dir for a sibling worktree (double underscore folds to double dash)', () => {
    expect(
      worktreePathToProjectSlug('/home/operator/worktrees-challenge__worktrees/2-core'),
    ).toBe('-home-operator-worktrees-challenge--worktrees-2-core')
  })

  it('matches the worktree this issue was built in', () => {
    expect(
      worktreePathToProjectSlug(
        '/home/operator/worktrees-challenge__worktrees/34-sessionlog-collector',
      ),
    ).toBe('-home-operator-worktrees-challenge--worktrees-34-sessionlog-collector')
  })

  it('replaces every slash and underscore, nothing else', () => {
    expect(worktreePathToProjectSlug('/a/b_c/d')).toBe('-a-b-c-d')
  })

  it('maps a dot the same way as slash and underscore, so a dotted path still resolves', () => {
    expect(worktreePathToProjectSlug('/home/operator/work/v2.0/wt')).toBe(
      '-home-operator-work-v2-0-wt',
    )
  })

  it('maps a dotted directory name (e.g. a dotted username)', () => {
    expect(worktreePathToProjectSlug('/home/jane.doe/project')).toBe('-home-jane-doe-project')
  })

  it('replaces every slash, underscore and dot, nothing else', () => {
    expect(worktreePathToProjectSlug('/a/b_c.d/e')).toBe('-a-b-c-d-e')
  })

  /**
   * **THE WINDOWS SLUG, AGAINST A REAL ONE** (ledger #11).
   * `research/2026-08-14-cross-host-resume.md` reads
   * `~/.claude/projects/C--Users-operator-agenticlaunchpad/` on a machine whose
   * cwd was `C:\Users\operator\agenticlaunchpad` — so the drive colon and the
   * backslashes take the same substitution `/`, `_` and `.` already take. This
   * is the exact pair from the note, not a constructed example: before the
   * mapping, this function returned the Windows path unchanged and would have
   * looked for a transcript in a directory Claude Code never writes.
   */
  it('matches the real Windows slug from the cross-host-resume capture', () => {
    expect(worktreePathToProjectSlug('C:\\Users\\operator\\agenticlaunchpad')).toBe(
      'C--Users-operator-agenticlaunchpad',
    )
  })

  it('maps a backslash and a colon on their own, so neither rides on the other', () => {
    expect(worktreePathToProjectSlug('a\\b')).toBe('a-b')
    expect(worktreePathToProjectSlug('D:')).toBe('D-')
  })

  /**
   * A space moved INTO this function's class at prd-42 ruling 1 — this
   * pinned expectation is the one the ruling names as moving in the same
   * commit as the fix, so it stays a fact about the encoding rather than a
   * stale copy of it (AGENTS.md's #649 lesson).
   *
   * The tilde staying UNMAPPED here is NOT a claim that this is correct — it
   * is punctuation, same as everything else in Claude Code's real transform
   * (`/[^a-zA-Z0-9]/g`, per this function's own doc comment). It is a KNOWN,
   * DELIBERATE divergence, pinned so a reader does not mistake the absence
   * of a test failure for evidence the tilde is handled: closing it is out
   * of this issue's fence, and #47 is where the colon/backslash slice of the
   * same broader gap is tracked. (A dash is a wash either way: the real
   * transform replaces `-` with `-`, so its presence here proves nothing
   * about which side is more correct.)
   */
  it('pins the tilde as UNMAPPED — a known divergence from the real slugger (#47), not a correctness claim', () => {
    expect(worktreePathToProjectSlug('/home/j~ane/my project-1')).toBe('-home-j~ane-my-project-1')
  })
})

// prd-42 ruling 1's round-trip law (space, dot, underscore, colon,
// backslash) now lives in `concierge/repos.test.ts`, not here (#47,
// absorbing #52): it needs the real, typed `reverseProjectSlug`, and a test
// inside `concierge/` reaches that without the computed-specifier dodge this
// file used to carry — `namespace-law.test.ts` clause 1 skips the concierge
// directory's own files outright. See that file for the law and its history.
