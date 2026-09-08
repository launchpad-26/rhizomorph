import { describe, expect, it } from 'vitest'
import { EVENT_TYPES } from '../events/index.js'
import { ERA_CORPUS } from './corpus.js'
import { ERAS, canonicalStateJson, foldEraRecording } from './fold.js'

/**
 * THE GOLDEN ERA CORPUS LAW — prd17 ruling 3, item 2.
 *
 * Every era recording is folded by whatever the reducer has become, and the
 * result must equal the committed snapshot BYTE FOR BYTE. A reducer change that
 * alters the meaning of a past era's log fails the build here, before it can
 * quietly rewrite history that has already been exported, merged and read.
 *
 * **Re-blessing is a deliberate act, never automatic — and it cannot happen
 * from inside this suite at all.** Three things enforce that:
 *
 * 1. Nothing here can write. Core has no `node:*` in scope (see `fold.ts`), so
 *    the recordings and snapshots arrive as `?raw` text through `corpus.ts` and
 *    there is no file handle in this file to misuse. The blessing procedure in
 *    `CAPTURE.md` is a command a human runs from the repo root, outside vitest.
 * 2. The comparison is plain string equality, deliberately NOT
 *    `expect(...).toMatchFileSnapshot(...)` — `vitest -u` rewrites those, and
 *    `-u` is something people run to fix an unrelated snapshot. The permanent
 *    record must not be collateral damage of that habit.
 * 3. A commit that moves a snapshot has to say why (`CAPTURE.md`).
 */
