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
})
