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
    expect(worktreePathToProjectSlug('C:\\Users\\lachl\\agenticlaunchpad')).toBe(
      'C--Users-operator-agenticlaunchpad',
    )
  })

  it('maps a backslash and a colon on their own, so neither rides on the other', () => {
    expect(worktreePathToProjectSlug('a\\b')).toBe('a-b')
    expect(worktreePathToProjectSlug('D:')).toBe('D-')
  })

  /** Still nothing else: the class is five characters, not "punctuation". */
  it('leaves a dash, a space and a tilde exactly as they were', () => {
    expect(worktreePathToProjectSlug('/home/j~ane/my project-1')).toBe('-home-j~ane-my project-1')
  })
})
