import path from 'node:path'

/**
 * WHERE THE SERVER IS, IN BOTH WORLDS — the one place the shell answers "which
 * file do I spawn", so a packaging change has exactly one place to be wrong.
 *
 * The shell runs in two layouts and the difference is a single root:
 *
 * - **development** — this checkout. The root is the repo root, and the entry
 *   is `packages/server/bin/rhizomorph.mjs`, the same file `npm start` runs.
 * - **packaged** — an installed app. The root is Electron's `resourcesPath`,
 *   and `electron-builder.yml` copies `packages/server/{bin,dist}` and
 *   `packages/web/dist` under it **at their repo-relative paths**.
 *
 * That mirroring is not tidiness; it is load-bearing twice over, and both
 * reasons are why {@link resolveLayout} joins the same relative segments in
 * both branches rather than carrying two different path shapes:
 *
 * 1. `run.ts`'s `defaultWebDistDir()` resolves the SPA at
 *    `<dir of the server bundle>/../../../web/dist`. Mirror the repo layout and that
 *    relative walk lands on the copied `packages/web/dist` with no flag, no
 *    env var and no shell-only branch inside `packages/server` — which is
 *    ruling 1's own "the server ships unmodified", enforced by the shape of
 *    the copy rather than by a promise.
 * 2. `bin/rhizomorph.mjs` prefers `../dist/cli/index.js` and falls back to
 *    `../src` only when it exists. A packaged app copies no `src/`, so the bin
 *    runs the built bundle — and still prints the line naming which entry it
 *    ran, so a mispackaged build says so on its first boot instead of being
 *    silently the wrong code.
 *
 * The bin is the entry in both worlds on purpose. `dist/cli/index.js` only
 * *exports* `runCli`; the bin is what calls it, installs the signal handlers,
 * and reports a stale build. A packaged shell that reimplemented those three
 * things would be the forked server-code path ruling 1 forbids.
 */

/** The repo-relative segments of every file the shell needs, from the root of whichever world it is in. */
export const SERVER_ENTRY_SEGMENTS = ['packages', 'server', 'bin', 'rhizomorph.mjs'] as const
export const SERVER_BUNDLE_SEGMENTS = ['packages', 'server', 'dist', 'cli', 'index.js'] as const
export const WEB_DIST_SEGMENTS = ['packages', 'web', 'dist'] as const

export interface HostLayout {
  /** True when running from an installed app rather than this checkout. */
  packaged: boolean
  /** The root the three paths below hang off — repo root, or `resourcesPath`. */
  root: string
  /** The file the shell spawns. Always the server's own bin. */
  serverEntry: string
  /** The built bundle that bin prefers. The shell never spawns this directly — it is here so a preflight can say it is missing. */
  serverBundle: string
  /** The SPA the server serves. The shell never serves it and never reads it — it is here for the same preflight. */
  webDist: string
}

export interface LayoutInput {
  packaged: boolean
  /** Electron's `process.resourcesPath`. Read only when packaged. */
  resourcesPath: string
  /** The repo root this checkout lives at. Read only when unpackaged. */
  repoRoot: string
}

export function resolveLayout(input: LayoutInput): HostLayout {
  const root = input.packaged ? input.resourcesPath : input.repoRoot
  return {
    packaged: input.packaged,
    root,
    serverEntry: path.join(root, ...SERVER_ENTRY_SEGMENTS),
    serverBundle: path.join(root, ...SERVER_BUNDLE_SEGMENTS),
    webDist: path.join(root, ...WEB_DIST_SEGMENTS),
  }
}

/**
 * The repo root, found by walking up from `startDir` until a directory holds
 * the server's own bin. Used only in the unpackaged branch — a packaged app
 * never asks, because its `__dirname` is inside an asar archive and would
 * answer confidently and wrongly.
 *
 * **A count of `..` segments would be wrong half the time**, which is why this
 * searches instead: the same module runs from `packages/app/src/main/` under
 * vitest and tsx, and from `packages/app/dist/` once esbuild has bundled it —
 * two different depths, one of which would silently resolve to the directory
 * *above* the repo and hand the spawner a path that does not exist.
 *
 * Returns `null` rather than a guess when the walk reaches the filesystem root:
 * the caller's next act is spawning a process, and a wrong root there produces
 * a confusing ENOENT instead of "I could not find the server, and here is where
 * I looked".
 */
export function findRepoRoot(startDir: string, exists: (candidate: string) => boolean): string | null {
  let dir = path.resolve(startDir)
  for (;;) {
    if (exists(path.join(dir, ...SERVER_ENTRY_SEGMENTS))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}
