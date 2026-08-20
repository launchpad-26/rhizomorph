import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import type { AppMenuId } from '../host/app-menu.js'
import { badgeFor, unreachableBadge, type TrayBadge } from '../host/badge.js'
import { BRIDGE_CHANNELS, HOST_CAPABILITIES, type HostDescription } from '../host/bridge-contract.js'
import type { FleetDigest } from '../host/digest.js'
import { failurePage } from '../host/failure-page.js'
import { fetchChunks, fetchJson, FleetFeed } from '../host/fleet-feed.js'
import { findRepoRoot, resolveLayout, type HostLayout } from '../host/layout.js'
import { pageHostDescriptor } from '../host/host-descriptor.js'
import { honestCapabilities, loginItemPlan, type LoginItemPlan } from '../host/login-item.js'
import { firstRunPlan, withDemoSeen, withInvitationTaken, withRepo, type FirstRunPlan, type RunState } from '../host/first-run.js'
import { decideNotifications } from '../host/notify.js'
import { loadRunState, saveRunState } from '../host/run-state-file.js'
import { signingPlan, unsignedNote } from '../host/signing.js'
import { loadPreferences, savePreferences } from '../host/prefs-file.js'
import { withPreference, type HostPreferences } from '../host/prefs.js'
import { serverSpawnRequest } from '../host/spawn-contract.js'
import { ServerSupervisor, type ChildLike, type ServerStatus } from '../host/supervisor.js'
import {
  DEMO_ATTEMPTS,
  DEMO_RETRY_MS,
  DEMO_VERIFY_SCRIPT,
  demoDispatchScript,
  expectSimulated,
  type DemoSource,
} from '../host/demo-mode.js'
import { unavailableUpdates, type UpdateState } from '../host/update-gate.js'
import { startsHidden, windowFrame } from '../host/window-frame.js'
import { installAppMenu } from './menu.js'
import { createTray, type TrayHandle } from './tray.js'
import { Updater } from './updates.js'

/**
 * THE SHELL (prd-34 rulings 1 and 2; #563, #564) — the whole Electron surface
 * of this package, and deliberately the only file in it that imports
 * `electron`.
 *
 * Everything that could be got wrong lives in `../host/`, pure and tested:
 * where the server is, how it is started, what its output means, what to do
 * when it dies, how big the window is, what the badge says, which notifications
 * fire, what the tray menu contains, whether an update may relaunch. What is
 * left here is wiring, which is what an untestable file should be made of.
 *
 * **#564 changed what this file is.** In wave 1 the window was the app: closing
 * it quit. It is now the other way round — the fleet is a background fact with
 * a window. Closing the window hides it, the watcher keeps running, the tray
 * stays lit, and quitting is an explicit act from the tray. That inversion is
 * the whole of ruling 2, and it shows up here as three things: a `quitting`
 * flag that separates "the person asked to quit" from "a window closed", a
 * `window-all-closed` that does nothing, and a `close` handler that hides.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))

/**
 * `RHIZOMORPH_REPO` is a development convenience with no packaged equivalent
 * and no settings entry: unset, the shell passes no repo at all and the server
 * applies its own default (the process cwd — `parseArgs`). **Which repo a
 * packaged app watches is #565's question**, answered by the first-run path and
 * the concierge's own picker, not by an environment variable a stranger would
 * have to know about.
 */
function chosenRepo(): string | null {
  const declared = process.env.RHIZOMORPH_REPO
  return declared !== undefined && declared.trim() !== '' ? path.resolve(declared.trim()) : null
}

function layoutFor(): HostLayout | null {
  if (app.isPackaged) {
    return resolveLayout({ packaged: true, resourcesPath: process.resourcesPath, repoRoot: '' })
  }
  const repoRoot = findRepoRoot(HERE, existsSync)
  if (repoRoot === null) return null
  return resolveLayout({ packaged: false, resourcesPath: '', repoRoot })
}

