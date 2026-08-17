import { Menu } from 'electron'
import { appMenu, type AppMenuId, type AppMenuInput, type AppMenuItem } from '../host/app-menu.js'

/**
 * THE APPLICATION MENU, WIRED (#565) — the translation from
 * `host/app-menu.ts`'s data into Electron's own template, and nothing else.
 *
 * Which items exist, which are enabled, where each one goes and whether the
 * standing invitation is offered are all decided in `app-menu.ts`, under a law
 * that holds every destination against the SPA's own router. What is left here
 * is `Menu.buildFromTemplate`.
 *
 * The whole menu hangs under one top-level entry rather than being scattered
 * across File/Edit/View, because it has one subject: the instrument. Electron
 * gives macOS an application menu whether we ask or not; the first submenu on
 * every platform is this one, so the standing invitation is in the same place
 * in all three.
 */

export type MenuAction = (id: AppMenuId) => void

export function installAppMenu(input: AppMenuInput, onAction: MenuAction): void {
  const items = toTemplate(appMenu(input), onAction)

  const template: Electron.MenuItemConstructorOptions[] = [
    { label: 'rhizomorph', submenu: items },
    // Copy/paste in the window are the operating system's job, not ours: an app
    // that dropped the edit menu would silently break ⌘C in the SPA's own text
    // fields. `role`s, so every platform gets its own correct accelerators.
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }],
    },
  ]

  // macOS reads the FIRST submenu as the application menu and puts it under the
  // app's name; every other platform draws the bar as given. Same items either
  // way — this is only about where the OS expects them, which is why there is
  // no per-platform branch here.
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function toTemplate(items: readonly AppMenuItem[], onAction: MenuAction): Electron.MenuItemConstructorOptions[] {
  return items.map((item) => {
    if (item.kind === 'separator') return { type: 'separator' }
    if (item.kind === 'label') return { label: item.label, enabled: false }
    if (item.kind === 'submenu') return { label: item.label, submenu: toTemplate(item.items ?? [], onAction) }
    return {
      label: item.label,
      enabled: item.enabled,
      click: () => onAction(item.id as AppMenuId),
    }
  })
}
