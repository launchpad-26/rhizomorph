import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { actionableItems, appMenu, INVITATION_LABEL, routesOf, type AppMenuInput } from './app-menu.js'
import { firstRunPlan, NEW_RUN_STATE, withRepo } from './first-run.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

function menuFor(overrides: Partial<AppMenuInput> = {}) {
  return appMenu({
    plan: firstRunPlan(NEW_RUN_STATE, false),
    serving: true,
    unsigned: true,
    ...overrides,
  })
}

describe('the standing invitation (S1)', () => {
  it('is offered, exactly once, and goes to the surface that owns repo choice', () => {
    const invitations = menuFor().filter((item) => item.label === INVITATION_LABEL)
    expect(invitations).toHaveLength(1)
    expect(invitations[0]?.route).toBe('/connect')
  })

  it('is still on the menu once a repo is being watched — standing, not spent', () => {
    const configured = menuFor({ plan: firstRunPlan(withRepo(NEW_RUN_STATE, '/repo'), true) })
    expect(configured.some((item) => item.label === INVITATION_LABEL)).toBe(true)
  })

  it('says why the demonstration fleet is on screen, while it is', () => {
    const plan = firstRunPlan(NEW_RUN_STATE, false)
    const line = menuFor({ plan }).find((item) => item.kind === 'label')
    expect(line?.label).toBe(plan.why)
    expect(line?.enabled).toBe(false)
  })
})

describe('demo mode is reachable from the menu at any time (ruling 6)', () => {
  it('offers both fixtures and the way back to live', () => {
    const ids = actionableItems(menuFor()).map((item) => item.id)
    expect(ids).toContain('demo-fleet20')
    expect(ids).toContain('demo-pathology')
    expect(ids).toContain('demo-live')
  })

  it('offers them to a configured instrument too', () => {
    const ids = actionableItems(menuFor({ plan: firstRunPlan(withRepo(NEW_RUN_STATE, '/repo'), true) })).map(
      (item) => item.id,
    )
    expect(ids).toContain('demo-fleet20')
  })

  it('carries no checkbox and no preference — demo mode is an act', () => {
    for (const item of actionableItems(menuFor())) {
      expect(item.kind === 'act' || item.kind === 'route').toBe(true)
    }
  })
})

/**
 * RULING 7'S LAW, in the form this package can hold it: **the shell owns no
 * control.** Every item is a route into a surface the SPA owns or an act on the
 * shell itself — and the routes are held against the SPA's own router, so the
 * shell cannot point somewhere that does not exist and cannot quietly grow a
 * surface of its own to point at.
 */
describe('every destination is a surface the SPA already owns (#565)', () => {
  const routerSource = readFileSync(path.join(REPO_ROOT, 'packages', 'web', 'src', 'app', 'router.ts'), 'utf8')

  it('found the router to read', () => {
    expect(routerSource).toContain('export function parseRoute')
  })

  it.each(routesOf(menuFor()))('%s is a route the SPA parses', (route) => {
    // The router declares each path as a regex; `/connect` is `CONNECT_PATH`,
    // `/settings` is `SETTINGS_PATH`. A route the shell invents would match no
    // declaration and fall back to the balcony — a menu item that silently
    // goes somewhere else.
    const name = route.replace('/', '')
    expect(routerSource).toContain(`const ${name.toUpperCase()}_PATH = /^\\/${name}\\/?$/`)
    expect(routerSource).toContain(`return { name: '${name}' }`)
  })

  it('points at more than nothing — an empty route list would pass the law above', () => {
    expect(routesOf(menuFor()).length).toBeGreaterThan(1)
  })

  it('has no item that takes a value: no field, no prompt, no picker', () => {
    const kinds = new Set(menuFor().flatMap((item) => [item.kind, ...(item.items ?? []).map((child) => child.kind)]))
    expect([...kinds].sort()).toEqual(['act', 'label', 'route', 'separator', 'submenu'])
  })
})

describe('what a dead server takes away', () => {
  it('withholds every route and every fixture, and keeps open and quit', () => {
    const ids = actionableItems(menuFor({ serving: false })).map((item) => item.id)
    expect(ids).not.toContain('watch-my-repo')
    expect(ids).not.toContain('settings')
    expect(ids).not.toContain('demo-fleet20')
    expect(ids).toContain('open')
    expect(ids).toContain('quit')
  })

  it('shows them disabled rather than hiding them', () => {
    const labels = menuFor({ serving: false }).map((item) => item.label)
    expect(labels).toContain(INVITATION_LABEL)
    expect(labels).toContain('Settings…')
  })
})

describe('the unsigned note (ruling 9)', () => {
  it('offers the explanation while builds are unsigned', () => {
    expect(actionableItems(menuFor({ unsigned: true })).map((item) => item.id)).toContain('about-unsigned')
  })

  it('drops it the day builds are signed', () => {
    expect(actionableItems(menuFor({ unsigned: false })).map((item) => item.id)).not.toContain('about-unsigned')
  })
})
