import { Disclosure, type DisclosureContent } from '../../disclosure/index.js'
import { useMemo, useRef, useState, type MouseEvent } from 'react'
import { selectCollisionPairs, selectTouchesByBranch, type CollisionPair } from '@rhizomorph/core'
import { laneUrl, navigate } from '../../app/router.js'
import { useStream } from '../../app/StreamContext.js'
import { elidePathMiddle, formatCheckedLine, formatPairEvidence, shortenBranch } from './format.js'
import { MAX_VISIBLE_ROWS, selectCollisionColumns, selectCollisionRows } from './rows.js'

/**
 * File x branch collision matrix — demoted to calm chrome (ruling 14). The
 * matrix itself keeps prd2's rows/columns logic unchanged; what changes is the
 * register around it:
 *
 * - a real collision is evidence, not an alarm painted on the whole panel — the
 *   panel's only ladder-hue surface is a genuinely collided cell, wearing the
 *   same NEEDS-YOU amber `buildFleet` ranks it (graft g4: hue = severity, form
 *   = kind; a bare "2 branches" label is never enough, so each entry names the
 *   pair and its worst file);
 * - the empty state never lies by omission: "collisions: 0" always carries the
 *   branch/file counts actually checked, the same arithmetic the strip's ALL
 *   CLEAR uses over the same session (see `formatCheckedLine`).
 *
 * Clicking a pair's evidence entry scrolls the matrix to a row that proves it
 * and marks that row, rather than repainting the whole table — the panel is
 * the evidence a ladder item points at, not a second alarm.
 *
 * #159 — every column header is also a row drill-down (Grafana's data-link
 * pattern): a branch column names one lane, so it is one click from
 * "which branches collide" to that lane's own `/lane/:handle` page.
 */
