import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sessionFilePath } from '../log/session-log.js'
import { buildApp, type RegisteredRoute } from '../server/build-app.js'
import { SessionRecorder } from '../server/recorder.js'
import { ROUTE_CLASSES, type RouteClassification } from './index.js'

// packages/server/src/api -> repo root (the same climb retarget-law.test.ts uses)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

/**
 * Fastify auto-registers a `HEAD` mirror for every `GET` (`exposeHeadRoutes`,
 * on by default) — same handler, same `preHandler`s, same security posture as
 * its `GET`. Classifying it as a fourth, separate thing would double-count
 * every read for no trust-boundary reason, so the law ignores it rather than
 * declaring a class that means nothing.
 */
function isAutoHead(route: RegisteredRoute): boolean {
  return route.method === 'HEAD'
}

function classify(route: RegisteredRoute, table: readonly RouteClassification[]): RouteClassification | undefined {
  return table.find((entry) => entry.method === route.method && entry.url === route.url)
}

/** Whether a classification is one of the two gated postures the presence law covers. */
function isGated(entry: RouteClassification): boolean {
  return entry.routeClass === 'gated-mutation' || entry.routeClass === 'gated-read'
}

/**
 * THE GATE-PRESENCE LAW itself (prd-29 ruling 2 / ADR-0024), as one pure
 * function both the real-app walk and the synthetic bite-test call — the
 * mechanism that guards the routes is the same one proven able to fail.
 *
 * Returns every `gated-*` row whose actually-registered route does NOT carry
 * the capability gate (`hasCapabilityGate`), plus every row the table calls a
 * plain `read`/`ungated-mutation` that unexpectedly DOES — a stray gate on
 * `GET /*` is as much a defect as a missing one on `/api/transcript/:lane`. A
 * row with no registered route at all is left to the stale-row law above; this
 * one speaks only about routes that exist.
 */
function gatePresenceViolations(
  routes: readonly RegisteredRoute[],
  table: readonly RouteClassification[],
): { method: string; url: string; expectedGate: boolean; actualGate: boolean }[] {
  const out: { method: string; url: string; expectedGate: boolean; actualGate: boolean }[] = []
  for (const route of routes) {
    const entry = classify(route, table)
    if (entry === undefined) continue
    const expectedGate = isGated(entry)
    if (route.hasCapabilityGate !== expectedGate) {
      out.push({ method: route.method, url: route.url, expectedGate, actualGate: route.hasCapabilityGate })
    }
  }
  return out
}

describe('the route-class law (prd-23 ruling 5)', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-route-class-law-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function makeCtx() {
    return {
      repoPath: '/repo',
      repoName: 'repo',
      sessionDir: dir,
      recorder: new SessionRecorder('1000', sessionFilePath(dir, '1000')),
    }
  }

  it('classifies every route this app registers, and only this many', async () => {
    const app = buildApp(makeCtx())
    // `api/otel.ts`'s four routes live inside their own `app.register(...)`
    // plugin — the plugin queue only actually runs its routes once `ready()`
    // resolves, so reading `registeredRoutes` any earlier would silently miss
    // them and this law would walk vacuously over the other 22.
    //
    // Both numbers are derived, not typed: the four are `ROUTE_CLASSES`'
    // `ungated-mutation` rows, which ARE the OTLP inbox (`/v1/metrics`,
    // `/v1/logs`, `/v1/traces` and the bare-path fallback `POST /`, ADR-0018),
    // and 22 is the 26 asserted below minus those four. Re-derive rather than
    // trust: the previous wording said "three" and "14", which was true before
    // ADR-0018 added the fallback and never updated. #232's own ruling is that
    // a count stated in prose is derived from the thing it counts.
    await app.ready()

    const routes = app.registeredRoutes.filter((route) => !isAutoHead(route))
    const unclassified = routes.filter((route) => classify(route, ROUTE_CLASSES) === undefined)

    expect(unclassified).toEqual([])
    // A count pinned independently of `ROUTE_CLASSES.length` itself: a walk
    // that silently matched zero real routes, or a classification table
    // quietly emptied, must not both agree and pass anyway. This repo has
    // had two laws walk vacuously before.
    // 23 -> 25: the lane index's two reads (prd-31 ruling 5, #556) —
    // `/api/lane-index` and `/api/lane-index/:handle`. prd-29 ruling 7 (#58,
    // #59) reclassifies six existing rows to `gated-read` and adds none, so
    // the count is unchanged. 25 -> 26: prd-17 ruling 1's operator door
    // (#276), `POST /api/operator/:act` — one route, three acts.
    expect(routes.length).toBe(26)
    expect(ROUTE_CLASSES.length).toBe(26)

    await app.close()
  })

  it('bites: a real route registered with no row in the table fails the walk', async () => {
    const app = buildApp(makeCtx())
    // Registered directly on the real instance, exactly the way any future
    // route would be — proving the law reads the app, not a list of what is
    // merely expected to exist.
    app.post('/api/not-a-real-route', async () => ({}))
    await app.ready()

    const routes = app.registeredRoutes.filter((route) => !isAutoHead(route))
    const unclassified = routes.filter((route) => classify(route, ROUTE_CLASSES) === undefined)

    expect(unclassified).toEqual([{ method: 'POST', url: '/api/not-a-real-route', hasCapabilityGate: false }])

    await app.close()
  })

  it('every row in the table is still an actually-registered route — a stale row cannot hide behind a table that was never checked both ways', async () => {
    const app = buildApp(makeCtx())
    await app.ready()

    const routes = app.registeredRoutes.filter((route) => !isAutoHead(route))
    const stale = ROUTE_CLASSES.filter(
      (entry) => !routes.some((route) => route.method === entry.method && route.url === entry.url),
    )

    expect(stale).toEqual([])

    await app.close()
  })

  it('the gate-presence law holds: every gated row carries its gate, and no read carries one (prd-29 ruling 2)', async () => {
    const app = buildApp(makeCtx())
    await app.ready()

    const routes = app.registeredRoutes.filter((route) => !isAutoHead(route))

    // Every `gated-*` row's real route holds the capability gate, and every
    // plain `read`/`ungated-mutation` holds none. Deleting a `preHandler` from
    // any of the twenty-one gated routes turns this red — that is the law
    // biting.
    expect(gatePresenceViolations(routes, ROUTE_CLASSES)).toEqual([])

    // A count pinned independently, so the walk cannot pass vacuously by
    // matching zero gated routes: seven gated mutations (six plus prd-17
    // ruling 1's operator door, #276) + seven gated reads (prd-29 wave 1) +
    // four gated reads (prd-29 wave 1b, ruling 7, #58) + two gated reads
    // (prd-29 wave 2a, ruling 7, #59) + one gated read (prd-29 wave 2b,
    // ruling 4, #60 — `/api/stream`). If this number and the walk above
    // disagree with the table, they cannot both pass.
    const gatedFound = routes.filter((route) => {
      const entry = classify(route, ROUTE_CLASSES)
      return entry !== undefined && isGated(entry) && route.hasCapabilityGate
    })
    expect(gatedFound.length).toBe(21)

    await app.close()
  })

  it('GET /* stays tokenless — the bootstrap keeps no gate (prd-29 ruling 1)', async () => {
    const app = buildApp(makeCtx())
    await app.ready()

    const catchAll = app.registeredRoutes.find((route) => route.method === 'GET' && route.url === '/*')
    expect(catchAll).toBeDefined()
    expect(catchAll?.hasCapabilityGate).toBe(false)

    await app.close()
  })

  it('bites: a gated-read row whose route lacks its gate is a violation, and a present gate is clean', () => {
    // Runs the REAL predicate the walk above uses — not a re-implementation —
    // against a hand-built routing table, so it proves the law can distinguish
    // a missing gate from a present one rather than passing on everything.
    const table: RouteClassification[] = [{ method: 'GET', url: '/api/sessions', routeClass: 'gated-read' }]

    const missing: RegisteredRoute[] = [{ method: 'GET', url: '/api/sessions', hasCapabilityGate: false }]
    expect(gatePresenceViolations(missing, table)).toEqual([
      { method: 'GET', url: '/api/sessions', expectedGate: true, actualGate: false },
    ])

    const present: RegisteredRoute[] = [{ method: 'GET', url: '/api/sessions', hasCapabilityGate: true }]
    expect(gatePresenceViolations(present, table)).toEqual([])

    // …and a stray gate on a plain read is caught too, not only a missing one.
    const strayTable: RouteClassification[] = [{ method: 'GET', url: '/*', routeClass: 'read' }]
    const stray: RegisteredRoute[] = [{ method: 'GET', url: '/*', hasCapabilityGate: true }]
    expect(gatePresenceViolations(stray, strayTable)).toEqual([
      { method: 'GET', url: '/*', expectedGate: false, actualGate: true },
    ])
  })
})

// ── the every-occurrence discipline, shared by every law in this file ──────
//
// These lived inside the mutating-route describe when #23 first landed, and
// the two laws below it went on reading only their FIRST match — the exact
// defect `captureAll` was written to end, ninety lines further down the same
// file. Hoisted to module scope so a law cannot silently opt out of the rule
// by being declared somewhere the helper is not in scope.
/** English number words this repo's prose actually uses for these counts — extend if a doc starts spelling higher. */
const NUMBER_WORDS: Readonly<Record<string, number>> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
}

function wordToNumber(word: string): number {
  const n = NUMBER_WORDS[word.toLowerCase()]
  if (n === undefined) throw new Error(`unrecognised number word in a doc's stated count: "${word}"`)
  return n
}

/**
 * Collapses newlines/wrapping before matching — this repo hard-wraps prose
 * near 80 columns, so an anchor spanning a line break (e.g. "Two more\nare
 * gated") must not depend on exactly where the wrap falls.
 *
 * Finds EVERY occurrence of `pattern` (which must carry the `g` flag), not
 * the first. Round 2 of this issue's review found the actual failure mode
 * a single-match `.match()` has here: a claim restated in two places (a
 * headline count and a back-reference to it) is two independent chances to
 * drift, and a check that reads only the first sees only one of them. Round
 * 2 also verified, against `git log -p`, that *this repo's* two flagged
 * back-references (README's "three hands above", SECURITY.md's "those two
 * classes") were each authored in the SAME commit as their sibling and are
 * not restatements of the SAME question — one counts hands preceding a
 * section, the other counts hands in total; one counts a mutating route's
 * own two postures, the other counts all four route classes — so forcing
 * them equal would introduce the bug this law exists to prevent, not catch
 * one. Every anchor below still names one specific, single-question claim;
 * this function just stops assuming a claim can only be written once.
 */
