# Contributing

Released as-is — see the note in [README.md](README.md#maintenance). This
file is about the mechanics: how to run things, and the standard a change
has to clear.

## Running it

**Check your Node version first.** `package.json`'s `engines` requires
**Node >= 22.22.2**, and CI pins that exact minimum — so a machine on an older
Node is not a machine this suite has ever been green on:

```sh
node --version        # must be >= 22.22.2
```

On Node 20 every test file in the `web` workspace fails to start its worker with
`TypeError: webidl.util.markAsUncloneable is not a function`, thrown from
`undici` by way of `jsdom` — one function that only exists in Node 22.

**The danger is not that it fails, it's that it looks like it passed.** The
counts describe only the files that ran, and the files that never started are
reported separately as errors, one per file — so a run that silently skipped
**about half the suite** still prints a wall of green:

```
Test Files  <that started> passed      # <- NOT the whole suite
     Tests  <in those files> passed    # <- ditto
    Errors  <n> errors                 # <- n = web test files that never booted
```

The tell is the **exit code**, not the counts: green figures and a non-zero
exit. Compare `Test Files` against the real total — if `passed` plus `errors`
equals it, the difference never ran and none of `web`'s behaviour was checked at
all. On a supported Node the same command finishes with **exit 0 and no errors
line**.

If you see that shape, upgrade Node rather than debugging the tests, and don't
trust any "all green" measured on the older one.

```sh
npm install
npm test              # vitest, all workspaces
npm run typecheck     # tsc --noEmit, all workspaces
npm run lint          # biome lint (linter only — the formatter is disabled)
npm run build         # bundles the server CLI, builds the web dashboard
npm start             # boots collectors + API, serving the build above
```

`npm run dev:web` and `npm run dev:server` run the web and server packages
in watch mode individually, if you're working on one side.

## The gate standard

A change is done when `npm test` and `npm run typecheck` are green — that's
the bar CI (`.github/workflows/ci.yml`) checks on every push and pull
request, alongside a boot smoke test (start the server, hit `/api/meta` and
`/`, shut it down cleanly).

For anything that touches tests, green isn't measured in isolation: this
project's own build process ran suites **4x concurrently, beside whatever
else was running at the time**, because a quiet-machine green had already
been caught lying once — a suite that passed 12/12 against an idle box
failed 11/12 the moment it ran beside real concurrent load, on suite-wide
fixture-cost timeouts that had nothing to do with the diff that exposed
them. A test that only survives a quiet machine is a latent flake sitting
in the suite waiting for a bad day. If you're touching test-heavy code and
can run a few suites concurrently before you call it done, do — that's the
condition the gate actually checks, not the friendlier one.

## Laws live in tests

Behavior this app depends on — a color that means exactly one thing
everywhere, a shape a pathology always draws, a channel that only ever moves
forward — is asserted in the test suite, not left to a screenshot or a
comment. Read `packages/web/src/scene/marks.test.ts` for the density of this:
dozens of assertions with names like "FROZEN pinches to nothing at two
points along its own length," each one a fact a future change is not allowed
to break by accident.

The rule for touching one: a law can be **restated at equal or greater
strength**, never weakened to make a change pass. If a change requires
loosening an assertion, the assertion was probably catching something real —
find out what before you loosen it. `docs/architecture.md`'s decisions log
has several examples of a law getting *stricter* after a bug slipped through
a version of it that was too lax to catch it.

## Releases and semver

Every user-visible change belongs in [`CHANGELOG.md`](CHANGELOG.md), Keep a
Changelog style, under an `[Unreleased]` heading until it ships. That file's
own header is the semver policy — read it before deciding whether a change
is breaking: the short version is that the CLI's flags/subcommands and the
shape of `.swarm/lanes.json` are the public contract (a major bump), while
the scene's visual grammar, internal telemetry, and the session-log format
are free to change release to release (minor or patch).

Publishing itself is a human act, done from a `v*` tag by whoever holds the
`NPM_TOKEN` — see `.github/workflows/release.yml`. Nothing in CI publishes
on a push to `main`.

## Docs

`docs/architecture.md` is the decision record — append to its decisions log
rather than editing history when a change supersedes an earlier entry.
`docs/screenshots/**` should reflect what the app actually looks like; if
your change is visible on screen, regenerate the relevant ones.