export default function CollisionsPanel() {
  const { state: stream, status } = useStream()
  const session = stream.session
  const columns = useMemo(() => selectCollisionColumns(session), [session])
  const rows = useMemo(() => selectCollisionRows(session), [session])
  const pairs = useMemo(() => selectCollisionPairs(session), [session])
  const checkedLine = useMemo(
    () => formatCheckedLine(selectTouchesByBranch(session)),
    [session],
  )

  const visibleRows = rows.slice(0, MAX_VISIBLE_ROWS)
  const hiddenCount = rows.length - visibleRows.length
  const hasData = visibleRows.length > 0 && columns.length > 0
  const hasCollisions = pairs.length > 0
  /** Same signal ConnectionBadge/StatusBar read, plus proof at least one event has folded. */
  const connected = status === 'open' && stream.events.length > 0

  const [focusedPair, setFocusedPair] = useState<readonly [string, string] | null>(null)
  const rowNodes = useRef(new Map<string, HTMLTableRowElement>())

  const focusPair = (pair: CollisionPair) => {
    setFocusedPair(pair.branches)
    const target = pair.files[0]
    if (target === undefined) return
    rowNodes.current.get(target)?.scrollIntoView({ block: 'nearest' })
  }

  const isFocused = (row: { branches: readonly string[] }) =>
    focusedPair !== null && row.branches.includes(focusedPair[0]) && row.branches.includes(focusedPair[1])

  return (
    // No frame and no heading of its own since #552: the dock draws the border
    // and its tab strip names this surface, so a second copy of either would be
    // the duplication prd-32 ruling 5 is against — one thing, one name, one
    // edge. Everything else about the panel is untouched.
    <section data-panel="collisions" className="flex h-full flex-col">

      {!connected ? (
        <p className="mt-2 text-read-body text-(--ink-dim)">Waiting for the stream…</p>
      ) : (
        <>
          {hasCollisions ? (
            <ul className="mt-2 flex flex-col gap-1" aria-label="Collision evidence">
              {pairs.map((pair) => (
                <li key={`${pair.branches[0]}×${pair.branches[1]}`}>
                  <button
                    type="button"
                    onClick={() => focusPair(pair)}
                    // prd-32 ruling 9: `focus-ring`, the one token, replacing
                    // `focus-visible:ring-needs-you`. A status hue as focus
                    // chrome made "a human must act on this collision" and
                    // "your keyboard is here" the same amber — so the summons
                    // hue meant two things on the one surface that shows
                    // nothing but summonses. It goes first for that reason.
                    className="focus-ring figures flex w-full items-center gap-2 truncate rounded-none px-2 py-1 text-left text-needs-you hover:bg-(--surface-raised)"
                  >
                    <span aria-hidden>●</span>
                    <span className="truncate">{formatPairEvidence(pair)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="figures mt-2 text-read-body text-(--ink-dim)" role="status">
              {checkedLine}
            </p>
          )}

          {hasData ? (
            <div className="mt-2">
              <table className="w-full min-w-max border-collapse text-left text-inst">
                {/*
                  * STICKY AGAIN, offset below the dock (review of #65, option
                  * B — the operator's own call). `top-0` used to pin these two
                  * `<th>`s to the viewport's top edge once the panel lost its
                  * own scrollport (the `flex-1 overflow-auto` wrapper removed
                  * one screen up) — landing them underneath the shell's opaque
                  * sticky dock, which sits at the higher `--z-header` rung on
                  * purpose. `top-(--dock-h)` is the actual fix: it stops the
                  * header row exactly where the dock ends, so `z-(--z-sticky)`
                  * (10, below the dock's 20) now means what it always meant —
                  * "in front of the table, behind the chrome" — rather than
                  * fighting the dock for the same pixels. `--dock-h` is
                  * measured live in `Shell.tsx` because the dock's height is
                  * dynamic: the attention strip and the replay banner swap in
                  * and out. `sticky-scrollport-law.test.ts` accepts this shape
                  * as the second lawful answer, alongside owning a scrollport.
                  */}
                <thead>
                  <tr>
                    <th className="sticky top-(--dock-h) z-(--z-sticky) min-w-[14rem] bg-(--surface-panel) px-2 py-1.5 font-medium text-(--ink-dim)">
                      File
                    </th>
                    {columns.map((branch) => (
                      <th
                        key={branch}
                        scope="col"
                        className="sticky top-(--dock-h) z-(--z-sticky) min-w-14 truncate bg-(--surface-panel) px-2 py-1.5 text-center font-medium text-(--ink-dim)"
                      >
                        {/*
                          Inline trigger: `OpenBranchLink` is itself a control,
                          and a button around it would be the nesting ADR-0040
                          exists to prevent.
                        */}
                        <Disclosure disclosure={branchColumnDisclosure(branch)} trigger="inline">
                          <OpenBranchLink branch={branch} />
                        </Disclosure>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((row) => (
                    <tr
                      key={row.path}
                      ref={(node) => {
                        if (node) rowNodes.current.set(row.path, node)
                        else rowNodes.current.delete(row.path)
                      }}
                      data-collided={row.collided}
                      data-focused={isFocused(row)}
                      className={isFocused(row) ? 'bg-(--surface-raised)' : undefined}
                    >
                      <td
                        className={`figures min-w-[14rem] truncate px-2 py-1.5 leading-relaxed ${
                          row.collided ? 'glow-needs-you text-needs-you' : 'text-(--ink-body)'
                        }`}
                      >
                        <Disclosure disclosure={pathRowDisclosure(row)} triggerLabel={row.path}>
                          {elidePathMiddle(row.path)}
                        </Disclosure>
                      </td>
                      {columns.map((branch) => (
                        <td
                          key={branch}
                          className={`px-2 py-1.5 text-center ${row.collided ? 'glow-needs-you' : ''}`}
                        >
                          {row.branches.includes(branch) ? (
                            <span
                              aria-label={`${branch} touches ${row.path}`}
                              className={row.collided ? 'text-needs-you' : 'text-(--ink-dim)'}
                            >
                              ●
                            </span>
                          ) : null}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>

              {hiddenCount > 0 ? (
                <p className="mt-1 text-read-floor text-(--ink-dim)">
                  +{hiddenCount} more file{hiddenCount === 1 ? '' : 's'} touched, not shown
                </p>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </section>
  )
}

/**
 * THE COLUMN DRILL-DOWN (issue #159, Grafana's data-link pattern) — a branch
 * column header is not clickable today, so there is nothing to hijack; this
 * is the same modifier-aware, real-`<a href>` convention the drawer's own
 * `OpenPageLink` and the fleet table's `OpenLaneLink` both use, over
 * `shortenBranch`'s existing display text rather than a second label.
 */
function OpenBranchLink({ branch }: { branch: string }) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0) return
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    navigate(laneUrl(branch))
  }

  return (
    <a
      href={laneUrl(branch)}
      onClick={onClick}
      data-testid="collisions-open-lane"
      className="focus-ring rounded-none text-inherit hover:text-(--ink-primary)"
    >
      {shortenBranch(branch)}
    </a>
  )
}

/**
 * A column header's disclosure (#220) — the branch name the header elides.
 *
 * `elapsedMs: 0`: the collision matrix is rebuilt from the fold on every tick,
 * so the column's existence is a fact confirmed just now (core's own register
 * in `selectors/condition.ts`), not an observation with a "since".
 */
function branchColumnDisclosure(branch: string): DisclosureContent {
  return {
    label: branch,
    why: {
      reason: 'a lane working in this repo right now',
      evidence: { fact: `the fold carries work on ${branch}`, elapsedMs: 0 },
    },
    remedy: { kind: 'action', action: 'open the branch to see what it is touching' },
  }
}

/**
 * A row's disclosure — the full path the cell elides, and whether more than one
 * lane is in it. The elision is why the native `title=` was here; the collision
 * is why the row is worth asking about at all.
 */
function pathRowDisclosure(row: { path: string; collided: boolean }): DisclosureContent {
  return {
    label: row.path,
    why: {
      reason: row.collided ? 'more than one lane is touching this path' : 'one lane is touching this path',
      evidence: {
        fact: row.collided
          ? 'the ticks across this row name which lanes'
          : 'no other lane in this fold has touched it',
        elapsedMs: 0,
      },
    },
    remedy: row.collided
      ? { kind: 'action', action: 'move the work to the lane that owns the path, or widen a fence on the issue before the change' }
      : { kind: 'none', because: 'a path one lane owns is the wanted state — nothing to do' },
  }
}
