import path from 'node:path'

/**
 * LAUNCH ON LOGIN (prd-34 ruling 2's third clause) — the decision, pure.
 *
 * ## What was wrong — on one platform
 *
 * #564 built this properly for macOS and Windows: `applyPreference` calls
 * `app.setLoginItemSettings` on every change, and `describeHost` withholds the
 * capability from an unpackaged build. Both are right and neither is changed
 * here.
 *
 * **Linux was the hole.** `setLoginItemSettings` is documented as macOS and
 * Windows only, and on Linux it is a silent no-op — while the capability filter
 * asked `app.isPackaged` and nothing else. So a packaged `.deb` or AppImage
 * advertised `launch-on-login`, rendered the switch in settings, saved the
 * value, survived a restart, and never started at login. `describeHost`'s own
 * comment already said "a no-op on a Linux build with no autostart directory"
 * — the sentence was there, the filter just did not act on it.
 *
 * A switch that saves and lies is worse than an absent one, because an absent
 * control tells the truth. This module makes Linux work through the mechanism
 * Linux actually has, and makes the capability answer per-build rather than
 * per-guess.
 *
 * ## Why the decision is a pure function
 *
 * Because the honest answer is per-platform and per-build, and every one of
 * those branches is a thing to get wrong:
 *
 *  - **macOS and Windows** have a real API. `app.setLoginItemSettings` writes a
 *    LaunchAgent or a `Run` registry value, and Electron owns the details.
 *  - **Linux has no such API.** `setLoginItemSettings` is documented as
 *    macOS/Windows only, and on Linux it is a silent no-op — so calling it
 *    there would reproduce exactly the lie this module exists to end. The XDG
 *    autostart spec is the mechanism instead: a `.desktop` file in
 *    `$XDG_CONFIG_HOME/autostart/`.
 *  - **An unpackaged build cannot honour it at all.** The executable is
 *    Electron's own binary in `node_modules`, so a login item would launch a
 *    bare Electron against a `dist/main.js` that may not exist by the next
 *    login. Refused, with the reason said out loud.
 *
 * The capability list is then computed from this rather than declared, so the
 * bridge stops claiming something a given build cannot do.
 */

export type LoginItemMechanism = 'electron' | 'xdg-autostart' | 'unsupported'

export interface LoginItemPlan {
  mechanism: LoginItemMechanism
  /** Whether this build can honour the preference at all. */
  supported: boolean
  /** Null when supported. A sentence a settings surface can show when not. */
  reason: string | null
  /**
   * The autostart file to write, or to remove when `openAtLogin` is false.
   * Only ever set for `xdg-autostart`; the other mechanisms have no file.
   */
  desktopFile: { path: string; contents: string } | null
}

export interface LoginItemInput {
  /** `process.platform`. */
  platform: string
  /** The value of `application.launchOnLogin`. */
  openAtLogin: boolean
  /** `app.isPackaged`. An unpackaged build refuses — see the header. */
  packaged: boolean
  /** `app.getPath('home')`. */
  homeDir: string
  /** `process.env.XDG_CONFIG_HOME`, if set. The spec says it wins over `~/.config`. */
  xdgConfigHome?: string | undefined
  /** The executable a login item should run — `process.execPath` for a packaged app. */
  execPath: string
  /** `productName`, for the desktop entry's `Name`. */
  appName: string
}

/** The autostart filename. Stable, because turning the preference off has to find the file turning it on wrote. */
export const AUTOSTART_BASENAME = 'rhizomorph.desktop'

function autostartDir(input: LoginItemInput): string {
  const base =
    input.xdgConfigHome !== undefined && input.xdgConfigHome.trim() !== ''
      ? input.xdgConfigHome
      : path.join(input.homeDir, '.config')
  return path.join(base, 'autostart')
}

/**
 * The desktop entry.
 *
 * `X-GNOME-Autostart-enabled` is included because GNOME reads it and treats a
 * missing value as enabled — harmless, but stating it means a person editing
 * the file by hand sees the switch they are looking for. `--hidden` is passed
 * so a login start comes up to the tray rather than throwing a window at
 * someone who just logged in, which is the same courtesy close-to-tray extends.
 */
function desktopEntry(input: LoginItemInput): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    `Name=${input.appName}`,
    'Comment=Watch a fleet of coding agents',
    `Exec=${input.execPath} --hidden`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n')
}

export function loginItemPlan(input: LoginItemInput): LoginItemPlan {
  if (!input.packaged) {
    return {
      mechanism: 'unsupported',
      supported: false,
      reason:
        'launch on login needs an installed app: a development build would register Electron itself, pointed at a bundle that may not exist next time you log in',
      desktopFile: null,
    }
  }

  if (input.platform === 'darwin' || input.platform === 'win32') {
    return { mechanism: 'electron', supported: true, reason: null, desktopFile: null }
  }

  if (input.platform === 'linux') {
    return {
      mechanism: 'xdg-autostart',
      supported: true,
      reason: null,
      // The file is described either way. When `openAtLogin` is false the
      // caller removes this exact path — the contents are ignored then, and
      // returning them anyway keeps the shape of this value the same in both
      // directions rather than making the caller branch on null.
      desktopFile: { path: path.join(autostartDir(input), AUTOSTART_BASENAME), contents: desktopEntry(input) },
    }
  }

  return {
    mechanism: 'unsupported',
    supported: false,
    reason: `launch on login is not implemented for ${input.platform}`,
    desktopFile: null,
  }
}

/**
 * The capabilities this build can actually honour.
 *
 * `bridge-contract.ts` declares the full vocabulary; this narrows it to the
 * truth for one build, which is what its own comment already promised:
 * "a capability absent here must not render a control".
 *
 * `updates` is filtered on the same principle. Ruling 9 defers signing and
 * `updates.ts` reports `unavailable` with a reason — so a build with no feed
 * must not advertise the capability either, or settings renders a switch over
 * a machine that says it cannot run.
 */
export function honestCapabilities(
  declared: readonly string[],
  facts: { loginItem: LoginItemPlan; updatesAvailable: boolean },
): string[] {
  return declared.filter((capability) => {
    if (capability === 'launch-on-login') return facts.loginItem.supported
    if (capability === 'updates') return facts.updatesAvailable
    return true
  })
}