function captureAll(text: string, pattern: RegExp, label: string): number[] {
  if (!pattern.global) throw new Error(`${label}: pattern must carry the 'g' flag — captureAll reads every match`)
  const normalized = text.replace(/\s+/g, ' ')
  const matches = [...normalized.matchAll(pattern)]
  if (matches.length === 0) {
    throw new Error(`${label}: anchor not found — the prose changed and this law's pattern did not follow it`)
  }
  return matches.map((match) => {
    if (match[1] === undefined) throw new Error(`${label}: anchor matched with no captured number`)
    return wordToNumber(match[1])
  })
}

/** Every occurrence of a claim must equal `expected` — one drifting occurrence is still a defect, not an average. */
function expectAllAgree(stated: readonly number[], expected: number, label: string): void {
  const disagreeing = stated.filter((n) => n !== expected)
  expect(disagreeing, `${label}: at least one stated occurrence disagreed with the derived value`).toEqual([])
}


/**
 * THE DERIVED-COUNTS LAW (prd-43 wave 4, #23; swept repo-wide, #232) — every
 * occurrence of a RECOGNISED route-count claim is derived from `ROUTE_CLASSES`
 * and never retyped beside it, in whatever file it occurs.
 *
 * The claim is deliberately bounded to a recognised vocabulary rather than to
 * "every count stated in prose", because the second is an open set no matcher
 * closes: a count can be phrased in a sentence nobody has written yet, or
 * spelled in digits that `wordToNumber` structurally cannot read. A law making
 * the unbounded claim needs a round per counter-example and never converges —
 * #23 already learned this on the outbound-call sweep one PRD over, and
 * narrowed that claim to a named vocabulary for the same reason.
 *
 * So the vocabulary IS the claim: `CLAIMS` below is the whole of what this law
 * recognises, every one of its patterns is applied to every swept file rather
 * than only to the file its row names, and the completeness test further down
 * fails on any occurrence no row declares. The boundary is written out beside
 * that test rather than left for a reader to discover.
 *
 * #23 grew one hand-written `it()` per claim, in the two files it was fenced
 * to touch. That shape cannot notice a claim in a THIRD file — which is
 * exactly what happened: eight further sites state the same kind of count,
 * across files nobody had grown an anchor for, and two of them had already
 * drifted (`security.ts` said "ten" gated reads, `lane-index.test.ts` said
 * "eleven", both against a true fourteen). So this is a table, not a growing
 * pile of `it()` blocks — the walk below is the ONLY place the check is
 * written, and a thirteenth site costs one row, not one more test.
 *
 * `docs/adr/` and `docs/review/` are excluded by design (AGENTS.md: the ADR
 * log is append-only and a dated record counts the tree as it stood), except
 * the one ADR-0008 row below — that row lives inside an explicit, dated
 * *amendment* to the original decision (see its own "Amendment" blockquote),
 * stating the CURRENT count rather than the historical one the ADR first
 * recorded, so it is not the append-only body the exclusion protects.
 *
 * Every claim is its OWN anchored regex against the doc's actual current
 * wording, never a shared loose pattern — a prior chain in this same PRD
 * spent fourteen review rounds closing one spelling of a check and missing
 * its sibling axis. `captureAll`/`expectAllAgree` (below) give the
 * both-directions, every-occurrence guarantee: a document overstating OR
 * understating the real count fails identically, a restated claim is checked
 * as many times as it is stated, and a code change that adds or removes a
 * mutating route fails every doc side at once, without anyone retyping a
 * digit.
 */
