import { Menu, nativeImage, Notification, Tray } from 'electron'
import type { TrayBadge } from '../host/badge.js'
import type { HostNotification } from '../host/notify.js'
import { iconDataUrl, TEMPLATE_INK, RANK_INK } from '../host/tray-icon.js'
import { trayMenu, type TrayItemId, type TrayMenuInput, type TrayMenuItem } from '../host/tray-menu.js'

/**
 * THE TRAY, WIRED (#564, S2) — the translation layer between
 * `host/tray-menu.ts`'s data and Electron's own objects, and nothing else.
 *
 * Every decision this file might look like it makes is made elsewhere: which
 * items exist and which are enabled (`tray-menu.ts`), what the badge says
 * (`badge.ts`), what the icon looks like (`tray-icon.ts`), whether a
 * notification is raised at all (`notify.ts`). What is left is `new Tray`,
 * `Menu.buildFromTemplate` and `new Notification`, which is the correct amount
 * of untestable code for a tray: none of it can be wrong without one of the
 * tested modules being wrong first.
 */

export type TrayAction = (id: TrayItemId) => void

export interface TrayHandle {
  update(input: TrayMenuInput): void
  notify(notification: HostNotification, onClick: () => void): void
  destroy(): void
}

/**
 * macOS renders a tray image as a *template*: black-and-alpha, tinted by the
 * system to match the menu bar, light or dark. Handing it our own hue there
 * produces a washed-out blob; handing Linux or Windows a black icon produces an
 * invisible one on a dark taskbar. So the ink is per-platform and the shape
 * never is — which is exactly `sigils.tsx`' rule, applied where hue is not ours.
 */
function iconFor(badge: TrayBadge, platform: string) {
  const template = platform === 'darwin'
  const image = nativeImage.createFromDataURL(iconDataUrl(badge.shape, template ? TEMPLATE_INK : RANK_INK[badge.rank]))
  if (template) image.setTemplateImage(true)
  return image
}

export function createTray(initial: TrayMenuInput, onAction: TrayAction, platform: string = process.platform): TrayHandle {
  const tray = new Tray(iconFor(initial.badge, platform))

  const apply = (input: TrayMenuInput): void => {
    tray.setImage(iconFor(input.badge, platform))
    tray.setToolTip(input.badge.tooltip)
    // macOS is the only platform with room for a word beside the icon, and the
    // menu bar is the one place a person reads text at this size. The mark is
    // empty at rest, so a calm fleet adds nothing to the bar.
    if (platform === 'darwin') tray.setTitle(input.badge.mark)
    tray.setContextMenu(Menu.buildFromTemplate(toTemplate(trayMenu(input), onAction)))
  }

  apply(initial)

  return {
    update: apply,
    notify: (notification, onClick) => {
      if (!Notification.isSupported()) return
      const shown = new Notification({ title: notification.title, body: notification.body })
      shown.on('click', onClick)
      shown.show()
    },
    destroy: () => tray.destroy(),
  }
}

function toTemplate(items: readonly TrayMenuItem[], onAction: TrayAction): Electron.MenuItemConstructorOptions[] {
  return items.map((item) => {
    if (item.kind === 'separator') return { type: 'separator' }
    if (item.kind === 'submenu') {
      return { label: item.label, enabled: item.enabled, submenu: toTemplate(item.items ?? [], onAction) }
    }
    return {
      label: item.label,
      enabled: item.enabled,
      type: item.kind === 'checkbox' ? 'checkbox' : 'normal',
      checked: item.checked,
      click: () => onAction(item.id as TrayItemId),
    }
  })
}
