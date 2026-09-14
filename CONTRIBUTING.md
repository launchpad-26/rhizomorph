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
`npm run lint` are green — that's the bar `.github/workflows/ci.yml` used to
check on every push and pull request, and `Build` runs *ahead* of `Test` on every leg
(the `Build` step precedes `Test`), so a bundle that no longer builds fails in front of the suite
rather than behind it. CI checks two more things the local four do not: a
packaging guard (the `Packaging guard` step, `scripts/packaging-guard.mjs`) that fails if `npm pack` would ship anything
outside its allowlist, and a boot smoke test (the `Boot smoke` step, `scripts/boot-smoke.sh` — start the server, hit
`/api/meta` and `/`, shut it down cleanly). Lint is a required CI step
(the `Lint` step), not an optional tidy-up: skipping it locally means finding out in
CI.

There is also a **second job**, `pack-smoke` (`scripts/pack-smoke.sh`), which packs the repo
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

### Where that bar is checked now

**GitHub Actions is off on this repo.** All four workflows are disabled — the
bill reached 45,209 minutes over eleven days — so a pull request gets no check
runs at all, and the red rollup still sitting on the older ones is the billing
failure, not your change. Do not read either as a verdict.

The same leg runs on an operator's machine instead. `scripts/ci-local.sh` is
`ci.yml` composed as a script: the same steps, the same order, the same gating
(`Typecheck` and `Lint` still run after a red suite; the packaging guard and
the boot smoke are still held behind a green `Build`, because both report green
over an empty `dist/`). `scripts/gate.sh` runs the same five checks before it
merges, so nothing lands without them.

`scripts/ci-local.sh --pr <n>` publishes what it found back onto the pull
request, as two marks that are not interchangeable:

- **the `Passed local CI` label.** Visible in the PR list and in search, and
  pinned to *nothing* — push one commit after a green run and the label goes on
  claiming a result for a tree nobody tested.
- **a `local-ci (<platform>)` commit status on the head sha.** Per-sha by
  construction, so it appears in the check box and goes quiet the moment the
  label starts lying. This is the mark to trust, and it is the one that says
  which platform.

That last part is permanent, not a transitional caveat. `ci.yml` ran ubuntu and
macOS at two Node versions and `windows-suite.yml` ran a native Windows suite;
one operator machine is one of those. A green `local-ci (Darwin)` with no Linux
or Windows row beside it is evidence about macOS and **silence** about the other
two — `packages/web/src/disclosure/case-collision-law.test.ts` exists because a macOS
leg caught sixteen failures Linux cannot see. Write which platform. Never write
"CI passed".

`scripts/pr-verdict.sh` is what does the posting, and it refuses rather than
marking something it cannot stand behind: a PR that is not open, a `HEAD` that
is not the PR's head sha, or a dirty working tree. It refuses **before** the
leg runs, so finding out costs a second instead of a suite. `--pr` also refuses
`--no-install` and `--no-pack-smoke` — a label that says the full leg passed
when two of its steps were skipped is a claim wider than its evidence.

## `gh` calls in this repo's own scripts retry a transient network fault

`scripts/dev/gh-retry.sh` wraps a single `gh` invocation and retries it once,
immediately, when it failed before ever reaching the network — see that
file's header for the measurement: on at least one contributor
machine, a DNS proxy returns malformed response packets that Go's resolver
(and so `gh`) treats as `no such host` on roughly half of every call, while
glibc tools on the same host (`curl`, `git`, `dig`-on-retry) are unaffected.
The failure alternates rather than clustering, so one immediate retry
recovers it; retrying the *script* around several `gh` calls does not, since
a compound of n calls still succeeds at p^n regardless of how many times the
whole thing is retried. `scripts/dev/issues.sh` sources it and calls
`gh_retry` in place of `gh` throughout.

**Three error messages are the same fault, reported three different ways,**
because `gh` itself makes internal API calls to decide what to tell you:

| what you see | why |
|---|---|
| `error connecting to api.github.com` | the direct connection failure |
| `unknown owner type` | `gh` needed a network call to learn whether an owner is a user or an org, and that call is what failed |
| `API rate limit already exceeded` with quota actually remaining | `gh`'s own rate-limit bookkeeping call failed the same way and it misreports the cause |

**The one-command check that tells them apart from a real failure:**

```sh
curl -sS https://api.github.com/rate_limit
```

No auth needed — this only has to prove `curl` reaches `api.github.com`,
which the unauthenticated endpoint answers just as well (and `-sS`, not
`-s`, so a genuine `curl` failure still prints its own error instead of an
empty screen). An earlier draft here authenticated with
`-H "Authorization: token $(gh auth token)"`, which works but puts the token
in `curl`'s argv — visible to anyone on the same machine via `ps`, in a doc
a public repo hands every contributor. Not needed for what this check is for.

`curl` uses glibc's resolver and is unaffected by this fault. If it succeeds
while a `gh` call in the same window fails or reports one of the three
messages above, the fault is this one — the network is fine, `gh`'s own
attempt to reach it wasn't. If `curl` also fails, the problem is real and no
retry (in `gh-retry.sh` or anywhere else) should paper over it.

`gh_retry` retries the first two messages, and deliberately still not the
third. `unknown owner type` is genuinely ambiguous — measured (EXECUTED,
repeated, this worktree): a real nonexistent owner and this fault produce
byte-*identical* plain stderr, so no text-based check can tell them apart —
but it is cheap and bounded to retry anyway: one extra `gh` call, and a
genuine bad owner still fails identically on the second attempt, reaching
the caller with the same honest message just one call later. That call site
(`fetch_board`'s `gh project item-list --owner`) sits under nearly every
write in `scripts/dev/issues.sh`, so leaving it unretried left board
operations "effectively unusable" — the issue's own words — even after every
other call site was fixed. A real rate limit is a different calculus: unlike
a bad owner, retrying it is *guaranteed* to fail again and spends real quota
doing it, working against the caller rather than costing one wasted round
trip — so it still needs the `curl` check above, run by a human, rather than
a blind retry.

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
