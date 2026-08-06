# Code quality review

- **Healthy core, bloated periphery.** Strict TS (`strict`, `noUncheckedIndexedAccess`), zero real `any` in src, sane function sizes, meaningful tests with minimal mocking — but ~23k of 112k lines are a hand-rolled generative-art canvas engine, and the test suite is red on main on the developer's own OS.
- **Lint: clean** (`biome lint` — 547 files, no findings). **Typecheck: clean** (all three workspaces).
- **Test: 1 failed / 3411 passed** (226 files pass, 1 fails, 66s). The failure is real, deterministic, and on macOS — investigated below.

## The red test

`packages/server/src/lab/namespace-law.test.ts:655` — `registered.some(w => w.startsWith(realDataRoot))` compares git's canonicalized worktree paths (`/private/var/…`) against `realDataRoot` built from `tmpdir()` (`/var/…`, itself a symlink on macOS). The evidence block the test itself prints shows `raw=/var/… native=/private/var/…` — i.e. the test asserts the raw spelling where it means the native one. Commit `7a9219d` fixed exactly this class of bug for the *second* assertion (`realpathSync.native(repoDir)`) but left the first. The fix shipped to CI without a local run on macOS. **Action:** wrap `realDataRoot` in `realpathSync.native` at line 655 (and give CI a macOS leg, or require local `npm test` pre-push). 0 lines saved; suite goes green.

## Findings

- `packages/web/src/scene/` (~11,991 src + ~11,500 test lines) — **this is where 112k went**: a bespoke canvas art engine (mycorrhizal heart, growth rings, hyphal fans, motes, pulses, ribbons, retire registry, seeded PRNGs, simplex noise). For a localhost worktree dashboard this is the product's identity, not sloppiness — but it should be named honestly as ~21% of the repo, and its scope frozen. `marks/` alone is 5.6k src lines across 10 painters. **Action:** stop growing it; consolidate `marks/{ambient,dissolve,light}.ts` (each is a thin painter) into one file (est. −300).
- `packages/core/src/events/upcast.ts:1-67` — an identity function that "does nothing today," reserved as a future migration chokepoint, plus law tests pinning that it stays an identity function. Speculative layer by its own admission; the era corpus has exactly one era. **Action:** delete until era-2 exists; git history preserves the design (est. −150 with tests).
- Duration/byte/token formatters duplicated ≥7× — `web/src/recordings/format.ts:14`, `web/src/replay/format.ts:21`, `web/src/panels/ledger/format.ts:5`, `server/src/lab/compare.ts:304`, `server/src/cli/sessions.ts:129`, `server/src/log/session-log.ts:419`, `server/src/collectors/sessionlog/lane-state.ts:331`; `formatBytes` twice (`cli/doctor.ts:448`, `cli/sessions.ts:160`); `formatTokens` twice. Seven near-identical `formatDuration` implementations will drift. **Action:** one `formatDuration`/`formatBytes` in `web/src/lib/format.ts` and one in server (est. −120).
- Grep-your-own-source "law" tests — `web/src/lab/no-live-fleet-law.test.ts`, `web/src/recordings/no-live-fleet-law.test.ts`, `collectors/otel/fixture-hygiene-law.test.ts`: regex-scan source text for forbidden imports. A renamed import passes vacuously; the pattern is copy-pasted per directory ("modeled on directly"). **Action:** one parameterized test, or Biome's `noRestrictedImports` which is the actual tool for this (est. −150).
- Scene test mass — `marks.test.ts` (3,772 lines, 169 tests), `geometry.test.ts` (1,277), `perf.test.ts` (1,005). The module docs say the *form* "is free to change" and only *roles* are law — yet thousands of lines pin geometric constants and allowance tables that are form. **Action:** cull tests asserting constants against themselves; keep role-level laws (est. −2,000 to −4,000, the single biggest saving available).
- `packages/server/src/cli/telemetry-env.ts:29-58` — three shell renderers (`sh`, `powershell`, `cmd`) for a tool whose entire collector layer is tmux, which does not exist on Windows. Speculative generality. **Action:** ship `sh` only (est. −60 with tests).
- `packages/server/src/api/security.ts` (84) + `server/mutation-guard.ts` (152) + tests — capability token and Origin/Host guard for two mutating routes on a loopback-only server. Thoughtfully written and defensible against DNS rebinding, but disproportionate to a single-user local tool; flagging as a judgment call, not a defect.
- Comments as archaeology — ~every module header cites "prdN ruling M, item K" (`reduce.ts:38`, `upcast.ts:4`, `heart.ts:6`). The reasoning is genuinely good, but a reader must excavate `docs/prd0..17.md` to decode the code. **Action:** inline the ruling's *content*, cite the PRD second.

## Naming

The vocabulary (rhizomorph, era, judge, lab, tide, mark, balcony, heart, filament, motes) is whimsy — but *disciplined* whimsy: terms are used consistently, defined in module headers, and map to real distinctions (lab = forked realities, tide = timeline, judge = merge analysis). A new reader loses an hour, not a day. Keep it; add a one-page glossary to the README and stop coining new ones.

## TypeScript rigor

Strong: strict mode + `noUncheckedIndexedAccess` + `noImplicitOverride` on; the 10 `any` matches in src are all in comments; all `@ts-expect-error` are negative tests; non-null assertions ~15 and justified. The ~103 `as` casts concentrate in `scene/` canvas code (`as Rgb`, geometry tuples) — acceptable but unaudited; worth one pass over `marks/*.ts`.

## Top 10

1. Fix `namespace-law.test.ts:655` — suite is red on main on macOS.
2. Add a macOS CI leg (this failure class has now bitten twice: #217/#227, #231).
3. Freeze scene scope; consolidate thin painters (−300).
4. Cull form-pinning scene tests; keep role laws (−2,000–4,000).
5. Delete `upcast.ts` until a second era exists (−150).
6. One `formatDuration`/`formatBytes` per package (−120).
7. Replace grep-law tests with one parameterized test or Biome rule (−150).
8. Drop `powershell`/`cmd` env renderers (−60).
9. Add README glossary; freeze the vocabulary.
10. Inline PRD ruling text at citation sites instead of bare "prdN ruling M" pointers.