describe('the golden era corpus', () => {
  it('holds at least one era — every sweep below would pass vacuously otherwise', () => {
    expect(ERA_CORPUS.length).toBeGreaterThan(0)
  })

  it('numbers its eras 1..N with no gaps and no repeats', () => {
    expect(ERAS.map((era) => era.era)).toEqual(ERAS.map((_, at) => at + 1))
  })

  it('binds every registered era\'s bytes — a registry entry nothing reads guards nothing', () => {
    expect(ERA_CORPUS.map((era) => era.name)).toEqual(ERAS.map((era) => era.name))
    for (const era of ERA_CORPUS) {
      expect(era.recordingText.length).toBeGreaterThan(0)
      expect(era.snapshotText.length).toBeGreaterThan(0)
    }
  })

  for (const era of ERA_CORPUS) {
    describe(era.name, () => {
      it('folds byte-identically to its committed snapshot', () => {
        expect(canonicalStateJson(foldEraRecording(era.recordingText).state)).toBe(era.snapshotText)
      })

      it('folds to the same bytes twice — the fold of a past era is deterministic', () => {
        expect(canonicalStateJson(foldEraRecording(era.recordingText).state)).toBe(
          canonicalStateJson(foldEraRecording(era.recordingText).state),
        )
      })

      it('is understood in full — nothing in a past era of our own log reads as unknown', () => {
        // If this ever fails, an event family was removed from the union and a
        // recording the instrument itself wrote can no longer be folded. The
        // lenient boundary means that is now VISIBLE rather than a silently
        // shorter history (prd17 ruling 3, item 1), which is the only reason
        // this assertion can exist at all.
        const fold = foldEraRecording(era.recordingText)
        expect(fold.unknown).toEqual([])
        expect(fold.events.length).toBeGreaterThan(0)
      })

      it('is a recording, not a stub — its fold moved real state', () => {
        const { state, events } = foldEraRecording(era.recordingText)
        expect(state.eventCount).toBe(events.length)
        expect(state.firstEventTs).not.toBeNull()
        expect(state.lastEventTs).not.toBeNull()
      })
    })
  }

  it('names exactly which event families the corpus does and does not reach', () => {
    const covered = new Set<string>()
    for (const era of ERA_CORPUS) {
      for (const event of foldEraRecording(era.recordingText).events) covered.add(event.type)
    }

    // A real slice contains what actually happened in it, so the corpus's
    // coverage is a fact to state rather than a target to hit. Stated as the
    // exact GAP, not a floor: adding an era, or losing an arm from an existing
    // one, changes this list and has to be acknowledged here — which is the
    // point.
    //
    // era-2 (#279) closes nine of the families era-1 left open. Four of them
    // now fold real state for the first time in this corpus — `session.started`
    // (era-1 deliberately starts mid-session and holds none),
    // `collector.degraded`/`collector.disabled` (both fired for real, a tmux
    // socket going missing on startup), and `judge.finding`. The other five —
    // `operator.ack`/`.verdict`/`.note` (the wave-2 route, driven for real) and
    // `summons.raised`/`.cleared` (a lane frozen and then recovered) — are
    // genuinely present and understood, but prd17 ruling 1 (#219) made every
    // one of them additive-only in the reducer: `reduce.ts` returns `state`
    // unchanged for all eight of that ruling's families, so their presence
    // here proves the union accepts them and nothing yet reads them out of a
    // recording, not that folding one moves anything.
    //
    // What still isn't here, and why, era-2 included: `collector.error` DID
    // fire in the source log era-2 was sliced from, once — but ~200 lines past
    // the window's own close (`summons.cleared`), and reaching it would have
    // cost another ~80KB of committed bytes for one single-fire family already
    // adjacent to the two `collector.*` arms the window already covers. Left
    // out on purpose (see CAPTURE.md), not missed. `collector.recovered` needs
    // a collector to recover after degrading, which neither era's window ever
    // saw happen. `gate.verdict`/`dispatch.brief`/`fence.declared` are still
    // unemitted anywhere — no surface writes them yet. `session.closed` needs
    // a clean server shutdown, which no capture has caught mid-session.
    // `telemetry.refused` needs a misconfigured lane. `fork.*` need THE LAB to
    // have been driven — not the judge, which era-2 did run: it holds seven
    // `judge.finding` events, and `fork.checkpoint`/`.dispatched` come only from
    // `server/src/lab/{fork,checkpoint,restore}.ts`, which no collector reaches.
    // (Corrected in review of #279. The clause was inherited from the pre-diff
    // comment, where `judge.finding` was still on this list and pairing the two
    // was correct; moving it out left the clause behind.)
    //
    // `agent.removed` (#306) is newer than ERA-1's capture — not both, which the
    // rewrite claimed without re-deriving: it entered the union 2026-08-12 in
    // `6bead13`, 26 days BEFORE era-2 was captured. Its real reason in era-2
    // is stronger and checkable: era-2's window carries ZERO `workmux` and ZERO
    // `tmux` events, because both collectors were disabled for its whole span —
    // which is what those 90 `collector.disabled` events are. So the one
    // collector that emits `agent.removed` never emitted anything at all. The
    // same correction applies to any family whose only emitter is those two.
    //
    // `beacon.received` is the absence that most needs a reason, and it is the
    // one this comment omitted until review of #279 asked for it. Unlike the
    // families above it EXISTED and COULD have fired: it landed 2026-09-04
    // (`d1ffc05`, #217), it has a live emitter in
    // `server/src/collectors/beacon/collector.ts`, and era-2's own base commit
    // is the merge of #310. It did not fire because no rhizomorph-owned beacon
    // directory existed in the watched tree during the window — the gate that
    // writes one had merged minutes earlier and no landing had run since. `worktree.dirtyStatusFailed`/`.dirtyStatusRecovered` (#429)
    // need a worktree's `git status --porcelain` to cross the failure bound and
    // recover mid-recording, which neither capture's window hit either.
    expect(EVENT_TYPES.filter((type) => !covered.has(type)).sort()).toEqual([
      'agent.removed',
      'beacon.received',
      'collector.error',
      'collector.recovered',
      'dispatch.brief',
      'fence.declared',
      'fork.checkpoint',
      'fork.dispatched',
      'gate.verdict',
      'session.closed',
      'telemetry.refused',
      'worktree.dirtyStatusFailed',
      'worktree.dirtyStatusRecovered',
    ])
  })
})

/**
 * FIXTURE HYGIENE, era corpus edition — the same law
 * `collectors/otel/fixture-hygiene-law.test.ts` states for OTel captures, and
 * the same one `collectors/sessionlog/fixtures/CAPTURE.md` names: a real capture
 * checked into a repo that is going public must carry no identity and no host.
 *
 * Grep-law style, over the raw source text rather than the parsed shape, so it
 * also catches a leak in a field no reducer reads and no schema mentions — and
 * over the SNAPSHOT too, since a fold copies payload strings into state.
 *
 * **And over the DECODED text as well as the raw bytes** (review of #279). Raw
 * bytes alone are not the whole surface: a path written with standard JSON
 * `\u` escapes is still a leak, still valid JSON, and `JSON.parse` hands the
 * original back. EXECUTED — `/home/someone/worktrees-challenge` escaped into a
 * `summons.raised` payload's `lane` passed all 25 tests here; the same path as
 * a raw literal reddened 2. Both halves of this law missed it at once, and the
 * second half is the interesting one: prd17 ruling 1's families are
 * additive-only in `reduce.ts` (they return `state` unchanged), so a payload
 * leak never reaches the fold and the snapshot's byte-equality assertion cannot
 * see it either. Decoding closes every JSON-representable spelling in one edit
 * rather than one per round.
 */
