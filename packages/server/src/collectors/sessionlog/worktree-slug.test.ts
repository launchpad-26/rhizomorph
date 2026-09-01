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

  it('replaces every slash and underscore', () => {
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

  it('replaces every slash, underscore and dot', () => {
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
   */
  it('maps a literal space, and leaves an existing dash alone, so a spaced path still resolves', () => {
    expect(worktreePathToProjectSlug('/home/operator/my project-1')).toBe('-home-operator-my-project-1')
  })

  /**
   * #124: the class widened from six hand-picked characters to the real
   * transform's own (`/[^a-zA-Z0-9]/g`, per this function's doc comment) — so
   * punctuation the old class left untouched, like a tilde, an at-sign or a
   * parenthesis, now maps the same as `/`, `_` and `.` always did. This is
   * the exact probe pairing the doc comment cites
   * (`/tmp/slugprobe3/a+b~c(d),e'f@g` → `-tmp-slugprobe3-a-b-c-d--e-f-g`),
   * not a constructed example, so a class narrowed back toward the old six
   * reddens here rather than surviving as a silent regression.
   */
  it('maps every non-alphanumeric character, not just the old six — the real Claude Code grammar', () => {
    expect(worktreePathToProjectSlug('/tmp/slugprobe3/a+b~c(d),e\'f@g')).toBe(
      '-tmp-slugprobe3-a-b-c-d--e-f-g',
    )
  })

  /**
   * The hyphen itself is a wash — the real transform maps `-` to `-`, so no
   * change to its handling can redden that alone, and the old name for this
   * test said as much. What it DOES pin is that the transform is
   * per-character: each foldable character becomes its own dash, so `--`
   * survives as `--` rather than collapsing under the plausible
   * `/[^a-zA-Z0-9]+/g`. That property is not pinned here alone — the
   * sibling-worktree and Windows-slug cases above carry it too, on real
   * captured paths — so this is a local guard beside the hyphen, not the only
   * one. Renamed for the invariant rather than for the wash, per the repo's
   * own "what mutation would this survive?" standard (#124 review).
   */
  it('folds one dash per character, so an existing dash is neither dropped nor collapsed', () => {
    expect(worktreePathToProjectSlug('/a-b/c')).toBe('-a-b-c')
    expect(worktreePathToProjectSlug('/a--b/c')).toBe('-a--b-c')
  })
})

// prd-42 ruling 1's round-trip law (space, dot, underscore, colon,
// backslash) now lives in `concierge/repos.test.ts`, not here (#47,
// absorbing #52): it needs the real, typed `reverseProjectSlug`, and a test
// inside `concierge/` reaches that without the computed-specifier dodge this
// file used to carry — `namespace-law.test.ts` clause 1 skips the concierge
// directory's own files outright. See that file for the law and its history.
