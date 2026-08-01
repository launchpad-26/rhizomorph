import { createEventFactory } from '@observatory/core'
import { describe, expect, it } from 'vitest'
import { attachPlan, findTmuxIdentity, shellQuote, workmuxHandle, type AttachLane } from './attach.js'

const WORKTREE = '/repo-wt/84-chat-drawer'

const LANE: AttachLane = {
  id: '84-chat-drawer',
  branch: '84-chat-drawer',
  worktreePath: WORKTREE,
  handles: ['84-chat-drawer'],
  present: true,
}

describe('shellQuote', () => {
  it('leaves an ordinary name bare, so the operator can read the command', () => {
    expect(shellQuote('observatory')).toBe('observatory')
    expect(shellQuote('84-chat-drawer')).toBe('84-chat-drawer')
    expect(shellQuote('3')).toBe('3')
  })

  it('quotes anything with a space or a shell metacharacter', () => {
    expect(shellQuote('my session')).toBe("'my session'")
    expect(shellQuote('a;rm -rf b')).toBe("'a;rm -rf b'")
    expect(shellQuote('')).toBe("''")
  })

  it('escapes an embedded single quote', () => {
    expect(shellQuote("lachlan's box")).toBe(`'lachlan'\\''s box'`)
  })
})

describe('findTmuxIdentity', () => {
  it('reads session and window index off the pane the collector mapped to this worktree', () => {
    const f = createEventFactory()
    const events = [
      f.paneDiscovered({
        paneId: '%7',
        sessionName: 'observatory',
        windowName: '84-chat-drawer',
        windowIndex: 3,
        currentPath: WORKTREE,
        worktreePath: WORKTREE,
      }),
    ]

    expect(findTmuxIdentity(events, LANE)).toEqual({ sessionName: 'observatory', window: '3', paneId: '%7' })
  })

  it('falls back to the window name when no index was reported', () => {
    const f = createEventFactory()
    const events = [
      f.paneDiscovered({
        paneId: '%7',
        sessionName: 'observatory',
        windowName: '84-chat-drawer',
        currentPath: WORKTREE,
        worktreePath: WORKTREE,
      }),
    ]

    expect(findTmuxIdentity(events, LANE)?.window).toBe('84-chat-drawer')
  })

  it('matches a pane by window name when the collector could not map it to a worktree', () => {
    const f = createEventFactory()
    const events = [
      f.paneDiscovered({
        paneId: '%9',
        sessionName: 'observatory',
        windowName: '84-chat-drawer',
        currentPath: '/somewhere/else',
        worktreePath: null,
      }),
    ]

    expect(findTmuxIdentity(events, LANE)?.paneId).toBe('%9')
  })

  it('takes the newest pane when the lane has been reopened', () => {
    const f = createEventFactory({ startTs: 1_000, stepMs: 1_000 })
    const events = [
      f.paneDiscovered({ paneId: '%1', sessionName: 'old', windowName: 'w', windowIndex: 1, currentPath: WORKTREE, worktreePath: WORKTREE }),
      f.paneDiscovered({ paneId: '%2', sessionName: 'new', windowName: 'w', windowIndex: 2, currentPath: WORKTREE, worktreePath: WORKTREE }),
    ]

    expect(findTmuxIdentity(events, LANE)?.sessionName).toBe('new')
  })

  it('will not hand over a pane that has since closed', () => {
    const f = createEventFactory({ startTs: 1_000, stepMs: 1_000 })
    const events = [
      f.paneDiscovered({ paneId: '%1', sessionName: 'observatory', windowName: 'w', windowIndex: 1, currentPath: WORKTREE, worktreePath: WORKTREE }),
      f.paneClosed({ paneId: '%1' }),
    ]

    expect(findTmuxIdentity(events, LANE)).toBeNull()
  })

  it('will not guess a session name the collector never reported', () => {
    const f = createEventFactory()
    const events = [
      f.paneDiscovered({
        paneId: '%1',
        sessionName: null,
        windowName: '84-chat-drawer',
        windowIndex: 1,
        currentPath: WORKTREE,
        worktreePath: WORKTREE,
      }),
    ]

    expect(findTmuxIdentity(events, LANE)).toBeNull()
  })

  it('ignores another lane\'s pane', () => {
    const f = createEventFactory()
    const events = [
      f.paneDiscovered({
        paneId: '%1',
        sessionName: 'observatory',
        windowName: '77-attention-strip',
        windowIndex: 1,
        currentPath: '/repo-wt/77-attention-strip',
        worktreePath: '/repo-wt/77-attention-strip',
      }),
    ]

    expect(findTmuxIdentity(events, LANE)).toBeNull()
  })
})

