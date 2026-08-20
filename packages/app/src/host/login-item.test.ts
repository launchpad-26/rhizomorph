import { describe, expect, it } from 'vitest'
import { BRIDGE_CHANNELS, HOST_CAPABILITIES } from './bridge-contract.js'
import { AUTOSTART_BASENAME, honestCapabilities, loginItemPlan, type LoginItemInput } from './login-item.js'
import { DEFAULT_PREFERENCES, HOST_PREFS } from './prefs.js'

const PACKAGED_LINUX: LoginItemInput = {
  platform: 'linux',
  openAtLogin: true,
  packaged: true,
  homeDir: '/home/operator',
  execPath: '/opt/rhizomorph/rhizomorph',
  appName: 'rhizomorph',
}

describe('launch on login', () => {
  it('the preference it implements is declared, and still defaults to off — offered, never imposed', () => {
    // #564 wired this for macOS and Windows. Linux advertised the capability
    // and silently did nothing, because `setLoginItemSettings` is a no-op
    // there. This test is the join between the declaration and the effect: if
    // either side is removed, it fails rather than leaving a switch that saves
    // and lies.
    expect(HOST_PREFS.map((p) => p.id)).toContain('application.launchOnLogin')
    expect(DEFAULT_PREFERENCES['application.launchOnLogin']).toBe(false)
  })

  it('uses the real OS API on macOS and Windows, and writes no file', () => {
    for (const platform of ['darwin', 'win32']) {
      const plan = loginItemPlan({ ...PACKAGED_LINUX, platform })
      expect(plan.mechanism).toBe('electron')
      expect(plan.supported).toBe(true)
      expect(plan.reason).toBeNull()
      expect(plan.desktopFile).toBeNull()
    }
  })

  it('uses XDG autostart on Linux, because setLoginItemSettings is a silent no-op there', () => {
    const plan = loginItemPlan(PACKAGED_LINUX)
    expect(plan.mechanism).toBe('xdg-autostart')
    expect(plan.supported).toBe(true)
    expect(plan.desktopFile?.path).toBe(`/home/operator/.config/autostart/${AUTOSTART_BASENAME}`)
    const contents = plan.desktopFile?.contents ?? ''
    expect(contents).toContain('[Desktop Entry]')
    expect(contents).toContain('Type=Application')
    expect(contents).toContain('Name=rhizomorph')
    expect(contents).toContain('Exec=/opt/rhizomorph/rhizomorph --hidden')
    expect(contents).toContain('X-GNOME-Autostart-enabled=true')
  })

  it('honours XDG_CONFIG_HOME over ~/.config, as the spec requires', () => {
    const plan = loginItemPlan({ ...PACKAGED_LINUX, xdgConfigHome: '/home/operator/.myconfig' })
    expect(plan.desktopFile?.path).toBe(`/home/operator/.myconfig/autostart/${AUTOSTART_BASENAME}`)
  })

  it('names the same file whether turning it on or off — otherwise off could never find what on wrote', () => {
    const on = loginItemPlan({ ...PACKAGED_LINUX, openAtLogin: true })
    const off = loginItemPlan({ ...PACKAGED_LINUX, openAtLogin: false })
    expect(off.desktopFile?.path).toBe(on.desktopFile?.path)
  })

  it('a launch-on-login start comes up hidden, so logging in does not throw a window at you', () => {
    expect(loginItemPlan(PACKAGED_LINUX).desktopFile?.contents).toContain('--hidden')
  })

  it('refuses in a development build, and says why rather than silently doing nothing', () => {
    const plan = loginItemPlan({ ...PACKAGED_LINUX, packaged: false })
    expect(plan.supported).toBe(false)
    expect(plan.mechanism).toBe('unsupported')
    expect(plan.reason).toMatch(/installed app/)
    expect(plan.desktopFile).toBeNull()
  })

  it('refuses an unknown platform by name, rather than pretending', () => {
    const plan = loginItemPlan({ ...PACKAGED_LINUX, platform: 'aix' })
    expect(plan.supported).toBe(false)
    expect(plan.reason).toContain('aix')
  })
})

describe('capabilities are reported honestly, not declared', () => {
  it('drops launch-on-login when this build cannot honour it', () => {
    const unsupported = loginItemPlan({ ...PACKAGED_LINUX, packaged: false })
    const got = honestCapabilities(HOST_CAPABILITIES, { loginItem: unsupported, updatesAvailable: true })
    expect(got).not.toContain('launch-on-login')
    // and keeps the ones that are still true
    expect(got).toContain('notifications')
    expect(got).toContain('tray-badge')
  })

  it('drops updates while there is no feed — ruling 9 defers signing, so the switch must not be offered', () => {
    const plan = loginItemPlan(PACKAGED_LINUX)
    const got = honestCapabilities(HOST_CAPABILITIES, { loginItem: plan, updatesAvailable: false })
    expect(got).not.toContain('updates')
    expect(got).toContain('launch-on-login')
  })

  it('a packaged build with a feed reports the full declared set — the filter is not vacuously subtractive', () => {
    const plan = loginItemPlan(PACKAGED_LINUX)
    const got = honestCapabilities(HOST_CAPABILITIES, { loginItem: plan, updatesAvailable: true })
    expect(got).toEqual([...HOST_CAPABILITIES])
  })

  it('the bridge still declares the channel settings reads this through', () => {
    // A guard on the seam: if the channel is renamed, the settings surface
    // silently loses every one of these controls.
    expect(BRIDGE_CHANNELS.setPreference).toBe('rhizomorph:host:set-preference')
    expect(BRIDGE_CHANNELS.describe).toBe('rhizomorph:host:describe')
  })
})
