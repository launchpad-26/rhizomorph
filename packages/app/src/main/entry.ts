import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, shell } from 'electron'
import { failurePage } from '../host/failure-page.js'
import { findRepoRoot, resolveLayout, type HostLayout } from '../host/layout.js'
import { serverSpawnRequest } from '../host/spawn-contract.js'
import { ServerSupervisor, type ChildLike, type ServerStatus } from '../host/supervisor.js'
import { windowFrame } from '../host/window-frame.js'

/**
 * THE SHELL (prd-34 ruling 1, #563) — the whole Electron surface of this
 * package, and deliberately the only file in it that imports `electron`.
 *
 * Everything this file does that could be got wrong lives in `../host/`, pure
 * and tested: where the server is (`layout.ts`), how it is started
 * (`spawn-contract.ts`), what its output means (`boot-line.ts`), what to do
 * when it dies (`supervisor.ts`, `failure-page.ts`), how big the window is
 * (`window-frame.ts`). What is left here is wiring, which is what an
 * untestable file should be made of.
 *
 * The sequence is JupyterLab Desktop's, adopted rather than re-derived:
 * **spawn the server → read the URL it prints → load that URL in a window.**
 * No token is passed and none is minted — ADR-0012 delivers the capability
 * token in-band in the page, so the window performs the same handshake a
 * browser tab does (see `boot-line.ts` for the whole argument).
 *
 * Wave 1 quits with its window, exactly as a plain app does. **Wave 2 (#564)
 * is what makes the fleet a background fact** — close-to-tray, explicit quit —
 * and it changes this file rather than growing a second one.
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
let lastStatus: ServerStatus = { phase: 'starting', url: null, detail: null, outputTail: [] }
const repoPath = chosenRepo()

function createWindow(): BrowserWindow {
  const frame = windowFrame()
  const window = new BrowserWindow({
    width: frame.width,
    height: frame.height,
    minWidth: frame.minWidth,
    minHeight: frame.minHeight,
    backgroundColor: frame.backgroundColor,
    show: frame.show,
    title: frame.title,
    webPreferences: {
      // The page is the instrument's own SPA over loopback, and it needs
      // nothing from Node. Everything below is the closed posture: no Node in
      // the renderer, an isolated context, and the sandbox on. prd-34 changes
      // no trust boundary, and this is where that is either true or not.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  })

  // A fresh window has rendered nothing yet, whatever the previous one showed.
  renderedKey = null

  window.once('ready-to-show', () => window.show())

  // A link to anywhere else is the operating system's business, not this
  // window's: the shell is a frame around one loopback origin, and a window
  // that could be navigated to the open web is a browser nobody asked for.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  window.on('closed', () => {
    mainWindow = null
  })

  return window
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
 * 1. *Render once per phase.* `boot()` used to render the status it awaited
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
  } catch (error) {
    renderedKey = null
    process.stderr.write(`rhizomorph: the window could not load ${status.phase} — ${String(error)}\n`)
  }
}

async function boot(): Promise<void> {
  mainWindow = createWindow()

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
}

// A second launch is a person looking for the window they already have, not a
// request for a second watcher on the same repo — two servers would record two
// sessions of one run.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow === null) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(boot, (error: unknown) => {
    process.stderr.write(`rhizomorph: the shell failed to start: ${String(error)}\n`)
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length > 0) return
    mainWindow = createWindow()
    void showStatus(mainWindow, lastStatus)
  })

  app.on('window-all-closed', () => {
    // Wave 1's behaviour, replaced by #564's tray: for now the window IS the
    // app, on every platform including macOS — a shell that lingered with no
    // window and no tray icon would be a process a person cannot see or quit.
    app.quit()
  })

  app.on('before-quit', (event) => {
    if (supervisor === null || supervisor.current().phase === 'stopped') return
    // The server holds a session lock and releases it on SIGTERM. Quitting
    // without waiting for that leaves a lock behind that the next boot has to
    // wait out — so the quit is deferred exactly once, for as long as the
    // shutdown takes.
    event.preventDefault()
    void stopServerThen(() => app.quit())
  })

  // A quit from the desktop is not the only way this process ends. A terminal
  // `SIGTERM` (how it is run in development, and how a session manager stops it
  // at logout) does not raise `before-quit` on its own, and the child would
  // then outlive the shell holding the port and the session lock. Both signals
  // route through the same shutdown as the menu does.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void stopServerThen(() => app.exit(0))
    })
  }
}

/**
 * Stops the server exactly once, however many times a quit is asked for, then
 * runs `after`. Idempotence matters because `before-quit` and a signal can both
 * arrive — a second `stop()` would `SIGTERM` a pid that has already gone and,
 * worse, `app.quit()` twice re-enters `before-quit`.
 */
let stopping: Promise<void> | null = null
function stopServerThen(after: () => void): Promise<void> {
  stopping ??= (supervisor?.stop() ?? Promise.resolve()).catch((error: unknown) => {
    process.stderr.write(`rhizomorph: the server did not stop cleanly — ${String(error)}\n`)
  })
  return stopping.then(after)
}