describe('every recognised route-count claim is derived from ROUTE_CLASSES, in whatever file it occurs (#23, #232)', () => {
  const gatedMutationCount = ROUTE_CLASSES.filter((entry) => entry.routeClass === 'gated-mutation').length
  const ungatedMutationCount = ROUTE_CLASSES.filter((entry) => entry.routeClass === 'ungated-mutation').length
  const totalMutationCount = gatedMutationCount + ungatedMutationCount
  const gatedReadCount = ROUTE_CLASSES.filter((entry) => entry.routeClass === 'gated-read').length

  interface RouteCountClaim {
    /** Repo-root-relative path segments, joined with `path.join` — never a hand-typed `/`, so this reads correctly on Windows too. */
    file: string[]
    /** Anchored, must carry the `g` flag and exactly one capturing group — see `captureAll`. */
    pattern: RegExp
    label: string
    expected: number
    /**
     * True only for a claim living inside a `/** ... *\/` block comment where
     * the anchor spans a wrapped line — a continuation line's leading ` * `
     * is not whitespace, and `captureAll`'s newline collapse leaves it
     * in place, splitting the match. Every claim below that does NOT need
     * this reads on a single physical line, so the flag is the exception,
     * not the default.
     */
    stripCommentGutter?: true
  }

  const CLAIMS: readonly RouteCountClaim[] = [
    // SECURITY.md (#23)
    {
      file: ['SECURITY.md'],
      pattern: /answers \*\*(\w+)\*\* mutating routes in total/g,
      label: 'SECURITY.md total',
      expected: totalMutationCount,
    },
    {
      file: ['SECURITY.md'],
      pattern: /remaining (\w+) are the OTLP telemetry inbox/g,
      label: 'SECURITY.md ungated',
      expected: ungatedMutationCount,
    },
    // mutation-guard.ts (#23) — EXPLICITLY OUT of #232's fence: read here, never written.
    {
      file: ['packages', 'server', 'src', 'server', 'mutation-guard.ts'],
      pattern: /This server has (\w+) mutating routes today/g,
      label: 'mutation-guard.ts total',
      expected: totalMutationCount,
      stripCommentGutter: true,
    },
    {
      file: ['packages', 'server', 'src', 'server', 'mutation-guard.ts'],
      pattern: /this server's (\w+) GATED mutating routes/g,
      label: 'mutation-guard.ts gated',
      expected: gatedMutationCount,
      stripCommentGutter: true,
    },
    // security.ts (#232) — wrong today: said "ten", true count is fourteen.
    {
      file: ['packages', 'server', 'src', 'api', 'security.ts'],
      pattern: /puts the same token on (\w+) reads/g,
      label: 'security.ts gated reads',
      expected: gatedReadCount,
    },
    // lane-index.test.ts (#232) — wrong today: said "eleven", true count is fourteen.
    {
      file: ['packages', 'server', 'src', 'api', 'lane-index.test.ts'],
      pattern: /covered once for all (\w+) gated reads/g,
      label: 'lane-index.test.ts gated reads',
      expected: gatedReadCount,
    },
    // index.ts (#232) — EXPLICITLY OUT of #232's fence: read here, never written; already correct.
    {
      file: ['packages', 'server', 'src', 'api', 'index.ts'],
      pattern: /The app's (\w+) mutating routes/g,
      label: 'index.ts total mutating',
      expected: totalMutationCount,
    },
    // docs/architecture.md (#232) — already correct.
    {
      file: ['docs', 'architecture.md'],
      pattern: /(\w+) reads are gated:/g,
      label: 'architecture.md gated reads',
      expected: gatedReadCount,
    },
    {
      file: ['docs', 'architecture.md'],
      pattern: /`gated-mutation` row among (\w+) mutating routes/g,
      label: 'architecture.md total mutating',
      expected: totalMutationCount,
    },
    // docs/adr/0008 (#232) — EXPLICITLY OUT of #232's fence: read here, never written. See
    // this describe's own doc for why the ADR exclusion does not cover this one row.
    {
      file: ['docs', 'adr', '0008-localhost-only-single-origin-server.md'],
      pattern: /`ROUTE_CLASSES` declares (\w+) gated mutations/g,
      label: 'adr-0008 amendment gated mutations',
      expected: gatedMutationCount,
    },
    // gated-reads.test.ts (#232) — EXPLICITLY OUT of #232's fence: read here, never written; already correct.
    {
      file: ['packages', 'server', 'src', 'api', 'gated-reads.test.ts'],
      pattern: /\): (\w+) SPA-only reads/g,
      label: 'gated-reads.test.ts SPA-only reads',
      expected: gatedReadCount,
    },
    {
      file: ['packages', 'server', 'src', 'api', 'gated-reads.test.ts'],
      pattern: /the (\w+) gated reads answer only the token holder/g,
      label: 'gated-reads.test.ts describe title',
      expected: gatedReadCount,
    },
  ]

  // Read once per (file, gutter-mode) pair, however many claims share it —
  // SECURITY.md, mutation-guard.ts, architecture.md and gated-reads.test.ts
  // each carry two.
  const fileCache = new Map<string, string>()
  function contentFor(claim: RouteCountClaim): string {
    const key = `${path.join(...claim.file)}\0${claim.stripCommentGutter ? 1 : 0}`
    const cached = fileCache.get(key)
    if (cached !== undefined) return cached
    const raw = readFileSync(path.join(REPO_ROOT, ...claim.file), 'utf8')
    const text = claim.stripCommentGutter ? raw.replace(/^\s*\*\s?/gm, ' ') : raw
    fileCache.set(key, text)
    return text
  }

  it.each(CLAIMS.map((claim): [string, RouteCountClaim] => [claim.label, claim]))(
    '%s: every occurrence agrees with the count ROUTE_CLASSES derives',
    (_label, claim) => {
      expectAllAgree(captureAll(contentFor(claim), claim.pattern, claim.label), claim.expected, claim.label)
    },
  )

  /**
   * COMPLETENESS. The walk above validates rows somebody already knew to add.
   * On its own that reproduces the omission shape #232 was filed for: #23 grew
   * one hand-written `it()` per claim and so could not notice a claim in a
   * THIRD file, and a table of (file, pattern) pairs cannot either — it just
   * fails one level up.
   *
   * Demonstrated by ciaran-slow on PR #260, and reproduced before this was
   * written: appending the already-recognised sentence "puts the same token on
   * thirteen reads" to `api/test-support.ts`, a file no row declares, left the
   * law 84/84 GREEN. A false route count sat in a swept package with nothing
   * red.
   *
   * So every registered pattern is applied to every swept file, not only to the
   * file its row names. A recognised claim shape occurring anywhere no row
   * declares it is an UNREGISTERED claim and fails here, naming the file and
   * the pattern, so the remedy is to add a row rather than to guess.
   *
   * WHAT THIS DOES NOT CLOSE, stated rather than implied — the claim this law
   * makes is bounded, and these are the boundary:
   *
   *  - **A novel phrasing.** A count written in a sentence no row's pattern
   *    recognises is invisible here. Closing that needs a coarse
   *    number-word-adjacency sweep with a committed baseline for the prose that
   *    legitimately exists today, which is its own issue and its own decision.
   *  - **A digit-spelled count.** `wordToNumber` is words-only and
   *    `NUMBER_WORDS` stops at twenty, so "13 gated reads" is structurally
   *    unreachable by this mechanism.
   *  - **This file.** `route-class-law.test.ts` is excluded because it carries
   *    every pattern as a regex literal and every claim in prose; sweeping
   *    itself would match its own source. That is a real hole: a count added to
   *    THIS file's comments escapes.
   *  - **Dated artefacts.** `docs/adr/` and `docs/review/` are excluded by
   *    design — an ADR counts the tree as it stood and the log is
   *    append-only. #232's own scope statement names both.
   *
   *    `docs/prds/` was excluded here too, on the same reasoning, from
   *    2026-09-04 until issue #289: a verify pass found the omission silently
   *    load-bearing and named it — but named it without checking whether it
   *    was still doing anything. It was not. EXECUTED (#289): all twelve
   *    `CLAIMS` patterns below, the real ones extracted from the table rather
   *    than retyped, against all 53 tracked markdown files under `docs/prds/`
   *    — zero matches. An exclusion earns its place by hiding a claim this
   *    sweep would otherwise flag; ruling 1's own reasoning is that a PRD's
   *    Evidence section cites a dead path *on purpose* (this document's own
   *    Evidence section names four), which is a reason to protect a claim
   *    already known to be there — not license to keep excluding a directory
   *    that has nothing in it for this particular detector to trip over.
   *    **Rejected: reviving it** (asserting the exclusion non-vacuous as-is).
   *    That would mean either asserting a false thing about the current tree,
   *    or growing a docs/prds/ file a route-count sentence for no reason but
   *    to keep a test green — manufacturing the exact fixture ruling 1 exists
   *    to warn against. Retired instead: `docs/prds/` is swept like any other
   *    tracked doc, and the pinned assertion below is what keeps a silent
   *    re-exclusion from creeping back in unnoticed.
   */
  const SWEPT_EXTENSIONS = ['.md', '.ts', '.tsx', '.mjs', '.js'] as const
  const SWEEP_EXCLUDED_PREFIXES = ['docs/adr/', 'docs/review/'] as const
  const THIS_FILE_REL = 'packages/server/src/api/route-class-law.test.ts'

  /**
   * THE SWEEPING TESTS' BUDGET — #270, #266.
   *
   * `sweptFiles()` shells out to `git ls-files` and then reads EVERY tracked
   * file with a swept extension. That is hundreds of synchronous reads inside
   * one `it`, and vitest's default 5000 ms was never enough for it under load.
   * Measured on one machine, one commit, 2026-09-04 (#270):
   *
   *   run alone                     ~4.2 s   88/88 pass
   *   under VITEST_MAX_WORKERS=6     5.8 s   timeout
   *   under the same load            8.1 s   timeout
   *   under the same load           11.1 s   timeout
   *
   * So the default was marginal even in isolation. One failing run named the
   * cause in its own output — `Preparing worktree (detached HEAD ...)`, a
   * concurrent law test creating git worktrees while this one shells out to
   * git.
   *
   * **Read the failure, not the test name, if this ever goes red.** The failure
   * was `Error: Test timed out in 5000ms`, never an assertion — but the test is
   * named for an undeclared route-count claim, so twice in one session a reader
   * concluded the sweep had FOUND one and went looking for it. It had not.
   *
   * EVERY sweeping test carries this, not just the slow one. Raising one and
   * leaving its sibling on the default to time out next month is the shape this
   * repo names most often, and it is the shape #266's first draft had: it
   * raised the completeness sweep and left `reads a non-empty file set` — which
   * calls the same `sweptFiles()` — on 5000 ms.
   *
   * WHAT THIS IS NOT. It is a catastrophe backstop, never the regression guard.
   * #266 cut the sweep's cost roughly six-fold, and a verify pass then showed
   * that reverting that fix left every semantic test green well inside this
   * ceiling — so a wall-clock bound cannot be what protects it. The structural
   * assertion below ("the sweep normalises each swept file once") is the guard.
   * If a future reader sees these tests near 30 s again, the answer is to make
   * the sweep cheaper, not to raise the number.
   */
  const SWEEP_TIMEOUT_MS = 30_000

  function sweptFiles(): string[] {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' })
    return out
      .split('\0')
      .filter((rel) => rel.length > 0)
      .filter((rel) => SWEPT_EXTENSIONS.some((ext) => rel.toLowerCase().endsWith(ext)))
      .filter((rel) => !SWEEP_EXCLUDED_PREFIXES.some((p) => rel.startsWith(p)))
      .filter((rel) => rel !== THIS_FILE_REL)
  }

  it('the completeness sweep reads a non-empty file set — a sweep matching nothing would pass vacuously', () => {
    expect(sweptFiles().length).toBeGreaterThan(50)
  }, SWEEP_TIMEOUT_MS)

  /**
   * THE RETIREMENT ITSELF (#289) — `docs/prds/` is no longer in
   * `SWEEP_EXCLUDED_PREFIXES`, and this is the guard against it silently
   * coming back. Pinned so a re-addition cannot pass unnoticed: an editor who
   * re-excludes the directory (for a real reason, or out of habit copied from
   * `EXCLUDED_CLONE_SITE_DIRS` or `doc-citation-law.test.ts`'s `EXCLUDED_DIRS`)
   * gets a failing diff here, naming the exact list this test expects, rather
   * than a silent widening nobody notices until the next verify pass.
   *
   * EXECUTED, by mutation: re-adding `'docs/prds/'` to the array above turns
   * this test red on the `toEqual` line, before either assertion below ever
   * runs — reverted after confirming it.
   */
  it('docs/prds/ stays swept — issue #289: the exclusion hid nothing and is retired, not revived', () => {
    expect(SWEEP_EXCLUDED_PREFIXES).toEqual(['docs/adr/', 'docs/review/'])

    const prdFiles = sweptFiles().filter((rel) => rel.startsWith('docs/prds/'))
    expect(prdFiles.length).toBeGreaterThan(50)
  }, SWEEP_TIMEOUT_MS)

  /** Git emits `/` from `ls-files` on every platform, independently of `path.sep`. */
  function claimKey(file: readonly string[], pattern: RegExp): string {
    return `${file.join('/')}\u0000${pattern.source}`
  }

  /**
   * The two readings of one file — plain, and with block-comment gutters
   * stripped — carrying the same hard-wrap tolerance as `captureAll`, and
   * computed ONCE per file.
   *
   * This used to live inside `containsClaim`, which the sweep calls per
   * (file, claim) pair, so the three whole-file replaces below ran once per
   * CLAIMS row rather than once per file — `CLAIMS.length` times the work the
   * sweep actually needs, since the normalisation depends only on the TEXT and
   * never on the pattern. That cost the sweep 7490 ms on `macos-latest`
   * against vitest's 5000 ms default: a timeout on other people's branches,
   * pointing at their diff rather than at this sweep (#266; caught on PR #263,
   * an approved and unrelated change).
   *
   * Deliberately NO file or row counts in this prose. Both figures grow with
   * the repo, and a count stated in prose drifting from the thing it counts is
   * the exact defect this whole file exists to catch — the first draft of this
   * docblock said 1109 files and 15 rows against a real 979 and 12, and every
   * figure derived from them was wrong. The ratio is the durable fact, and the
   * structural test below asserts it against the live corpus rather than
   * restating it. Measured 2026-09-04: 4.73 s to 783 ms.
   *
   * Hoisting is behaviour-preserving by construction: same inputs, same two
   * strings, same probes run against them.
   */
  function readingsOf(text: string): readonly [string, string] {
    const normalized = text.replace(/\s+/g, ' ')
    const gutterless = text.replace(/^\s*\*\s?/gm, ' ').replace(/\s+/g, ' ')
    return [normalized, gutterless]
  }

  /**
   * A claim's probe, compiled once. The rows' own patterns carry `/g` and are
   * stateful, so they cannot be reused for `.test` across files without leaking
   * `lastIndex`; a non-global copy has no such state and is safe to share.
   */
  function probeFor(pattern: RegExp): RegExp {
    return new RegExp(pattern.source, pattern.flags.replace('g', ''))
  }

  function containsClaim(readings: readonly [string, string], probe: RegExp): boolean {
    return probe.test(readings[0]) || probe.test(readings[1])
  }

  it('the completeness probe sees a recognised claim split across a hard-wrapped block comment', () => {
    const wrapped = [
      '/**',
      ' * prd-29 puts the same token on',
      ' * thirteen reads.',
      ' */',
    ].join('\n')
    const pattern = CLAIMS.find((claim) => claim.label === 'security.ts gated reads')!.pattern
    expect(containsClaim(readingsOf(wrapped), probeFor(pattern))).toBe(true)
  })

  it('claim keys use git\'s platform-independent path spelling', () => {
    const claim = CLAIMS.find((entry) => entry.label === 'security.ts gated reads')!
    expect(claimKey(claim.file, claim.pattern)).toBe(
      `packages/server/src/api/security.ts\u0000${claim.pattern.source}`,
    )
  })

  /**
   * The completeness sweep, with its normaliser injected so the structural test
   * below can count the calls. `normalise` is the only thing here that reads a
   * file's text, so anything computed per (file, claim) rather than per file
   * shows up directly as a call count above `sweptFiles().length`.
   */
  function sweepUnregistered(
    normalise: (text: string) => readonly [string, string] = readingsOf,
  ): string[] {
    const declared = new Set(CLAIMS.map((claim) => claimKey(claim.file, claim.pattern)))
    const probes = CLAIMS.map((claim) => ({ claim, probe: probeFor(claim.pattern) }))
    const unregistered: string[] = []

    for (const rel of sweptFiles()) {
      const readings = normalise(readFileSync(path.join(REPO_ROOT, rel), 'utf8'))
      for (const { claim, probe } of probes) {
        if (declared.has(claimKey([rel], claim.pattern))) continue
        if (containsClaim(readings, probe)) {
          unregistered.push(`${rel} matches the pattern registered for ${claim.label}`)
        }
      }
    }

    return unregistered
  }

  it('no swept file states a recognised route-count claim that no CLAIMS row declares', () => {
    expect(sweepUnregistered()).toEqual([])
    // Budget and its rationale: SWEEP_TIMEOUT_MS above.
  }, SWEEP_TIMEOUT_MS)

  /**
   * The regression guard for the hoist, structural rather than wall-clock.
   *
   * The verify pass on #266 established that `SWEEP_TIMEOUT_MS` could not
   * fail for the reason it claimed: moving the normalisation back inside the
   * (file, claim) loop left every semantic test green at roughly 3.2 s, so the
   * exact regression the fix exists to prevent survived its own timeout. A
   * wall-clock ceiling can only catch a catastrophe, and it catches that one
   * differently on every machine.
   *
   * Counting the calls fails on that mutation deterministically, under any
   * load, on any runner: once per file is `sweptFiles().length`; once per
   * (file, claim) pair is up to `CLAIMS.length` times that.
   */
  it('the sweep normalises each swept file once, not once per claim — the hoist is load-bearing', () => {
    // With a single row the two shapes coincide and the count below would prove
    // nothing, so the assertion states the condition it needs rather than
    // assuming it.
    expect(CLAIMS.length).toBeGreaterThan(1)

    const expected = sweptFiles().length
    let calls = 0
    const counted = (text: string): readonly [string, string] => {
      calls += 1
      return readingsOf(text)
    }

    expect(sweepUnregistered(counted)).toEqual([])
    expect(calls).toBe(expected)
  }, SWEEP_TIMEOUT_MS)

  it('every claimed file actually exists under REPO_ROOT — a moved file must fail loudly, not read as zero claims', () => {
    for (const claim of CLAIMS) {
      expect(() => contentFor(claim), claim.label).not.toThrow()
    }
  })

  it('bites: a stale hand-typed count is told apart from the real one, not just parsed', () => {
    // "nine" is the exact defect this issue was filed over. If a revert ever
    // restores that word, this proves the extractor still reads it as 9,
    // distinct from whatever `totalMutationCount` derives — the comparison
    // above is what turns that into a red build.
    //
    // The real total is deliberately NOT restated here. It was written in as
    // "ten" and went stale the moment prd17 ruling 1's operator door made it
    // eleven (#276) — and this file is excluded from the sweep that catches
    // exactly that kind of rot, so nothing could tell us. A fixture's own prose
    // is the one place a hand-typed count has no guard at all, so the count
    // goes through `totalMutationCount` and the sentence stops claiming it.
    const stale = 'This server has nine mutating routes today, all POST.'
    const stated = captureAll(stale, /This server has (\w+) mutating routes today/g, 'fixture')
    expect(stated).toEqual([9])
    expect(stated).not.toEqual([totalMutationCount])
  })

  it('bites: a wrong count in a SECOND occurrence is caught even when the first occurrence is correct', () => {
    // The exact shape round 2 asked for: two occurrences of the identical
    // claim, only one mutated. A first-match-only reader — this law's own
    // shape before this round — would see the plausible first "ten" and never
    // read as far as the second, differing "nine". Both are literals of this
    // fixture and neither is asserted to be the app's real total; what is
    // asserted is that the extractor returns BOTH.
    const fixture =
      'This server answers **ten** mutating routes in total, not three. ' +
      'Reminder, three paragraphs later: this server answers **nine** mutating routes in total, not three.'
    const stated = captureAll(fixture, /answers \*\*(\w+)\*\* mutating routes in total/g, 'fixture')
    expect(stated).toEqual([10, 9])
    expect(() => expectAllAgree(stated, totalMutationCount, 'fixture')).toThrow(/at least one stated occurrence/)
  })
})

