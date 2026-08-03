import { useMemo, useRef, useState } from 'react'
import { selectCollisionPairs, selectTouchesByBranch, type CollisionPair } from '@rhizomorph/core'
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
    <section className="flex h-full flex-col rounded-lg border border-ice-850 bg-ice-950 p-4">
      <h2 className="text-xs font-semibold uppercase tracking-widest text-ice-400">Collisions</h2>

      {!connected ? (
        <p className="mt-2 text-sm text-ice-400">Waiting for the stream…</p>
      ) : (
        <>
          {hasCollisions ? (
            <ul className="mt-2 flex flex-col gap-1" aria-label="Collision evidence">
              {pairs.map((pair) => (
                <li key={`${pair.branches[0]}×${pair.branches[1]}`}>
                  <button
                    type="button"
                    onClick={() => focusPair(pair)}
                    className="figures flex w-full items-center gap-2 truncate rounded px-2 py-1 text-left text-needs-you hover:bg-ice-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-needs-you"
                  >
                    <span aria-hidden>●</span>
                    <span className="truncate">{formatPairEvidence(pair)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="figures mt-2 text-sm text-ice-400" role="status">
              {checkedLine}
            </p>
          )}

          {hasData ? (
            <div className="mt-2 flex-1 overflow-auto">
              <table className="w-full min-w-max border-collapse text-left text-xs">
                <thead>
                  <tr>
                    <th className="sticky top-0 z-10 min-w-[14rem] bg-ice-950 px-2 py-1 font-medium text-ice-400">
                      File
                    </th>
                    {columns.map((branch) => (
                      <th
                        key={branch}
                        scope="col"
                        title={branch}
                        className="sticky top-0 z-10 min-w-14 truncate bg-ice-950 px-2 py-1 text-center font-medium text-ice-400"
                      >
                        {shortenBranch(branch)}
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
                      className={isFocused(row) ? 'bg-ice-900' : undefined}
                    >
                      <td
                        title={row.path}
                        className={`figures min-w-[14rem] truncate px-2 py-1 ${
                          row.collided ? 'glow-needs-you text-needs-you' : 'text-ice-300'
                        }`}
                      >
                        {elidePathMiddle(row.path)}
                      </td>
                      {columns.map((branch) => (
                        <td
                          key={branch}
                          className={`px-2 py-1 text-center ${row.collided ? 'glow-needs-you' : ''}`}
                        >
                          {row.branches.includes(branch) ? (
                            <span
                              aria-label={`${branch} touches ${row.path}`}
                              className={row.collided ? 'text-needs-you' : 'text-ice-400'}
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
                <p className="mt-1 text-[10px] text-ice-400">
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
