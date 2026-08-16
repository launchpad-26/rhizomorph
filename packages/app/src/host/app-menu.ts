import { DEMO_LABEL, type DemoSource } from './demo-mode.js'
import type { FirstRunPlan } from './first-run.js'

/**
 * THE APPLICATION MENU (#565; prd-34 rulings 5, 6 and 7).
 *
 * The tray is where the daemon lives (#564); this is where the *doorstep*
 * lives. It carries S1's **one standing invitation** to watch a real repo, and
 * ruling 6's permanent route into demo mode — both on the menu bar, where a
 * stranger looks, rather than only in a tray a stranger has not learned yet.
 *
 * ## Every item is a destination or an act. None is a control.
 *
 * Ruling 7 divides the ground: *settings changes things, `/connect` proves
 * things*, and the wizard "drives both and reimplements neither". A shell menu
 * is a very easy place to break that — one "Repository…" item with a folder
 * picker and the shell owns repo choice, in a dialog nobody can test, beside a
 * `/connect` that owns the same thing and disagrees.
 *
 * So the menu has exactly two kinds of item that do anything: a **route** into
 * a surface the SPA already owns, and an **act** on the shell itself (open,
 * quit, demo). `app-menu.test.ts` reads `packages/web/src/app/router.ts` and
 * fails if any route here is one the SPA does not have — so the shell can only
 * point at surfaces that exist, and a renamed route breaks a test here rather
 * than a menu item at a stranger's first launch.
 *
 * There is no `kind: 'field'`, no `prompt`, no dialog. The type is the fence.
 */

export type AppMenuKind = 'route' | 'act' | 'submenu' | 'separator' | 'label'

export type AppMenuId =
  | 'open'
  | 'watch-my-repo'
  | 'settings'
  | 'demo'
  | 'demo-live'
  | 'demo-fleet20'
  | 'demo-pathology'
  | 'invitation'
  | 'about-unsigned'
  | 'quit'

export interface AppMenuItem {
  id: AppMenuId | `separator-${number}`
  label: string
  kind: AppMenuKind
  /** For `route` items only: the SPA path to open. Held against the SPA's own router by the law. */
  route?: string
  /** For the demo acts: which log to drive. */
  source?: DemoSource
  enabled: boolean
  items?: AppMenuItem[]
}

export interface AppMenuInput {
  plan: FirstRunPlan
  /** True while the instrument is being served — a route into a page nobody is serving is a menu item that lies. */
  serving: boolean
  /** True while builds are unsigned (prd-34 ruling 9), which is what puts the honest note on the menu. */
  unsigned: boolean
}

/** The one place the invitation is spelled. S1 says one; this is it. */
export const INVITATION_LABEL = 'Watch my own repo…'

export function appMenu(input: AppMenuInput): AppMenuItem[] {
  const serving = input.serving

  return [
    { id: 'open', label: 'Open rhizomorph', kind: 'act', enabled: true },
    { id: 'separator-1', label: '', kind: 'separator', enabled: true },
    // The standing invitation, and the reason it is a route rather than a
    // picker: the concierge's repo picker and connect's verification rows are
    // the surface that owns this, and the shell drives them (ruling 7).
    { id: 'watch-my-repo', label: INVITATION_LABEL, kind: 'route', route: '/connect', enabled: serving },
    { id: 'settings', label: 'Settings…', kind: 'route', route: '/settings', enabled: serving },
    { id: 'separator-2', label: '', kind: 'separator', enabled: true },
    {
      id: 'demo',
      label: 'Demonstration fleet',
      kind: 'submenu',
      enabled: true,
      items: [
        { id: 'demo-fleet20', label: DEMO_LABEL.fleet20, kind: 'act', source: 'fleet20', enabled: serving },
        { id: 'demo-pathology', label: DEMO_LABEL.pathology, kind: 'act', source: 'pathology', enabled: serving },
        { id: 'demo-live', label: DEMO_LABEL.live, kind: 'act', source: 'live', enabled: serving },
      ],
    },
    ...(input.plan.invite
      ? [
          { id: 'separator-3' as const, label: '', kind: 'separator' as const, enabled: true },
          // Not a control and not a step: the plan's own sentence, shown as a
          // disabled line, so the reason the demo is on screen is legible in
          // the same place the way out of it is.
          { id: 'invitation' as const, label: input.plan.why, kind: 'label' as const, enabled: false },
        ]
      : []),
    ...(input.unsigned
      ? [
          {
            id: 'about-unsigned' as const,
            label: 'Why does my system warn about this app?',
            kind: 'act' as const,
            enabled: true,
          },
        ]
      : []),
    { id: 'separator-4', label: '', kind: 'separator', enabled: true },
    { id: 'quit', label: 'Quit rhizomorph', kind: 'act', enabled: true },
  ]
}

/** Every route this menu can navigate to — what the law holds against the SPA's router. */
export function routesOf(items: readonly AppMenuItem[]): string[] {
  return items.flatMap((item) => [
    ...(item.route === undefined ? [] : [item.route]),
    ...routesOf(item.items ?? []),
  ])
}

/** Every item that does something when pressed. */
export function actionableItems(items: readonly AppMenuItem[]): AppMenuItem[] {
  return items.flatMap((item) => {
    if (item.kind === 'separator' || item.kind === 'label') return []
    if (item.kind === 'submenu') return actionableItems(item.items ?? [])
    return item.enabled ? [item] : []
  })
}
