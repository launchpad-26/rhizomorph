# Testing strategy, coverage, and quality review

**Reviewer:** `gpt-5.6-sol`, `xhigh` — testing strategy agent  
**Date:** 2026-08-06  
**Scope:** test architecture, coverage, CI, fixtures, mocks, browser/system realism,
security contracts, performance testing, flakiness, accessibility, and missing test
categories

## Verdict

Rhizomorph has an unusually deep and thoughtful semantic test suite: 227 test files and
3,412 tests across approximately 313 production TypeScript/TSX files. Reducers, event
schemas, persistence, collectors, APIs, visual grammar, delivery packaging, and many
architectural invariants receive serious attention.

The weakness is release confidence across boundaries. Coverage is unmeasured, the
browser is simulated, canvas is mocked or absent, top-level UI tests stub most panels,
and the CI boot smoke proves only that HTML is returned. A green suite gives strong
confidence in internal rules but materially less confidence that the installed server,
SSE stream, web client, canvas, accessibility behavior, and mutating controls work
together in a real browser.

Overall: strong unit and contract quality, good server integration, weak system/browser
coverage, unknown quantitative coverage, and an expensive performance layer that is
neither a reliable benchmark nor a real performance gate.

## Suite census and observed run

- Production files: approximately 42 core, 98 server, and 173 web.
- Test files: 30 core, 83 server, and 114 web.
- Root discovery: 227 files and 3,412 tests.
- The primary verified run completed with 3,411 passing and one failing test.
- The failure is the macOS raw `/var/...` versus canonical `/private/var/...` assertion
  in `packages/server/src/lab/namespace-law.test.ts:650-657`.
- There are no skipped or `.only` tests and no snapshot assertions.
- There is no configured coverage provider, coverage report, or threshold.

## Strengths

### Broad, behavior-oriented assertions

Tests generally assert domain behavior rather than implementation trivia or broad
snapshots. Representative examples include:

- Byte-stable backwards compatibility through the committed era corpus in
  `packages/core/src/eras/eras.test.ts:27-103`.
- Tamper location, manifest, genesis, and forward-era verification in
  `packages/core/src/record/verify.test.ts:17-143`.
- Real Fastify route composition and SSE backlog/live-tail behavior in
  `packages/server/src/server/build-app.test.ts:37-152`.
- Visual grammar expressed as geometry, brightness, count, ordering, and semantic laws
  rather than screenshot snapshots in `packages/web/src/scene/marks.test.ts`.
- Deliberate byte equality instead of updateable snapshots for the era corpus
  (`packages/core/src/eras/eras.test.ts:14-25`).

The absence of snapshot testing is a strength here: a sweeping snapshot update cannot
silently bless a changed operational meaning.

### Strong deterministic fixture discipline

The shared event factory uses sequential IDs and an explicit movable clock
(`packages/core/src/fixtures.ts:12-46`), avoiding ambient time and randomness in most
suites.

Captured session-log fixtures document tool versions, corpus size, outcome frequencies,
preserved fields, redaction rules, and reproduction steps in
`packages/server/src/collectors/sessionlog/fixtures/CAPTURE.md:1-82`. Git parsing uses
captured output with exact structural assertions.

### Good security and integrity testing where controls exist

- Capability generation and rejection cover missing, empty, prefix-sharing, and
  non-echo behavior (`packages/server/src/api/security.test.ts:12-70`).
- Mutation-guard tests cover hostile Origin/Host shapes, content types, IPv4/IPv6
  loopback, DNS-rebinding inputs, and all mutating verbs
  (`packages/server/src/server/mutation-guard.test.ts:22-198`).
- OTLP tests verify that foreign or unattributed traffic records no usage.
- Record tampering, append-only behavior, and namespace restrictions are tested
  directly.
- Several hygiene/law tests prove their detector actually bites rather than merely
  asserting an empty result.

### Useful platform and delivery realism

CI builds before testing and covers Linux/macOS plus current/minimum Node combinations
(`.github/workflows/ci.yml:17-58`). Packaging is exercised from a tarball installed into
an unrelated temporary project, including paths with spaces and Unicode
(`scripts/pack-smoke.sh:57-162`). This is materially stronger than testing workspace
execution alone.

The landing gate also contains a thoughtful flake-under-load pass, bounds worker pools,
and separates marked timing tests from concurrent race probing
(`scripts/gate.sh:67-138`).

## Prioritized findings

