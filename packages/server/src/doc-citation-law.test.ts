import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
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
 * | glob, directory-rooted (`` `packages/core/**` ``) | HANDLED — truncated at `**`, the parent directory must exist |
 * | glob, mid-filename (`` `docs/research/2026-08-02-obs-prd7-*.md` ``) | HANDLED — resolved against a real directory listing, not truncated like the directory glob above (a naive truncate-at-`*` would falsely redden this real, existing citation — caught by running the extractor against the tree before trusting it) |
 * | bare directory/number, no filename (`` `docs/adr/0012` ``)   | HANDLED — the one live instance of this form; resolved as a prefix match against `docs/adr/`'s real listing, same convention `adr-log-law.test.ts` already codifies for ADR numbers |
 * | inside a fenced code block (` ```json … ``` `)   | SKIPPED — verified BOTH ways in this corpus: `docs/architecture.md`'s own `.swarm/lanes.json` example fences a fabricated lane (`packages/web/src/panels/shelved/**`, an illustrative fixture, not a real file) alongside real command examples (`node packages/server/bin/rhizomorph.mjs`); mixing real and fabricated content inside fences means including them risks a false positive on the fabricated half, and ruling 5 (README recipes executed by the suite) is the mechanism for verifying the real half, not this law |
 * | path + trailing prose/args in ONE span (`` `scripts/dev/issues.sh list` ``) | SKIPPED — the one live instance; the character class stops at the space, so the whole span fails to match rather than truncating to a wrong substring — under-inclusion, not a false positive |
 * | `packages/**\/*.ts` **comments** (line comments, block comments, doc comments) | HANDLED — comment text only, via `extractComments`; a citation inside actual code (a string or template literal) is deliberately NOT swept, per ruling 1's own wording ("packages/**\/*.ts comments") |
 * | `packages/**\/*.ts` **code** (string/template literals) | SKIPPED — see above; a `` ` `` inside a `//` line is only swept if it appears AFTER the `//`, so a citation-shaped string literal preceding a trailing comment is correctly left alone |
 * | a path under a gitignored directory (`packages/*\/dist/…`) | HANDLED as always-valid — `dist/` is gitignored (`.gitignore:2`) and is a build artefact that exists only after `npm run build`; a doc describing where the bundle lands is not making a claim about the tracked tree, and treating it as broken would be a false positive this law would ship with (found while building this extractor: three `dist/`-rooted citations, none of them real breaks) |
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

