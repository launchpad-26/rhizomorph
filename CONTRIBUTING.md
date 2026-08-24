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

**You will not get far on the wrong one** (#403). `.npmrc` sets
`engine-strict=true`, so `npm install` *refuses* rather than warning, naming the
required range and the version you are on. `.nvmrc` holds the same floor, so
`nvm use` / `fnm use` switches to it without your having to read this section at
all. The rest of this section describes what used to happen, and what still
happens if you get past the install some other way — it is kept because the
failure shape is the one this repo cares most about.

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

The tell is the **`Errors` line existing at all**, under green counts and a
non-zero exit. On a supported Node the same command finishes with **exit 0 and
no `Errors` line**, so you never need to know the suite's real total to spot
this: any `Errors` count is test files that never booted, and none of the
behaviour in them was checked.

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

A change is done when `npm run build`, `npm test`, `npm run typecheck` and
`npm run lint` are green — that's the bar CI (`.github/workflows/ci.yml`) checks
on every push and pull request, and `Build` runs *ahead* of `Test` on every leg
(`ci.yml:60`), so a bundle that no longer builds fails in front of the suite
rather than behind it. CI checks two more things the local four do not: a
packaging guard (`ci.yml:72`) that fails if `npm pack` would ship anything
outside its allowlist, and a boot smoke test (`ci.yml:97` — start the server, hit
`/api/meta` and `/`, shut it down cleanly). Lint is a required CI step
(`ci.yml:69`), not an optional tidy-up: skipping it locally means finding out in
CI.

There is also a **second job**, `pack-smoke` (`ci.yml:166`), which packs the repo
the way a release would, installs the tarball into a project that has never heard
of this checkout, and runs the CLI from those installed files — on both operating
systems and both the declared-minimum and the current Node. None of what it
checks is reachable from the four commands above, so a change to what actually
ships (`package.json`'s `files`, a `bin` path, a runtime import that only
resolves inside this checkout) is a change whose verification lives there or
nowhere — `scripts/pack-smoke.sh` is the same script, if you want it locally.

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

A decision goes where `AGENTS.md`'s authority map sends it, and that map is the
one to follow: `docs/adr/` for structure, contracts, formats and where authority
lives — read `docs/adr/README.md` before writing one, and note that the log is
append-only, so a changed mind gets a *new* record superseding the old rather than
an edit to the old one; `docs/design-notes/` for the rationale behind a single
value, formula or visual form, cited directly from the code comment that needs it;
`docs/prds/` for product scope and behaviour. `docs/architecture.md` is the
running account of how the system got here, and its `## Decisions log` is where a
superseding entry is appended rather than editing history — append to it, but
don't mistake it for the place a structural decision is first made.

`docs/screenshots/**` should reflect what the app actually looks like; if
your change is visible on screen, regenerate the relevant ones.