### P0 — The macOS namespace-law test is wrong

`packages/server/src/lab/namespace-law.test.ts:650-657` requires a Git-reported canonical
worktree path to start with raw `realDataRoot`. On macOS the diagnostic shows:

- Raw root: `/var/folders/...`.
- Native root: `/private/var/folders/...`.
- Git worktree: `/private/var/folders/...`.

The assertion fails even though the actual containment assertion at lines 659-665
canonicalizes both sides correctly and passes. Canonicalize `realDataRoot` in the
non-vacuousness guard. Do not skip this test by platform or Node version; it protects an
important write boundary.

### P1 — Coverage is unknown, not demonstrably high

The root Vitest config only selects workspace projects. Package configs choose Node or
jsdom environments. There is no:

- Coverage provider installed and configured.
- Line, branch, function, or statement threshold.
- Published coverage artifact.
- Changed-file coverage gate.
- Critical-module coverage policy.

The large test count is encouraging but cannot reveal untouched branches, dead seams,
or tests that execute code without discriminating assertions.

Add V8 coverage and record the current baseline before setting ambitious global gates.
A pragmatic initial policy:

- Changed production files: at least 90% lines and 80% branches.
- Security guards, event validation/reduction, record verification, and recorder writes:
  at least 90% branch coverage.
- Moderate global floors, ratcheted upward only after inspecting real gaps.

Do not target 100%. Coverage should direct risk analysis, not reward incidental execution.

### P1 — There is no real-browser or full cross-layer test

The web suite runs under jsdom (`packages/web/vitest.config.ts:4-9`). Main App tests stub
attention, burn, fleet, ledger, collisions, feed, replay, and scene and inject a fake
EventSource (`packages/web/src/App.test.tsx:25-67`). Scene tests provide either no canvas
or a hand-built fake context because jsdom lacks Canvas 2D and `Path2D`
(`packages/web/src/scene/SceneView.test.tsx:67-88,226-249`).

CI's boot check starts the server, calls `/api/meta`, and verifies only that `/` has an
HTML content type (`.github/workflows/ci.yml:85-145`). It never executes the shipped
JavaScript, opens SSE in a browser, paints canvas, or performs a user flow.

Add a small Playwright or Vitest Browser lane on every PR against the built server:

1. Load the dashboard with no console errors.
2. Receive real SSE backlog and a subsequent live event.
3. Verify that the event changes a real panel and produces non-empty canvas pixels.
4. Open a lane, enter replay, scrub, and return to live.
5. Exercise pause, reduced motion, keyboard navigation, and focus behavior.
6. Exercise label, rotate, and Lab confirmation through real HTTP controls.
7. Run a basic accessibility scan.

Use a few stable screenshot baselines only as a complement to the existing semantic
visual laws.

### P1 — Security tests do not enforce a route-wide policy

The Origin/Host/content-type guard is well tested, but capability enforcement is
per-route and intentionally incremental (`packages/server/src/api/security.ts:64-70`).
Only `/api/label` uses it. Tests for `/api/rotate` and `/api/lab/launch` successfully POST
without a token (`packages/server/src/api/rotate.test.ts:98-137`,
`packages/server/src/api/lab.test.ts:452-491`).

Build a structural contract test from the real Fastify app:

- Enumerate every registered mutating route.
- Classify it as operator control or telemetry ingestion.
- Require missing/wrong credentials to fail for every control route.
- Assert zero handler side effects after rejection.
- Give ingestion a separate, explicit identity policy.
- Fail when a future route is unclassified.

This would have caught both current omissions and future routes that forget to opt in.

### P1 — Performance tests are expensive but do not enforce budgets

Several tests are described as 60 fps guarantees while explicitly declining to assert
the budget. `packages/web/src/scene/perf.test.ts:300-307` says median and worst timing
are not asserted; its frame test only requires positive measurements. The testing review
observed a reported 16.67 ms budget and an approximately 86 ms worst frame while the test
still passed. The Lab branching performance test has the same “positive measurement”
shape.

Other tests assert wall-clock ordering or ratios and are therefore load-sensitive,
including:

- `packages/web/src/app/streamState.test.ts:229-287`.
- `packages/web/src/panels/ledger/perf.test.ts:134-184`.

Large-event measurements account for a material share of suite runtime. The gate's
timing discovery includes only `// @gate-timing` files and `*.bench.test.ts`, missing
several other timing blocks; ordinary CI runs plain `npm test`, not the serial timing
split.

