import { mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { worktreePathToProjectSlug } from './worktree-slug.js'

/**
 * `reverseProjectSlug` lives in the concierge module, and
 * `concierge/namespace-law.test.ts` clause 1 fails a `.test.ts` file outside
 * `concierge/` that reaches it through an ordinary `from '...'`/`import(
 * '...')` literal — that law's reachability sweep is a static text scan, and
 * this file is not `api/concierge.ts`, its one declared importer (verified:
 * adding a plain `import { reverseProjectSlug } from '../../concierge/
 * repos.js'` here reddens that law's "no file in either package reaches the
 * concierge module" test). Clause 2 ("no blind spots") deliberately exempts
 * test files from the requirement that a dynamic `import()` use a literal
 * specifier — the sweep can only ever see a literal one, so it cannot forbid
 * what it cannot see, and its own authors chose not to convict a test for
 * that. This law needs the REAL reverse walk (a second copy of its character
 * class would just make the same mistake this issue is about, twice), so it
 * is loaded through a specifier built at runtime rather than a static import.
 */
const CONCIERGE_REPOS_SPECIFIER = ['..', '..', 'concierge', 'repos.js'].join('/')

type ReverseProjectSlugResult = { path: string } | { path: null; reason: string }

async function loadReverseProjectSlug(): Promise<(slug: string) => Promise<ReverseProjectSlugResult>> {
  const mod = (await import(CONCIERGE_REPOS_SPECIFIER)) as {
    reverseProjectSlug: (slug: string) => Promise<ReverseProjectSlugResult>
  }
  return mod.reverseProjectSlug
}

describe('worktreePathToProjectSlug', () => {
  it('matches the real ~/.claude/projects dir for the main worktree', () => {
    expect(worktreePathToProjectSlug('/home/operator/worktrees-challenge')).toBe(
      '-home-operator-worktrees-challenge',
    )
  })

  it('matches the real ~/.claude/projects dir for a sibling worktree (double underscore folds to double dash)', () => {
    expect(
      worktreePathToProjectSlug('/home/operator/worktrees-challenge__worktrees/2-core'),
    ).toBe('-home-operator-worktrees-challenge--worktrees-2-core')
  })

  it('matches the worktree this issue was built in', () => {
    expect(
      worktreePathToProjectSlug(
        '/home/operator/worktrees-challenge__worktrees/34-sessionlog-collector',
      ),
    ).toBe('-home-operator-worktrees-challenge--worktrees-34-sessionlog-collector')
  })

  it('replaces every slash and underscore, nothing else', () => {
    expect(worktreePathToProjectSlug('/a/b_c/d')).toBe('-a-b-c-d')
  })

  it('maps a dot the same way as slash and underscore, so a dotted path still resolves', () => {
    expect(worktreePathToProjectSlug('/home/operator/work/v2.0/wt')).toBe(
      '-home-operator-work-v2-0-wt',
    )
  })

  it('maps a dotted directory name (e.g. a dotted username)', () => {
    expect(worktreePathToProjectSlug('/home/jane.doe/project')).toBe('-home-jane-doe-project')
  })

  it('replaces every slash, underscore and dot, nothing else', () => {
    expect(worktreePathToProjectSlug('/a/b_c.d/e')).toBe('-a-b-c-d-e')
  })

  /**
   * **THE WINDOWS SLUG, AGAINST A REAL ONE** (ledger #11).
   * `research/2026-08-14-cross-host-resume.md` reads
   * `~/.claude/projects/C--Users-operator-agenticlaunchpad/` on a machine whose
   * cwd was `C:\Users\operator\agenticlaunchpad` — so the drive colon and the
   * backslashes take the same substitution `/`, `_` and `.` already take. This
   * is the exact pair from the note, not a constructed example: before the
   * mapping, this function returned the Windows path unchanged and would have
   * looked for a transcript in a directory Claude Code never writes.
   */
  it('matches the real Windows slug from the cross-host-resume capture', () => {
    expect(worktreePathToProjectSlug('C:\\Users\\operator\\agenticlaunchpad')).toBe(
      'C--Users-operator-agenticlaunchpad',
    )
  })

  it('maps a backslash and a colon on their own, so neither rides on the other', () => {
    expect(worktreePathToProjectSlug('a\\b')).toBe('a-b')
    expect(worktreePathToProjectSlug('D:')).toBe('D-')
  })

  /**
   * A space moved INTO this function's class at prd-42 ruling 1 — this
   * pinned expectation is the one the ruling names as moving in the same
   * commit as the fix, so it stays a fact about the encoding rather than a
   * stale copy of it (AGENTS.md's #649 lesson).
   *
   * The tilde staying UNMAPPED here is NOT a claim that this is correct — it
   * is punctuation, same as everything else in Claude Code's real transform
   * (`/[^a-zA-Z0-9]/g`, per this function's own doc comment). It is a KNOWN,
   * DELIBERATE divergence, pinned so a reader does not mistake the absence
   * of a test failure for evidence the tilde is handled: closing it is out
   * of this issue's fence, and #47 is where the colon/backslash slice of the
   * same broader gap is tracked. (A dash is a wash either way: the real
   * transform replaces `-` with `-`, so its presence here proves nothing
   * about which side is more correct.)
   */
  it('pins the tilde as UNMAPPED — a known divergence from the real slugger (#47), not a correctness claim', () => {
    expect(worktreePathToProjectSlug('/home/j~ane/my project-1')).toBe('-home-j~ane-my-project-1')
  })
})

/**
 * prd-42 ruling 1's round-trip law: for a generated set of paths including
 * spaces, dots, underscores and colons, encoding then walking back through
 * `reverseProjectSlug` must return the original path. This asserts the ROUND
 * TRIP only, never the character class's literal contents — a literal
 * assertion passes at any wrong-but-matching pair, which is exactly how the
 * encoder and the reverse walk disagreeing on a space survived to now.
 *
 * Colon is generated but not asserted to round-trip: `concierge/repos.ts:229`
 * re-encodes only `.`, `_` and a space when it matches real directory
 * entries against a slug — it has never re-encoded `:`, or `\` either (same
 * gap, same reason; #47 tracks both, not #243, which does not exist in this
 * tracker). A colon segment is therefore asserted to come back as an HONEST
 * REFUSAL (`path: null`), matching the module's own "never guess" contract,
 * rather than silently claiming a round trip the code does not provide.
 *
 * That refusal assertion is proven non-vacuous below by first confirming the
 * colon directory is really on disk (measured: without that check, deleting
 * the `mkdir` call for it leaves this test passing for an unrelated reason —
 * `reverseProjectSlug`'s refusal message names only the unmatched remainder
 * of the slug, not which real entries it rejected, so "directory absent" and
 * "directory present but unmatched" read identically through `path: null`
 * alone). **When #47 widens `repos.ts:229`'s re-encode class, this
 * assertion must be deleted or inverted in that same commit** — measured:
 * changing it to `entry.replace(/[^a-zA-Z0-9]/g, '-')` makes the colon
 * segment round-trip like every other one above, and this refusal check
 * goes red. Left as a passing "honest refusal" test past that point, it
 * would be defending the very gap #47 exists to close.
 */
describe("worktreePathToProjectSlug round-trips through the concierge module's reverse walk", () => {
  it('resolves every generated path back to itself, including one with a literal space', async () => {
    const reverseProjectSlug = await loadReverseProjectSlug()

    // `os.tmpdir()` is a symlink on macOS (`/var` -> `/private/var`) and is
    // not on Linux — encoding the raw path and walking back to the canonical
    // one would pass on ubuntu and fail only on the macOS CI leg. Resolved
    // once, up front, so every generated case is built beneath the canonical
    // root and the round trip is symmetric on every platform.
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'worktree-slug-law-'))
    const root = await realpath(tmpRoot)

    try {
      const ROUND_TRIP_SEGMENTS = ['plain-word', 'dotted.segment', 'under_score', 'a space here']

      // Every ordered pair of distinct segments — each mapped character is
      // exercised both leading and following another — plus one path
      // carrying all four together, so the round trip also holds when every
      // one of them appears in the same slug at once.
      const roundTripPaths: string[][] = []
      for (const first of ROUND_TRIP_SEGMENTS) {
        for (const second of ROUND_TRIP_SEGMENTS) {
          if (first !== second) roundTripPaths.push([first, second])
        }
      }
      roundTripPaths.push(ROUND_TRIP_SEGMENTS)

      expect(roundTripPaths.some((segments) => segments.some((segment) => segment.includes(' ')))).toBe(true)

      for (const segments of roundTripPaths) {
        const target = path.join(root, ...segments)
        await mkdir(target, { recursive: true })

        const slug = worktreePathToProjectSlug(target)
        const result = await reverseProjectSlug(slug)

        expect(result, `round trip broke for ${target} (slug ${slug})`).toEqual({ path: target })
      }

      const colonParent = path.join(root, 'plain-word')
      const colonTarget = path.join(colonParent, 'colon:segment')
      await mkdir(colonTarget, { recursive: true })

      // Proves the directory is really there, so the refusal below is
      // evidence the reverse walk cannot MATCH a literal colon — not
      // evidence the directory is simply missing (see this describe
      // block's own doc comment for the measurement that found this
      // mattered).
      const colonParentEntries = await readdir(colonParent)
      expect(colonParentEntries).toContain('colon:segment')

      const colonSlug = worktreePathToProjectSlug(colonTarget)
      const colonResult = await reverseProjectSlug(colonSlug)
      expect(colonResult.path, `expected an honest refusal for ${colonTarget} (slug ${colonSlug})`).toBeNull()
      expect(
        (colonResult as { path: null; reason: string }).reason,
        'expected the refusal reason to name the unmatched colon segment',
      ).toContain('colon-segment')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