/**
 * THE SUPPORT-MATRIX LAW (#23) — README's platform table and `ci.yml`'s
 * actual job matrix must agree, in both directions: nothing the table claims
 * may be untrue of the workflow, and nothing the workflow proves may go
 * undocumented (in particular, the macOS `exclude` and the absence of any
 * `windows-latest` leg in this file — `desktop.yml`'s installer leg is a
 * different job, not this one).
 *
 * ## "Both directions" once covered half the table (verify round, #23)
 *
 * The first version asserted macOS and Windows and left **Linux and WSL
 * unasserted**, while its own header claimed the whole table. EXECUTED, both
 * directions, before the rows below existed:
 *
 * | mutation | old law | why it matters |
 * |---|---|---|
 * | Linux row → "Unverified — nothing here runs on it" | GREEN | understates what CI proves; harmless but undocumented |
 * | WSL row → "CI-verified on every push at both node legs" | GREEN | **claims CI that does not exist** — no WSL runner is in this workflow, or any other |
 *
 * The second is the direction that matters: a table claiming more coverage
 * than the workflow delivers is the failure a reader acts on. All four rows
 * are asserted now, and `every platform row the table carries is asserted by
 * name` fails if a fifth row is added without a law to go with it — the
 * sibling that would otherwise reopen this hole the next time the matrix grows.
 */
