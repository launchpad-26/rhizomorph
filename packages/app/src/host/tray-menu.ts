import type { TrayBadge } from './badge.js'
import { DEMO_LABEL } from './demo-mode.js'
import type { HostPreferences } from './prefs.js'
import type { ServerPhase } from './supervisor.js'
import { updateNote, type UpdateState } from './update-gate.js'

/**
 * THE TRAY MENU, AS DATA (#564, **S2**: "the tray menu offers open, settings,
 * demo mode, and quit").
 *
 * A `Menu.buildFromTemplate` call is untestable and a menu is exactly the place
 * a promise quietly goes missing — the quit item that only appears in one
 * branch, the demo entry that disappears when the server is down, the
 * launch-on-login checkbox that reads the wrong preference. So the menu is
 * computed here and `main/tray.ts` only translates it.
 *
 * Three things the states below are careful about:
 *
 * - **Quit is always present and always enabled.** S2 says quitting is explicit
 *   and from the tray; a tray whose quit item can be disabled by a state is a
 *   process a person cannot get rid of.
 * - **Demo mode is a first-class entry, and it is an act rather than a setting**
 *   (ruling 6: "reachable from the menu at any time"). It carries no checkbox
 *   and no preference — the simulated/real distinction is on prd-35 ruling 2's
 *   never-configurable list, so there is deliberately nothing here that could
 *   dim its chrome. It follows the server for the same reason `Settings…`
 *   does: the fixture fleets live in the SPA, and the SPA is what the server
 *   serves. Offering them over a failure page would be a menu item that lies.
 * - **The header is a reading, not a decoration.** It shows the rung the badge
 *   is showing, so a person who cannot read a 16px glyph gets the same answer
 *   in words.
 */

export type TrayItemId =
  | 'header'
  | 'open'
  | 'demo'
  | 'demo-fleet'
  | 'demo-pathology'
  | 'demo-live'
  | 'settings'
  | 'update'
  | 'launch-on-login'
  | 'close-to-tray'
  | 'quit'

export interface TrayMenuItem {
  id: TrayItemId | `separator-${number}`
  label: string
  kind: 'normal' | 'separator' | 'checkbox' | 'submenu'
  enabled: boolean
  checked?: boolean
  items?: TrayMenuItem[]
}

export interface TrayMenuInput {
  badge: TrayBadge
  serverPhase: ServerPhase
  preferences: HostPreferences
  updates: UpdateState
}

export function trayMenu(input: TrayMenuInput): TrayMenuItem[] {
  const serving = input.serverPhase === 'running'

  return [
    { id: 'header', label: input.badge.tooltip, kind: 'normal', enabled: false },
    { id: 'separator-1', label: '', kind: 'separator', enabled: true },
    {
      id: 'open',
      label: 'Open rhizomorph',
      kind: 'normal',
      // A window with nothing to show is still worth opening: it shows the
      // honest failure page, which is the only place the reason lives.
      enabled: true,
    },
    {
      id: 'settings',
      label: 'Settings…',
      kind: 'normal',
      // Settings is a route in the SPA, and the SPA is served by the server.
      // Offering it while nothing is served would open a window on a failure
      // page under a label that promised settings.
      enabled: serving,
    },
    {
      id: 'demo',
      label: 'Demonstration fleet',
      kind: 'submenu',
      enabled: true,
      items: [
        { id: 'demo-fleet', label: DEMO_LABEL.fleet20, kind: 'normal', enabled: serving },
        { id: 'demo-pathology', label: DEMO_LABEL.pathology, kind: 'normal', enabled: serving },
        { id: 'demo-live', label: DEMO_LABEL.live, kind: 'normal', enabled: serving },
      ],
    },
    { id: 'separator-2', label: '', kind: 'separator', enabled: true },
    {
      id: 'update',
      label: updateNote(input.updates),
      kind: 'normal',
      // Clickable only when clicking does something: applying a ready update.
      // Every other phase is a reading, and a reading you can press is a button
      // that lies about being one.
      enabled: input.updates.phase === 'ready',
    },
    {
      id: 'launch-on-login',
      label: 'Start when I log in',
      kind: 'checkbox',
      enabled: true,
      checked: input.preferences['application.launchOnLogin'],
    },
    {
      id: 'close-to-tray',
      label: 'Closing the window leaves the fleet watching',
      kind: 'checkbox',
      enabled: true,
      checked: input.preferences['application.closeToTray'],
    },
    { id: 'separator-3', label: '', kind: 'separator', enabled: true },
    { id: 'quit', label: 'Quit rhizomorph', kind: 'normal', enabled: true },
  ]
}

/**
 * Every id a click can actually reach, submenus included. A submenu's own row
 * is not one of them — it opens a list, it does not act — which is why the
 * parent is `demo` and the thing that acts is `demo-fleet` beneath it.
 */
export function actionableIds(items: readonly TrayMenuItem[]): string[] {
  return items.flatMap((item) => {
    if (item.kind === 'separator') return []
    if (item.kind === 'submenu') return actionableIds(item.items ?? [])
    return item.enabled ? [item.id] : []
  })
}