let mainWindow: BrowserWindow | null = null
let supervisor: ServerSupervisor | null = null
let tray: TrayHandle | null = null
let feed: FleetFeed | null = null
let updater: Updater | null = null
let lastStatus: ServerStatus = { phase: 'starting', url: null, detail: null, outputTail: [] }
let digest: FleetDigest | null = null
let badge: TrayBadge = unreachableBadge('the server has not started yet')
let updates: UpdateState = unavailableUpdates()
/** True only between a person choosing Quit and the process ending. Closing a window never sets it. */
let quitting = false
const repoPath = chosenRepo()

let preferences: HostPreferences = { ...loadPreferences(app.getPath('userData')).preferences }
let runState: RunState = { ...loadRunState(app.getPath('userData')).state }

/**
 * #565: the shell's whole contribution to first run is a plan — which fixture
 * to open on, and whether the standing invitation is being urged. The wizard
 * itself is `packages/web/src/connect/wizard.tsx`'s, driven rather than forked
 * (ruling 7), and the menu can only navigate to it.
 */
let plan: FirstRunPlan = firstRunPlan(runState, repoPath !== null)

/** True while builds ship unsigned — ruling 9's deferral, read from the environment rather than assumed. */
const signing = signingPlan(process.env, platformFamily())

function platformFamily(): 'mac' | 'win' | 'linux' {
  if (process.platform === 'darwin') return 'mac'
  if (process.platform === 'win32') return 'win'
  return 'linux'
}

// ── the window ──────────────────────────────────────────────────────────────

/**
 * The app icon, for the window and the taskbar.
 *
 * A packaged build gets this from the bundle — electron-builder derives every
 * platform's format from `build/icon.png` — but a development run and a Linux
 * window both take it from `BrowserWindow`, and without it the window wears
 * Electron's own atom. Resolved rather than assumed, and omitted if absent, so
 * a build with no icon still opens a window.
 */
function windowIcon(): string | undefined {
  const candidate = path.join(HERE, '..', '..', 'build', 'icon.png')
  return existsSync(candidate) ? candidate : undefined
}

function createWindow(): BrowserWindow {
  const frame = windowFrame()
  const icon = windowIcon()
  const window = new BrowserWindow({
    width: frame.width,
    height: frame.height,
    minWidth: frame.minWidth,
    minHeight: frame.minHeight,
    backgroundColor: frame.backgroundColor,
    show: frame.show,
    title: frame.title,
    ...(icon === undefined ? {} : { icon }),
    webPreferences: {
      // The page is the instrument's own SPA over loopback, and it needs
      // nothing from Node. Everything below is the closed posture: no Node in
      // the renderer, an isolated context, and the sandbox on. prd-34 changes
      // no trust boundary, and this is where that is either true or not. The
      // preload adds exactly three IPC calls, all of them the shell's own
      // preferences — see `preload.ts`.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      preload: path.join(HERE, 'preload.cjs'),
    },
  })

  // A fresh window has rendered nothing yet, whatever the previous one showed.
  renderedKey = null

  // A launch from the login item comes up to the tray instead of throwing a
  // window at someone who just logged in — `--hidden`, which the autostart
  // entry passes. Every other launch shows on `ready-to-show` as before, and
  // the tray's Open still works either way because the window exists, hidden.
  if (!startsHidden(process.argv)) window.once('ready-to-show', () => window.show())

  // A link to anywhere else is the operating system's business, not this
  // window's: the shell is a frame around one loopback origin, and a window
  // that could be navigated to the open web is a browser nobody asked for.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // Ruling 2, in one handler: closing the window leaves the watcher running and
  // the tray lit. The window is hidden rather than destroyed so reopening is
  // instant and the session is uninterrupted — S2's acceptance is exactly
  // "closing and reopening shows an uninterrupted session", and a destroyed
  // window would reload the SPA and lose its scroll, its selection and its
  // panel state.
  window.on('close', (event) => {
    if (quitting || !preferences['application.closeToTray']) return
    event.preventDefault()
    window.hide()
  })

  window.on('closed', () => {
    mainWindow = null
  })

  return window
}

