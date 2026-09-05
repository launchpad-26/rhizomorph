import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * prd43 ruling 1's law — a path cited from a document or a comment must exist.
 *
 * The audit behind prd-43 found four live clusters of dead paths: `architecture.md`
 * citing a moved `buildFleet.ts`/`fences.ts`/`fences.test.ts`/`spend/format.ts`; four
 * source comments citing a research note `756e1bf` deleted (whose own sweep covered
 * documents citing documents, not code citing documents); three design-notes citing
 * `docs/decisions/` where the targets live under `docs/design-notes/` itself; and
 * (found independently, running this law's own extractor before writing it) an ADR
 * citing a PRD by its pre-`done/` path, a scaffold comment citing a server entry point
 * that never existed at that name, and a comment citing this repo's pre-rename PRD
 * numbering (`docs/prd2.md`). Nothing caught any of these, because nothing checked them.
 *
 * Lives under `packages/server/` for the reason every sibling law here already gives:
 * the root vitest config globs `packages/*`, so a root-level test would never run and
 * would be its own vacuous law.
 *
 * ## Scope, and the two directories a citation can point OUT of vs. point INTO
 *
 * `docs/research/`, `docs/review/` and `docs/prds/` — the whole PRD tree, not only
 * `done/` — are excluded as CITING sources: a dated artefact's own citations are a
 * record of the tree at a commit, not a live claim. This is NOT the same as exempting
 * paths that merely live inside those directories from being cited-INTO: a source
 * comment or an ADR citing a specific file under `docs/research/` or `docs/prds/`
 * still makes a live claim that file exists there NOW, which is exactly the deleted
 * research note and the pre-`done/` PRD path above. Excluding by citing-file directory,
 * not by cited-target directory, is what makes both of those findable.
 *
 * A dated artefact can also live OUTSIDE those three directories — the first instance
 * is a run record under `docs/design/` pinned to one commit (#228). Excluding it by
 * directory would sweep every live design document with it, and excluding it by
 * filename is the guard-scoped-by-naming-convention failure AGENTS.md records twice.
 * So a document is a dated artefact by what it IS: it opens with a tree pin,
 * `**Tree:** \`<ref>\` at \`<sha>\``, and that pin RESOLVES to a real commit. A pin that
 * does not resolve is not an exemption — it is reported by name (`badPins()`), or any
 * live document could write a fake one and leave the sweep. Documents only: a `.ts`
 * comment declaring a pin is still a live claim, and `allCitations()`'s TS loop never
 * consults `isPinnedArtefact`.
 *
 * ## The land-red question, resolved on the issue before this file was written
 *
 * This law commits GREEN. `ALLOWLISTED_BROKEN_CITATIONS` below names every citation
 * this law's own extractor found broken, and is itself asserted honest (every entry
 * currently fails, or the entry is stale). prd-24 ruling 4 already settled the general
 * shape — "a new law is shown red against the pre-fix tree, in the PR body" — and
 * `no-personal-paths-law.test.ts` solved this exact problem once before, in `754891a`,
 * with `EXCLUDED_PENDING_FIXTURE_REDACTION`: a pinned, reason-carrying, honesty-checked
 * list. This is that shape, copied.
 *
 * ## The input table
 *
 * Every way a `packages/`, `scripts/` or `docs/`-rooted path can appear in this corpus,
 * enumerated and verified against the real tree BEFORE the extractor below was written
 * (`AGENTS.md`'s rule: a form not listed is a form not handled).
 *
 * | Form                                            | Verdict                                        |
 * |--------------------------------------------------|-----------------------------------------------|
 * | `` `packages/foo/bar.ts` `` (backticked)          | HANDLED — the only form this law recognises   |
 * | bare, no backticks (`see docs/foo.md for…`)       | SKIPPED — every real citation in this corpus is backticked (verified by grep); a bare sweep would also catch markdown link TEXT (`[docs/architecture.md](architecture.md#anchor)`), which names the doc, not a claim about a repo-relative path |
 * | markdown link `[text](href)`                      | SKIPPED — hrefs in this corpus are relative to the linking file (`architecture.md#anchor`), never repo-rooted; the bracket TEXT is prose, not a citation, and is correctly left alone by requiring backticks |
 * | trailing punctuation (`` `foo.ts`. ``)             | N/A — punctuation after a *closing* backtick is outside the match; nothing to strip, unlike `no-personal-paths-law`'s bare-name sweep |
 * | line/anchor suffix (`` `foo.ts:111` ``, `` `foo.md#heading` ``) | HANDLED — `:` and `#` are IN the character class, so the span is extracted whole and the suffix stripped before the existence check. It was NOT handled when this table first claimed it was: the class excluded both, so a suffixed span failed to match at all and `stripCitationSuffix` was unreachable from the sweep — a broken `x.ts:42` was invisible while a broken `x.ts` was caught. 234 `:NNN` occurrences exist across tracked markdown (215 distinct, 48 files) and ~12 in in-scope files — the earlier `~100` in this row was understated by more than half, so this is the corpus's most common form (review of #16) |
 * | line RANGE (`` `foo.ts:78-85` ``) | HANDLED — the sibling of the row above, and the reason widening the character class alone is not the fix: `/:\d+$/` matches a single number and stops, so admitting `:` without the range arm turns 7 real range citations into fresh violations. Stripped by `/:\d+(?:-\d+)?$/` (review of #16) |
 * | glob, directory-rooted (`` `packages/core/**` ``) | HANDLED — resolved against the real tracked tree, not truncated at the first `**` with everything past it unchecked (`` `packages/**\/anything-that-does-not-exist.ts` `` used to pass on the parent existing alone). `**` matches ZERO OR MORE path segments (review round 2): the first fix's regex kept both literal slashes flanking `**` mandatory, so `` `packages/core/src/fleet/**\/fences.ts` ``, `` `docs/**\/roadmap.md` `` and `` `packages/*\/src/**\/*.ts` `` — three real, existing citations — resolved false, a false positive louder than the false negative this row exists to close |
 * | glob, mid-filename (`` `docs/research/2026-08-02-obs-prd7-*.md` ``) | HANDLED — resolved against a real directory listing, not truncated like the directory glob above (a naive truncate-at-`*` would falsely redden this real, existing citation — caught by running the extractor against the tree before trusting it) |
 * | bare directory/number, no filename (`` `docs/adr/0012` ``)   | HANDLED — the one live instance of this form; resolved as a prefix match against `docs/adr/`'s real listing, same convention `adr-log-law.test.ts` already codifies for ADR numbers |
 * | inside a fenced code block (` ```json … ``` `)   | SKIPPED — verified BOTH ways in this corpus: `docs/architecture.md`'s own `.swarm/lanes.json` example fences a fabricated lane (`packages/web/src/panels/shelved/**`, an illustrative fixture, not a real file) alongside real command examples (`node packages/server/bin/rhizomorph.mjs`); mixing real and fabricated content inside fences means including them risks a false positive on the fabricated half, and ruling 5 (README recipes executed by the suite) is the mechanism for verifying the real half, not this law |
 * | path + trailing prose/args in ONE span (`` `scripts/dev/issues.sh list` ``) | SKIPPED — the one live instance; the character class stops at the space, so the whole span fails to match rather than truncating to a wrong substring — under-inclusion, not a false positive |
 * | `packages/**\/*.ts` **comments** (line comments, block comments, doc comments) | HANDLED — comment text only, via `extractComments`; a citation inside actual code (a string or template literal) is deliberately NOT swept, per ruling 1's own wording ("packages/**\/*.ts comments") |
 * | `packages/**\/*.ts` **code** (string/template literals) | SKIPPED — see above; a `` ` `` inside a `//` line is only swept if it appears AFTER the `//`, so a citation-shaped string literal preceding a trailing comment is correctly left alone |
 * | `//` inside a STRING literal, ahead of a real citation on the same line (`` const u = 'https://x/`packages/foo.ts`' ``) | SKIPPED, declared (review of #186 item 2) — `extractComments`'s line-comment regex has no string-awareness, so a `//` inside a string is read as starting a real comment, and a citation-shaped backtick span later on the same line is swept as if it were commentary. Closing it needs a string-literal-aware tokenizer — quote tracking with escapes, template-literal nesting, and the classic regex-literal-vs-division ambiguity — categorically bigger than the regex-based extractor this file deliberately is, the same "needs a real parser" line the CODE-vs-comment row above already draws. No live instance; pinned by a CONTROL test below so the behaviour cannot silently change |
 * | a path under a BUILD-ARTEFACT directory (`packages/*\/dist/…`) | HANDLED as always-valid — `dist/`, `dist-desktop/` and `dist-vendor/` are gitignored (`.gitignore`) build artefacts that exist only after `npm run build` or packaging; a doc describing where the bundle lands is not making a claim about the tracked tree. Scoped to exactly those three directory NAMES, not "anything git ignores" (review of #186 item 4) — `docs/audit/`, `coverage/`, `node_modules/` and any rule added later are gitignored too but are not build artefacts, and a citation into one of them is a real claim that can be wrong; the earlier, blanket form exempted every ignored path, so a dead citation into `docs/audit/` silently passed |
 * | a CITING document whose head declares `` **Tree:** `<ref>` at `<sha>` `` | EXCLUDED as a citing source, when the sha resolves (`git cat-file -e <sha>^{commit}`) — a dated run record pinned to one commit is a record of that tree, not a live claim (#228; the same reasoning as the three excluded directories, keyed on what the file IS rather than where it sits). The marker is exactly that form, read from the first 12 non-fenced lines: prose mentioning a tree, a pin with no `at`, or a pin buried in the body do not exempt. A pin whose sha does NOT resolve exempts nothing and is reported by `badPins()` |
 * | `.tsx` and `.mjs` source comments | OUT OF SCOPE, ruling (#186 item 9) — ruling 1 says `packages/**\/*.ts`, and `trackedFiles('packages/*.ts')` matches that exactly: 137 `.tsx` and 5 `.mjs` files go unswept. Verified this is the right call, not an oversight: the last of the 5 `.mjs` files the sweep would reach (`git ls-files 'packages/*.mjs'`, alphabetical — review round 2 corrected "first" to "last"; the substance is unaffected), `packages/web/src/scene/parity/capture.mjs`, cites a deleted `packages/web/src/scene/paint.ts` deliberately — in a comment AND a code constant — and resolves it out of git history, because `8686f24` (#578) replaced the 2D painter and the parity harness intentionally diffs against the pre-deletion file. Widening the sweep as written would false-positive on that live, working, documented citation. Before widening, the law needs a way to say "cited from history, on purpose" so a comment like that one can opt out — that mechanism does not exist yet, so the scope stays exactly ruling 1's, not narrower and not wider |
 *
 * ## The `git ls-files` glob gotcha this law's own tests pin down
 *
 * `git ls-files -- 'docs/**\/*.md'` does **not** match a file directly under `docs/` —
 * git's default pathspec fnmatch treats a bare `*` as already crossing `/`, so `**\/`
 * demands a LITERAL extra path separator, silently requiring at least one subdirectory.
 * `docs/architecture.md` — the file carrying the FIRST cluster this law exists to catch
 * — sits directly under `docs/` and was invisible under that pattern. `docs/*.md` alone
 * (single star) already matches every markdown file at any depth, `**` included or not;
 * this law uses the single-star form for exactly that reason, and one of the tests below
 * pins `docs/architecture.md` into the swept set so a future edit back to `**\/*.md`
 * reddens instead of silently narrowing the sweep again.
 */

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()

/**
 * This file's own repo-relative path, resolved from `import.meta.url` rather than typed
 * as a string constant — a rename can't leave a stale exclusion behind, unlike
 * `no-personal-paths-law.test.ts`'s `OWN_PATH`, which this is otherwise the same fix as.
 *
 * Not optional: this file's own doc comment narrates the audit's findings and this law's
 * own input-table examples using the exact backtick-delimited `packages/`/`docs/`-rooted
 * syntax the extractor below is built to catch — `` `docs/decisions/` ``, `` `docs/prd2.md` ``
 * (real dead targets, quoted for context) and `` `packages/foo/bar.ts` ``,
 * `` `docs/adr/0012-slug.md` `` (fabricated illustrations) alike. Once this file is
 * TRACKED, `packages/*.ts` sweeps it like any other source file and every one of those
 * becomes a self-reported violation — the file enrolled itself in its own derived set,
 * the exact shape `no-personal-paths-law.test.ts`'s `OWN_PATH` comment already names.
 * Found only once this file was staged: `git ls-files` reads the INDEX, and every
 * verification pass before `git add` ran against an untracked file `git ls-files` could
 * not see, so the bug was structurally unobservable until the commit that shipped it.
 *
 * Declared here, beside `REPO_ROOT`, rather than beside `isExcludedCitingFile` below,
 * on purpose: `prefix-comparison-law.test.ts` flags any `X.startsWith(ident)` sitting
 * within a few lines of a `path.*` call as a containment idiom, and
 * `isExcludedCitingFile`'s unrelated `file.startsWith(dir)` (an EXCLUDED_DIRS prefix
 * check, present since this file's first commit) sat outside that law's detection
 * window until this constant's `path.relative(...)` call was placed three lines above
 * it — an accident of layout, not a change in what that line does. Keeping the two
 * apart avoids tripping an orthogonal law's pinned test-file count as a side effect of
 * an unrelated identity fix.
 */
const OWN_FILE = path.relative(REPO_ROOT, fileURLToPath(import.meta.url))

function trackedFiles(pattern: string): string[] {
  return execFileSync('git', ['ls-files', '--', pattern], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.length > 0)
}

/** Tracked AND untracked-but-not-ignored files matching `pattern` (#186 item 5) — a brand new doc must be checkable before `git add`, not only after it lands in the index. */
function sweepFiles(pattern: string): string[] {
  return execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '--', pattern],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  )
    .split('\n')
    .filter((line) => line.length > 0)
}

/**
 * Guards a sweep read against a file the git listing still names but that is
 * gone from disk — deleted without `git rm`, or a staged-but-uncommitted
 * deletion (#186 item 5's related finding: this used to throw ENOENT
 * straight out of `readFileSync`, crashing the run instead of failing the law
 * like any other missing citation would).
 *
 * ## Every read in this file, and whether it needs this guard (#203)
 *
 * The issue asked for the enumeration rather than the one call site it named,
 * because #186 fixed one instance of this and left its sibling. Four reads come
 * through this guard — two loops in `allCitations`, one in `badPins`, and the
 * exclusion scan that #203 moved here — and five stay bare. Exactly ONE was fed
 * from `git ls-files` and unguarded. Verdict per row, so a later reader does not
 * have to re-derive it, and so a new read has an obvious question to answer.
 *
 * **SCOPE: the path-citation law only, and that had to be said out loud.** This
 * table read "Every read in this file" and claimed "**Nine reads, and the table
 * is all of them**" until #261 added the citation ceiling law to the same file,
 * with seven reads of its own that the table never learned about. The completeness
 * claim was the load-bearing half, and it went false the moment a second law moved
 * in. The ceiling law's own reads are enumerated in its docblock below; this table
 * covers the law it was written for.
 *
 * The count is gone rather than corrected, and that is this docblock's own ruling
 * applied to itself: it closes by explaining that every set of numbers it carried
 * has rotted, listing three line-citations that went stale — one of them stale
 * inside the very commit that wrote it. It then opened with a number, which
 * rotted, for exactly the reason given. The rows are the enumeration; a reader
 * checking completeness counts them against the code, which is the check a typed
 * total was standing in for.
 *
 * | read | where its path comes from | verdict |
 * |---|---|---|
 * | `allCitations`'s two loops | `sweepFiles` (tracked + untracked) | GUARDED — `readSweptFile`, #186 item 5 |
 * | `badPins` | `sweepFiles('docs/*.md')` — the same listing | GUARDED — `readSweptFile`. Predates #203 and was already correct; it is a row because the heading says *every* read, and it was missing (review of #242) |
 * | the exclusion-honesty scan | `trackedFiles` — the git INDEX | **WAS THE DEFECT** — guarded now; this is #203 |
 * | `cleanUpOrphanedFixtures` | `readdirSync(docsDir)` — a live directory listing | NOT NEEDED — the entry exists because the listing just named it, and it is wrapped in its own `try`/`catch` besides |
 * | the allowlist-still-fails check | `ALLOWLISTED_BROKEN_CITATIONS[].file`, a literal list | NOT NEEDED — `existsSync` is asserted on the line above, with a message telling you to remove the entry |
 * | the own-identity control | `OWN_FILE`, a constant naming this file | NOT NEEDED — if this file were gone, nothing here would be running |
 * | the sibling-violation control | a hardcoded `packages/core/src/placeholder.ts` | NOT NEEDED — a fixed path, not a listing; deleting it is a deliberate act that SHOULD break this control loudly |
 * | the `.mjs` scope control | a hardcoded `capture.mjs` path | NOT NEEDED — same reasoning as the row above |
 *
 * The distinction that matters is not "does the path exist today". It is
 * **whether the path was produced by asking git**, because that is the only
 * source that can name a file the disk does not have. A literal is wrong
 * loudly; an index entry is wrong silently.
 *
 * The issue's own line citations were against PR #200's head and had already
 * moved by the time this was picked up — re-derived rather than trusted, which
 * is what its Blocked-by note asked for. **Named by symbol here, not by line,
 * and that is the point:** the guarded read is `readSweptFile` itself, and the
 * one that was unguarded is the exclusion-honesty scan, now
 * `countBrokenCitationsIn`.
 *
 * The numbers are left out because every set of them has rotted. The issue
 * cited `:140`/`:587`; by the time it was picked up those had become
 * `:152`/`:709`; and `:152`/`:709` were themselves stale **inside the very
 * commit that recorded them**, because that commit added this docblock and
 * shifted every line below it. A pointer that reports the wrong location while
 * looking precise is worse than no pointer — the lesson `AGENTS.md` already
 * records for CI citations and `.swarm/coupling.txt` entries.
 */
function readSweptFile(file: string): string | undefined {
  const filePath = path.join(REPO_ROOT, file)
  // `existsSync` then `readFileSync` is a CHECK-then-USE, not a guard: a
  // sibling concurrent run lists this path, passes the existence check, and
  // then the owning run's own `finally` removes the fixture before the read
  // lands. EXECUTED on the pre-fix tree at 8x: two legs died here with
  // "ENOENT ... citation-law-untracked-fixture-<pid>-<n>.md" out of
  // `allCitations()`, alongside the TRACKED-guard race this commit fixes.
  //
  // To watch it fire on demand rather than at 8x, widen the window instead of
  // the load — an `Atomics.wait(…, 5)` between the check and the read, for
  // fixture-named paths only. EXECUTED in review of #263, 4 simultaneous runs
  // of this file over five rounds, the two arms differing in NOTHING but this
  // `try`: uncaught read 2 failing legs of 20, this catch 0 of 20. Both ENOENT
  // paths carried a LIVE pid, which is the point below.
  //
  // The live-pid argument that makes `:839` and `:959` safe does NOT cover
  // this, and that is the sibling case the first enumeration missed: those
  // verdicts answer "can a sibling's cleanup delete MY fixture", while this
  // is "can MY fixture's deletion break a SIBLING". The pid on this path
  // belongs to the sibling and is alive, which is exactly why the alive check
  // never fires.
  //
  // Catching is the whole fix. A file that vanishes between the listing and
  // the read is precisely the case this function's docblock above says it
  // exists to absorb — "a file the git listing still names but that is gone
  // from disk" — and `existsSync` cannot close it because the window is
  // AFTER it returns.
  try {
    return readFileSync(filePath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
}

/**
 * Every tracked file in the repo, for resolving a `**` glob against the real
 * tree rather than truncating at the first occurrence (#186 item 3).
 *
 * INDEX-only, unlike `sweepFiles` (#186, review round 3, worth doing but not
 * fixed): a brand-new UNTRACKED file cited through a `**` glob is reported
 * broken, while the identical target cited LITERALLY resolves fine via the
 * plain `existsSync` check earlier in `citationExists` — the glob arm here
 * simply cannot see a file `git ls-files` does not know about yet. Reachable
 * only in the narrow window where BOTH hold: the target itself is not yet
 * `git add`ed, AND it is cited via a glob rather than its literal path: it
 * clears the moment either the target is staged or the citation is written
 * out in full. Noted rather than widened to `sweepFiles`' tracked+untracked
 * union — that would make this function fork `git ls-files --others
 * --exclude-standard` for every `**` citation, and the asymmetry is a real
 * but momentary gap, not a false claim this file makes about what it checks.
 */
function allTrackedFiles(): string[] {
  return execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.length > 0)
}

const UNTRACKED_FIXTURE_RE = /^citation-law-untracked-fixture-(\d+)-\d+\.md$/

/** The exact bytes `an untracked doc is swept too` writes to its fixture — the one thing `cleanUpOrphanedFixtures` is allowed to treat as proof it wrote a candidate file (#186, review round 3). */
const UNTRACKED_FIXTURE_CONTENT = 'Cites a real path: `packages/server/src/doc-citation-law.test.ts`.\n'

/** HEAD, resolved once — the one sha a pinned FIXTURE can declare and be sure resolves in every checkout that runs this suite. */
const HEAD_SHA = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()

/**
 * The exact bytes `a document that declares a resolving tree pin…` writes (#228): the
 * pin, then the SAME real-path citation as `UNTRACKED_FIXTURE_CONTENT`, for the same
 * concurrency reason that test's doc comment gives — a dead citation left on shared
 * disk reddens a sibling run's sweep, a real one cannot, and the exclusion is still
 * provable by the fixture's ABSENCE from `allCitations()`.
 */
const PINNED_FIXTURE_CONTENT = `**Tree:** \`main\` at \`${HEAD_SHA}\`\n\nCites a real path: \`packages/server/src/doc-citation-law.test.ts\`.\n`

/**
 * What `cleanUpOrphanedFixtures` may treat as bytes this file wrote: the untracked
 * fixture's exact content, or the pinned fixture's SHAPE — an orphan from an earlier
 * HEAD carries a different sha, so equality against today's constant would leave it
 * behind forever, and the shape (a 40-hex pin over the same one-line real citation)
 * is still something no real document produces.
 */
const PINNED_FIXTURE_SHAPE_RE = /^\*\*Tree:\*\* `main` at `[0-9a-f]{40}`\n\nCites a real path: `packages\/server\/src\/doc-citation-law\.test\.ts`\.\n$/
function isFixtureContent(content: string): boolean {
  return content === UNTRACKED_FIXTURE_CONTENT || PINNED_FIXTURE_SHAPE_RE.test(content)
}

/**
 * Deletes an `an untracked doc is swept too` fixture left behind by a PAST
 * run of this same test — one that never reached its own `finally` because
 * the process was killed (SIGINT, a CI timeout) rather than exiting normally.
 *
 * A candidate is deleted only if ALL THREE hold: its name matches the
 * fixture pattern, its PID is no longer alive, its bytes are EXACTLY
 * `UNTRACKED_FIXTURE_CONTENT`, and it is genuinely untracked. The first
 * version checked name and PID only — EXECUTED against a real repro (review
 * round 3's BLOCKER): a real document that merely happens to be named
 * `citation-law-untracked-fixture-999999-<ts>.md` was deleted purely for
 * matching that name, with no check on what the file actually was. Scoping a
 * destructive guard by what a file is CALLED rather than what it IS is the
 * #649 lesson this file already carries elsewhere, landing here on its own
 * cleanup step. The content check alone would still let a TRACKED file with
 * byte-identical content be swept up — `trackedFiles` closes that: only a
 * file this test itself could have written, and never staged by anyone, is
 * ever removed. An ACTIVE fixture from a genuinely concurrent run of this
 * same test in another process must be left alone regardless — the alive
 * check is what stops this cleanup step from manufacturing the exact race
 * item 5's own fixture used to (#186, review round 2's BLOCKER), FROM THE
 * OTHER DIRECTION: deleting a live run's fixture out from under it.
 * `process.kill(pid, 0)` sends no signal — it only asks whether the PID is
 * live, throwing ESRCH when it is not (EPERM means live but unowned by this
 * user, which counts as alive here). `{ force: true }` on the delete because
 * two processes can race the SAME orphan: without it, the loser's `rmSync`
 * throws ENOENT on a file that is already gone rather than treating "someone
 * else got there first" as success.
 *
 * `isTracked` defaults to the real, `git`-backed check — every REAL call
 * site (this file's own housekeeping, at the top of `an untracked doc is
 * swept too`) uses that default and nothing else. It takes a parameter at
 * all only so the TRACKED-file guard can be proven without staging into the
 * real index (#186, review round 4): doing that for real, from a test,
 * raced this file's own required 4x-concurrent execution three separate
 * ways in three separate attempts — `git`'s repo-wide `index.lock` against a
 * sibling run's own `git add`/`git reset`; a real file sitting on shared
 * disk, dead-pid-named and content-matching, genuinely untracked for the
 * instant between being written and being staged, which a SIBLING run's own
 * cleanup pass is CORRECT to delete by this guard's own rules; and finally,
 * even once tracked-before-visible ordering closed that window, a residual
 * ~2% rate of a fresh `git ls-files` disagreeing with an `update-index` that
 * had just reported success against the SAME shared index under sustained
 * concurrent writes. None of those three is a defect in this function —
 * they are the cost of many processes racing to mutate ONE shared git index
 * at once, which is exactly the situation a permanent, deterministic test
 * must not need to create. Injecting the answer keeps the guard itself
 * real (the `if (isTracked(rel)) continue` line below is exactly what ships)
 * while making what "tracked" means for a single test case fixed and
 * reproducible; `trackedFiles` and the real index it reads are already
 * exercised elsewhere in this file (`an untracked doc is swept too` asserts
 * `trackedFiles(fixtureRel)` is empty before relying on the same default).
 *
 * `docsDir` takes a fourth-attempt fix for the SAME reason, one directory up
 * the same ladder (#241): injecting `isTracked` closed the staging race above
 * but left the fixture itself sitting in the real, shared `docs/`, dead-pid-
 * named and content-matching — bait a SIBLING run's own default (uninjected)
 * `cleanUpOrphanedFixtures()` sweep is, correctly, going to delete out from
 * under this test's assertion, by these exact rules, the instant that sibling
 * calls `readdirSync` on the same directory. 20 runs of 4x-concurrent on
 * `main` at `6b5f70f` failed 1/20 this way.
 *
 * "4x-concurrent" names two different experiments, and the cheaper one is far
 * louder — worth knowing before anyone rebuilds an 8x harness to watch this
 * fire. Four concurrent WHOLE-SUITE runs (the gate's load pass) stagger this
 * file against everything else, so the overlap window is thin and the race
 * reads as ~1% per leg. Four simultaneous runs of THIS FILE ALONE overlap
 * maximally and reproduce it at 30%: EXECUTED in review of #263 — pre-fix
 * tree 6 failing legs of 20, this commit's tree 0 of 20, same harness and
 * machine, `for i in 1 2 3 4; do npx vitest run <this file> & done; wait`
 * over five rounds. So the issue's "20 runs of 4x-concurrent are 20/20" IS a
 * falsifiable criterion under the single-file reading, and this commit meets
 * it against a pre-fix tree that visibly does not.
 * The fix mirrors #203's own —
 * `countBrokenCitationsIn` took its file list as a parameter rather than
 * reading shared state, because "a test that touches shared state races every
 * other copy of itself" — one level up: this function now takes the
 * directory it sweeps, defaulting to the real `docs/` for every production
 * call, so the TRACKED-guard test alone can point it at a fresh `mkdtemp`
 * directory instead. No sibling run's sweep of the real `docs/` ever lists a
 * `mkdtemp` directory, so nothing but this test's own (still-injected)
 * `isTracked` decides the fixture's fate — the guard under test stays exactly
 * as real as before, and the race is closed by removing the shared directory
 * rather than by weakening what is asserted.
 */
function cleanUpOrphanedFixtures(
  isTracked: (rel: string) => boolean = (rel) => trackedFiles(rel).length > 0,
  docsDir: string = path.join(REPO_ROOT, 'docs'),
): void {
  for (const entry of readdirSync(docsDir)) {
    const match = entry.match(UNTRACKED_FIXTURE_RE)
    if (!match) continue
    const pid = Number(match[1])
    let alive = true
    try {
      process.kill(pid, 0)
    } catch (err) {
      alive = (err as NodeJS.ErrnoException).code !== 'ESRCH'
    }
    if (alive) continue

    // Relative to REPO_ROOT, not `docsDir` — the real default call needs
    // exactly `docs/${entry}`, the shape `trackedFiles` (a `git ls-files`
    // pathspec, matched against the index from REPO_ROOT) expects; deriving
    // it from `docsDir` rather than hardcoding the `docs/` prefix is what
    // lets a test-only `mkdtemp` directory (#241) pass a real, if
    // repo-external, relative path through to its own injected `isTracked`
    // without that default ever needing to understand a directory outside
    // `docs/`.
    const rel = path.relative(REPO_ROOT, path.join(docsDir, entry))
    const filePath = path.join(docsDir, entry)
    let content: string
    try {
      content = readFileSync(filePath, 'utf8')
    } catch {
      continue // gone already — another process's cleanup (or its own `finally`) beat us to it
    }
    if (!isFixtureContent(content)) continue
    if (isTracked(rel)) continue
    rmSync(filePath, { force: true })
  }
}

/** `git check-ignore` needs a trailing slash to resolve a directory pattern (like `dist/`) against a path that doesn't exist on disk — tried both ways. */
function isIgnored(relPath: string): boolean {
  for (const candidate of [relPath, `${relPath}/`]) {
    try {
      execFileSync('git', ['check-ignore', '-q', '--', candidate], { cwd: REPO_ROOT, stdio: 'ignore' })
      return true
    } catch {
      // try the next candidate
    }
  }
  return false
}

/** Dated artefacts, excluded as CITING sources only — see the doc comment above. */
const EXCLUDED_DIRS = ['docs/research/', 'docs/review/', 'docs/prds/']

// `prefix-comparison-law.test.ts` flags any `X.startsWith(ident)` sitting near a
// `path.*` call as a containment idiom — see OWN_FILE's own doc comment above
// for why that constant is declared far from this line on purpose (#186 item
// 8). If OWN_FILE (or its `path.relative(...)` call) is ever moved down here,
// re-check that law's pinned count before assuming this line is unaffected.
function isExcludedCitingFile(file: string): boolean {
  return file === OWN_FILE || EXCLUDED_DIRS.some((dir) => file.startsWith(dir))
}

/**
 * The tree-pin marker (#228) — one form, no variants. `**Tree:**`, a backticked ref,
 * the word `at`, a backticked 7–40 hex sha, at the start of a line. Anchored to a
 * line start and to the literal `at` so prose like "the *Tree* view: `foo.ts`" or a
 * bare `**Tree:** `main`` cannot match — the rigged-input test below holds both.
 * Read from the head of the (fence-stripped) document only: a pin buried in the body
 * is not a declaration, it is a mention.
 */
const TREE_PIN_RE = /^\*\*Tree:\*\*\s+`[^`\n]+`\s+at\s+`([0-9a-f]{7,40})`/m
const PIN_HEAD_LINES = 12

function declaredTreePin(text: string): string | undefined {
  const head = text.split('\n').slice(0, PIN_HEAD_LINES).join('\n')
  return TREE_PIN_RE.exec(head)?.[1]
}

/**
 * `git cat-file -e <sha>^{commit}` — exits 0 when the object exists AND is a commit.
 * Cached per sha: the sweep asks once per pinned document, and every pinned document
 * in one run tends to pin the same few commits.
 */
const pinResolutionCache = new Map<string, boolean>()
function pinResolves(sha: string): boolean {
  const cached = pinResolutionCache.get(sha)
  if (cached !== undefined) return cached
  let resolves = true
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: REPO_ROOT, stdio: 'ignore' })
  } catch {
    resolves = false
  }
  pinResolutionCache.set(sha, resolves)
  return resolves
}

/**
 * `pinResolves` asks the LOCAL object store, so it can only answer in a clone that has
 * the history. A `--depth 1` checkout holds no sha but the tip, so every honest pin to
 * an ancestor reads as a fake one — and the exemption inverts into its own defect: the
 * one real pinned record, `docs/design/glance-2026-09-02.md` at `0851512`, gets reported
 * by `badPins()` and swept as a live claim, which is exactly what #228 fixes, on CI only.
 *
 * `.github/workflows/ci.yml`'s suite leg therefore checks out with `fetch-depth: 0`, and
 * the test below asserts that precondition rather than trusting it: an edit back to the
 * default depth fails HERE, naming the cause, instead of surfacing as a bad-pin report
 * against a document whose pin is perfectly honest (review of #229).
 */
function repoIsShallow(): boolean {
  return execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim() === 'true'
}

/** A pinned artefact — excluded as a CITING source — only when its declared pin resolves. */
function isPinnedArtefact(text: string): boolean {
  const sha = declaredTreePin(text)
  return sha !== undefined && pinResolves(sha)
}

interface BadPin {
  file: string
  sha: string
}

/** Pure: every entry whose head declares a pin that does not resolve. Tested on rigged input; `badPins()` runs it over the tree. */
function badPinsIn(entries: readonly { file: string; text: string }[]): BadPin[] {
  const out: BadPin[] = []
  for (const { file, text } of entries) {
    const sha = declaredTreePin(text)
    if (sha !== undefined && !pinResolves(sha)) out.push({ file, sha })
  }
  return out
}

function badPins(): BadPin[] {
  const entries: { file: string; text: string }[] = []
  for (const file of sweepFiles('docs/*.md')) {
    if (isExcludedCitingFile(file)) continue
    const raw = readSweptFile(file)
    if (raw === undefined) continue
    entries.push({ file, text: stripFencedCodeBlocks(raw) })
  }
  return badPinsIn(entries)
}

/**
 * Build artefacts that exist only after `npm run build` or packaging — the
 * exemption below is scoped to exactly these directory NAMES, not "anything
 * git ignores" (#186 item 4). `.gitignore`'s `dist/`, `dist-desktop/` and
 * `dist-vendor/` rules have no leading slash, so git itself matches them at
 * any depth; matching by path SEGMENT here mirrors that, rather than
 * requiring the citation to be repo-rooted.
 */
const BUILD_ARTIFACT_DIR_NAMES = ['dist', 'dist-desktop', 'dist-vendor']

function isBuildArtifactPath(relPath: string): boolean {
  return relPath.split('/').some((segment) => BUILD_ARTIFACT_DIR_NAMES.includes(segment))
}

/** Illustrative examples, not citations — see the input table's fenced-code-block row. */
function stripFencedCodeBlocks(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '')
}

/** The `//` and `/* *\/` comment bodies of a TS source file, concatenated — code is out of ruling 1's scope. */
function extractComments(source: string): string {
  const blockComments = [...source.matchAll(/\/\*[\s\S]*?\*\//g)].map((m) => m[0])
  const lineComments = [...source.matchAll(/\/\/.*$/gm)].map((m) => m[0])
  return [...blockComments, ...lineComments].join('\n')
}

/** Every backtick-delimited `packages/`, `scripts/` or `docs/`-rooted path string in `text`. */
const CITATION_RE = /`((?:packages|scripts|docs)\/[A-Za-z0-9_./*:#-]+)`/g

function extractCitations(text: string): string[] {
  return [...text.matchAll(CITATION_RE)].map((m) => m[1]!)
}

/**
 * Strips a trailing `:123` line ref, a `:78-85` line RANGE, or an `#anchor` heading ref
 * — none of them part of the path proper.
 *
 * The range arm is not decoration. Widening CITATION_RE to admit `:` without it turns 7
 * real range citations (`…/common.ts:78-85`) into fresh violations, because `/:\d+$/`
 * matches a single number and stops. Range is the sibling of line-ref, and the two
 * arrive together (review of #16).
 *
 * One alternation matching a RUN of suffix groups, not two sequential replaces. Two
 * replaces are order-dependent and only strip the outermost: `x.md:1#anchor` had `:\d+$`
 * fail (the anchor is last), then the anchor stripped, leaving `x.md:1` — which exists
 * nowhere, so a valid citation became a FALSE VIOLATION. The mirrored spelling
 * `x.md#anchor:1` resolved fine, so the defect was visible in one order only.
 *
 * That regression was introduced by widening the character class, and it is strictly
 * worse than what it replaced: before the widening these spans did not match at all and
 * were silently skipped; after it they matched and were mis-stripped. A false positive
 * is louder than a false negative, and still wrong. Found by the fix re-review, which is
 * the pass that exists because a repair has been read by only the person who asked for
 * it (re-review of #16).
 */
function stripCitationSuffix(cite: string): string {
  return cite.replace(/(?::\d+(?:-\d+)?|#[A-Za-z0-9_.-]+)+$/, '')
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${escaped}$`)
}

/**
 * Turns a FULL path glob into a regex over whole repo-relative paths, where
 * `**` crosses `/` and matches ZERO OR MORE path segments, and a lone `*`
 * matches within one segment only (#186 item 3, review round 2). `globToRegExp`
 * above is the wrong tool for this: it treats every `*` — single or doubled —
 * as `.*`, which is only correct for the basename-only, no-`**` case it is
 * actually used for.
 *
 * Segment-by-segment, not token-by-token (the first version of this function
 * was token-by-token and was defeated by its own doc comment: it claimed
 * "zero or more" while `dir/**\/file` compiled to `dir/.*\/file`, which keeps
 * BOTH literal slashes flanking `**` mandatory — matching zero segments would
 * require the source string to contain `dir//file`, a double slash no real
 * path has, so the "zero" case silently could never fire. `packages/core/src/
 * fleet/**\/fences.ts` (that file exists), `docs/**\/roadmap.md` and
 * `packages/*\/src/**\/*.ts` (live at `docs/review/gemini-3.1-pro/
 * code-quality.md:25`, reachable through `citationExists` directly even
 * though that file's own directory is excluded as a CITING source) all
 * resolved false before this rewrite despite naming real files — a false
 * positive on real, working citations, louder than the false negative this
 * branch exists to close and just as wrong.
 *
 * An interior `**` (segments on both sides) compiles to `(?:/.*)?` and
 * contributes NO separating slash of its own — the segment immediately after
 * it still adds its own leading `/` the normal way. That is what lets the
 * SAME token serve both the zero-segment case (group absent: the two real
 * neighbours end up adjacent through one shared slash) and the N-segment
 * case (group present: it swallows its own leading slash plus every
 * character up to, but not including, the next segment's slash). A leading
 * `**` (nothing before it) compiles to `(?:.*\/)?` instead — the trailing
 * slash lives INSIDE the group there, since there is no earlier segment to
 * borrow one from. A trailing `**` is unchanged from the first version:
 * `/.*`, requiring the slash already emitted by the segment before it.
 *
 * The whole-glob-is-`**`-alone arm and the leading-`**` arm above are
 * UNREACHABLE through any real citation (#186, review round 3, worth noting
 * rather than fixing): `CITATION_RE` guarantees every span starts with a
 * literal `packages/`, `scripts/` or `docs/`, so `segment === '**'` can never
 * be true at index 0 for a glob this file's own extractor ever produces. Both
 * arms are verified correct anyway — 182 comparisons against `picomatch`
 * across repeated `**`, zero-segment and mixed `*`/`**` cases found zero
 * mismatches (review round 2) — and kept for that reason: this function
 * describes glob semantics in general, not "whatever CITATION_RE happens to
 * feed it today," and removing a correct arm because nothing currently
 * reaches it would leave the function quietly wrong the moment something
 * else calls it with a leading `**`.
 */
function globToPathRegExp(glob: string): RegExp {
  const escapeLiteral = (segment: string) =>
    segment.replace(/[.+?^${}()|[\]\\]/g, '\\$&').split('*').join('[^/]*')

  const segments = glob.split('/')
  let pattern = ''
  // Whether the NEXT literal segment must add its own leading `/`. Starts
  // false (nothing precedes the first segment); a leading `**` also leaves
  // it false, on purpose — its own optional group already carries the
  // trailing slash it needs when non-empty, so the segment right after it
  // must not double it.
  let needsSlash = false
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]!
    const isFirst = i === 0
    const isLast = i === segments.length - 1
    if (segment === '**') {
      if (isFirst && isLast) {
        pattern += '.*'
      } else if (isLast) {
        pattern += needsSlash ? '/.*' : '.*'
      } else if (isFirst) {
        pattern += '(?:.*/)?'
        needsSlash = false
        continue
      } else {
        pattern += '(?:/.*)?'
      }
      needsSlash = true
      continue
    }
    pattern += (needsSlash ? '/' : '') + escapeLiteral(segment)
    needsSlash = true
  }
  return new RegExp(`^${pattern}$`)
}

/** A cited path exists if the literal target exists, a `**` glob resolves against a real tracked file, a mid-filename `*` glob matches a real sibling, a bare ADR-style prefix matches a real record, or the target sits under a build-artefact directory (`dist/` and friends — not a tracked-tree claim). */
function citationExists(cite: string): boolean {
  const stripped = stripCitationSuffix(cite)

  // Filesystem first, `git check-ignore` second, and (#186 item 4, review round 2)
  // `isBuildArtifactPath` gates the SECOND check now, short-circuiting `isIgnored`'s
  // 1-2 child processes per citation before they fork at all for anything whose path
  // does not contain a `dist`/`dist-desktop`/`dist-vendor` segment — which is nearly
  // everything in the exclusion scan (docs/research, docs/review, docs/prds citations
  // are mostly broken paths that never mention a build-artefact directory) and most of
  // the main sweep too. This INVERTED the ordering the old form of this comment
  // measured (measured per test BY NAME, not by sorting two durations and assuming the
  // order — the ORIGINAL form of this comment did that and had both pairs swapped):
  //
  //     exclusion honesty   3156 ms -> ~380 ms -> ~60 ms
  //     main sweep          2466 ms -> ~145 ms -> ~90 ms
  //
  // The exclusion scan is now the FASTER of the two: `isBuildArtifactPath` prunes
  // essentially every one of its ~700 citations before `isIgnored` would have forked
  // for them, where before this commit every one of them still forked unconditionally.
  // The main sweep still carries the ~9 real `dist/`-rooted citations that DO reach
  // `isIgnored`'s subprocess, so it is now the slower side by a comparatively narrow
  // margin — the opposite of "slower on both sides, by a wider ratio," which was true
  // only before this commit. gate.sh's load-batches mode runs the suite four times
  // concurrently, where a multi-second test under a 5 s timeout has no room (review of
  // #16); at these durations neither test is close to that ceiling.
  if (existsSync(path.join(REPO_ROOT, stripped))) return true
  if (isBuildArtifactPath(stripped) && isIgnored(stripped)) return true

  if (stripped.includes('**')) {
    // The literal prefix before the first `**` is a cheap early-out for the
    // common "does not exist at all" case; it is NOT the whole check (#186
    // item 3) — everything after the `**` must also resolve against a real
    // tracked file, or a bogus filename past the `**` would pass on the
    // prefix existing alone. Skipped entirely when the prefix itself
    // contains a `*` (`packages/*/src/**/*.ts`, review round 2): `existsSync`
    // can never see a literal directory named `*`, so the early-out would
    // report the prefix as absent and false-negative every citation of that
    // shape regardless of whether a real file matches — the exact failure
    // this branch exists to close, one level up.
    const prefix = stripped.slice(0, stripped.indexOf('**')).replace(/\/$/, '')
    if (!prefix.includes('*') && (prefix.length === 0 || !existsSync(path.join(REPO_ROOT, prefix)))) return false
    const regex = globToPathRegExp(stripped)
    return allTrackedFiles().some((file) => regex.test(file))
  }

  if (stripped.includes('*')) {
    const dir = path.dirname(stripped)
    if (!existsSync(path.join(REPO_ROOT, dir))) return false
    const pattern = globToRegExp(path.basename(stripped))
    return readdirSync(path.join(REPO_ROOT, dir)).some((entry) => pattern.test(entry))
  }

  // Bare directory/number, no filename — `docs/adr/0012` for `docs/adr/0012-slug.md`.
  const dir = path.dirname(stripped)
  const base = path.basename(stripped)
  if (!base.includes('.') && existsSync(path.join(REPO_ROOT, dir))) {
    return readdirSync(path.join(REPO_ROOT, dir)).some((entry) => entry.startsWith(`${base}-`))
  }

  return false
}

type Citation = { file: string; cite: string }

/**
 * How many citations in `files` are broken — the body of the exclusion-honesty
 * scan, lifted out so the ENOENT guard inside it can be tested directly (#203).
 *
 * It was inline in the test, which left the guard unprovable without staging a
 * deletion into the real index — and this law runs 4x concurrently, so a test
 * that mutates git races every other copy of itself. Passing the file list in
 * means the tracked-but-deleted case is a one-element array, not a repo
 * mutation.
 */
function countBrokenCitationsIn(files: readonly string[]): number {
  let broken = 0
  for (const file of files) {
    // `readSweptFile`, not a bare `readFileSync`: these paths come from
    // `git ls-files`, which names what the INDEX holds and the disk may not —
    // a tracked file deleted and not yet staged. #186 item 5 fixed exactly
    // that for `allCitations`; this scan is its sibling and kept throwing
    // ENOENT, so the run died carrying a stack trace instead of failing like
    // a law.
    const raw = readSweptFile(file)
    if (raw === undefined) continue
    for (const cite of new Set(extractCitations(stripFencedCodeBlocks(raw)))) {
      if (!citationExists(cite)) broken += 1
    }
  }
  return broken
}

/**
 * Every citation from every in-scope `docs/*.md` file and every `packages/*.ts`
 * file's comments — deduplicated per file, since existence does not depend on
 * how many times a file repeats the same citation.
 *
 * Swept via `sweepFiles`, tracked and untracked alike (#186 item 5): reading
 * only `git ls-files`' INDEX made a brand new doc invisible until `git add`,
 * so a dead citation in it passed all three of `AGENTS.md`'s pre-commit
 * commands and only reddened once staged. `readSweptFile` skips (rather than
 * crashes on) a file the listing names but that is gone from disk — the
 * related ENOENT finding.
 */
function allCitations(): Citation[] {
  const out: Citation[] = []
  for (const file of sweepFiles('docs/*.md')) {
    if (isExcludedCitingFile(file)) continue
    const raw = readSweptFile(file)
    if (raw === undefined) continue
    const text = stripFencedCodeBlocks(raw)
    // A declared, RESOLVING tree pin makes this a dated artefact (#228) — see the
    // Scope section. Documents only; the TS loop below deliberately never asks.
    if (isPinnedArtefact(text)) continue
    for (const cite of new Set(extractCitations(text))) out.push({ file, cite })
  }
  for (const file of sweepFiles('packages/*.ts')) {
    if (isExcludedCitingFile(file)) continue
    const raw = readSweptFile(file)
    if (raw === undefined) continue
    const text = extractComments(raw)
    for (const cite of new Set(extractCitations(text))) out.push({ file, cite })
  }
  return out
}

/**
 * Every currently-broken citation this law's own extractor found, from an in-scope
 * file, run against the real tree while writing this law. Six clusters, sixteen
 * citations — more than the four the issue's audit named, because the audit's list
 * did not include citations INTO `docs/research/`/`docs/prds/` made from OUTSIDE
 * them (the ADR→PRD and the `docs/prd2.md` entries), which this law's scope (citing
 * file, not cited-target directory) does catch. Wave 2 removes entries as each doc
 * is corrected; when this list is empty, the law is unconditional.
 */
const ALLOWLISTED_BROKEN_CITATIONS: ReadonlyArray<{ file: string; cite: string; reason: string }> = [
  {
    file: 'docs/adr/0029-a-recording-may-repeat-a-fact.md',
    cite: 'docs/prds/prd-40-the-record-survives-the-write.md',
    reason: 'prd-40 was blessed and moved to docs/prds/done/ after this ADR cited its pre-done path',
  },
  {
    file: 'packages/core/src/placeholder.ts',
    cite: 'packages/server/src/app.ts',
    reason: 'scaffold-era comment; no file has ever existed at this path (the server entry point is elsewhere)',
  },
  {
    file: 'packages/web/src/lib/format.ts',
    cite: 'docs/prd2.md',
    reason: 'pre-rename PRD numbering; the PRD corpus has never used bare numeric filenames since',
  },
]

describe('doc citation law: a path cited from a document or a comment must exist (prd43 ruling 1)', () => {
  it('the sweep is non-empty — the checks below would pass vacuously otherwise', () => {
    expect(allCitations().length).toBeGreaterThan(200)
  })

  it('a file directly under docs/ is swept — the git-ls-files glob gotcha this law was almost shipped with', () => {
    // docs/architecture.md sits at depth 1, not under any subdirectory. `docs/**/*.md`
    // requires an extra path separator and misses it; `docs/*.md` does not, because git's
    // default pathspec matching already lets a bare `*` cross `/`.
    //
    // Asserted against `allCitations()` — the PRODUCTION sweep — not against a
    // `trackedFiles` call this test makes itself. The earlier form re-derived the
    // pattern independently, so it passed unchanged while the sweep at its own call
    // site was narrowed to `docs/**/*.md`: every depth-1 doc dropped out, a real dead
    // path in architecture.md went unseen, and this file stayed 14/14 green. A pin
    // that re-derives what it is pinning is not a pin (review of #16).
    const sweptFiles = new Set(allCitations().map(({ file }) => file))
    expect(sweptFiles).toContain('docs/architecture.md')
    expect(sweptFiles).toContain('docs/roadmap.md')
    expect(trackedFiles('docs/*.md').length).toBeGreaterThan(150)
  })

  it('every excluded directory is still tracked and still trips the detector — the exclusion is doing real work, not vacuous', () => {
    // Pinned so the loop below cannot pass vacuously (#186 item 6): with
    // EXCLUDED_DIRS emptied to `[]`, the `for` loop's body never runs and the
    // test still reported green — 0 iterations is 0 failing assertions. This
    // assertion fails on its own, before the loop, regardless of what the
    // loop does or doesn't get to check.
    expect(EXCLUDED_DIRS).toEqual(['docs/research/', 'docs/review/', 'docs/prds/'])

    for (const dir of EXCLUDED_DIRS) {
      const files = [...new Set([...trackedFiles(`${dir}*.md`), ...trackedFiles(`${dir}**/*.md`)])]
      expect(files.length, `${dir} has no markdown files to check`).toBeGreaterThan(0)

      const brokenCount = countBrokenCitationsIn(files)
      expect(brokenCount, `${dir} would trip nothing if scanned — the exclusion is stale`).toBeGreaterThan(0)
    }
  })

  it('an untracked doc is swept too — a new doc must fail before `git add`, not only after it (#186 item 5)', () => {
    // The fixture cites a path that RESOLVES (review round 2, BLOCKER): the
    // first version cited a dead path, so for however briefly this file sat
    // on real disk under docs/, ANY OTHER process's concurrent sweep — of
    // this same suite, staggered by nothing more than normal scheduling
    // jitter — would pick it up via the exact `--others` visibility this test
    // exists to prove, and fail ITS `every in-scope citation exists` test on
    // a file it does not own. Reproduced: 8 staggered concurrent runs x 6
    // rounds gave failures under load with the dead-citation fixture and none
    // with this one. Citing a REAL path still proves the untracked file
    // reaches `allCitations()` at all — which is everything item 5 asked —
    // and still reddens when `sweepFiles` is reverted to `trackedFiles`,
    // since a reverted sweep would not see this untracked file, real citation
    // or not. Trade-off: unlike the dead-citation version, this no longer
    // demonstrates end-to-end that an untracked file's BROKEN citation
    // reddens the law — that path is covered separately, on a file already IN
    // the tree, by `every in-scope citation exists...` at the bottom of this
    // describe block.
    cleanUpOrphanedFixtures()

    const fixtureRel = `docs/citation-law-untracked-fixture-${process.pid}-${Date.now()}.md`
    const fixturePath = path.join(REPO_ROOT, fixtureRel)
    expect(existsSync(fixturePath), `${fixtureRel} already exists — pick a different fixture name`).toBe(false)

    writeFileSync(fixturePath, UNTRACKED_FIXTURE_CONTENT)
    try {
      // Genuinely untracked, not accidentally staged — the whole point of the fixture.
      expect(trackedFiles(fixtureRel)).toEqual([])
      expect(sweepFiles(fixtureRel)).toEqual([fixtureRel])

      expect(allCitations()).toContainEqual({
        file: fixtureRel,
        cite: 'packages/server/src/doc-citation-law.test.ts',
      })
    } finally {
      rmSync(fixturePath, { force: true })
    }
  })

  it('cleanUpOrphanedFixtures never deletes a real document that merely matches its naming pattern (#186, review round 3 BLOCKER)', () => {
    // `process.hrtime.bigint()`, not `Date.now()` (#186, review round 5): a
    // CONSTANT dead-pid segment plus millisecond resolution is the one
    // combination in this file with no per-process uniqueness at all — two
    // concurrent suites entering this test in the same millisecond mint the
    // IDENTICAL path, and the gate's own 4x-concurrent load found exactly
    // that: one run's `finally { rmSync }` deletes the file out from under
    // the other run's `expect(existsSync(...))`, reading as this test's own
    // BLOCKER when it is really two runs sharing one filename. The dead pid
    // segment stays a constant on purpose — the cleanup must get PAST the
    // alive check to reach the content check this test is actually proving,
    // or it survives for the wrong reason. Nanosecond resolution is the
    // fix, the same treatment the sibling test below already carries.
    const rel = `docs/citation-law-untracked-fixture-999996-${process.hrtime.bigint()}.md`
    const filePath = path.join(REPO_ROOT, rel)
    writeFileSync(filePath, '# A real document that happens to match the fixture naming pattern\n')
    try {
      cleanUpOrphanedFixtures()
      expect(existsSync(filePath), 'a real document was deleted for merely matching the fixture filename pattern').toBe(true)
    } finally {
      rmSync(filePath, { force: true })
    }
  })

  it('cleanUpOrphanedFixtures never deletes a file its caller reports as TRACKED, even with a dead-pid name and byte-identical content (#186, review round 4; #241)', () => {
    // `isTracked` is INJECTED here, not answered by staging into the real
    // index (review round 4): three separate attempts to prove this by
    // actually running `git add`/`update-index` from the test each raced
    // this file's own required 4x-concurrent execution a different way —
    // `git`'s repo-wide `index.lock` against a sibling run's own index
    // write; a real, on-disk, dead-pid-named, content-matching file sitting
    // genuinely untracked for the instant between being written and being
    // staged, which a SIBLING run's cleanup pass is CORRECT to delete by
    // this guard's own rules; and, once that ordering was closed, a
    // residual ~2% rate of a fresh `git ls-files` disagreeing with an
    // `update-index` that had just reported success, under sustained
    // concurrent writes to the ONE shared index. None of those is a defect
    // in `cleanUpOrphanedFixtures` — they are the cost of many processes
    // racing to mutate a single shared file, which a permanent,
    // deterministic test has no business creating. `trackedFiles` and the
    // real index it reads stay exercised elsewhere in this file (`an
    // untracked doc is swept too` relies on the same default `isTracked`
    // and separately asserts `trackedFiles(fixtureRel)` is empty first) —
    // this test's job is only to prove `cleanUpOrphanedFixtures` respects
    // whatever `isTracked` reports, which the injected function lets it do
    // with zero flakiness.
    //
    // `docsDir` is ALSO injected now, into a fresh `mkdtemp` directory rather
    // than the real `docs/` (#241): the fourth race, found by this file's own
    // mandatory 4x-concurrent run (1/20) rather than by review, was never in
    // this test's own body — it was a SIBLING run's unrelated, default
    // `cleanUpOrphanedFixtures()` call sweeping the SAME real `docs/`,
    // finding this same dead-pid-named, content-matching file genuinely
    // untracked (which it is — the injected `isTracked` above protects only
    // the call this test itself makes), and correctly deleting it by its own
    // rules before this test's assertion ran. Naming the fixture for the
    // current (live) pid instead would dodge that race by never reaching the
    // content check at all, making the TRACKED guard itself unexercised — the
    // trap the issue names explicitly. `mkdtemp` closes the race the other
    // way: no sibling run's sweep of the real `docs/` ever lists a directory
    // it was never told about, so the file's fate is decided by nothing but
    // the injected `isTracked` above, which is the one thing under test.
    const tmpDocsDir = mkdtempSync(path.join(tmpdir(), 'citation-law-tracked-guard-'))
    try {
      const entry = `citation-law-untracked-fixture-999997-${process.hrtime.bigint()}.md`
      const filePath = path.join(tmpDocsDir, entry)
      const rel = path.relative(REPO_ROOT, filePath)
      writeFileSync(filePath, UNTRACKED_FIXTURE_CONTENT)

      // POSITIVE CONTROL, and it is load-bearing rather than decorative.
      // Isolating this test into a tmpdir removed the race, and in doing so
      // made its own setup silently optional: with `tmpDocsDir` NOT passed,
      // the sweep runs over the real `docs/`, never lists this fixture, and
      // the survival assertion below passes because nothing ever looked at
      // the file. EXECUTED: deleting that one argument left the file 31/31
      // green. Before this commit the equivalent one-token deletion — the
      // injected `isTracked` — reddened it, so isolation traded a
      // self-enforcing setup for a vacuous one.
      //
      // This second fixture is identical in every respect the sweep tests —
      // dead pid, byte-identical content, same directory — and differs only
      // in the answer `isTracked` gives for it. So the pair cannot both come
      // out right unless the sweep actually VISITED `tmpDocsDir`, and unless
      // `isTracked`'s verdict is the only thing separating them.
      const controlEntry = `citation-law-untracked-fixture-999998-${process.hrtime.bigint()}.md`
      const controlPath = path.join(tmpDocsDir, controlEntry)
      writeFileSync(controlPath, UNTRACKED_FIXTURE_CONTENT)

      cleanUpOrphanedFixtures((candidate) => candidate === rel, tmpDocsDir)
      expect(existsSync(filePath), 'a file reported TRACKED was deleted by a cleanup step meant only for untracked orphans').toBe(true)
      expect(
        existsSync(controlPath),
        'the control fixture — same directory, same dead pid, same bytes, reported UNTRACKED — was NOT deleted, so the sweep never visited tmpDocsDir and the assertion above proved nothing',
      ).toBe(false)
    } finally {
      rmSync(tmpDocsDir, { recursive: true, force: true })
    }
  })

  it("cleanUpOrphanedFixtures never deletes a fixture whose PID is still alive — the dangerous direction, since it could be a genuinely concurrent run's own (#186, review round 3)", () => {
    // This test's own process is unimpeachably alive, so its PID doubles as
    // a live one without needing a second process.
    const rel = `docs/citation-law-untracked-fixture-${process.pid}-${Date.now()}.md`
    const filePath = path.join(REPO_ROOT, rel)
    writeFileSync(filePath, UNTRACKED_FIXTURE_CONTENT)
    try {
      cleanUpOrphanedFixtures()
      expect(existsSync(filePath), 'a fixture with a LIVE pid was deleted — this is the guard that stops cleanup from destroying a genuinely concurrent run').toBe(true)
    } finally {
      rmSync(filePath, { force: true })
    }
  })

  it('a document that declares a resolving tree pin is a dated artefact, excluded as a citing source — wherever it lives (#228)', () => {
    cleanUpOrphanedFixtures()

    const fixtureRel = `docs/citation-law-untracked-fixture-${process.pid}-${Date.now()}.md`
    const fixturePath = path.join(REPO_ROOT, fixtureRel)
    expect(existsSync(fixturePath), `${fixtureRel} already exists — pick a different fixture name`).toBe(false)

    // The unpinned half of the same bytes DOES extract the citation — so the
    // absence asserted below is the pin's doing, not the extractor's.
    const unpinned = PINNED_FIXTURE_CONTENT.split('\n\n').slice(1).join('\n\n')
    expect(declaredTreePin(unpinned)).toBeUndefined()
    expect(extractCitations(unpinned)).toEqual(['packages/server/src/doc-citation-law.test.ts'])
    expect(declaredTreePin(PINNED_FIXTURE_CONTENT)).toBe(HEAD_SHA)
    expect(isFixtureContent(PINNED_FIXTURE_CONTENT), 'the cleanup must recognise its own fixture by shape').toBe(true)

    writeFileSync(fixturePath, PINNED_FIXTURE_CONTENT)
    try {
      expect(trackedFiles(fixtureRel)).toEqual([])
      expect(sweepFiles(fixtureRel), 'the sweep must SEE the file — exclusion, not invisibility, is what is being proved').toEqual([fixtureRel])
      expect(allCitations().filter(({ file }) => file === fixtureRel)).toEqual([])
      expect(badPins().filter(({ file }) => file === fixtureRel), 'a resolving pin is not a bad pin').toEqual([])
    } finally {
      rmSync(fixturePath, { force: true })
    }
  })

  it('the pin marker is exactly one form — prose about a tree, a pin with no `at`, or a pin outside the head do not exempt (#228)', () => {
    const sha = HEAD_SHA.slice(0, 7)
    expect(declaredTreePin(`**Tree:** \`main\` at \`${sha}\`\n`)).toBe(sha)
    expect(declaredTreePin(`# Title\n\n**Protocol:** x\n**Tree:** \`origin/main\` at \`${HEAD_SHA}\`. **Disposition:** y\n`)).toBe(HEAD_SHA)
    // The false positives the regex is anchored against.
    expect(declaredTreePin(`The *Tree* view: \`packages/server/src/doc-citation-law.test.ts\` at \`${sha}\`\n`)).toBeUndefined()
    expect(declaredTreePin(`**Tree:** \`main\` \`${sha}\`\n`)).toBeUndefined()
    expect(declaredTreePin(`**Tree:** \`main\` at \`not-a-sha\`\n`)).toBeUndefined()
    expect(declaredTreePin(`**Tree:** \`main\` at \`${sha}\``.padStart(200, 'prose ') + '\n')).toBeUndefined()
    // Buried past the head: twelve lines of body, then a pin.
    expect(declaredTreePin(`${'body\n'.repeat(PIN_HEAD_LINES)}**Tree:** \`main\` at \`${sha}\`\n`)).toBeUndefined()
    // Inside a fence, which the docs loop strips before asking.
    expect(declaredTreePin(stripFencedCodeBlocks(`\`\`\`\n**Tree:** \`main\` at \`${sha}\`\n\`\`\`\n`))).toBeUndefined()
  })

  it('a pin that does not resolve exempts nothing and is reported by name — a fake pin is a defect, not an exit (#228)', () => {
    const fake = 'deadbeef0'
    expect(pinResolves(fake)).toBe(false)
    expect(pinResolves(HEAD_SHA)).toBe(true)
    expect(pinResolves(HEAD_SHA.slice(0, 7)), 'a short sha resolves like a long one').toBe(true)

    const rigged = [
      { file: 'docs/design/rigged-fake-pin.md', text: `**Tree:** \`main\` at \`${fake}\`\n\nCites \`packages/this-directory-does-not-exist/nothing.ts\`.\n` },
      { file: 'docs/design/rigged-real-pin.md', text: PINNED_FIXTURE_CONTENT },
      { file: 'docs/design/rigged-no-pin.md', text: 'No pin at all.\n' },
    ]
    expect(badPinsIn(rigged)).toEqual([{ file: 'docs/design/rigged-fake-pin.md', sha: fake }])
    expect(isPinnedArtefact(rigged[0]!.text), 'a fake pin must NOT exempt').toBe(false)
    expect(isPinnedArtefact(rigged[1]!.text)).toBe(true)

    // The real tree carries no bad pin today — pinned like the allowlist, so a
    // fake one landing anywhere under docs/ is named here rather than absorbed.
    expect(badPins()).toEqual([])
  })

  it('the pin arm has the history it needs — in a shallow clone every honest pin reads as fake (#228, review of #229)', () => {
    expect(
      repoIsShallow(),
      'this clone is SHALLOW, so `git cat-file -e <sha>^{commit}` cannot see any sha but the tip and every tree pin to an ancestor reads as a fake one — run `git fetch --unshallow`, or restore `fetch-depth: 0` on the suite leg in `.github/workflows/ci.yml`',
    ).toBe(false)
    // And the pin arm is not vacuous in this clone: an ancestor of HEAD resolves,
    // which is the case a depth-1 checkout loses and a fake sha never had.
    const parent = execFileSync('git', ['rev-parse', 'HEAD^'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
    expect(pinResolves(parent), 'an ancestor sha must resolve — this is the case a shallow clone breaks').toBe(true)
  })

  it('a file the git listing names but that is gone from disk is skipped, not a crash — the ENOENT sibling of item 5', () => {
    expect(readSweptFile('docs/this-file-does-not-exist-on-disk.md')).toBeUndefined()
  })

  it('the EXCLUSION scan skips a tracked-but-deleted file too, not just the main sweep (#203)', () => {
    // The sibling #186 left behind. `readSweptFile` was already proven above,
    // but the exclusion-honesty scan called `readFileSync` directly, so the
    // same tracked-but-deleted file that the main sweep skipped killed this
    // scan with ENOENT — a stack trace where a verdict belonged.
    //
    // Driven through the real `countBrokenCitationsIn` rather than asserting
    // on `readSweptFile` again: the guard being reachable FROM THE SCAN is the
    // whole claim, and re-testing the helper would prove the thing that was
    // never broken. Remove the `raw === undefined` guard and this throws.
    const gone = 'docs/research/this-file-is-tracked-but-gone-from-disk.md'
    expect(existsSync(path.join(REPO_ROOT, gone)), 'the fixture path must NOT exist for this test to mean anything').toBe(
      false,
    )
    expect(() => countBrokenCitationsIn([gone])).not.toThrow()
    expect(countBrokenCitationsIn([gone])).toBe(0)

    // ...and the scan still COUNTS a file that is present, so the skip above
    // is a skip and not a scan that silently stopped working. Uses a real
    // excluded-directory file with at least one broken citation, which is the
    // property the enclosing law already asserts for every excluded dir.
    const realFiles = [...new Set([...trackedFiles('docs/research/*.md'), ...trackedFiles('docs/research/**/*.md')])]
    expect(realFiles.length, 'docs/research/ must hold tracked markdown for this control to mean anything').toBeGreaterThan(0)
    expect(countBrokenCitationsIn([gone, ...realFiles])).toBe(countBrokenCitationsIn(realFiles))
    expect(countBrokenCitationsIn(realFiles)).toBeGreaterThan(0)
  })

  it('the allowlist is pinned — a silent addition here is exactly how a real regression gets waved through', () => {
    expect(ALLOWLISTED_BROKEN_CITATIONS.map(({ file, cite }) => `${file} -> ${cite}`)).toEqual(
      [
        'docs/adr/0029-a-recording-may-repeat-a-fact.md -> docs/prds/prd-40-the-record-survives-the-write.md',
        'packages/core/src/placeholder.ts -> packages/server/src/app.ts',
        'packages/web/src/lib/format.ts -> docs/prd2.md',
      ].sort(),
    )
    for (const { reason } of ALLOWLISTED_BROKEN_CITATIONS) expect(reason.length).toBeGreaterThan(0)
  })

  it('every allowlisted entry is still cited by its file, and actually fails today — a stale entry would silently widen the law', () => {
    for (const { file, cite } of ALLOWLISTED_BROKEN_CITATIONS) {
      const filePath = path.join(REPO_ROOT, file)
      expect(existsSync(filePath), `${file} no longer exists — remove its allowlist entries`).toBe(true)

      const isDoc = file.endsWith('.md')
      const raw = readFileSync(filePath, 'utf8')
      const swept = isDoc ? extractCitations(stripFencedCodeBlocks(raw)) : extractCitations(extractComments(raw))
      expect(swept, `${file} no longer cites ${cite} — this allowlist entry is stale`).toContain(cite)

      expect(citationExists(cite), `${cite} now resolves — remove this allowlist entry, ${file} is fixed`).toBe(false)
    }
  })

  it('the detector bites on a missing path and passes on a real one — rigged fixtures, not the real tree', () => {
    expect(citationExists('packages/this-directory-does-not-exist/nothing.ts')).toBe(false)
    expect(citationExists('packages/server/src/doc-citation-law.test.ts')).toBe(true)
  })

  it('fenced code blocks are stripped before extraction — the illustrative-example false positive this law was built to avoid', () => {
    // The fenced content is itself citation-SHAPED (backtick-delimited, per
    // CITATION_RE), not the double-quoted-JSON form real fenced examples in
    // this corpus happen to use (#186 item 1). The earlier fixture fenced
    // `{ "fence": ["packages/…/**"] }` — no backticks anywhere inside it, so
    // CITATION_RE could never have matched it whether or not the fence was
    // stripped, and `stripFencedCodeBlocks` returning its input UNCHANGED left
    // this test 14/14 green. Asserted first WITHOUT stripping, so the fixture
    // is proven to actually exercise the stripper before trusting the second
    // assertion that stripping removes it.
    const rigged = [
      'See `packages/server/src/doc-citation-law.test.ts` in prose.',
      '```markdown',
      'Example: `packages/this-fabricated-example-does-not-exist/**` is illustrative only.',
      '```',
      'And again in prose: `packages/this-directory-does-not-exist/nothing.ts`.',
    ].join('\n')

    expect(extractCitations(rigged)).toContain('packages/this-fabricated-example-does-not-exist/**')

    const swept = extractCitations(stripFencedCodeBlocks(rigged))
    expect(swept).toEqual(['packages/server/src/doc-citation-law.test.ts', 'packages/this-directory-does-not-exist/nothing.ts'])
  })

  it('only comment text is swept from a TS file — a citation-shaped string in real code is not a claim', () => {
    const rigged = [
      "const p = `packages/this-directory-does-not-exist/from-code.ts` // not a citation",
      '// but `packages/server/src/doc-citation-law.test.ts` after the slashes IS one',
    ].join('\n')
    const swept = extractCitations(extractComments(rigged))
    expect(swept).toEqual(['packages/server/src/doc-citation-law.test.ts'])
  })

  it('CONTROL (#186 item 2, declared out of scope): a `//` inside a string literal still starts a "comment" — extractComments has no string-awareness', () => {
    // See the input table's row for this. `extractComments`'s line-comment
    // regex cannot tell a `//` inside a string from a real comment, so text
    // after it — including a citation-shaped backtick span — is swept as if
    // it were commentary. This is a KNOWN, documented false positive, not a
    // fix in this change: closing it needs a string-literal-aware tokenizer,
    // which this regex-based extractor deliberately does not attempt. Pinned
    // so a change to extractComments that narrows or widens this behaviour is
    // visible here rather than silent.
    const subject = "const u = 'https://example.invalid/`packages/this-directory-does-not-exist/nothing.ts`'"
    const control = "const u = 'no-slashes-here `packages/this-directory-does-not-exist/nothing.ts`'"
    expect(extractCitations(extractComments(subject))).toEqual(['packages/this-directory-does-not-exist/nothing.ts'])
    expect(extractCitations(extractComments(control))).toEqual([])
  })

  it('a directory glob resolves against its parent, and a mid-filename glob resolves against a real sibling', () => {
    expect(citationExists('packages/server/**')).toBe(true)
    expect(citationExists('packages/this-directory-does-not-exist/**')).toBe(false)
    // Truncating a mid-filename glob at the first `*` (rather than matching the real
    // directory listing) would falsely redden this — the exact false positive found
    // while building this extractor, against docs/architecture.md's real
    // `docs/research/2026-08-02-obs-prd7-*.md` citation.
    expect(citationExists('docs/research/2026-08-02-obs-prd7-*.md')).toBe(true)
    expect(citationExists('docs/research/2026-08-02-obs-prd7-this-does-not-exist-*.md')).toBe(false)
  })

  it('a `**` glob checks everything after it too, not just the parent (#186 item 3)', () => {
    // The three real citations this branch resolves today, all trailing
    // `dir/**` — pinned so the rewrite below is proven against the actual
    // corpus, not only rigged fixtures.
    expect(citationExists('packages/server/src/concierge/harness/**')).toBe(true)
    expect(citationExists('packages/core/**')).toBe(true)
    expect(citationExists('packages/web/src/disclosure/**')).toBe(true)

    // The defect: the parent (`packages`) existing used to be the WHOLE
    // check, so anything after the first `**` — a real filename, a further
    // glob segment, a second `**` — was silently discarded rather than
    // resolved. All three are real, reachable shapes; none existed live, but
    // the earlier code could not have told any of them from a real citation.
    expect(citationExists('packages/**/this-file-definitely-does-not-exist-anywhere.ts')).toBe(false)
    expect(citationExists('packages/**/*-this-suffix-does-not-exist-anywhere.ts')).toBe(false)
    expect(citationExists('packages/**/**/this-file-does-not-exist-either.ts')).toBe(false)

    // A real file DOES resolve through a mid-pattern `**`, proving the fix is
    // under-inclusive nowhere it should not be.
    expect(citationExists('packages/**/doc-citation-law.test.ts')).toBe(true)
  })

  it('`**` matches ZERO path segments, not one-or-more (#186 item 3, review round 2)', () => {
    // Three real citations, each requiring the ZERO-directory case to
    // resolve: the round-1 fix kept both literal slashes flanking `**`
    // mandatory, so none of these — all real, all existing — could ever
    // match, a false positive on working code.
    expect(citationExists('packages/core/src/fleet/**/fences.ts')).toBe(true)
    expect(citationExists('docs/**/roadmap.md')).toBe(true)
    // Live at docs/review/gemini-3.1-pro/code-quality.md:25 — reachable
    // through citationExists directly even though that file's own directory
    // is excluded as a citing source, so this pins the shape rather than the
    // sweep finding it.
    expect(citationExists('packages/*/src/**/*.ts')).toBe(true)

    // The one-or-more-segment case must keep working too — this is a fix to
    // the zero case, not a rewrite that only handles zero.
    expect(citationExists('packages/core/src/fleet/**/does-not-exist.ts')).toBe(false)
  })

  it('a lone `*` does not cross `/` — only `**` spans directories (#186 item 3, review round 2)', () => {
    // Pinned directly against globToPathRegExp's own regex, not just an
    // end-to-end true/false: changing '[^/]*' to '.*' for the single-star arm
    // would leave every citationExists() case above green (none of them
    // exercises a lone `*` where the difference is observable), so the
    // observable difference has to be asserted here.
    expect(globToPathRegExp('packages/*/doc-citation-law.test.ts').test('packages/server/src/doc-citation-law.test.ts')).toBe(false)
    expect(globToPathRegExp('packages/*/src/doc-citation-law.test.ts').test('packages/server/src/doc-citation-law.test.ts')).toBe(true)
  })

  it('a line-ref, line-range or heading-anchor suffix survives EXTRACTION and is then stripped', () => {
    // Asserted end-to-end, through extractCitations. The earlier form called
    // citationExists() directly with an already-suffixed string, which cannot fail for
    // the reason its title claimed: CITATION_RE's character class excluded `:` and `#`,
    // so the sweep never produced such a string and stripCitationSuffix was unreachable
    // from it. A broken `x.ts:42` citation was invisible while a broken `x.ts` was
    // caught — same defect, two spellings (review of #16).
    const doc = [
      'a line ref `packages/server/src/doc-citation-law.test.ts:1`',
      'a line range `packages/server/src/doc-citation-law.test.ts:78-85`',
      'an anchor `docs/architecture.md#some-heading`',
      'a dead one `packages/this-directory-does-not-exist/nothing.ts:1`',
    ].join('\n')

    const extracted = extractCitations(doc)
    expect(extracted).toEqual([
      'packages/server/src/doc-citation-law.test.ts:1',
      'packages/server/src/doc-citation-law.test.ts:78-85',
      'docs/architecture.md#some-heading',
      'packages/this-directory-does-not-exist/nothing.ts:1',
    ])

    expect(extracted.filter((c) => !citationExists(c))).toEqual([
      'packages/this-directory-does-not-exist/nothing.ts:1',
    ])
  })

  it('a COMPOUND suffix strips to the path in either order — the regression the widened class introduced', () => {
    // `:1#anchor` and `#anchor:1` are the same claim about the same file. Two sequential
    // replaces stripped only the outermost, so the first spelling resolved to `x.md:1`
    // and reported a file that exists as broken, while its mirror resolved correctly.
    // Both orders, both arms, and a repeated run (re-review of #16).
    for (const cite of [
      'docs/architecture.md:1#some-heading',
      'docs/architecture.md#some-heading:1',
      'docs/architecture.md:78-85#some-heading',
      'docs/architecture.md#some-heading:78-85',
      // A `file:line:col` triple. The run-alternation strips both numeric groups; two
      // sequential replaces took only the last, leaving `…md:150`. Zero instances today —
      // this repo's house style is `file:line` — but it is the same class, and the class
      // is what the fix is for.
      'docs/architecture.md:150:12',
      // An anchor containing a dot. `#[A-Za-z0-9_-]+` stopped at the `.` and stripped
      // nothing, so the whole span survived to the existence check and reported a real
      // file as broken.
      'docs/architecture.md#v1.2',
    ]) {
      expect(stripCitationSuffix(cite), `${cite} must strip to the bare path`).toBe('docs/architecture.md')
      expect(citationExists(cite), `${cite} names a file that exists`).toBe(true)
    }

    // CONTROL: the suffix machinery must not invent existence for a path that is absent.
    expect(citationExists('docs/this-file-does-not-exist.md:1#x')).toBe(false)
  })

  it('a bare ADR number resolves as a prefix match against the real record — the one live instance of this form', () => {
    expect(citationExists('docs/adr/0012')).toBe(true)
    expect(citationExists('docs/adr/9999')).toBe(false)
  })

  it('a gitignored path is treated as valid, not broken — a dist/ build artefact is not a tracked-tree claim', () => {
    expect(isIgnored('packages/web/dist')).toBe(true)
    expect(citationExists('packages/web/dist')).toBe(true)
    expect(citationExists('packages/web/dist/index.html')).toBe(true)
    expect(isBuildArtifactPath('packages/web/dist')).toBe(true)
  })

  it('a gitignored path that is NOT a build artefact is still a real violation (#186 item 4)', () => {
    // docs/audit/ is gitignored — see .gitignore's own comment: findings are
    // "kept out of git deliberately" — but it is not a build artefact, and a
    // citation into a nonexistent audit file is a real, checkable claim. The
    // earlier code exempted EVERY gitignored path, not just dist/ and its two
    // siblings, so this silently passed.
    expect(isIgnored('docs/audit/2026-08-20-does-not-exist.md')).toBe(true)
    expect(isBuildArtifactPath('docs/audit/2026-08-20-does-not-exist.md')).toBe(false)
    expect(citationExists('docs/audit/2026-08-20-does-not-exist.md')).toBe(false)

    // coverage/ is also gitignored and also not a build artefact this
    // exemption covers.
    expect(isIgnored('coverage/this-file-does-not-exist-2mL9qX.html')).toBe(true)
    expect(isBuildArtifactPath('coverage/this-file-does-not-exist-2mL9qX.html')).toBe(false)
    expect(citationExists('coverage/this-file-does-not-exist-2mL9qX.html')).toBe(false)
  })

  it('this file excludes itself by an exact match, not a naming CONVENTION — and does not weaken the sweep for any other file', () => {
    // The title does NOT say "not by name" (#186 item 7, review round 2): a
    // hardcoded NAME (a plain string literal) is exactly what this assertion
    // cannot rule out. `OWN_FILE === '<literal path>'` holds identically
    // whether OWN_FILE is `path.relative(REPO_ROOT, fileURLToPath(import.meta.
    // url))` (identity) or the same string typed by hand (a hardcoded name) —
    // the first retitle still claimed "not by name", and that claim is exactly
    // as unprovable from in here as the original "by identity" one was. What
    // IS provable, and is what the rest of this test asserts, is that the
    // exclusion is not a naming CONVENTION — matching a PATTERN like "any
    // `*-law.test.ts` file" — since a same-directory sibling with a similar
    // name is demonstrably not excluded.
    expect(OWN_FILE).toBe('packages/server/src/doc-citation-law.test.ts')

    // Not a naming CONVENTION either — the #649 lesson. A same-directory file with a
    // similar name, or any other sibling `*-law.test.ts`, is NOT swept up by this
    // exclusion; only an exact match on this file's own resolved path is.
    expect(isExcludedCitingFile('packages/server/src/doc-citation-law.ts')).toBe(false)
    expect(isExcludedCitingFile('packages/server/src/no-personal-paths-law.test.ts')).toBe(false)
    expect(isExcludedCitingFile(OWN_FILE)).toBe(true)

    // The control: this file's own rigged, self-descriptive citations disappear once
    // excluded (proving the exclusion does something)...
    const ownText = extractComments(readFileSync(path.join(REPO_ROOT, OWN_FILE), 'utf8'))
    expect(extractCitations(ownText).length).toBeGreaterThan(0)
    expect(allCitations().some(({ file }) => file === OWN_FILE)).toBe(false)

    // ...while a REAL sibling violation — already on the allowlist above, from a file
    // this exclusion must NOT reach — is still extracted and still reported broken. If
    // the exclusion ever widened past this file's own identity, this would go green for
    // the wrong reason.
    const siblingFile = 'packages/core/src/placeholder.ts'
    const siblingText = extractComments(readFileSync(path.join(REPO_ROOT, siblingFile), 'utf8'))
    expect(extractCitations(siblingText)).toContain('packages/server/src/app.ts')
    expect(citationExists('packages/server/src/app.ts')).toBe(false)
    expect(allCitations().some(({ file, cite }) => file === siblingFile && cite === 'packages/server/src/app.ts')).toBe(true)
  })

  it('CONTROL (#186 item 9 ruling): capture.mjs carries the deliberate historical citation the ruling is about, and .mjs stays out of the sweep', () => {
    const mjsFile = 'packages/web/src/scene/parity/capture.mjs'
    const raw = readFileSync(path.join(REPO_ROOT, mjsFile), 'utf8')

    // The citation the ruling's evidence rests on is really there, backtick-
    // delimited in a doc comment, exactly like any citation this law does
    // sweep — the only thing exempting it is the file EXTENSION.
    expect(extractCitations(extractComments(raw))).toContain('packages/web/src/scene/paint.ts')

    // `packages/*.ts` (git's own glob semantics) does not reach a `.mjs` file
    // — confirmed structurally, not just by absence from the citation list
    // below, since an empty result there could also mean "swept and found no
    // citations" rather than "never swept at all".
    expect(trackedFiles('packages/*.ts')).not.toContain(mjsFile)
    expect(allCitations().some(({ file }) => file === mjsFile)).toBe(false)
  })

  it('every in-scope citation exists, unless it is honesty-checked on the allowlist above', () => {
    const allowlisted = new Set(ALLOWLISTED_BROKEN_CITATIONS.map(({ file, cite }) => `${file} -> ${cite}`))
    const violations = allCitations()
      .filter(({ file, cite }) => !allowlisted.has(`${file} -> ${cite}`))
      .filter(({ cite }) => !citationExists(cite))
      .map(({ file, cite }) => `${file} -> ${cite}`)
    expect(violations).toEqual([])
  })
})

/**
 * #261's law — a `#NNN` citation in a tracked markdown file may not exceed this repo's
 * LIVE tracker maximum. Wave 7's second half: `#66` is a dated note in `AGENTS.md` and
 * `docs/prds/README.md` explaining the 216 references this audit found; this is the guard
 * that stops a 217th arriving. It catches a dead ISSUE NUMBER the same way the law above
 * catches a dead PATH, but it is a different mechanism end to end — a different
 * character (`#` vs a backtick), a different notion of "exists" (a numeric ceiling, not a
 * filesystem check), and a different tolerance problem, which is the reason it is a
 * second law in this file rather than a clause of the first.
 *
 * ## The decision this law exists to make: a committed baseline, not a date-scoped predicate
 *
 * The naive form — "a `#NNN` citation above the live maximum reddens" — fails immediately
 * on every one of the 216 references the audit found, so how it tolerates them is the
 * design decision, and the issue that filed this law named two candidate shapes rather
 * than handing one down:
 *
 *   1. a committed baseline, in the `.windows-known-failures` style: new violations
 *      redden, recorded ones do not, and the file is the visible statement of what is
 *      owed; or
 *   2. a predicate scoped by document DATE, so only prose written after the 2026-08-21
 *      migration is held to the live maximum.
 *
 * (2) is rejected. A document's date is not reliably recoverable from its content — most
 * of this corpus carries no front-matter date at all, `git log --follow`'s "when was this
 * LINE last touched" answers a different question than "when was this citation first
 * written" (a file touched yesterday for an unrelated reason does not make its five-year-
 * old citations current), and the one place this corpus DOES carry a reliable date --
 * `isPinnedArtefact`'s `**Tree:** \`ref\` at \`sha\`` marker, established for the sibling law
 * above -- is deliberately rare (a handful of pinned run-records), not a property most
 * documents have or should be made to adopt just so this law can read them. A predicate
 * that can only date a handful of files is not a predicate that scopes the corpus.
 *
 * (1) is what ships. `.citation-prior-tracker` (repo root, alongside
 * `.windows-known-failures`, the pattern the issue named) is the committed list --
 * `<file>  #<number>` pairs, one per currently-existing violation, honesty-checked below
 * the same way `ALLOWLISTED_BROKEN_CITATIONS` already is: a listed pair that stops being
 * cited, or stops exceeding the live maximum, fails its own test ("remove this baseline
 * entry") rather than silently going stale. `git blame` on that file is then a genuine
 * record of when each debt was recorded, which a date-scoped predicate would not give you
 * either -- it would just quietly refuse to catch anything written by an author who never
 * added the date field.
 *
 * ## Deriving the live maximum, not typing it
 *
 * This repo's issue/PR tracker restarted at 1 on 2026-08-21 (`TRACKER_RESET_DATE` below;
 * README.md and prd-43 both record the date) after the pre-recreation repository was
 * deleted -- the commits survived, replayed into the fresh tree, but the OLD tracker's
 * issue and PR numbers did not, and its own counter reached at least 655
 * (`packages/web/src/app/shell-bounds-law.test.ts`, prd-43's own re-derivation; an
 * earlier hand read of 674 was `#674c63`, a CSS hex colour, not a citation at all -- the
 * exact false-positive `ISSUE_CITATION_RE`'s lookaround below is built to avoid). The two
 * sequences OVERLAP: a citation above the live maximum is unambiguously prior-tracker; at
 * or below it, the number alone cannot say, which is why this law only ever guards the
 * unambiguous side and leaves the rest to `#66`'s note.
 *
 * The live maximum climbs daily, so it is derived, every run, from something this repo
 * cannot fake by editing prose: every commit dated on or after the reset carries a
 * `Merge pull request #N from <owner>/<branch>` subject when it lands a real, numbered
 * GitHub PR (`scripts/gate.sh`'s local-merge-then-push landing produces exactly that
 * subject; verified against this clone's own history, where every such subject after the
 * reset date names a PR in the 1-3-digit range this corpus's tracker has stayed in so
 * far, and every one below it is dated BEFORE the reset). Two alternatives considered and
 * rejected:
 *
 *   - re-deriving it from every `#NNN` citation already IN the corpus (mirroring the
 *     shell one-liner prd-43 used to measure it by hand): self-defeating for a LAW rather
 *     than a one-off measurement, because the sweep would include the very documents it
 *     is about to check -- the first document that ever cites a new high number would
 *     raise the ceiling to admit itself, and a citation that is actually wrong would
 *     raise the ceiling to admit itself too. The measurement in prd-43 is a snapshot; a
 *     law needs a source the corpus being checked cannot move.
 *   - asking GitHub directly (`gh issue list` / the REST API) at test time: correct in
 *     principle, but network-dependent, requires a token in every environment this suite
 *     runs (including a bare clone with no `gh` auth), and is not reproducible against a
 *     past commit the way a git-log-derived answer is -- checking out an old commit and
 *     re-running the suite would ask GitHub about TODAY, not about the tree's own date.
 *
 * `git log <LANDING_REF> --since=<reset date> --format=%s`, filtered to that one subject
 * shape, is local, offline, reproducible against any full clone (the CI suite leg already
 * runs `fetch-depth: 0` for `isPinnedArtefact`'s sha resolution above, and that same
 * checkout is what supplies the `origin/main` remote ref this derivation reads, so the
 * precondition is already paid for), and -- because it counts only PRs that actually
 * LANDED -- is a
 * deliberately CONSERVATIVE lower bound on the tracker's true current counter: an issue or
 * an open, unmerged PR can already hold a higher number than any merge this clone has seen
 * yet (a lane's own branch is frequently named after such a number). A citation to that
 * kind of very-recent, real, not-yet-merged number reads as "above the live maximum" here
 * and needs a baseline row until it lands -- erring toward rejecting a citation that
 * happens to be current is the safe direction for a law whose entire purpose is refusing
 * ones that are not.
 *
 * ## Scope: tracked, and markdown -- nothing else
 *
 * `AGENTS.md` records the failure mode this law must not repeat: a fixture-hygiene guard
 * scoped by a NAMING convention (`startsWith('claude-code-')`) never saw the older
 * captures sitting beside the ones it checked, and reported truthfully and uselessly that
 * nothing was wrong. This law's citing-file predicate is `trackedFiles('*.md')` --
 * every tracked markdown file in the repo, at any depth (the same bare-star form the
 * sibling law's own docblock already proves crosses directories where `**` does not) --
 * filtered by exactly two things that are properties of the FILE, not its name: the three
 * `EXCLUDED_DIRS` the sibling law above already established and justifies at length
 * (`docs/research/`, `docs/review/`, `docs/prds/` -- dated artefacts making historical
 * claims, not live ones; re-running this law's own sweep with that filter removed reaches
 * 129 additional files there -- MEASURED 2026-09-05, and dated because it moves every time
 * a PRD or a review lands, which is why the empty-exclusion control test below pins the
 * number's sign and not its exact value. It read "75" from this line's first draft until
 * review of #272 measured it: 36 under `docs/research/`, 40 under `docs/review/`, 53 under
 * `docs/prds/`. Either figure supports the point -- the exclusion is doing real work, not
 * standing in for nothing -- which is precisely why nothing caught the wrong one), and
 * `isPinnedArtefact` (a document that declares a resolving `**Tree:**`
 * pin, established above for the identical reason). A THIRD directory -- a top-level
 * `research/` tree, distinct from `docs/research/`, holding the same shape of dated spike
 * write-ups -- is deliberately NOT added to that list here: it was never named by any
 * existing law or ruling as a recognised dated-artefact location, and inventing a new
 * directory exclusion on this law's own say-so is exactly the kind of scope-by-surface-
 * resemblance judgement call the fixture-hygiene failure warns against, one level up from
 * a naming convention. Its four current citations are in the baseline like anything else;
 * if that directory is ever formally recognised, `isExcludedCitingFile` gains a row and a
 * cited ruling, not a guess made here.
 *
 * `AGENTS.md` is IN scope, not excluded, even though it is `#66`'s fence and this issue
 * must not edit it -- reading is not editing. See the coupling note below for what that
 * means for the baseline.
 *
 * ## The wave-7 coupling with `#66`, and why the baseline is not hand-pinned against it
 *
 * `#66` and this issue share a fence-disjoint PR: `#66` writes a dated note INTO
 * `AGENTS.md` explaining the 216 references audited there; this law reads `AGENTS.md`
 * (never writes it) as part of the ordinary sweep. Per `#66`'s own definition of done the
 * 216 existing references are left UNTOUCHED -- so the six `AGENTS.md` entries already in
 * `.citation-prior-tracker` remain genuine violations after `#66` lands and the honesty
 * check below stays green without hand-tracking that lane's edits. The risk that remains
 * is additive, not corrective: if `#66`'s own new note cites a number above the live
 * maximum (likely, given its subject is the prior tracker's own high numbers), that is a
 * NEW citation this law has never seen, and the merged wave will not go green until
 * whoever assembles it re-runs this law's sweep and adds that row -- which is the
 * "regenerate at assembly" half of the ruling that filed this issue, made concrete rather
 * than assumed. This file does not special-case `AGENTS.md`'s content to pre-empt that;
 * doing so would bake in a guess about text `#66` had not written yet.
 *
 * ## Digits, and the bound this law inherits from the sibling measurement
 *
 * `ISSUE_CITATION_RE` matches 1-3 digits only, for the same reason prd-43's own
 * measurement did: this corpus's tracker has never exceeded three digits, and admitting a
 * fourth would re-open the `#674c63` hex-colour false positive from the other direction.
 * The day the live maximum crosses 999, this regex stops matching legitimate four-digit
 * citations at all (silently under-sweeping, not over-matching) and needs widening in the
 * same commit as whatever raises this comment's own three-digit assumption -- noted here
 * so that day does not rediscover the tradeoff from scratch.
 */

/** The day this repo's tracker restarted at 1 (README.md, prd-43) — a fixed historical fact, not the live maximum itself, so pinning it here types nothing this law is supposed to derive. */
const TRACKER_RESET_DATE = '2026-08-21'

/**
 * A `#NNN` citation, 1-3 digits, bounded on both sides so it cannot fire inside a hex
 * colour (`#674c63` — the digits are followed by a letter, not a boundary) or a heading
 * anchor (`#some-heading` — no digit follows the `#` at all). Lookaround, not a captured
 * boundary character, so the matched group is exactly the digits with nothing to strip
 * afterward (unlike `stripCitationSuffix` above, which has a real suffix to remove).
 */
const ISSUE_CITATION_RE = /(?<![0-9A-Za-z#])#([0-9]{1,3})(?![0-9A-Za-z])/g

function extractIssueCitations(text: string): number[] {
  return [...text.matchAll(ISSUE_CITATION_RE)].map((m) => Number(m[1]))
}

/** Every `Merge pull request #N from <owner>/<branch>` subject in `subjects` — pure, so the derivation is testable on rigged git output without a real repo. */
function livePrMergeNumbers(subjects: string): number[] {
  return [...subjects.matchAll(/^Merge pull request #([0-9]+) from/gm)].map((m) => Number(m[1]))
}

/**
 * The ceiling this law compares against, derived offline and never asked of the network.
 *
 * TWO NUMBERS, DELIBERATELY, because they answer different questions.
 *
 * `recordedMaximum()` is the ceiling the committed baseline was MEASURED against, read
 * from `.citation-prior-tracker`'s own `live-maximum=` field. It is frozen by
 * construction, and it has to be: a citation that exceeded the ceiling on the day it was
 * recorded is a prior-tracker citation forever, so re-checking that historical fact
 * against a ceiling that climbs guarantees the baseline rots out from under itself.
 *
 * `liveMaximum()` is the ceiling a NEW citation is judged against, so it must climb. It is
 * derived every run from something the corpus being checked cannot move: every commit
 * dated on or after the reset and reachable from `LANDING_REF` carries a
 * `Merge pull request #N from <owner>/<branch>` subject when it lands a real, numbered PR.
 * The ref is pinned rather than `--all` for the reason `LANDING_REF`'s own comment gives. It is floored at `recordedMaximum()`, so a
 * shallow clone or a rewritten mirror falls back to the committed measurement rather than
 * to zero. There is no environment in which it returns nothing — that total absence of a
 * skip path is the property the rest of this describe depends on.
 *
 * WHY NOT `gh`, MEASURED. A version of this shelled out to `gh issue list` / `gh pr list`
 * for an exact ceiling. Two independent review seats rejected it, and both were right:
 *
 *  - **It tied an assertion to a clock nobody controls.** The head went red with no commit
 *    and no edit, because somebody filed an issue: `#267 no longer exceeds the live
 *    maximum (268)`. Re-measured a day later, the same tree failed on `#269` against 272 —
 *    272 being the number of the PR that would have landed the wave. A law that reddens on
 *    other people's activity is not a law.
 *  - **It failed OPEN, and silently.** `gh` needs auth, and every caller met its absence
 *    with a bare `return`, not `ctx.skip()`. EXECUTED against a `gh` shim exiting 4: this
 *    file reported **44 passed, exit 0**, with the word "skip" appearing nowhere in the
 *    output — the entire law vacuous and indistinguishable from a green run. The `ci.yml`
 *    `GH_TOKEN` added to feed it declared no `permissions:` block, so a restricted default
 *    would have bought precisely that green in CI.
 *
 * The section above already rejected asking GitHub at test time, for those same reasons,
 * before it was tried. This restores that ruling rather than arguing with it.
 *
 * What the git derivation costs, stated plainly: it is a CONSERVATIVE LOWER BOUND. It sees
 * PRs merged into `LANDING_REF` and nothing else, so a number that exists but has not landed reads as above
 * the ceiling and needs a baseline row until it does. Erring toward rejecting a citation
 * that happens to be current is the safe direction for a law whose whole purpose is
 * refusing the ones that are not.
 */
function recordedMaximum(): number {
  const { measured } = parseBaseline(readFileSync(BASELINE_PATH, 'utf8'))
  const m = BASELINE_MEASURED_RE.exec(measured[0] ?? '')
  if (m === null) throw new Error('.citation-prior-tracker has no parseable "# measured:" line')
  return Number(m[2])
}

// Memoised, not eager: reading the baseline and shelling out to git at module
// load would take the unrelated path-citation law above down with it on a
// malformed file, rather than failing the tests that actually need the ceiling.
let cachedLiveMaximum: number | undefined
/**
 * The ref the ceiling is derived from, and it is deliberately ONE ref rather than `--all`.
 *
 * `--all` walks every ref the object store holds — every local branch, every
 * `refs/remotes/*`, and the refs of every linked worktree sharing this `.git`. None of
 * those is evidence that a number landed. EXECUTED in this repo, no fabrication needed:
 * `comm -13` between the two derivations returns `96 97 101 102`, all four carried by
 * `refs/remotes/origin/prd44` — the abandoned integration branch AGENTS.md documents as an
 * incident, still pushed and still fetched by an ordinary clone. A scratch local commit
 * with a merge-shaped subject moved the ceiling from 272 to 999 while the `origin/main`
 * derivation stayed at 272.
 *
 * That is the clone-dependence this law's own history already rejected once, in the
 * paragraph the `gh` removal deleted: a ceiling that reads one number in a clone holding
 * an unpushed branch and another in a fresh clone. Above the ceiling is supposed to mean
 * "unambiguously prior-tracker"; a ceiling any stale branch can inflate cannot mean it.
 */
const LANDING_REF = 'origin/main'

function liveMaximum(): number {
  if (cachedLiveMaximum !== undefined) return cachedLiveMaximum
  let merged: number[] = []
  try {
    const subjects = execFileSync('git', ['log', LANDING_REF, `--since=${TRACKER_RESET_DATE}`, '--format=%s'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    merged = livePrMergeNumbers(subjects)
  } catch {
    // `origin/main` absent — a fork clone, a CI checkout that fetched only the PR ref, a
    // mirror under another remote name. EXECUTED: `git log no-such-ref/main` exits 128, so
    // without this the swap away from `--all` would trade a clone-dependent ceiling for a
    // thrown law, which is the environment-sensitivity the `gh` version was rejected for.
    // Falling through leaves `merged` empty and the floor below does the rest.
  }
  cachedLiveMaximum = Math.max(merged.length > 0 ? Math.max(...merged) : 0, recordedMaximum())
  return cachedLiveMaximum
}

interface CeilingViolation {
  file: string
  num: number
}

/**
 * Pure: every `#NNN` above `liveMax` in `entries`, deduplicated per file (existence does
 * not depend on repeat count), minus whatever `baseline` already carries. `baseline` keys
 * are `${file}\t${num}` — a plain Set rather than a nested structure, since every lookup
 * is an exact (file, number) pair and nothing here needs to iterate one file's numbers on
 * their own.
 */
function ceilingViolationsIn(
  entries: readonly { file: string; text: string }[],
  liveMax: number,
  baseline: ReadonlySet<string>,
): CeilingViolation[] {
  const out: CeilingViolation[] = []
  for (const { file, text } of entries) {
    for (const num of new Set(extractIssueCitations(text))) {
      if (num <= liveMax) continue
      if (baseline.has(`${file}\t${num}`)) continue
      out.push({ file, num })
    }
  }
  return out
}

const BASELINE_PATH = path.join(REPO_ROOT, '.citation-prior-tracker')

interface BaselineEntry {
  line: number
  file: string
  num: number
}

const BASELINE_MEASURED_RE = /^# measured: (\d{4}-\d{2}-\d{2}) live-maximum=(\d+) violations=(\d+)$/

function parseBaseline(text: string): { measured: string[]; entries: BaselineEntry[] } {
  const measured: string[] = []
  const entries: BaselineEntry[] = []
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.replace(/\s+$/, '')
    if (line.length === 0) return
    if (line.startsWith('#')) {
      if (/^# measured:/.test(line)) measured.push(line)
      return
    }
    const m = /^(\S+)\s+#([0-9]+)$/.exec(line)
    if (m === null) throw new Error(`.citation-prior-tracker:${index + 1} does not match "<file>  #<number>": ${line}`)
    entries.push({ line: index + 1, file: m[1] ?? '', num: Number(m[2]) })
  })
  return { measured, entries }
}

function baselineSet(entries: readonly BaselineEntry[]): Set<string> {
  return new Set(entries.map(({ file, num }) => `${file}\t${num}`))
}

/**
 * Every tracked markdown file's post-fence text, in scope for the ceiling sweep — the
 * real-tree counterpart to `ceilingViolationsIn`'s rigged-input tests. `trackedFiles`
 * (the git INDEX), not `sweepFiles`: the issue's own wording is "a tracked markdown file",
 * and unlike the path-citation law above, nothing here needs to see a brand-new untracked
 * doc before `git add` — this law's tolerance mechanism is the committed baseline, not a
 * pre-stage check.
 */
function issueCitationEntries(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = []
  for (const file of trackedFiles('*.md')) {
    if (isExcludedCitingFile(file)) continue
    const raw = readSweptFile(file)
    if (raw === undefined) continue
    const text = stripFencedCodeBlocks(raw)
    if (isPinnedArtefact(text)) continue
    out.push({ file, text })
  }
  return out
}

// Measured against this file's own history: 234 tracked markdown files, none
// heavier than a few hundred lines, one `git ls-files` call and no
// per-claim-row re-normalisation (`route-class-law.test.ts`'s wave-6 defect,
// recorded in this issue's own brief) — comfortably inside vitest's 5000ms
// default even under `gate.sh`'s 4x load-batches concurrency, so no explicit
// timeout is set on the sweep test below.
describe('citation ceiling law: a #NNN citation above the live maximum cannot enter the corpus (#261)', () => {
  it('the clone is not shallow — required for the live-maximum sweep, the same precondition sha-pin resolution above already needs', () => {
    expect(repoIsShallow()).toBe(false)
  })

  it('a hex colour and a heading anchor are not mistaken for a citation', () => {
    expect(extractIssueCitations('background: #674c63; see [x](#some-heading) and #12ab.')).toEqual([])
  })

  it('a real citation, at a word boundary, IS extracted — the control the rows above would be vacuous without', () => {
    expect(extractIssueCitations('closes #261, see also (#66) and #6.')).toEqual([261, 66, 6])
  })

  it('fenced code examples are stripped before extraction, mirroring the path-citation law\'s own exemption', () => {
    const text = '```\nSee #9999 in the example output.\n```\nReal text cites #12.'
    expect(extractIssueCitations(stripFencedCodeBlocks(text))).toEqual([12])
  })

  it('the pure checker: above the ceiling reddens, at or below it does not, and a baselined pair is silenced — the mutation this law exists to catch', () => {
    const liveMax = 300
    const entries = [
      { file: 'docs/example.md', text: 'See #301 for details. #301 again — the same number, must not double-count.' },
      { file: 'docs/at-ceiling.md', text: 'See #300 for details.' },
      { file: 'docs/below.md', text: 'See #299 for details.' },
    ]
    expect(ceilingViolationsIn(entries, liveMax, new Set())).toEqual([{ file: 'docs/example.md', num: 301 }])
    expect(ceilingViolationsIn(entries, liveMax, new Set(['docs/example.md\t301']))).toEqual([])
  })

  it('the live maximum derives from a real "Merge pull request" subject and ignores an ordinary merge-from-main one', () => {
    const subjects = [
      'Merge pull request #265 from launchpad-26/24-readme-lab-sessions',
      'Merge pull request #12 from launchpad-26/some-other-lane',
      'Merge remote-tracking branch \'origin/main\' into some-lane',
      'chore: unrelated commit mentioning #999 in prose, not a merge subject',
    ].join('\n')
    expect(livePrMergeNumbers(subjects)).toEqual([265, 12])
  })

  it('the derived ceiling is sane, and never below the measurement the baseline was taken at', () => {
    const max = liveMaximum()
    expect(max).toBeGreaterThan(0)
    expect(max, 'the floor wiring is what makes a shallow clone fall back rather than read zero').toBeGreaterThanOrEqual(recordedMaximum())
    expect(max).toBeLessThan(1000) // this corpus's tracker has never exceeded three digits — see the digits note in the docblock above
  })

  it('the sweep is non-empty — the checks below would pass vacuously otherwise', () => {
    expect(issueCitationEntries().length).toBeGreaterThan(100)
  })

  it('every excluded directory still trips the detector when the exclusion is bypassed — the exclusion is doing real work, not vacuous', () => {
    const liveMax = liveMaximum()
    for (const dir of EXCLUDED_DIRS) {
      const files = [...new Set([...trackedFiles(`${dir}*.md`), ...trackedFiles(`${dir}**/*.md`)])]
      expect(files.length, `${dir} has no markdown files to check`).toBeGreaterThan(0)
      const entries = files.map((file) => ({ file, text: stripFencedCodeBlocks(readSweptFile(file) ?? '') }))
      const violations = ceilingViolationsIn(entries, liveMax, new Set())
      expect(violations.length, `${dir} would trip nothing if scanned — the exclusion is stale`).toBeGreaterThan(0)
    }
  })

  it('the baseline file parses, has no duplicate entries, and its measured line matches its own entry count', () => {
    const { measured, entries } = parseBaseline(readFileSync(BASELINE_PATH, 'utf8'))
    expect(measured).toHaveLength(1)
    const m = BASELINE_MEASURED_RE.exec(measured[0] ?? '')
    expect(m, `the measured line does not match the grammar: ${measured[0]}`).not.toBeNull()
    expect(Number(m?.[3])).toBe(entries.length)

    const keys = entries.map(({ file, num }) => `${file}\t${num}`)
    expect(new Set(keys).size, 'a duplicate (file, number) pair in the baseline is dead weight').toBe(keys.length)
  })

  /**
   * Against `recordedMaximum()`, NOT `liveMaximum()`, and that is the whole finding.
   *
   * A baseline row records a historical fact — "this citation exceeded the ceiling on the
   * date this file was measured" — and that fact does not expire when the repo files its
   * next issue. Checked against a climbing ceiling it does expire, on a timer nobody set:
   * `#267 no longer exceeds the live maximum (268)` reddened an unmodified tree, and the
   * remedy the message prescribed ("remove this baseline entry") was WRONG. `docs/roadmap.md`
   * cites `#267` meaning the prior tracker's issue; live `#267` is an unrelated beacon
   * collector. Dropping the row would have made the corpus permanently accept a citation
   * that now resolves to something else — the exact ambiguity `#66`'s note exists to warn
   * about, written into the law as an instruction.
   */
  it('every baseline entry is still a genuine violation — a stale entry would silently widen the law', () => {
    const recordedMax = recordedMaximum()
    const { entries } = parseBaseline(readFileSync(BASELINE_PATH, 'utf8'))
    for (const { file, num } of entries) {
      const filePath = path.join(REPO_ROOT, file)
      expect(existsSync(filePath), `${file} no longer exists — remove its .citation-prior-tracker entries`).toBe(true)

      const raw = readFileSync(filePath, 'utf8')
      const text = stripFencedCodeBlocks(raw)
      expect(extractIssueCitations(text), `${file} no longer cites #${num} — this baseline entry is stale`).toContain(num)
      expect(
        num,
        `#${num} does not exceed the ceiling this baseline was measured at (${recordedMax}) — it was never a violation, so this row is wrong and ${file} needs re-measuring, NOT the row deleted`,
      ).toBeGreaterThan(recordedMax)
    }
  })

  it('the corpus, swept for real, carries no ceiling violation outside the committed baseline', () => {
    const liveMax = liveMaximum()
    const { entries: baselineEntries } = parseBaseline(readFileSync(BASELINE_PATH, 'utf8'))
    const violations = ceilingViolationsIn(issueCitationEntries(), liveMax, baselineSet(baselineEntries))
    expect(violations, JSON.stringify(violations)).toEqual([])
  })
})
