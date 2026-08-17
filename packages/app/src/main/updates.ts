import {
  mayDownload,
  relaunchDecision,
  unavailableUpdates,
  type UpdateState,
} from '../host/update-gate.js'

/**
 * THE UPDATER (#564, prd-34 ruling 3 and **S3**) — wired, gated, and currently
 * reporting `unavailable` on purpose.
 *
 * ## What is built
 *
 * The whole path: a state machine (`update-gate.ts`), the gate that refuses
 * every automatic relaunch, the quiet note the tray shows, and the loader
 * below that adopts `electron-updater` the moment there is a feed to point it
 * at. What is *not* built is a feed, because ruling 9 deferred signing and an
 * unsigned build has nothing to check against — macOS auto-update requires a
 * signed app outright.
 *
 * ## Why `electron-updater` is a dynamic import and not a dependency
 *
 * It would be a lockfile entry, a transitive tree and seven CI installs for a
 * module that cannot do anything until a signing decision is made and a feed
 * exists. So it is loaded by name at runtime if it happens to be installed, and
 * its absence is reported as `unavailable` **with the reason** rather than as
 * silence. That is the same posture the collectors take toward a missing tool:
 * say what is not there and why, never let an absence read as an all-clear.
 *
 * When signing is paid for, the change here is two lines — a dependency and a
 * feed URL — and every state, gate and note this module already has keeps
 * working. That is what ruling 9's "signing is configuration rather than
 * rework" means in this file.
 *
 * ## The one law
 *
 * **No update path relaunches the app.** Not gated on whether the fleet is
 * live: refused outright, for every automatic caller, always. See
 * `update-gate.ts` for the argument — and `update-gate.test.ts`, which is
 * #564's "a test asserts no update path can relaunch while the fleet is live",
 * proved in the stronger form.
 */

/** The slice of `electron-updater` this app would use. Declared here so no dependency is needed to typecheck it. */
interface AutoUpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  checkForUpdates(): Promise<unknown>
  on(event: 'update-downloaded', listener: (info: { version?: string }) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

export interface UpdaterOptions {
  /** The feed's base URL. Null while signing is deferred — and null is why this reports `unavailable`. */
  feedUrl: string | null
  /** Whether a person left automatic downloads on. */
  downloadAutomatically: boolean
  onState: (state: UpdateState) => void
  /** Injected so a test can hand back a fake updater, or nothing at all. */
  load?: (specifier: string) => Promise<unknown>
}

export class Updater {
  private state: UpdateState = unavailableUpdates()

  constructor(private readonly options: UpdaterOptions) {}

  current(): UpdateState {
    return this.state
  }

  /**
   * Starts the updater, or explains why there is none. Never throws: an app
   * that failed to boot because its optional updater was missing would be the
   * worst possible trade.
   */
  async start(): Promise<UpdateState> {
    if (this.options.feedUrl === null) return this.emit(unavailableUpdates())

    const updater = await this.loadUpdater()
    if (updater === null) {
      return this.emit({
        phase: 'unavailable',
        version: null,
        detail: 'electron-updater is not installed in this build',
        unsigned: true,
      })
    }

    updater.autoDownload = mayDownload(this.state, this.options.downloadAutomatically)
    // The one line that would otherwise restart the app on its own. Electron's
    // updater installs on quit by default; the gate refuses every automatic
    // relaunch, and this is the same refusal said to the library.
    updater.autoInstallOnAppQuit = false

    updater.on('update-downloaded', (info) => {
      this.emit({ phase: 'ready', version: info.version ?? null, detail: null, unsigned: true })
    })
    updater.on('error', (error) => {
      // S3: a failed check retries silently and is surfaced only where someone
      // went looking. This state reaches the tray's own line and nothing else.
      this.emit({ phase: 'failed', version: null, detail: error.message, unsigned: true })
    })

    this.emit({ phase: 'checking', version: null, detail: null, unsigned: true })
    try {
      await updater.checkForUpdates()
    } catch (error) {
      return this.emit({
        phase: 'failed',
        version: null,
        detail: error instanceof Error ? error.message : String(error),
        unsigned: true,
      })
    }
    return this.state
  }

  /** A person asked to apply a ready update. The gate answers; this reports what it said. */
  applyNow(fleetLive: boolean): { allowed: boolean; why: string } {
    return relaunchDecision({ state: this.state, requester: 'person', fleetLive })
  }

  private async loadUpdater(): Promise<AutoUpdaterLike | null> {
    const load = this.options.load ?? ((specifier: string) => import(/* @vite-ignore */ specifier))
    try {
      const module = (await load('electron-updater')) as { autoUpdater?: AutoUpdaterLike }
      return module.autoUpdater ?? null
    } catch {
      return null
    }
  }

  private emit(state: UpdateState): UpdateState {
    this.state = state
    this.options.onState(state)
    return state
  }
}