/** Opens the window if it exists, creates it if it does not, and puts it in front either way. */
function showWindow(route?: string): void {
  if (mainWindow === null || mainWindow.isDestroyed()) {
    mainWindow = createWindow()
    void showStatus(mainWindow, lastStatus)
  }
  if (route !== undefined && lastStatus.phase === 'running' && lastStatus.url !== null) {
    renderedKey = `route:${route}`
    void mainWindow.loadURL(`${lastStatus.url}${route}`).catch((error: unknown) => {
      process.stderr.write(`rhizomorph: could not open ${route} — ${String(error)}\n`)
    })
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/**
 * Every status change, on stderr, in one line — the same habit
 * `bin/rhizomorph.mjs` already has ("running … (dist is built)"). A desktop app
 * hides its terminal, which is exactly why the terminal must still be told: it
 * is the only channel a person has when the window itself is the thing that did
 * not appear, and it is what a support answer asks for first.
 */
function announce(status: ServerStatus): void {
  if (status.phase === 'running') process.stderr.write(`rhizomorph: the instrument is at ${status.url}\n`)
  else if (status.phase === 'failed') process.stderr.write(`rhizomorph: the server did not start — ${status.detail}\n`)
  else if (status.phase === 'stopped') process.stderr.write('rhizomorph: the server has stopped\n')
}

/** The last thing rendered, so one status never navigates the window twice. */
let renderedKey: string | null = null

/** Two statuses are the same render when they say the same thing, not merely when they share a phase. */
function renderKey(status: ServerStatus): string {
  return `${status.phase}|${status.url ?? ''}|${status.detail ?? ''}`
}

/**
 * What the window shows: the instrument when there is one, the honest failure
 * when there is not (D43).
 *
 * **Two things here are scar tissue from the first real launch**, and both are
 * the same shape — a navigation is not a function call, and treating it as one
 * is what produced an `ERR_ABORTED (-3)` unhandled rejection on every boot:
 *
 * 1. *Render once per status.* `boot()` used to render the status it awaited
 *    AND `onStatus` rendered the same status a tick earlier, so two `loadURL`
 *    calls raced for one window; Electron aborts the older navigation and
 *    rejects its promise. Superseding a load is normal — the guard is here,
 *    at the one place that navigates, rather than at each caller.
 * 2. *Never reject.* Every call site is `void showStatus(...)`, so a rejection
 *    is an unhandled one by construction. A window that could not be
 *    navigated is worth a line on stderr and nothing more: the shell is still
 *    up, the tray is still there, and throwing out of a status handler would
 *    take down the process the failure page exists to keep alive.
 */
async function showStatus(window: BrowserWindow, status: ServerStatus): Promise<void> {
  if (status.phase === 'stopped') return
  const key = renderKey(status)
  if (key === renderedKey) return
  renderedKey = key

  const target =
    status.phase === 'running' && status.url !== null
      ? status.url
      : `data:text/html;charset=utf-8,${encodeURIComponent(
          failurePage({ status, at: new Date().toISOString(), repoPath }),
        )}`

  try {
    await window.loadURL(target)
    if (status.phase === 'running') applyPlan(window)
  } catch (error) {
    renderedKey = null
    process.stderr.write(`rhizomorph: the window could not load ${status.phase} — ${String(error)}\n`)
  }
}

// ── first run (#565) ────────────────────────────────────────────────────────

/**
 * The plan, applied to a window that has just loaded the instrument.
 *
 * The demonstration fleet is summoned the one way this shell can summon one —
 * by pressing the page's own key (`demo-mode.ts`) — so the SPA's own permanent
 * chrome arrives with it. There is deliberately no other channel: a shell that
 * folded the fixture itself would produce exactly the screenshot ruling 6
 * forbids.
 */
function applyPlan(window: BrowserWindow): void {
  if (plan.showDemo === null) return
  const source = plan.showDemo
  // Said BEFORE the plan is recomputed: this is the reason the demonstration
  // fleet is on screen right now. Announcing the recomputed plan instead — the
  // first version of this — reported the reason the NEXT launch would have, so
  // a genuine first launch logged "…the demonstration fleet again".
  process.stderr.write(`rhizomorph: ${plan.why}\n`)
  // `openDemo` against this window rather than `driveDemo`, which would raise
  // and focus a window that is already the one in front.
  void openDemo(window, source)
  runState = withDemoSeen(runState)
  persistRunState()
  plan = firstRunPlan(runState, repoPath !== null)
  refreshMenu()
}

function persistRunState(): void {
  const problem = saveRunState(app.getPath('userData'), runState)
  if (problem !== null) process.stderr.write(`rhizomorph: ${problem}\n`)
}

function refreshMenu(): void {
  installAppMenu(
    { plan, serving: lastStatus.phase === 'running', unsigned: !signing.enabled },
    onMenuAction,
  )
}

function onMenuAction(id: AppMenuId): void {
  switch (id) {
    case 'open':
      showWindow()
      return
    case 'watch-my-repo':
      // The invitation is taken: the shell stops opening on the demonstration
      // fleet and hands over to `/connect`, which owns repo choice. Nothing
      // about the repo is decided here — the wizard's outcome is observed on
      // the next launch, not assumed now.
      runState = withInvitationTaken(runState)
      persistRunState()
      plan = firstRunPlan(runState, repoPath !== null)
      showWindow('/connect')
      refreshMenu()
      return
    case 'settings':
      showWindow('/settings')
      return
    case 'demo-fleet20':
      driveDemo('fleet20')
      return
    case 'demo-pathology':
      driveDemo('pathology')
      return
    case 'demo-live':
      driveDemo('live')
      return
    case 'about-unsigned':
      // The honest instructions themselves, opened in whatever reads Markdown
      // on this machine — the same file the installer ships beside the app.
      void openInstallNotes()
      return
    case 'quit':
      quit()
      return
    default:
      return
  }
}

async function openInstallNotes(): Promise<void> {
  const layout = layoutFor()
  const notes =
    layout === null
      ? null
      : layout.packaged
        ? path.join(layout.root, 'INSTALL.md')
        : path.join(layout.root, 'packages', 'app', 'INSTALL.md')
  if (notes === null) return
  const problem = await shell.openPath(notes)
  if (problem !== '') process.stderr.write(`rhizomorph: could not open ${notes} — ${problem}\n`)
}

// ── the tray ────────────────────────────────────────────────────────────────

function trayInput() {
  return { badge, serverPhase: lastStatus.phase, preferences, updates }
}

function refreshTray(): void {
  tray?.update(trayInput())
}

/**
 * Demo mode, driven through the affordance the SPA already has.
 *
 * `StreamContext.tsx`'s `useFixtureKeys` switches the driving log on `1`/`2`/`3`
 * and has since #411 documented the keys on screen. The tray therefore *presses
 * the key* rather than growing its own channel into the page: no IPC, no new
 * route, no second copy of the fixture list, and — the part that matters — the
 * SPA's own permanent demo chrome comes with it, because the shell has not gone
 * around it. Ruling 6's screenshot rule survives precisely because the shell
 * has no way to switch a fixture on without the banner that says so.
 */
function driveDemo(source: DemoSource): void {
  showWindow()
  if (mainWindow !== null && !mainWindow.isDestroyed()) void openDemo(mainWindow, source)
}

/**
 * Raises the page's own keydown, then reads the page back to check it took —
 * `demo-mode.ts` has the whole argument, and the packaged-build failure that
 * made a blind keypress unacceptable.
 *
 * Returns whether the page ended up where it was asked to go, and says so on
 * stderr when it did not: on a first launch this is the only thing standing
 * between a stranger and an empty instrument.
 */
async function openDemo(window: BrowserWindow, source: DemoSource): Promise<boolean> {
  const wanted = expectSimulated(source)
  for (let attempt = 0; attempt < DEMO_ATTEMPTS; attempt += 1) {
    if (window.isDestroyed()) return false
    try {
      await window.webContents.executeJavaScript(demoDispatchScript(source), true)
      const simulated = await window.webContents.executeJavaScript(DEMO_VERIFY_SCRIPT, true)
      if (simulated === wanted) return true
    } catch (error) {
      // A navigation mid-dispatch destroys the execution context. That is a
      // retry, not a failure.
      if (window.isDestroyed()) return false
      process.stderr.write(`rhizomorph: demonstration fleet, attempt ${attempt + 1}: ${String(error)}\n`)
    }
    await new Promise((resolve) => setTimeout(resolve, DEMO_RETRY_MS))
  }
  process.stderr.write(
    `rhizomorph: could not open the ${source} log — the page did not take the keypress after ${DEMO_ATTEMPTS} attempts\n`,
  )
  return false
}

function onTrayAction(id: string): void {
  switch (id) {
    case 'open':
      showWindow()
      return
    case 'settings':
      showWindow('/settings')
      return
    case 'demo-fleet':
      driveDemo('fleet20')
      return
    case 'demo-pathology':
      driveDemo('pathology')
      return
    case 'demo-live':
      driveDemo('live')
      return
    case 'update': {
      const decision = updater?.applyNow(fleetIsLive()) ?? { allowed: false, why: 'there is no updater in this build' }
      process.stderr.write(`rhizomorph: ${decision.why}\n`)
      if (decision.allowed) quit()
      return
    }
    case 'launch-on-login':
      applyPreference('application.launchOnLogin', !preferences['application.launchOnLogin'])
      return
    case 'close-to-tray':
      applyPreference('application.closeToTray', !preferences['application.closeToTray'])
      return
    case 'quit':
      quit()
      return
    default:
      return
  }
}

/** True while the instrument is watching something: a running server with lanes in the fold. */
function fleetIsLive(): boolean {
  return lastStatus.phase === 'running' && (digest?.laneCount ?? 0) > 0
}

// ── preferences ─────────────────────────────────────────────────────────────

function applyPreference(id: string, value: unknown): { preferences: HostPreferences; refused: string | null } {
  const result = withPreference(preferences, id, value)
  if (result.refused !== null) return { preferences, refused: result.refused }
  preferences = result.preferences

  const problem = savePreferences(app.getPath('userData'), preferences)
  if (problem !== null) process.stderr.write(`rhizomorph: ${problem}\n`)

  // Launch-on-login is the one preference that lives outside this app: it is a
  // login item the operating system owns, so the value is not "remembered", it
  // is *applied*. Written on every change rather than only at boot, so turning
  // it off takes effect without a restart.
  if (id === 'application.launchOnLogin') {
    const problem = applyLoginItem(preferences['application.launchOnLogin'])
    if (problem !== null) {
      // Report it and keep the stored value honest: a preference that could not
      // be applied must not read as applied next time settings opens it.
      preferences = withPreference(preferences, id, !value).preferences
      savePreferences(app.getPath('userData'), preferences)
      refreshTray()
      return { preferences, refused: problem }
    }
  }

  refreshTray()
  return { preferences, refused: null }
}

/**
 * Applies the login item, or says why it could not.
 *
 * macOS and Windows have an API for this; Linux has a `.desktop` file in the
 * XDG autostart directory and NO api — `setLoginItemSettings` is documented as
 * macOS/Windows only and does nothing at all there. Calling it on Linux is what
 * made this switch save and lie on a packaged `.deb`.
 */
/** The login-item plan for this build, at the current preference. One place, so the applier and both descriptors cannot disagree. */
function currentLoginItemPlan(openAtLogin = preferences['application.launchOnLogin']): LoginItemPlan {
  return loginItemPlan({
    platform: process.platform,
    openAtLogin,
    packaged: app.isPackaged,
    homeDir: app.getPath('home'),
    xdgConfigHome: process.env.XDG_CONFIG_HOME,
    execPath: process.execPath,
    appName: app.getName(),
  })
}

function applyLoginItem(openAtLogin: boolean): string | null {
  const plan = currentLoginItemPlan(openAtLogin)

  if (!plan.supported) return plan.reason
  if (plan.mechanism === 'electron') {
    app.setLoginItemSettings({ openAtLogin })
    return null
  }

  const file = plan.desktopFile
  if (file === null) return 'launch on login has no mechanism on this platform'
  try {
    if (openAtLogin) {
      mkdirSync(path.dirname(file.path), { recursive: true })
      writeFileSync(file.path, file.contents, { mode: 0o644 })
    } else {
      // `force` so turning it off when it was never on is not an error — the
      // desired end state is "no autostart file", and it is already true.
      rmSync(file.path, { force: true })
    }
    return null
  } catch (error) {
    return `could not ${openAtLogin ? 'write' : 'remove'} ${file.path}: ${String(error)}`
  }
}

function describeHost(): HostDescription {
  return {
    version: app.getVersion(),
    platform: process.platform,
    // Reported, never assumed — and now computed from the same plan that does
    // the applying, rather than from `isPackaged` alone. That gap is what let a
    // packaged Linux build advertise `launch-on-login`, render the switch, and
    // never start at login: `setLoginItemSettings` is a no-op there, which the
    // old comment here said and the old filter did not act on.
    capabilities: honestCapabilities(HOST_CAPABILITIES, {
      loginItem: currentLoginItemPlan(),
      updatesAvailable: updates.phase !== 'unavailable',
    }) as HostDescription['capabilities'],
  }
}

// ── the fleet feed ──────────────────────────────────────────────────────────

function startFeed(baseUrl: string): void {
  feed?.stop()
  feed = new FleetFeed({
    baseUrl,
    chunks: fetchChunks,
    json: fetchJson,
    now: Date.now,
    onDigest: (next) => {
      // Notifications are decided from the transition, the badge from the rung.
      // They read the same digest and cannot disagree — and the badge is
      // computed with no reference to a preference at all, which is what makes
      // "a muted condition still moves the badge" structural rather than
      // careful (ruling 8).
      for (const notification of decideNotifications(digest, next, preferences)) {
        tray?.notify(notification, () => showWindow())
      }
      digest = next
      badge = badgeFor(next.rank)
      refreshTray()
    },
    onConnection: (phase, detail) => {
      if (phase !== 'lost') return
      // S2's *server unreachable*: the shell survives and says so. Not calm —
      // a quiet tray over an instrument that is not there is the one lie this
      // badge must never tell.
      digest = null
      badge = unreachableBadge(detail ?? 'the stream closed')
      refreshTray()
    },
  })
  feed.start()
}

// ── boot ────────────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  mainWindow = createWindow()
  tray = createTray(trayInput(), onTrayAction)
  refreshMenu()

  const note = unsignedNote(signing)
  if (note !== null) process.stderr.write(`rhizomorph: ${note}\n`)

  updater = new Updater({
    // Null until ruling 9's deferral ends: an unsigned build has no feed to
    // check against, and `updates.ts` reports that rather than pretending.
    feedUrl: null,
    downloadAutomatically: preferences['updates.downloadAutomatically'],
    onState: (state) => {
      updates = state
      refreshTray()
    },
  })
  void updater.start()

  const layout = layoutFor()
  if (layout === null) {
    await showStatus(mainWindow, {
      phase: 'failed',
      url: null,
      detail: `could not find the instrument: no packages/server/bin/rhizomorph.mjs above ${HERE}`,
      outputTail: [],
    })
    return
  }

  supervisor = new ServerSupervisor({
    spawn: (request) =>
      spawn(request.command, request.args, {
        env: request.env,
        cwd: request.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      }) as ChildLike,
    onStatus: (status) => {
      lastStatus = status
      announce(status)
      if (status.phase === 'running' && status.url !== null) startFeed(status.url)
      if (status.phase !== 'running') {
        feed?.stop()
        digest = null
        badge = unreachableBadge(status.detail ?? 'the server is not running')
      }
      refreshTray()
      refreshMenu()
      if (mainWindow !== null && !mainWindow.isDestroyed()) void showStatus(mainWindow, status)
    },
  })

  const status = await supervisor.start(
    serverSpawnRequest({
      execPath: process.execPath,
      serverEntry: layout.serverEntry,
      repoPath,
      env: process.env,
    }),
  )
  // No render here: `onStatus` above already fired for this exact status, and
  // rendering it a second time is the aborted-navigation race described on
  // `showStatus`.
  lastStatus = status

  // What this launch ended up watching, remembered for the next one. Written
  // from `repoPath` rather than inferred from the fold: the fold's repo is the
  // server's answer, and a shell that recorded it would start claiming to be
  // configured because a server defaulted to a cwd nobody chose.
  if (runState.watchedRepo !== repoPath) {
    runState = withRepo(runState, repoPath)
    persistRunState()
  }
}

// A second launch is a person looking for the window they already have, not a
// request for a second watcher on the same repo — two servers would record two
// sessions of one run.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())

  // Synchronous, and the one channel that is. `settings/host.ts` reads the
  // descriptor off the global while it builds the registry, so it cannot await
  // — see `BRIDGE_CHANNELS.descriptor`.
  ipcMain.on(BRIDGE_CHANNELS.descriptor, (event) => {
    event.returnValue = pageHostDescriptor({
      loginItem: currentLoginItemPlan(),
      updatesAvailable: updates.phase !== 'unavailable',
      trayPresent: tray !== null,
    })
  })

  ipcMain.handle(BRIDGE_CHANNELS.describe, () => describeHost())
  ipcMain.handle(BRIDGE_CHANNELS.getPreferences, () => preferences)
  ipcMain.handle(BRIDGE_CHANNELS.setPreference, (_event, id: string, value: unknown) => applyPreference(id, value))

  app.whenReady().then(boot, (error: unknown) => {
    process.stderr.write(`rhizomorph: the shell failed to start: ${String(error)}\n`)
  })

  app.on('activate', () => showWindow())

  app.on('window-all-closed', () => {
    // Ruling 2, and the reason this handler is empty on every platform rather
    // than only on macOS: the fleet is a background fact with a window. The
    // watcher keeps running, the tray stays lit, and the only way out is the
    // tray's own Quit — which is what "quitting is explicit" means.
  })

  app.on('before-quit', (event) => {
    quitting = true
    if (supervisor === null || supervisor.current().phase === 'stopped') return
    // The server holds a session lock and releases it on SIGTERM. Quitting
    // without waiting for that leaves a lock behind that the next boot has to
    // wait out — so the quit is deferred exactly once, for as long as the
    // shutdown takes.
    event.preventDefault()
    void stopServerThen(() => app.quit())
  })

  // A quit from the desktop is not the only way this process ends. A terminal
  // `SIGINT`/`SIGTERM` — how it is run in development, and how a session
  // manager stops it at logout — would otherwise leave the child holding the
  // port and the session lock, so both route through the same shutdown the
  // menu does.
  //
  // **They are not reliable, and that is measured rather than assumed.** Under
  // WSLg with Electron 43, Chromium's own POSIX handlers take `SIGTERM` and no
  // main-process JavaScript runs at all — see `supervisor.ts`'s `killNow` for
  // the probe and for what is left unclosed. These handlers are still correct
  // where the platform does deliver the signal; `process.on('exit')` below is
  // the backstop for every path that reaches a normal exit.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      quitting = true
      void stopServerThen(() => app.exit(0))
    })
  }

  // The last synchronous word. Nothing may await here, so this is a bare
  // `SIGTERM` at the child rather than the graceful stop above — which has
  // already run on every path that got the chance.
  process.on('exit', () => supervisor?.killNow())
}

/** The explicit quit ruling 2 asks for: from the tray, and from nowhere else in this app. */
function quit(): void {
  quitting = true
  app.quit()
}

/**
 * Stops the server exactly once, however many times a quit is asked for, then
 * runs `after`. Idempotence matters because `before-quit` and a signal can both
 * arrive — a second `stop()` would `SIGTERM` a pid that has already gone and,
 * worse, `app.quit()` twice re-enters `before-quit`.
 */
let stopping: Promise<void> | null = null
function stopServerThen(after: () => void): Promise<void> {
  stopping ??= (async () => {
    feed?.stop()
    tray?.destroy()
    await supervisor?.stop()
  })().catch((error: unknown) => {
    process.stderr.write(`rhizomorph: the server did not stop cleanly — ${String(error)}\n`)
  })
  return stopping.then(after)
}