Move observational benchmarks out of the PR correctness suite:

- Keep deterministic complexity proxies in PR tests.
- Run benchmarks with one worker on controlled hardware.
- Store baselines and assert explicit p50/p95 or regression-ratio budgets.
- Run full benchmarks nightly or before release.
- Put every wall-clock suite in one mechanically discoverable category.

A test that only prints a breached budget is a report, not a gate.

### P2 — Source-grep laws are tripwires, not architectural proof

Law tests are strongest when source scanning is paired with a real filesystem/ref diff.
Weaker examples infer reachability from names and regexes. For example, the Lab launch
law searches for the literal `launchExperiment` and selected timer spellings
(`packages/server/src/api/lab.test.ts:523-560`). Aliasing, wrappers, renamed functions,
dynamic imports, or alternate schedulers can evade such checks.

Keep source-grep tests as cheap tripwires, but back important boundaries with:

- Import-graph or lint rules.
- Explicit capability interfaces and route inventories.
- Real-app route enumeration.
- Temporary-tree and Git-ref before/after tests.
- Process or OS-level tests for write confinement.

### P2 — Fixture hygiene does not cover every committed capture

The session-log hygiene sweep filters filenames beginning with `claude-code-`
(`packages/server/src/collectors/sessionlog/turn-grammar-claude.test.ts:163-182`). Legacy
fixtures in the same directory are excluded and still contain captured paths, usernames,
UUIDs, request IDs, and text, including `worker-2-core.jsonl`.

Sanitize legacy fixtures or sweep every committed JSON/JSONL fixture with a small,
documented exception list. A privacy law scoped by a “new fixture” filename prefix
creates false assurance.

### P2 — Noisy test output hides actionable warnings

Runs repeatedly emit missing-build and unimplemented-canvas warnings. A replay
correctness test also produces a React duplicate-key warning: TraceTree keys interaction
rows solely by `traceId` (`packages/web/src/trace/TraceTree.tsx:37-48`) while its test
renders multiple orphan roots from one trace (`packages/web/src/trace/TraceTree.test.tsx:95-116`).

Make unexpected `console.error` and React warnings fail web tests. Suppress narrowly and
locally only when the warning itself is the behavior under test.

### P3 — Missing specialised categories

Add narrowly targeted coverage for:

- Property/fuzz testing of JSONL, OTLP envelopes, record readers, Unicode, truncation,
  and path containment.
- Accessibility beyond selected role/name assertions.
- Real SSE reconnect and `Last-Event-ID` behavior.
- Production startup and error-boundary failures.
- Mutation testing for security guards, record verification, and reducers.
- Windows-native execution only when Windows becomes a product claim.

## Pragmatic target strategy

### Every PR: fast correctness lane

- Typecheck and lint.
- Pure core, parser, reducer, geometry, and component tests.
- Fastify injection tests.
- V8 coverage with changed-file and critical-module thresholds.
- Unexpected console warnings fail.
- Target roughly 30-45 seconds locally and under two minutes in CI.

### Every PR: one real-browser smoke lane

- Build server and web.
- Start on an ephemeral port.
- Run Chromium against real APIs and SSE.
- Cover live, reconnect, replay, one mutation, canvas paint, keyboard/reduced motion,
  and basic accessibility.
- Keep it to a handful of high-value workflows rather than duplicating unit cases.

### Platform and delivery lane

- Full correctness suite on Ubuntu minimum and current Node.
- macOS for filesystem/process/package-sensitive behavior and browser smoke; retain a
  full macOS run if cost permits.
- Tarball installation and boot smoke on supported operating systems.
- Add Windows only with a real support claim.

### Nightly or pre-release lane

- Serial benchmarks on pinned hardware.
- Repeated load/flakiness probing.
- Parser/property fuzzing with retained seeds.
- Long-session SSE/reducer soak and memory ceiling.
- Focused mutation testing of the critical security and integrity surface.

## Recommended order

1. Fix the macOS symlink test.
2. Add coverage instrumentation and publish the baseline.
3. Add the real-browser SSE-to-UI smoke.
4. Add a real-app mutation-route security matrix.
5. Split benchmarks from PR correctness tests and repair timing discovery.
6. Expand fixture hygiene to all committed captures.
7. Fail on unexpected browser/React console warnings.
8. Add targeted fuzz, accessibility, and mutation testing.
