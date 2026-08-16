import { describe, expect, it } from 'vitest'
import { appMenu, actionableItems, INVITATION_LABEL } from './app-menu.js'
import {
  firstRunPlan,
  NEW_RUN_STATE,
  readRunState,
  withDemoSeen,
  withInvitationTaken,
  withRepo,
  type RunState,
} from './first-run.js'

describe('S1\'s states', () => {
  it('first launch ever opens the demonstration fleet, and invites', () => {
    const plan = firstRunPlan(NEW_RUN_STATE, false)
    expect(plan.stage).toBe('first-launch')
    expect(plan.showDemo).toBe('fleet20')
    expect(plan.invite).toBe(true)
    expect(plan.why).toContain('simulated')
  })

  it('launched but never configured shows it again — resumable, not one-shot', () => {
    const plan = firstRunPlan(withDemoSeen(NEW_RUN_STATE), false)
    expect(plan.stage).toBe('never-configured')
    expect(plan.showDemo).toBe('fleet20')
    expect(plan.invite).toBe(true)
  })

  it('configured opens on the repo, never on a simulation', () => {
    const state = withRepo(withDemoSeen(NEW_RUN_STATE), '/home/dev/project')
    const plan = firstRunPlan(state, true)
    expect(plan.stage).toBe('configured')
    // The asymmetry that matters: an instrument that IS watching something must
    // never open on a fixture, whatever it remembers about first runs.
    expect(plan.showDemo).toBeNull()
    expect(plan.invite).toBe(false)
  })

  it('demo declined skips it without argument, and keeps the invitation standing', () => {
    const plan = firstRunPlan(withInvitationTaken(NEW_RUN_STATE), false)
    expect(plan.stage).toBe('declined')
    expect(plan.showDemo).toBeNull()
    expect(plan.invite).toBe(true)
  })

  it('never shows a fixture to a configured instrument, whatever it remembers', () => {
    const shapes: RunState[] = [
      NEW_RUN_STATE,
      withDemoSeen(NEW_RUN_STATE),
      withInvitationTaken(NEW_RUN_STATE),
      withRepo(NEW_RUN_STATE, '/repo'),
    ]
    for (const state of shapes) expect(firstRunPlan(state, true).showDemo).toBeNull()
  })
})

/**
 * #565'S ACCEPTANCE — "a test drives the whole first-run path". Driven here
 * with an injected store and an injected act log, because what the SHELL owns
 * of first run is the plan and the sequence. The fetch-driven half is the
 * wizard's own (`packages/web/src/connect/wizard.test.tsx`), and this package
 * neither forks it nor re-tests it — `app-menu.test.ts` proves the shell only
 * points at it.
 */
describe('the whole first-run path, driven', () => {
  it('walks launch → demo → invitation → watching → a second launch that shows no demo', () => {
    const acts: string[] = []
    let store: RunState = readRunState(undefined)
    let repo: string | null = null

    // ── launch one ────────────────────────────────────────────────────────
    const first = firstRunPlan(store, repo !== null)
    expect(first.stage).toBe('first-launch')
    if (first.showDemo !== null) {
      acts.push(`demo:${first.showDemo}`)
      store = withDemoSeen(store)
    }
    const menu = appMenu({ plan: first, serving: true, unsigned: true })
    expect(menu.some((item) => item.label === INVITATION_LABEL)).toBe(true)
    expect(menu.some((item) => item.kind === 'label' && item.label === first.why)).toBe(true)

    // ── the person takes the invitation ───────────────────────────────────
    const invitation = actionableItems(menu).find((item) => item.id === 'watch-my-repo')
    expect(invitation?.route).toBe('/connect')
    acts.push(`navigate:${invitation?.route}`)
    store = withInvitationTaken(store)

    // ── the wizard does its work; the shell observes the outcome ──────────
    repo = '/home/dev/project'
    store = withRepo(store, repo)

    // ── launch two ────────────────────────────────────────────────────────
    const second = firstRunPlan(store, repo !== null)
    expect(second.stage).toBe('configured')
    expect(second.showDemo).toBeNull()
    const secondMenu = appMenu({ plan: second, serving: true, unsigned: true })
    expect(secondMenu.some((item) => item.kind === 'label')).toBe(false)
    // The invitation is still THERE — it is a menu item, not a step that is
    // spent — it is simply no longer being urged.
    expect(secondMenu.some((item) => item.label === INVITATION_LABEL)).toBe(true)

    expect(acts).toEqual(['demo:fleet20', 'navigate:/connect'])
    expect(store).toEqual({ seenDemo: true, declined: true, watchedRepo: '/home/dev/project' })
  })

  it('walks the declined path: straight to configuration, no demo, no argument', () => {
    let store = readRunState(undefined)
    store = withInvitationTaken(store)
    const plan = firstRunPlan(store, false)
    expect(plan.showDemo).toBeNull()
    expect(plan.stage).toBe('declined')
    // …and the demonstration fleet is still one menu away (ruling 6).
    const ids = actionableItems(appMenu({ plan, serving: true, unsigned: true })).map((item) => item.id)
    expect(ids).toContain('demo-fleet20')
  })
})

describe('what the shell remembers', () => {
  it('starts a new run with nothing seen, nothing declined, nothing watched', () => {
    expect(readRunState(undefined)).toEqual({ seenDemo: false, declined: false, watchedRepo: null })
  })

  it('keeps stored values of the right shape and discards the rest', () => {
    expect(readRunState({ seenDemo: true, declined: 'yes', watchedRepo: 42 })).toEqual({
      seenDemo: true,
      declined: false,
      watchedRepo: null,
    })
  })

  it('survives a file that is not an object', () => {
    expect(readRunState('nope')).toEqual(NEW_RUN_STATE)
    expect(readRunState(null)).toEqual(NEW_RUN_STATE)
  })

  it('remembers only three facts — a wizard cursor here would be the shell owning the wizard', () => {
    expect(Object.keys(NEW_RUN_STATE).sort()).toEqual(['declined', 'seenDemo', 'watchedRepo'])
  })
})