describe('the README support matrix agrees with what ci.yml actually proves, in both directions (#23)', () => {
  const CI_YML = readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
  const README_MD = readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8')

  function jobBlock(jobKey: string): string {
    const start = CI_YML.indexOf(`\n  ${jobKey}:`)
    if (start === -1) throw new Error(`ci.yml no longer declares a "${jobKey}" job — the law and the workflow drifted`)
    const rest = CI_YML.slice(start + 1)
    const nextJob = rest.slice(2).search(/\n {2}[a-z][\w-]*:\n/)
    const block = nextJob === -1 ? rest : rest.slice(0, nextJob + 2)
    // A job ends where the NEXT job's leading comment begins, not at the next
    // job's key. ci.yml documents every job in a comment block above it, and
    // those lines are not part of the job above them — without this trim, a
    // sentence written about pack-smoke is read as text inside build-test-boot,
    // which is enough to make the windows-latest law below accuse the wrong job.
    return block.replace(/\n(?: {2}#[^\n]*\n?)+$/, '\n')
  }

  const supportMatrixStart = README_MD.indexOf('## Support matrix')
  if (supportMatrixStart === -1) {
    throw new Error('README.md no longer has a "## Support matrix" section — the law has nothing to check')
  }
  /**
   * Bounded at the NEXT heading, not at end-of-file. Unbounded, the slice ran
   * to the bottom of the README and swept in every later table's rows — which
   * no assertion noticed while they were all `toMatch` existence checks, and
   * which the row-completeness check below caught immediately (24 stray rows).
   * A section that does not end where the section ends is not a section.
   */
  const nextHeading = README_MD.slice(supportMatrixStart + 3).search(/\n## /)
  const supportMatrixSection =
    nextHeading === -1 ? README_MD.slice(supportMatrixStart) : README_MD.slice(supportMatrixStart, supportMatrixStart + 3 + nextHeading)

  it('build-test-boot runs macOS only at the current node — min is excluded — matching the README claim', () => {
    const block = jobBlock('build-test-boot')
    expect(block).toMatch(/os:\s*\[ubuntu-latest, macos-latest\]/)
    expect(block).toMatch(/exclude:\s*\n\s*- os: macos-latest\s*\n\s*node: min/)
  })

  it('pack-smoke runs the full 3x2 grid — Linux, macOS and Windows at both node legs, no exclude — matching the README claim (#211)', () => {
    const block = jobBlock('pack-smoke')
    expect(block).toMatch(/os:\s*\[ubuntu-latest, macos-latest, windows-latest\]/)
    expect(block).not.toMatch(/exclude:/)
  })

  it('windows-latest runs on pack-smoke and ONLY pack-smoke — build-test-boot has no Windows leg until #212 commits the expected-fail list (prd-25 ruling 1, #211)', () => {
    // Until #211 this law asserted the ABSENCE of a windows-latest leg anywhere in
    // ci.yml, so the README's "unverified" row stayed true. The leg now exists, on
    // the job whose failures cannot be laundered by an untriaged suite; a Windows
    // row on build-test-boot would be permanently red until #212's list exists,
    // and a leg that is always red teaches everyone to ignore it.
    expect(jobBlock('pack-smoke')).toMatch(/windows-latest/)
    expect(jobBlock('build-test-boot')).not.toMatch(/windows-latest/)
  })

  /**
   * The one physical line for `platform`, and proof there is exactly one.
   *
   * The checks here used to be bare `toMatch` existence tests, which a SECOND,
   * contradicting row for the same platform satisfies — EXECUTED in the verify
   * round: duplicating the macOS row with a conflicting claim left this law
   * green. An existence check cannot see a contradiction; it can only see an
   * agreement somewhere. Resolving to exactly one row first makes every
   * assertion below a statement about *the* row rather than about *a* row.
   */
  /**
   * Every physical table row in the section, as `{ cells, line }`.
   *
   * Parsed by splitting on `|` rather than matched by one regex, because the
   * regex version was defeated three times in the fix re-review by rows that
   * render IDENTICALLY in GitHub-flavoured Markdown: `|FreeBSD|…|` with no
   * padding, ` | FreeBSD | … |` with a leading space, and a platform cell
   * containing a pipe inside an inline code span. GFM allows up to three
   * leading spaces and any padding inside cells, so a law that demands `"| "`
   * is asserting a formatting convention while claiming to enumerate rows —
   * and the unpadded spelling was a row claiming CI that does not exist.
   */
  function matrixRows(): { cells: string[]; line: string }[] {
    // Fenced blocks are skipped: wrapping the whole matrix in a ```/~~~ fence
    // makes it render as CODE, not a table, while every pipe line still looks
    // like a row to a naive scan — so the law passed over a matrix no reader
    // sees as a matrix (EXECUTED, fix re-review).
    const lines: string[] = []
    let fence: string | null = null
    for (const line of supportMatrixSection.split('\n')) {
      const opener = /^ {0,3}(`{3,}|~{3,})/.exec(line)
      if (fence === null && opener !== null) {
        fence = opener[1]![0]!
        continue
      }
      if (fence !== null) {
        if (opener !== null && opener[1]![0] === fence) fence = null
        continue
      }
      lines.push(line)
    }
    return lines
      // No trailing-pipe requirement: GFM renders `| FreeBSD | CI-verified` as
      // a row, and demanding the closing delimiter let a fifth platform row
      // arrive unasserted — the original #23 failure, on an adjacent spelling
      // (EXECUTED, fix re-review).
      .filter((line) => /^ {0,3}\|/.test(line))
      .map((line) => ({
        // Drop the leading and trailing delimiter, then split. An escaped
        // `\|` inside a cell is not a delimiter and is put back.
        cells: line
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split(/(?<!\\)\|/)
          .map((cell) => cell.trim().replace(/\\\|/g, '|')),
        line,
      }))
      .filter((row) => !row.cells.every((cell) => /^:?-+:?$/.test(cell)))
  }

  function rowFor(platform: string): string {
    const matches = matrixRows().filter((row) => row.cells[0] === platform)
    expect(matches.length, `README support matrix: expected exactly one "${platform}" row, found ${matches.length}`).toBe(1)
    return matches[0]!.line
  }

  it("README's macOS row cites both jobs' real shape: build-test-boot's macos-latest leg, and pack-smoke at both node legs", () => {
    expect(rowFor('macOS')).toMatch(/macos-latest[^\n]*pack-smoke[^\n]*both node legs/)
  })

  it("README's Windows (native) row cites the leg that proves it — pack-smoke on windows-latest at both node legs — and claims no suite run, because build-test-boot has none (#211)", () => {
    const row = rowFor('Windows (native)')
    expect(row).toMatch(/windows-latest[^\n]*pack-smoke[^\n]*both node legs/)
    expect(row).toMatch(/build-test-boot/)
    expect(row).not.toMatch(/\*\*Unverified/)
  })

  it('build-test-boot and pack-smoke both run ubuntu-latest — the Linux row claims CI, and CI delivers it', () => {
    expect(jobBlock('build-test-boot')).toMatch(/os:\s*\[ubuntu-latest,/)
    expect(jobBlock('pack-smoke')).toMatch(/os:\s*\[ubuntu-latest,/)
    // The other direction: the row must actually make the claim CI supports.
    expect(rowFor('Linux')).toMatch(/CI-verified on every push/)
  })

  it('the WSL row does NOT claim CI, because no workflow anywhere runs a WSL leg', () => {
    // The direction that bites. A row claiming coverage that does not exist is
    // the one a reader acts on, and it stayed green through the first version
    // of this law. `ci.yml` has no WSL runner and neither does any sibling
    // workflow — GitHub has no WSL runner image at all.
    for (const file of readdirSync(path.join(REPO_ROOT, '.github', 'workflows'))) {
      // No `\b` after `wsl`: the word boundary refuses a following digit, so
      // `runs-on: [self-hosted, wsl2]` — the commoner spelling of the thing
      // being forbidden — walked straight through (EXECUTED, fix re-review).
      expect(readFileSync(path.join(REPO_ROOT, '.github', 'workflows', file), 'utf8')).not.toMatch(/\bwsl/i)
    }
    const wsl = rowFor('WSL')
    expect(wsl).not.toMatch(/CI-verified/)
    expect(wsl).toMatch(/not by CI/)
  })

  it('every platform row the table carries is asserted by name — a fifth row cannot arrive unguarded', () => {
    const platforms = matrixRows()
      .map((row) => row.cells[0]!)
      .filter((cell) => cell !== 'Platform')
    expect(platforms).toEqual(['Linux', 'WSL', 'macOS', 'Windows (native)'])
  })
})

/**
 * THE OUTBOUND-FETCH RECIPE LAW (#23) — README's outbound-call sweep names a
 * real, enumerated, closed set of call sites rather than an uncounted claim.
 * Walks `packages/web/src` and `packages/app/src` (the browser and
 * Electron-host code — the only places a page or the shell itself can
 * originate a request), excluding tests, and asserts the result is EXACTLY
 * today's ten modules / thirteen call sites, not merely "at least these".
 *
 * This opener used to quote README's old sentence, "grep for fetch(/
 * EventSource(/http.request(", which THIS COMMIT deleted — a comment citing
 * doc text that no longer exists, inside the law whose entire subject is that
 * failure. Caught in review; recorded because the irony is the useful part.
 *
 * ## Two holes this law shipped with, and what closed them (verify round, #23)
 *
 * The first version walked `/\.tsx?$/` and matched only a literal call. Both
 * narrowings were invisible in the README sentence it certified, which is the
 * defect this whole issue exists to end — a document stating what its source
 * does not support, with a green law behind it.
 *
 * 1. **The file filter.** `packages/web/src/scene/parity/capture.mjs` is a
 *    `.mjs` module under a swept root with two real `fetch(` calls, and the
 *    extension test skipped it silently. EXECUTED: a new `.mjs` file
 *    containing `fetch('/x')` left this law green; the identical content
 *    named `.ts` reddened it.
 * 2. **The pattern.** Five modules never write `fetch(` at all. They alias the
 *    platform function first — `const impl = fetchImpl ?? globalThis.fetch`
 *    — and then call `impl(URL, …)`, which no literal-call regex can see:
 *    `concierge/clone.ts`, `concierge/instrument.ts`, `lab/launch/launch.ts`,
 *    `recordings/label.ts`, `replay/rotate.ts`.
 *
 * `ALIAS_PATTERNS` closes (2), and the `typeof` lookbehind is load-bearing
 * rather than cosmetic. `typeof globalThis.fetch === 'function'` is a
 * capability probe, not an origination, and **six** modules use exactly that
 * guard and then delegate to `recordings/capabilityRead.ts` — whose own two
 * call sites are already counted here: `app/StatusBar.tsx`, `connect/meta.ts`,
 * `drawer/useTranscript.ts`, `fleet/manifest.ts`, `lane-page/LanePage.tsx`,
 * `lane-page/laneIndex.ts`. Counting those six again would inflate the number
 * by double-counting one egress point through its callers, which is a
 * different way of being wrong, not a safer one.
 *
 * Both figures in this paragraph were WRONG when this repair first landed —
 * it said nine aliasing modules and four delegating ones, against a real five
 * and six — and both fix-re-review seats found it. Nothing asserted them,
 * which is the whole lesson: a count in a comment is prose, and this issue is
 * about prose that no source checks. The derived-list law below now pins the
 * README's own enumeration, so the numbers a READER acts on cannot drift even
 * though this docblock's cannot be asserted.
 */
describe("the README's outbound-fetch recipe names exactly the real call sites, and only those (#23)", () => {
  const SOURCE_ROOTS = [
    path.join(REPO_ROOT, 'packages', 'web', 'src'),
    path.join(REPO_ROOT, 'packages', 'app', 'src'),
  ]
  // No `\s*` before the paren: a call is `fetch(`, adjacent, never "fetch
  // (#181)" — a parenthetical remark in prose that merely names the verb.
  // `StatusBar.tsx`'s own doc comment does exactly that and would otherwise
  // false-positive as a seventh call site.
  // The vocabulary is this repo's own, lifted from
  // `packages/web/src/interaction/no-model-call-law.test.ts` — which has
  // always known about XHR, beacons, sockets and dynamic https imports, but
  // only swept its own directory. README's sentence says "anywhere", and
  // before this it was true only of `fetch`/`EventSource`: a scratch module
  // originating a request through `new XMLHttpRequest`, `navigator.sendBeacon`,
  // `new WebSocket` or `await import('node:https')` left this law green
  // (EXECUTED, fix re-review).
  //
  // `fetch`'s paren allows whitespace ONLY around an optional-call `?.`, never
  // on its own. That is what lets `fetch?.(url)` and even `fetch ?. (url)`
  // count — a real request spelling a re-review seat got past the first
  // version of this repair — while `StatusBar.tsx`'s own doc comment, which
  // writes "fetch (#181)" in prose, still does not false-positive: there is no
  // `?.` there, so the space before its paren has nowhere to be allowed.
  /**
   * A call may be plain or OPTIONAL (`?.(`) — `CALL` covers both, with
   * whitespace allowed ONLY around the `?.` and never on its own. That is what
   * keeps `StatusBar.tsx`'s prose "fetch (#181)" from false-positiving: there
   * is no `?.` there, so the space before its paren has nowhere to be allowed.
   *
   * The first version of this repair added the optional form to `fetch` alone
   * and a re-review seat immediately found the sibling — `navigator.sendBeacon
   * ?.('/x')` is a real outbound request and counted zero. Every plain-call
   * API gets the same treatment now.
   *
   * The `new X(...)` constructors deliberately do NOT: `new WebSocket?.()` is
   * a SyntaxError in JavaScript, not a spelling anyone can ship, so there is
   * no optional form to miss. That is a verdict, not an omission.
   */
  const CALL = String.raw`(?:\s*\?\.\s*)?\(`
  /**
   * Property access, plain or optional-chained. Round 4 established that the
   * optional chain can be on the OBJECT and then applied it to `globalThis
   * .fetch` and nowhere else — so `http?.request(...)`,
   * `navigator?.sendBeacon(...)` and `globalThis?.['fetch']` were all still
   * invisible, every one of them a spelling the README's vocabulary paragraph
   * PROMISES (EXECUTED, both seats, round 6). One fragment, used everywhere a
   * dot appears, is what stops the next round finding the fourth cell.
   */
  const DOT = String.raw`\s*\??\.\s*`
  const NETWORK_PATTERNS: readonly RegExp[] = [
    new RegExp(String.raw`\bfetch${CALL}`, 'g'),
    // `.get` as well as `.request`: `https.get(url)` is a first-class Node API
    // and a re-review seat originated a real request through it while this law
    // stayed green (EXECUTED). `\bhttps?\.` covers both modules in one row.
    new RegExp(String.raw`\bhttps?${DOT}(?:request|get)${CALL}`, 'g'),
    new RegExp(String.raw`\bnavigator${DOT}sendBeacon${CALL}`, 'g'),
    /\bnew\s+EventSource\s*\(/g,
    /\bnew\s+WebSocket\s*\(/g,
    /\bnew\s+XMLHttpRequest\b/g,
    /\bimport\s*\(\s*['"`](?:node:)?https?\b/g,
  ]
  /**
   * A module that never writes `fetch(` but takes a reference to the platform
   * function and calls it through a local name. The negative lookbehind drops
   * `typeof globalThis.fetch`, which is a capability probe in a conditional or
   * a TypeScript type position, not a request; the negative lookahead drops
   * `globalThis.fetch(`, which `NETWORK_PATTERNS` has already counted as a
   * literal call and which would otherwise be counted twice.
   *
   * Three spellings, not one. The first version of this repair handled only
   * property access on `globalThis`, and the fix re-review defeated it twice
   * in the two obvious neighbouring cells — `const { fetch: send } = globalThis`
   * and `globalThis['fetch']` — which is the same "closed the reported case,
   * opened the adjacent one" shape this file's other laws keep hitting. The
   * grammar is `{globalThis, window, self} × {.fetch, ['fetch'], destructured}`
   * and all nine cells are covered below.
   *
   * The lookahead excludes an optional call (`?.(`) as well as a plain one,
   * and that is not tidiness — without it `globalThis.fetch?.(url)` counted
   * TWICE: once as a literal call by `NETWORK_PATTERNS`, whose paren pattern
   * allows `?.`, and once again here, because `fetch` is followed by `?`
   * rather than `(` so the old lookahead let it through. Worth recording how
   * it was nearly missed: the probe meant to prove the optional-call spelling
   * works asserted only that the law went RED, and a double count reddens
   * exactly like a correct count of one. Asserting the COUNT, not the colour,
   * is what caught it — the same "a command that succeeded is not a
   * measurement that answered your question" trap this file keeps meeting.
   */
  // Leading `\b`: without it `self` matched inside a longer identifier, so
  // `const f = myself.fetch` counted as an outbound call — a false positive,
  // which here inflates a number this repo publishes.
  const GLOBAL_OBJECTS = String.raw`\b(?:globalThis|window|self)`
  /**
   * Property access, with an optional `typeof` CAPTURED rather than excluded
   * by a lookbehind. `(?<!typeof\s)` is fixed-width — it excludes exactly one
   * whitespace character — so `typeof  globalThis.fetch` with two spaces, or a
   * tab, or a newline, sailed through and counted as a request (EXECUTED, fix
   * re-review). Matching the prefix and filtering on it handles any amount of
   * whitespace, which a lookbehind in this position structurally cannot.
   */
  /**
   * The two ALIAS ACCESS forms — `globalThis.fetch` and `globalThis['fetch']`
   * — both carry an optional `typeof` CAPTURE and go through one filter.
   *
   * They were separate mechanisms until round 7: the dotted form captured and
   * filtered `typeof`, the bracket form did not, so
   * `typeof globalThis['fetch'] === 'function'` — a capability PROBE, the same
   * construct six modules use before delegating to `capabilityRead` — counted
   * as an outbound request (EXECUTED). That is a FALSE POSITIVE, and here it
   * is worse than a false negative: it inflates a number this repo publishes
   * in its own security section, and the existing dotted control stayed zero
   * so nothing pointed at it.
   *
   * `(?<!typeof\s)` is not used, for the reason round 6 recorded: a lookbehind
   * is fixed-width and misses `typeof  globalThis.fetch`.
   *
   * `typeof\s+` alone (#234) required at least one whitespace character
   * between the keyword and its operand — but `typeof` is a unary operator,
   * not a call, so `typeof(globalThis.fetch)` is valid JavaScript with no
   * space at all, and `TYPEOF_PREFIX`'s `\s+` never matched it. The capture
   * then failed to fire, the unprefixed alternative matched `globalThis.fetch`
   * on its own, and a capability probe counted as a request (EXECUTED,
   * `typeof(globalThis.fetch)` counted 1) — the same false-positive shape
   * round 7 already fixed for the no-parens form, in the one spelling that
   * form didn't reach. `\(?` after the optional whitespace, and another `\s*`
   * after that, admits `typeof(x)`, `typeof (x)`, and `typeof  (  x)` alike
   * without giving up any of the whitespace-only forms above.
   */
  const TYPEOF_PREFIX = String.raw`typeof\s*\(?\s*`
  const ALIAS_ACCESS_PATTERNS: readonly RegExp[] = [
    new RegExp(String.raw`(${TYPEOF_PREFIX})?${GLOBAL_OBJECTS}${DOT}fetch(?!\s*(?:\?\.\s*)?\()`, 'g'),
    // Bracket access takes NO dot (`globalThis['fetch']`) or an optional-chained
    // one (`globalThis?.['fetch']`), so the dot is `\.?` here where `DOT`
    // requires it. Substituting `DOT` for consistency would stop matching the
    // commoner plain form.
    new RegExp(String.raw`(${TYPEOF_PREFIX})?${GLOBAL_OBJECTS}\s*\??\.?\s*\[\s*['"\`]fetch['"\`]\s*\]`, 'g'),
  ]
  const DESTRUCTURE_INNER = String.raw`(?:[^{}]|\{[^{}]*\})*`
  /**
   * The KEY half of a renamed destructure, all five spellings of it (#234, review of #272).
   *
   * This was `\bfetch` alone until the review, which pinned the bare key and missed every
   * other way of writing the same construct. That is not a vocabulary boundary, it is a
   * hole: EXECUTED, a real aliased outbound call written `const { 'fetch': send } =
   * globalThis` under a swept root left this law GREEN, while the identical call with a
   * bare key reddened it. The law backs README's exhaustiveness claim — "exactly these ten
   * modules and thirteen call sites" — so a shippable spelling it cannot see is a count
   * that can go silently wrong in a trust document.
   *
   * #23 narrowed the README's claim to a NAMED VOCABULARY, and that boundary still holds
   * and still excludes things: a `node:http2` import, a type member, a destructuring
   * parameter. But the vocabulary names CONSTRUCTS, not spellings. A quoted or computed
   * key is the same construct as the bare one — a renamed destructure of `globalThis.fetch`
   * — so excluding a spelling of an included construct is exactly what makes the count
   * wrong. The three spellings come IN.
   *
   * Quote pairs are alternated rather than written `['"]fetch['"]`, which would match the
   * mismatched `'fetch"`. Alternation, not a backreference: `\1` would bind to whatever
   * group `DESTRUCTURE_INNER` happens to open, the coupling that rots when that constant
   * changes.
   */
  const DESTRUCTURE_KEY = String.raw`(?:\bfetch|'fetch'|"fetch"|\[\s*'fetch'\s*\]|\[\s*"fetch"\s*\])`
  const ALIAS_PATTERNS: readonly RegExp[] = [
    new RegExp(
      // `\b(?:const|let|var)\s*` — a destructure begins at a DECLARATION.
      // Without it, `let options: { fetch: unknown } = globalThis` counted as
      // one outbound call (EXECUTED, round 7): valid TypeScript in which the
      // braces are a TYPE LITERAL and nothing is destructured at all. Eight
      // earlier over-match probes — object literals, `type`/`interface`
      // members, a function parameter pattern — all missed it, because they
      // put the braces somewhere a declaration keyword never precedes.
      //
      // `[^{}]`, NOT `[^{}\n]`: a destructure wrapped across lines is the same
      // spelling this row pins, and biome wraps it once it gets long enough.
      // Excluding braces alone still confines the match to one pattern.
      //
      // `(?::[^=;{}]*)?` allows a type annotation between the pattern and the
      // `=`: `const { fetch: send }: Pick<typeof globalThis, 'fetch'> = globalThis`.
      // `DESTRUCTURE_INNER` allows ONE level of nested braces, so a sibling
      // binding that is itself destructured —
      // `const { fetch: send, hdrs: { a } } = globalThis` — is still seen.
      // With a flat `[^{}]*` it counted zero, and it is the one spelling in
      // this row's neighbourhood a formatter can actually produce.
      // Measured: a pathological 4,000-key input matches in 1ms, so the
      // nested alternation carries no backtracking risk at file scale.
      String.raw`\b(?:const|let|var)\s*\{${DESTRUCTURE_INNER}${DESTRUCTURE_KEY}\s*:\s*\w+${DESTRUCTURE_INNER}\}\s*(?::[^=;{}]*)?=\s*${GLOBAL_OBJECTS}\b`,
      'g',
    ),
  ]

  function walk(dir: string, out: string[]): void {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist') continue
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full, out)
        continue
      }
      // Every module format a swept root can actually contain, not just the
      // two the app is mostly written in — `.mjs` cost this law two real call
      // sites (see the docblock). `.d.ts` carries no runtime call.
      if (!/\.(?:tsx?|mts|cts|mjs|cjs|js|jsx)$/.test(entry)) continue
      // `.d.mts`/`.d.cts` are declaration files too — a `fetch(input: string)`
      // signature in one is a type, not a call, and the fix re-review reddened
      // this law with exactly that. Scope the guard by what the file IS.
      if (/\.d\.[cm]?ts$/.test(entry) || /\.test\.[a-z]+$/.test(entry)) continue
      out.push(full)
    }
  }

  /**
   * Verbatim from `packages/web/src/interaction/no-model-call-law.test.ts:37`,
   * this repo's own sibling sweep — including the `[^:]` guard that stops
   * `'https://x'` being read as a line comment and taking the rest of the line
   * with it, which a naive stripper does. Copied rather than imported because
   * that file is in another package and exports it for its own use only.
   *
   * Without this, a doc comment in any swept module that writes `fetch(`
   * adjacently counts as a real call site — so the first module to DOCUMENT
   * this law would break it.
   */
  function withoutComments(text: string): string {
    return text
      .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:])\/\/.*$/gm, (_whole, lead: string) => lead)
  }

  function countMatches(source: string): number {
    const text = withoutComments(source)
    let total = 0
    for (const pattern of NETWORK_PATTERNS) total += text.match(pattern)?.length ?? 0
    for (const pattern of ALIAS_ACCESS_PATTERNS) {
      total += [...text.matchAll(pattern)].filter((match) => match[1] === undefined).length
    }
    for (const pattern of ALIAS_PATTERNS) total += text.match(pattern)?.length ?? 0
    return total
  }

  function allSourceFiles(): string[] {
    const out: string[] = []
    for (const root of SOURCE_ROOTS) walk(root, out)
    return out
  }

  function realCallSites(): { file: string; count: number }[] {
    return allSourceFiles()
      .map((file) => ({ file: path.relative(REPO_ROOT, file), count: countMatches(readFileSync(file, 'utf8')) }))
      .filter((entry) => entry.count > 0)
      .sort((a, b) => a.file.localeCompare(b.file))
  }

  const EXPECTED_CALL_SITES: ReadonlyArray<{ file: string; count: number }> = [
    { file: path.join('packages', 'app', 'src', 'host', 'fleet-feed.ts'), count: 2 },
    { file: path.join('packages', 'web', 'src', 'app', 'StreamContext.tsx'), count: 1 },
    { file: path.join('packages', 'web', 'src', 'concierge', 'clone.ts'), count: 1 },
    { file: path.join('packages', 'web', 'src', 'concierge', 'instrument.ts'), count: 1 },
    { file: path.join('packages', 'web', 'src', 'hooks', 'useEventStream.ts'), count: 1 },
    { file: path.join('packages', 'web', 'src', 'lab', 'launch', 'launch.ts'), count: 1 },
    { file: path.join('packages', 'web', 'src', 'recordings', 'capabilityRead.ts'), count: 2 },
    { file: path.join('packages', 'web', 'src', 'recordings', 'label.ts'), count: 1 },
    { file: path.join('packages', 'web', 'src', 'replay', 'rotate.ts'), count: 1 },
    { file: path.join('packages', 'web', 'src', 'scene', 'parity', 'capture.mjs'), count: 2 },
  ]
  const EXPECTED_TOTAL = 13

  it('the sweep walks real source trees, not an empty directory — an empty sweep proves nothing', () => {
    expect(allSourceFiles().length).toBeGreaterThan(100)
  })

  it('are exactly these ten modules and thirteen call sites — no more, no fewer', () => {
    const found = realCallSites()
    expect(found).toEqual(EXPECTED_CALL_SITES)
    expect(found.reduce((sum, entry) => sum + entry.count, 0)).toBe(EXPECTED_TOTAL)
  })

  it('bites: an aliased call in a swept module is counted, not just a literal fetch(', () => {
    // The hole this law shipped with. `const impl = globalThis.fetch` followed
    // by `impl(url)` originates a request and matches no literal-call pattern,
    // so the sweep read zero in nine real modules while certifying an exact
    // total. Proven on a fixture rather than by editing a real module, so the
    // assertion cannot be satisfied by whatever the tree happens to contain.
    const aliased = 'const impl = fetchImpl ?? (globalThis.fetch as unknown as F)\nawait impl(URL, { method: "POST" })'
    expect(countMatches(aliased)).toBe(1)
    // ...and the capability probe beside it is NOT a call site.
    expect(countMatches("typeof globalThis.fetch === 'function' ? capabilityRead : null")).toBe(0)
    // ...and a literal call is still counted exactly once, not twice.
    expect(countMatches('return globalThis.fetch(input, init)')).toBe(1)
  })

  it.each([
    ['plain call on the global', 'return globalThis.fetch(u)', 1],
    ['optional call on the global', 'return globalThis.fetch?.(u)', 1],
    ['optional call on window', 'return window.fetch?.(u)', 1],
    ['optional call, spaced', 'return self.fetch ?. (u)', 1],
    ['bare optional call', 'return fetch?.(u)', 1],
    ['bare plain call', 'return fetch(u)', 1],
    ['alias, no call on this line', 'const impl = fetchImpl ?? globalThis.fetch', 1],
    ['destructured alias', 'const { fetch: send } = globalThis', 1],
    ['bracket access', 'return globalThis["fetch"](u)', 1],
    ['capability probe, not a request', "typeof globalThis.fetch === 'function' ? capabilityRead : null", 0],
    ['prose naming the verb before a paren', '// the drawer used to fetch (#181) on every render', 0],
    // Rows below were all added by the fix re-review that found them wrong.
    ['destructured WITHOUT rename, then called literally', 'const { fetch } = globalThis; fetch(u)', 1],
    ['destructured without rename and never called', 'const { fetch } = globalThis', 0],
    ['capability probe with TWO spaces after typeof', "typeof  globalThis.fetch === 'function'", 0],
    ['capability probe with a tab after typeof', 'typeof\tglobalThis.fetch === undefined', 0],
    ['typeof in a TYPE position, generously spaced', 'let f: typeof   globalThis.fetch', 0],
    ['optional sendBeacon', "navigator.sendBeacon?.('/x', payload)", 1],
    ['plain sendBeacon', "navigator.sendBeacon('/x', payload)", 1],
    ['optional http.request', 'http.request?.(options)', 1],
    ['plain https.request', 'https.request(options)', 1],
    ['constructor forms have no optional spelling', "new WebSocket('wss://x')", 1],
    // Round 5, all found uncounted by a re-review seat.
    ['https.get', "https.get('https://x')", 1],
    ['http.get', 'http.get(u)', 1],
    ['optional https.get', 'https.get?.(u)', 1],
    ['optional chain on the OBJECT', 'const impl = globalThis?.fetch', 1],
    ['optional chain on object and call', 'globalThis?.fetch?.(u)', 1],
    ['a doc comment naming a call is not a call', '/** calls globalThis.fetch(input) internally */', 0],
    ['a line comment naming a call is not a call', '// wraps fetch(input, init)', 0],
    ['a url in a string is not a comment', "const u = 'https://x'; return fetch(u)", 1],
    // Round 6. The README says every named spelling has a pinned count here,
    // and it did not: XHR, EventSource and the dynamic import had no row, so
    // replacing the XHR matcher left all 55 tests green. The claim is only
    // true if this table actually covers the vocabulary.
    ['new EventSource', 'return new EventSource(u)', 1],
    ['new XMLHttpRequest', 'const x = new XMLHttpRequest()', 1],
    ['dynamic import of https', "await import('node:https')", 1],
    ['dynamic import of http', "await import('http')", 1],
    // Round 6's four findings, each a spelling the prose already promised.
    ['optional chain on the http module', "http?.request('/x')", 1],
    ['optional chain on the https module', "https?.get('/x')", 1],
    ['optional chain on navigator', "navigator?.sendBeacon('/x', p)", 1],
    ['renamed destructure wrapped across lines', 'const {\n  fetch: send,\n} = globalThis', 1],
    ['renamed destructure with a type annotation', "const { fetch: send }: Pick<typeof globalThis, 'fetch'> = globalThis", 1],
    ['renamed destructure alongside another binding', 'const { fetch: doGet, Headers } = window', 1],
    ['optional chain plus bracket access', "const impl = globalThis?.['fetch']", 1],
    // ...and the case that must stay OUT: an ordinary object literal with a
    // `fetch` key is not a destructure of the global.
    ['an object literal with a fetch key', 'const opts = { fetch: myImpl }', 0],
    // Round 7. Both are FALSE POSITIVES that were counted as requests — worse
    // than a miss here, because they inflate a published number.
    ['a bracket-form capability probe', "typeof globalThis['fetch'] === 'function'", 0],
    ['a bracket-form probe, generously spaced', 'typeof  globalThis["fetch"] === "function"', 0],
    ['a TYPE LITERAL assigned from the global is not a destructure', 'let options: { fetch: unknown } = globalThis', 0],
    ['a type literal with more members', 'let o: { fetch: unknown; x: 1 } = globalThis', 0],
    ['a let-declared renamed destructure still counts', 'let { fetch: send } = globalThis', 1],
    ['a type member named fetch', 'type T = { fetch: typeof fetch }', 0],
    ['a destructuring function parameter', 'function f({ fetch: impl }: Deps) { return impl }', 0],
    // #234. Three spellings outside the README's exhaustiveness claim (#23
    // narrowed that claim to a named vocabulary precisely so a candidate could
    // be decided rather than chased forever) — decided here, not merely noted.
    //
    // 1. A quoted or computed destructure key is IN — all three spellings
    //    (#234, decided on review of #272; the open question that review left
    //    is closed here rather than carried).
    //
    //    The row asserted 0 twice, on two different reasons. The FIRST said
    //    biome's `useLiteralKeys` made the spelling unshippable; that was
    //    false — `biome.json` sets `"preset": "none"` and enables only
    //    `correctness` and `suspicious`, while `useLiteralKeys` lives in
    //    `complexity`, enabled nowhere. The SECOND, honest, said the spelling
    //    sits outside the vocabulary #23 named, and recorded underneath that
    //    this pinned a real blind spot.
    //
    //    It did, and that is why it is now IN. EXECUTED on review: a real
    //    aliased outbound call written `const { 'fetch': send } = globalThis`
    //    under a swept root left this law GREEN, while the identical call with
    //    a bare key reddened it. #23's vocabulary names CONSTRUCTS, not
    //    spellings — a quoted or computed key is the same renamed destructure
    //    of `globalThis.fetch` — so excluding one spelling of an included
    //    construct is what makes README's "ten modules and thirteen call
    //    sites" able to go quietly wrong. See `DESTRUCTURE_KEY` above.
    //
    //    Revert `DESTRUCTURE_KEY` to `\bfetch` and all three rows below go
    //    from 1 to 0 — the mutation this decision rests on.
    ['a single-quoted destructure key is the same call site (#234)', "const { 'fetch': send } = globalThis", 1],
    ['a double-quoted destructure key is the same call site (#234)', 'const { "fetch": send } = globalThis', 1],
    ['a computed destructure key is the same call site (#234)', "const { ['fetch']: send } = globalThis", 1],
    // 2. A dynamic import of a module the vocabulary never named. `http2` has
    //    no request/get/sendBeacon surface this law recognises and README's
    //    paragraph promises `http`/`https` only — recorded OUT, not a miss.
    [
      'import of a module outside the vocabulary is genuinely outside it, not a gap (#234)',
      "await import('node:http2')",
      0,
    ],
    // 3. `typeof(x)` — the false positive the TYPEOF_PREFIX comment above
    //    describes. Decided IN: it is the same capability-probe shape every
    //    other `typeof` row here already excludes, just spelled with parens
    //    instead of a space. Revert `TYPEOF_PREFIX` to `typeof\s+` alone and
    //    this row goes from 0 to 1 — the mutation this issue asks for.
    ['typeof with parens and no space is still a capability probe, not a call (#234)', 'typeof(globalThis.fetch)', 0],
  ])(
    'counts %s exactly %i time(s) — the COUNT, not merely red-or-green',
    (_label, source, expected) => {
      // Every row is a scalar equality on purpose. The optional-call spelling
      // was added on the strength of a probe that only checked the law turned
      // RED, and `globalThis.fetch?.(u)` was being counted twice — which
      // reddens identically to being counted once. A double count is not a
      // safe error here: it inflates a number this repo publishes in its own
      // security section.
      expect(countMatches(source)).toBe(expected)
    },
  )

  it('bites: a module format other than .ts/.tsx is swept, not skipped', () => {
    // `capture.mjs` sat under a swept root with two real calls and no test
    // could see it. The walk now accepts every module format; this asserts the
    // one that actually cost us is in the swept set, by name.
    const swept = allSourceFiles().map((file) => path.relative(REPO_ROOT, file))
    expect(swept).toContain(path.join('packages', 'web', 'src', 'scene', 'parity', 'capture.mjs'))
  })

  it("README's vocabulary paragraph names every spelling this law matches, and no others", () => {
    // The last hand-kept correspondence in this paragraph, now derived.
    // README claims the law matches a NAMED vocabulary; that claim is only
    // worth anything if the names and the patterns cannot drift apart. Found
    // by probe while writing that paragraph: the law matched
    // `navigator.sendBeacon` and the prose did not name it — an UNDER-claim,
    // harmless to a reader but the same doc-vs-source drift #23 is about, and
    // the third time in this file that a correspondence kept by hand rotted.
    const README_MD = readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8')
    const start = README_MD.indexOf('What "named vocabulary" means')
    const end = README_MD.indexOf('It is a **regression net')
    expect(start, 'README no longer carries the vocabulary paragraph this law checks').toBeGreaterThan(-1)
    expect(end, 'README no longer carries the bounded-claim paragraph after the vocabulary').toBeGreaterThan(start)
    const paragraph = README_MD.slice(start, end)
    // Each token is the thing a reader would grep for, and each is what the
    // corresponding pattern actually keys on.
    const VOCABULARY = [
      'fetch',
      'http.request',
      'https.request',
      'http.get',
      'https.get',
      'navigator.sendBeacon',
      'new EventSource',
      'new WebSocket',
      'new XMLHttpRequest',
      // `import(` rather than `import()`: the README writes the bare form
      // `import()` and the pinned rows write `import('node:https')`. The
      // common prefix is what both actually contain.
      'import(',
      'globalThis',
      'window',
      'self',
      "['fetch']",
      'destructure',
    ]
    const unnamed = VOCABULARY.filter((token) => !paragraph.includes(token))
    expect(unnamed, "README's vocabulary paragraph must name every spelling the law matches").toEqual([])
    // ...and the OVER-CLAIM direction, which is the one that matters and which
    // this law did not check when it was written: a spelling added to the prose
    // with no pattern behind it. Found by probe — inserting `new WeirdThing`
    // into the paragraph left this law green, because `VOCABULARY` is declared
    // here and the prose was only ever read for containment. So the paragraph's
    // own backticked list is extracted and pinned as a SET: prose and code now
    // constrain each other in both directions.
    // The sentence boundary is asserted, not assumed. `indexOf` returning -1
    // would make `slice(0, -1)` silently drop one character and read the WHOLE
    // paragraph instead of the list sentence — a wrong answer that still looks
    // like an answer, which is the failure mode this file exists to punish.
    const sentenceEnd = paragraph.indexOf('That list,')
    expect(sentenceEnd, "README's vocabulary sentence no longer ends where this law reads it").toBeGreaterThan(-1)
    // Compared as a SORTED set: the claim is "names every spelling and no
    // others", which is set equality. Order-sensitivity would redden on a
    // harmless prose reflow — a law that cries wolf gets suppressed, and a
    // suppressed law guarantees nothing.
    const listedSpellings = [...paragraph.slice(0, sentenceEnd).matchAll(/`([^`]+)`/g)]
      .map((match) => match[1]!)
      .sort()
    expect(
      listedSpellings,
      'the README vocabulary sentence lists a spelling this law does not implement, or has stopped listing one it does',
    ).toEqual([
      '.fetch',
      '?.fetch',
      "['fetch']",
      'fetch',
      'globalThis',
      'http',
      'http.get',
      'http.request',
      'https',
      'https.get',
      'https.request',
      'import()',
      'navigator.sendBeacon',
      'new EventSource',
      'new WebSocket',
      'new XMLHttpRequest',
      'self',
      'window',
    ])
    // The other direction, which round 6 found false: README says every named
    // spelling has "a pinned expected count" in the table below. Three did
    // not — XHR, EventSource and the dynamic import — so replacing the XHR
    // matcher left the suite green. Assert the table actually mentions each
    // token, so the paragraph's promise about the table is checked BY the
    // table.
    const tableSource = readFileSync(fileURLToPath(import.meta.url), 'utf8')
    const tableStart = tableSource.indexOf('the COUNT, not merely red-or-green')
    expect(tableStart, 'the pinned-count table this law refers to has been renamed').toBeGreaterThan(-1)
    // Scoped to the ROWS. This slice started at byte 0, so it swept in ~600
    // lines of docblock — and every vocabulary token is also named in that
    // prose, so the containment check passed whether a row existed or not.
    // Round 6's finding was therefore still live on the head that was supposed
    // to close it: neuter a matcher (replace, don't remove, so the length pin
    // does not fire) AND delete its row, and the suite went green. Measured:
    // 13 of the 15 tokens were shielded by prose. An assertion whose message
    // states something it cannot check is the second-worst defect shape this
    // repo records.
    const rowsStart = tableSource.indexOf('  it.each([')
    expect(rowsStart, 'the it.each table has moved — this check would read prose instead of rows').toBeGreaterThan(-1)
    expect(rowsStart, 'the it.each table must precede the assertion that names it').toBeLessThan(tableStart)
    const tableRows = tableSource.slice(rowsStart, tableStart)
    const unpinned = VOCABULARY.filter((token) => !tableRows.includes(token))
    expect(unpinned, 'every spelling named in the README must have a pinned count row in this file').toEqual([])
    // And the pattern counts are pinned, so a pattern added without a name in
    // the paragraph above — or a name added with no pattern behind it — is a
    // red build rather than a slow drift.
    //
    // Seven, not eight: `http`/`https` x `request`/`get` is ONE pattern
    // (`\bhttps?\.(?:request|get)`), covering four of the vocabulary's
    // tokens. Worth recording that this pin was first written as `8` by
    // counting the token list instead of the array, and failed immediately —
    // which is the pin doing precisely its job, on its author, within a
    // minute of being written.
    expect(NETWORK_PATTERNS.length, 'a network pattern was added or removed — name it in the README paragraph above').toBe(7)
    expect(
      ALIAS_ACCESS_PATTERNS.length + ALIAS_PATTERNS.length,
      'an alias pattern was added or removed — name it in the README paragraph above',
    ).toBe(3)
  })

  it('README\'s enumerated path list IS the sweep\'s result — the paths are derived, not retyped beside it', () => {
    // The numbers were pinned to the sweep; the ten PATHS under them, and the
    // `(two)` markers, were still a second hand-typed list nothing compared.
    // EXECUTED in the fix re-review: pointing one README path at a file that
    // does not exist, dropping a path while keeping "ten", and moving a
    // `(two)` marker to the wrong module all left the suite green — including
    // `doc-citation-law.test.ts`, whose corpus is `docs/*.md` plus `.ts`
    // comments and so never reads root `README.md`. Deriving the list is
    // strictly better than checking it: there is now one list, not two.
    const README_MD = readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8')
    // Whitespace-tolerant: this README hard-wraps near 80 columns, so the
    // marker sentence straddles a newline and a literal `indexOf` finds
    // nothing. Anchored on the module count so it cannot drift silently.
    //
    // EXACTLY ONE marker, asserted — not `.exec()`'s first match. This law was
    // added to close a first-match-only hole and opened the same hole in
    // itself: a re-review seat put a correct enumeration EARLIER in the file,
    // broke a path in the real list, and all 37 tests passed, because `.exec`
    // validated the decoy and never read as far as the list a reader uses.
    // Two markers is now a loud failure rather than a silent choice between
    // them.
    const markers = [...README_MD.matchAll(/call\s+sites\s+in\s+\*\*ten\*\*\s+modules:/g)]
    expect(
      markers.length,
      'README must introduce the fetch-recipe list exactly once — two occurrences means this law is validating whichever came first',
    ).toBe(1)
    const marker = markers[0]!
    const listStart = marker.index + marker[0].length
    const paragraphEnd = README_MD.indexOf('\n\n', listStart)
    const listText = README_MD.slice(listStart, paragraphEnd === -1 ? undefined : paragraphEnd)
    const stated = [...listText.matchAll(/`(packages\/[^`]+)`(\s*\((\w+)\))?/g)].map((match) => ({
      file: match[1]!.split('/').join(path.sep),
      count: match[3] === undefined ? 1 : wordToNumber(match[3]),
    }))
    expect(stated).toEqual([...EXPECTED_CALL_SITES].sort((a, b) => a.file.localeCompare(b.file)))
    expect(stated.reduce((sum, entry) => sum + entry.count, 0)).toBe(EXPECTED_TOTAL)
  })

  it('README states the same thirteen-across-ten the sweep above finds — every occurrence, not just the first', () => {
    const README_MD = readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8')
    // Two anchors over the same sentence rather than one two-group match, so
    // each number goes through the same every-occurrence rule the mutating-
    // route counts use. A restated claim further down the file is checked too;
    // the previous shape read only the first match and a wrong second one
    // stayed green (verify round, #23).
    expectAllAgree(
      captureAll(README_MD, /\*\*(\w+)\*\* call sites in \*\*\w+\*\* modules/g, "README fetch-recipe call sites"),
      EXPECTED_TOTAL,
      'README fetch-recipe call sites',
    )
    expectAllAgree(
      captureAll(README_MD, /\*\*\w+\*\* call sites in \*\*(\w+)\*\* modules/g, 'README fetch-recipe modules'),
      EXPECTED_CALL_SITES.length,
      'README fetch-recipe modules',
    )
    // The BACK-REFERENCES, which is round 2's own axis and was missed here.
    // Both anchors above require the bolded marker wording, so two plain-prose
    // restatements of the same two numbers were reachable by nothing:
    // "the <N> paths below them", inside the very sentence that claims
    // "nothing here is a number typed twice", and "Every one of the <N>
    // targets" in the paragraph that carries the loopback security argument.
    // EXECUTED before this: changing either to a wrong word left the whole
    // server package green, `doc-citation-law.test.ts` included.
    //
    // This is NOT the exemption round 2 carved out for README's "three hands
    // above" and SECURITY.md's "those two classes" — those answer a DIFFERENT
    // question from the total beside them. These answer the identical one.
    expectAllAgree(
      captureAll(README_MD, /the (\w+) paths below them/g, 'README path-count back-reference'),
      EXPECTED_CALL_SITES.length,
      'README path-count back-reference',
    )
    expectAllAgree(
      captureAll(README_MD, /Every one of the (\w+) targets/g, 'README loopback back-reference'),
      EXPECTED_TOTAL,
      'README loopback back-reference',
    )
  })
})