function isExcludedCitingFile(file: string): boolean {
  return file === OWN_FILE || EXCLUDED_DIRS.some((dir) => file.startsWith(dir))
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

/** A cited path exists if the literal target exists, a directory glob's parent exists, a mid-filename glob matches a real sibling, a bare ADR-style prefix matches a real record, or the target is gitignored (a build artefact, not a tracked-tree claim). */
function citationExists(cite: string): boolean {
  const stripped = stripCitationSuffix(cite)

  // Filesystem first, `git check-ignore` second. Both orders answer identically — a path
  // that exists and a path that is ignored each return true — but isIgnored spawns 1-2
  // child processes PER CITATION, and it was being consulted for all ~450 citations in
  // the main sweep plus ~700 more in the exclusion scan. Idle and alone, against vitest's
  // 5000 ms default (measured per test BY NAME, not by sorting two durations and assuming
  // the order — the earlier form of this comment did the latter and had both pairs
  // swapped):
  //
  //     exclusion honesty   3156 ms -> ~380 ms
  //     main sweep          2466 ms -> ~145 ms
  //
  // The exclusion scan is the slower one on BOTH sides, and post-fix it is slower by a
  // wider ratio — it walks citations that mostly do NOT exist, so `existsSync` fails to
  // short-circuit and each one still forks `git check-ignore`, while the main sweep's
  // mostly do exist and short-circuit immediately. gate.sh's load-batches mode runs the
  // suite four times concurrently, where a 3.1 s test under a 5 s timeout has no room
  // (review of #16).
  if (existsSync(path.join(REPO_ROOT, stripped))) return true
  if (isIgnored(stripped)) return true

  if (stripped.includes('**')) {
    const target = stripped.slice(0, stripped.indexOf('**')).replace(/\/$/, '')
    return target.length > 0 && existsSync(path.join(REPO_ROOT, target))
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

/** Every citation from every in-scope `docs/*.md` file and every `packages/*.ts` file's comments — deduplicated per file, since existence does not depend on how many times a file repeats the same citation. */
function allCitations(): Citation[] {
  const out: Citation[] = []
  for (const file of trackedFiles('docs/*.md')) {
    if (isExcludedCitingFile(file)) continue
    const text = stripFencedCodeBlocks(readFileSync(path.join(REPO_ROOT, file), 'utf8'))
    for (const cite of new Set(extractCitations(text))) out.push({ file, cite })
  }
  for (const file of trackedFiles('packages/*.ts')) {
    if (isExcludedCitingFile(file)) continue
    const text = extractComments(readFileSync(path.join(REPO_ROOT, file), 'utf8'))
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
    file: 'docs/architecture.md',
    cite: 'packages/web/src/fleet/buildFleet.ts',
    reason: 'moved to packages/core/src/fleet/buildFleet.ts (#246)',
  },
  {
    file: 'docs/architecture.md',
    cite: 'packages/web/src/fleet/fences.test.ts',
    reason: 'moved to packages/core/src/fleet/fences.test.ts alongside buildFleet.ts',
  },
  {
    file: 'docs/architecture.md',
    cite: 'packages/web/src/fleet/fences.ts',
    reason: 'moved to packages/core/src/fleet/fences.ts alongside buildFleet.ts',
  },
  {
    file: 'docs/architecture.md',
    cite: 'packages/web/src/panels/spend/',
    reason: 'SpendPanel moved to packages/web/src/lane-page/',
  },
  {
    file: 'docs/architecture.md',
    cite: 'packages/web/src/panels/spend/format.ts',
    reason: 'moved with the rest of the spend panel to packages/web/src/lane-page/',
  },
  {
    file: 'docs/design-notes/node-apical-tuft-glow.md',
    cite: 'docs/decisions/retire-transformation-not-deletion.md',
    reason: 'the target lives under docs/design-notes/, not docs/decisions/, which was never created',
  },
  {
    file: 'docs/design-notes/node-persist-lane.md',
    cite: 'docs/decisions/node-seal-fold.md',
    reason: 'the target lives under docs/design-notes/, not docs/decisions/, which was never created',
  },
  {
    file: 'docs/design-notes/node-persist-lane.md',
    cite: 'docs/decisions/retire-transformation-not-deletion.md',
    reason: 'the target lives under docs/design-notes/, not docs/decisions/, which was never created',
  },
  {
    file: 'docs/design-notes/root-depth-tissue-vibrancy.md',
    cite: 'docs/decisions/palette-vibrancy-dials.md',
    reason: 'the target lives under docs/design-notes/, not docs/decisions/, which was never created',
  },
  {
    file: 'packages/core/src/events/judge.ts',
    cite: 'docs/research/2026-08-04-semantic-judge-spike.md',
    reason: 'the research note was removed by 756e1bf, whose own sweep covered docs citing docs, not code citing docs',
  },
  {
    file: 'packages/core/src/placeholder.ts',
    cite: 'packages/server/src/app.ts',
    reason: 'scaffold-era comment; no file has ever existed at this path (the server entry point is elsewhere)',
  },
  {
    file: 'packages/server/src/collectors/judge/collector.ts',
    cite: 'docs/research/2026-08-04-semantic-judge-spike.md',
    reason: 'the research note was removed by 756e1bf, whose own sweep covered docs citing docs, not code citing docs',
  },
  {
    file: 'packages/server/src/judge/mergetree.ts',
    cite: 'docs/research/2026-08-04-semantic-judge-spike.md',
    reason: 'the research note was removed by 756e1bf, whose own sweep covered docs citing docs, not code citing docs',
  },
  {
    file: 'packages/server/src/judge/symbols.ts',
    cite: 'docs/research/2026-08-04-semantic-judge-spike.md',
    reason: 'the research note was removed by 756e1bf, whose own sweep covered docs citing docs, not code citing docs',
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
    for (const dir of EXCLUDED_DIRS) {
      const files = [...new Set([...trackedFiles(`${dir}*.md`), ...trackedFiles(`${dir}**/*.md`)])]
      expect(files.length, `${dir} has no markdown files to check`).toBeGreaterThan(0)

      let brokenCount = 0
      for (const file of files) {
        const text = stripFencedCodeBlocks(readFileSync(path.join(REPO_ROOT, file), 'utf8'))
        for (const cite of new Set(extractCitations(text))) {
          if (!citationExists(cite)) brokenCount += 1
        }
      }
      expect(brokenCount, `${dir} would trip nothing if scanned — the exclusion is stale`).toBeGreaterThan(0)
    }
  })

  it('the allowlist is pinned — a silent addition here is exactly how a real regression gets waved through', () => {
    expect(ALLOWLISTED_BROKEN_CITATIONS.map(({ file, cite }) => `${file} -> ${cite}`)).toEqual(
      [
        'docs/adr/0029-a-recording-may-repeat-a-fact.md -> docs/prds/prd-40-the-record-survives-the-write.md',
        'docs/architecture.md -> packages/web/src/fleet/buildFleet.ts',
        'docs/architecture.md -> packages/web/src/fleet/fences.test.ts',
        'docs/architecture.md -> packages/web/src/fleet/fences.ts',
        'docs/architecture.md -> packages/web/src/panels/spend/',
        'docs/architecture.md -> packages/web/src/panels/spend/format.ts',
        'docs/design-notes/node-apical-tuft-glow.md -> docs/decisions/retire-transformation-not-deletion.md',
        'docs/design-notes/node-persist-lane.md -> docs/decisions/node-seal-fold.md',
        'docs/design-notes/node-persist-lane.md -> docs/decisions/retire-transformation-not-deletion.md',
        'docs/design-notes/root-depth-tissue-vibrancy.md -> docs/decisions/palette-vibrancy-dials.md',
        'packages/core/src/events/judge.ts -> docs/research/2026-08-04-semantic-judge-spike.md',
        'packages/core/src/placeholder.ts -> packages/server/src/app.ts',
        'packages/server/src/collectors/judge/collector.ts -> docs/research/2026-08-04-semantic-judge-spike.md',
        'packages/server/src/judge/mergetree.ts -> docs/research/2026-08-04-semantic-judge-spike.md',
        'packages/server/src/judge/symbols.ts -> docs/research/2026-08-04-semantic-judge-spike.md',
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
    const rigged = [
      'See `packages/server/src/doc-citation-law.test.ts` in prose.',
      '```json',
      '{ "fence": ["packages/this-fabricated-example-does-not-exist/**"] }',
      '```',
      'And again in prose: `packages/this-directory-does-not-exist/nothing.ts`.',
    ].join('\n')
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
  })

  it('this file excludes itself by identity, not by name or convention — and does not weaken the sweep for any other file', () => {
    // Identity, not a hardcoded name: OWN_FILE is resolved from the running module itself.
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

  it('every in-scope citation exists, unless it is honesty-checked on the allowlist above', () => {
    const allowlisted = new Set(ALLOWLISTED_BROKEN_CITATIONS.map(({ file, cite }) => `${file} -> ${cite}`))
    const violations = allCitations()
      .filter(({ file, cite }) => !allowlisted.has(`${file} -> ${cite}`))
      .filter(({ cite }) => !citationExists(cite))
      .map(({ file, cite }) => `${file} -> ${cite}`)
    expect(violations).toEqual([])
  })
})
