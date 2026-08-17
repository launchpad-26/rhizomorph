# @rhizomorph/app — the desktop shell

The instrument, as software a stranger installs (prd-34). This package **spawns
the existing server and embeds the existing SPA**, and does nothing else: there
is no forked copy of either, no shell-only branch inside them, and no route,
view or reducer of its own. `src/host/no-fork.ts` is that promise as four
detectors, and `no-fork-law.test.ts` runs them over the real package on every
suite.

```
electron main ──spawn──▶ packages/server/bin/rhizomorph.mjs --port 0
      │                            │
      │        "rhizomorph running at http://127.0.0.1:<port>"
      │◀───────────────────────────┘
      └──loadURL──▶ the SPA the server is already serving
```

The capability token is **not** in that URL and is not passed on the command
line: ADR-0012 delivers it in-band in `index.html`, so the window performs the
same handshake a browser tab does. The shell mints no credential and carries
none, and `boot-line.ts` refuses to load any URL that is not loopback.

## Layout

| path | what it is |
|---|---|
| `src/host/` | everything that could be wrong: paths, spawn arguments, output parsing, supervision, window frame, the badge, the notifications, the tray menu, the update gate. Pure, node-environment, no `electron` import anywhere. |
| `src/main/` | the Electron wiring. `entry.ts` is the only place `electron` is imported (plus `tray.ts` and `preload.ts`, which are translation). |

The split is why this package is testable at all — a main process is not, so
nothing that can be decided is decided there.

## The daemon

The fleet is a background fact with a window. Closing the window hides it and
leaves the watcher running; quitting is explicit, from the tray.

The tray reads **the same derived fleet the window reads** — `/api/stream`,
folded with `@rhizomorph/core`'s own `parseEvent`/`reduce`, derived with its own
`buildFleet`. `stream-fold.test.ts` asserts the shell's fleet object equals the
one the window would build from the same events, because a badge that disagreed
with the instrument would be worse than no badge.

Four notifications — a lane needs a human · a lane died · work landed · spend
crossed a threshold you set — each individually toggleable. **Muting stops the
interruption and never the badge**: `badgeFor()` takes a rung and nothing else,
so there is no argument through which a preference could reach it.

## The bridge, for the settings surface

The shell's own preferences (the four notifications, the threshold,
launch-on-login, close-to-tray, automatic downloads) live in the host, because
the process that draws the tray is the process that must know them. prd-35's
Application and Notifications groups are where a person meets them, so the shell
**exposes** and settings **reads**:

```ts
const host = (window as { rhizomorphHost?: HostBridge }).rhizomorphHost
if (host === undefined) return null            // a browser tab: no tray, no login item
const { capabilities } = await host.describe() // render only what this build can honour
const preferences = await host.getPreferences()
await host.setPreference('notifications.died', false)
```

`src/host/bridge-contract.ts` is the whole contract — the global's name, the
three channels, the shapes — and `bridge-law.test.ts` holds the preload to it.
The absence of the global is the feature: a browser tab has no tray to badge and
no login item to set, and rendering those controls anyway would be four switches
that do nothing.

## Updates

Built, gated, and currently reporting `unavailable` on purpose: ruling 9 defers
signing, so there is no feed to check against and saying "up to date" would be a
claim about a check that never ran. `electron-updater` is loaded by name at
runtime if present rather than carried in the lockfile for a path that cannot
act yet.

**No update path relaunches the app** — refused for every automatic caller, on a
quiet fleet as well as a live one. A person may restart to apply.

## Running it in development

```sh
npm run build                     # server + web + this package's main bundle
RHIZOMORPH_REPO=$PWD npm start --workspace packages/app
```

`RHIZOMORPH_REPO` is a development convenience with no packaged equivalent:
unset, the server applies its own default (the process cwd). Which repo an
installed app watches is the first-run path's answer (#565), not an environment
variable's.

## What CI does and does not do with this package

`npm run build` at the repo root bundles `src/main/entry.ts` with esbuild, on
every CI leg, so the shell is compiled on ubuntu and macOS like everything else.
Nothing in CI *launches* Electron — `ELECTRON_SKIP_BINARY_DOWNLOAD=1` is set
workflow-wide, so the ~110 MB platform binary is downloaded only where it is
actually used. The npm package ships the server and the SPA and never this
package; the root `files` allowlist and CI's packaging guard both hold that.
