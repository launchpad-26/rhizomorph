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
| `src/host/` | everything that could be wrong: paths, spawn arguments, output parsing, supervision, window frame. Pure, node-environment, no `electron` import anywhere. |
| `src/main/` | the Electron wiring. The only place `electron` is imported. |

The split is why this package is testable at all — a main process is not, so
nothing that can be decided is decided there.

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