describe('era corpus fixture hygiene', () => {
  /**
   * Every string the text can yield: the raw source, and every string leaf of
   * every parsed line. `decoded` is derived, never a second hand-maintained
   * copy — a leak is a leak in whichever form it is committed.
   */
  function surfaces(text: string): readonly string[] {
    const out: string[] = [text]

    /**
     * WHOLE DOCUMENT FIRST, then line by line (fix re-review of #279, round 2).
     * The two texts this runs over have different shapes: a recording is JSONL,
     * one event per line, but a SNAPSHOT is pretty-printed JSON. An earlier
     * version split on newlines and parsed each line, which decoded **81 of the
     * snapshot's 5,979 lines** — the rest are fragments like `"agents": {` and
     * threw, so 98.6% of the snapshot was only ever swept as raw text while
     * CAPTURE.md claimed otherwise. EXECUTED: an escaped `/home/…` added as a
     * snapshot property stayed green; the same value raw reddened.
     *
     * A recording does not parse as one document, so it falls through — the
     * order is what makes one function correct for both shapes.
     */
    try {
      walkInto(JSON.parse(text), out)
      return out
    } catch {
      // not a single JSON document — it is JSONL, handled below
    }

    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        continue // a malformed line is the JSONL law's finding, not this one's
      }
      walkInto(parsed, out)
    }
    return out
  }

  /**
   * ONE walker, shared by both paths above. Hoisted rather than duplicated: a
   * second copy is how the whole-document path and the per-line path drift into
   * covering different things, which is the defect this file exists to catch.
   */
  function walkInto(node: unknown, out: string[]): void {
    if (typeof node === 'string') out.push(node)
    else if (Array.isArray(node)) for (const child of node) walkInto(child, out)
    else if (node !== null && typeof node === 'object')
          // KEYS as well as values (fix re-review of #279, both seats,
          // independently). `Object.values` alone let an escaped path ride in
          // as a key: `"\u002fhome\u002fx": "benign"` passed all 25 tests,
          // while the identical string as that key's VALUE reddened. Not
          // reachable today — no payload schema uses `z.record`, so no emitter
          // writes a data-derived key — but the claim this function makes is
          // about JSON-representable spellings, and a key is one.
      for (const [key, child] of Object.entries(node)) {
        out.push(key)
        walkInto(child, out)
      }
  }

  const BANNED: readonly (readonly [string, RegExp])[] = [
    ['a host home directory', /\/(home|Users)\//i],
    ['a NUL byte', /\0/],
    ['the source repo\'s real basename', /worktrees-challenge/i],
    /**
     * BOTH ROWS, and the reason is the whole finding of this repair's own
     * re-review. An earlier version of this commit REPLACED the name row with
     * the shape row below, calling `lachlan` "one contributor's literal name …
     * a string that was never going to be present". That was measured on
     * era-2 — a different operator's machine, and the one era for which the
     * row was already inert. It is the OS username of the machine that
     * produced **era-1's** recording: `fa5377d`, which added this row together
     * with era-1, is authored by Lachlan Kelliher and dated 2026-08-06, era-1's
     * own capture date. Deleting it was a NET NARROWING dressed as a widening —
     * A/B proven, ` reviewed by lachlan` in an additive-only payload: 25 passed
     * with the row gone, 1 failed with it present.
     *
     * `CAPTURE.md` says lane and branch names are byte-identical from the
     * capture, so a bare username can still reach era-1's bytes as
     * `lachlan/fix-x`, a tmux session name or an author line. The two rows
     * close different classes, which is the same argument this commit makes for
     * decoding beside raw bytes.
     */
    ['the era-1 capture host\'s username', /lachlan/i],
    /**
     * A SHAPE as well as the name. A dash-slugged home is what a leaked path
     * looks like once a tool has encoded it for a filename, and AGENTS.md
     * states that a path and its encoding are ONE fact written twice.
     *
     * The lookbehind is not decoration: without it this fired on ordinary
     * hyphenated English — `real-home-directory`, `feature/new-home-page`,
     * `user-Users-guide`. The first is the exact compound
     * `no-personal-paths-law.test.ts` has a dedicated test forbidding its own
     * slug detector to match, and it avoids it with this same lookbehind
     * (`HOME_SLUG_PATTERNS`). A capture is real unedited bytes, so a false
     * positive here is not a quick edit — it is a re-capture or a re-blessing,
     * and `fold.ts` names that cost: a corpus that cries wolf gets re-blessed
     * reflexively, which is how a golden snapshot stops guarding anything.
     *
     * `no-personal-paths-law.test.ts` is the repo-wide guard and it does NOT
     * subsume this one: it excludes `OWN_PATH` and five binary extensions, and
     * it has no bare-name detector at all — its home, slug and machine patterns
     * each require path, slug or hostname context. EXECUTED: a bare username
     * staged into era-2's recording leaves it at 40 passed, while
     * `/home/someone/x` reddens it. An earlier draft of this comment
     * claimed that law swept "every tracked file with no exclusions" and made
     * this row redundant; both halves were false.
     */
    ['a dash-slugged host home', /(?<![A-Za-z0-9])[-/](home|Users)-/i],
  ]

  for (const era of ERA_CORPUS) {
    describe(era.name, () => {
      for (const [what, pattern] of BANNED) {
        it(`carries no ${what}, raw or JSON-decoded`, () => {
          for (const text of [era.recordingText, era.snapshotText]) {
            for (const surface of surfaces(text)) expect(surface).not.toMatch(pattern)
          }
        })
      }

      it('carries no email address outside example.com', () => {
        for (const text of [era.recordingText, era.snapshotText]) {
          const emails = text.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g) ?? []
          expect(emails.filter((email) => !email.endsWith('@example.com'))).toEqual([])
        }
      })

      it('is newline-terminated JSONL with no blank lines — one event per line', () => {
        expect(era.recordingText.endsWith('\n')).toBe(true)
        expect(
          era.recordingText.slice(0, -1).split('\n').filter((line) => line.trim().length === 0),
        ).toEqual([])
      })
    })
  }

  it('the detector bites — a rigged line would fail the sweep above', () => {
    const rigged = '{"payload":{"path":"/home/someone/repo"}}'
    expect(BANNED.some(([, pattern]) => pattern.test(rigged))).toBe(true)
  })

  /**
   * The sibling of the test above, and it was missing until the fix re-review
   * of #279 pointed out that nothing in the suite witnessed the decode half at
   * all: replacing `surfaces()`'s body with `return [text]` on a clean corpus
   * left 25 passing. The proof that decoding is load-bearing lived only in a
   * commit message, which is exactly the "a test that cannot fail for the
   * reason it claims" shape this file exists to catch.
   */
  it('surfaces() bites — escaped value, escaped KEY, NESTED, inside an ARRAY, and a pretty-printed document', () => {
    const line = '{"payload":{"\\u002fhome\\u002fx":"benign","note":"\\u002fhome\\u002fsomeone"}}'
    const found = surfaces(line)

    expect(found, 'the escaped VALUE must decode, or the raw-bytes sweep is all there is').toContain('/home/someone')
    expect(found, 'the escaped KEY must decode too — Object.values alone let this ride in').toContain('/home/x')

    /**
     * NESTED, because the round-2 re-review found this witness asserted an
     * INSTANCE rather than the property: at one level deep, a walker that
     * stopped recursing still passed it. Both a key and a value, two levels in.
     */
    const nested = '{"payload":{"inner":{"\\u002fhome\\u002fu":"benign","deep":{"note":"\\u002fhome\\u002fjane.doe"}}}}'
    const deep = surfaces(nested)
    expect(deep, 'a walker that stops recursing must not pass this').toContain('/home/u')
    expect(deep, 'and it must reach a value two levels below that key').toContain('/home/jane.doe')

    /**
     * INSIDE AN ARRAY, because `walkInto`'s three branches are three siblings
     * and only two of them were witnessed (review of #279). EXECUTED: leaving
     * `Array.isArray(node)` matched but walking none of its children left this
     * file at 28 passed, while the same deletion on the object branch reddened
     * it — so the array arm could have been lost without a test moving. It is
     * not hypothetical on this corpus: the four committed fixtures hold 148
     * arrays with string members between them (era-2's snapshot alone has 75),
     * and `tmux`/`workmux` payloads carry lists of handles.
     */
    const inArray = '{"payload":{"paths":["benign","\\u002fhome\\u002foperator"],"nested":[[{"note":"\\u002fhome\\u002ffixture"}]]}}'
    const listed = surfaces(inArray)
    expect(listed, 'a string leaf inside an array must decode').toContain('/home/operator')
    expect(listed, 'and one inside an array of arrays of objects must too').toContain('/home/fixture')

    /**
     * PRETTY-PRINTED, because a snapshot is not JSONL and the per-line path
     * decoded 81 of its 5,979 lines. This is the shape that path cannot read.
     */
    const pretty = '{\n  "outer": {\n    "note": "\\u002fhome\\u002falice"\n  }\n}'
    expect(
      surfaces(pretty),
      'a whole pretty-printed document must decode — none of its lines parse alone',
    ).toContain('/home/alice')

    expect(BANNED.some(([, pattern]) => found.some((surface) => pattern.test(surface)))).toBe(true)
  })
})