describe('attachPlan', () => {
  it('gives the exact tmux command when the lane\'s tmux identity is known', () => {
    const f = createEventFactory()
    const events = [
      f.paneDiscovered({
        paneId: '%7',
        sessionName: 'observatory',
        windowName: '84-chat-drawer',
        windowIndex: 3,
        currentPath: WORKTREE,
        worktreePath: WORKTREE,
      }),
    ]

    const plan = attachPlan(events, LANE)

    expect(plan.kind).toBe('tmux')
    expect(plan.command).toBe('tmux attach -t observatory \\; select-window -t 3')
  })

  it('quotes a session name that would otherwise break the pasted command', () => {
    const f = createEventFactory()
    const events = [
      f.paneDiscovered({
        paneId: '%7',
        sessionName: 'my box',
        windowName: 'w',
        windowIndex: 3,
        currentPath: WORKTREE,
        worktreePath: WORKTREE,
      }),
    ]

    expect(attachPlan(events, LANE).command).toBe("tmux attach -t 'my box' \\; select-window -t 3")
  })

  it('falls back to the workmux equivalent when no pane is on record', () => {
    const plan = attachPlan([], LANE)

    expect(plan.kind).toBe('workmux')
    expect(plan.command).toBe('workmux open 84-chat-drawer')
    expect(plan.note).toContain('no tmux pane on record')
  })

  it('offers no command at all for a lane whose worktree has folded', () => {
    const plan = attachPlan([], { ...LANE, present: false })

    expect(plan.kind).toBe('none')
    expect(plan.command).toBeNull()
    expect(plan.note).toContain('NO WORKTREE')
  })

  it('prefers tmux over workmux — precise beats convenient', () => {
    const f = createEventFactory()
    const events = [
      f.paneDiscovered({
        paneId: '%7',
        sessionName: 'observatory',
        windowName: '84-chat-drawer',
        windowIndex: 3,
        currentPath: WORKTREE,
        worktreePath: WORKTREE,
      }),
    ]

    expect(attachPlan(events, LANE).command).not.toContain('workmux')
  })

  it('never produces a command that could run anything but an attach', () => {
    const f = createEventFactory()
    const events = [
      f.paneDiscovered({
        paneId: '%7',
        sessionName: 'observatory',
        windowName: '84-chat-drawer',
        windowIndex: 3,
        currentPath: WORKTREE,
        worktreePath: WORKTREE,
      }),
    ]

    for (const plan of [attachPlan(events, LANE), attachPlan([], LANE)]) {
      expect(plan.command).toMatch(/^(tmux attach|workmux open) /)
      expect(plan.command).not.toMatch(/send-keys|run-shell|workmux send|workmux run/)
    }
  })
})

describe('workmuxHandle', () => {
  it('prefers the handle the collectors recorded', () => {
    expect(workmuxHandle({ ...LANE, handles: ['84-chat-drawer'], branch: 'feature/84' })).toBe('84-chat-drawer')
  })

  it('falls back to the branch, then to the lane id', () => {
    expect(workmuxHandle({ ...LANE, handles: [], branch: 'feature/84' })).toBe('feature/84')
    expect(workmuxHandle({ ...LANE, handles: [], branch: null, id: 'wt-84' })).toBe('wt-84')
  })
})
