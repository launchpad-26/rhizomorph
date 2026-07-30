import { useMemo } from 'react'
import { reduceAll } from '@observatory/core'
import { useStream } from '../../app/StreamContext.js'
import { MAX_VISIBLE_ROWS, selectCollisionColumns, selectCollisionRows } from './rows.js'

/**
 * File x branch collision matrix. A filled cell means that branch has its
 * hands on that file (dirty or committed vs main); a row touched by 2+
 * branches glows magenta — the warning state prd0 asks for.
 */
export default function CollisionsPanel() {
  const { state: raw, status } = useStream()
  const session = useMemo(() => reduceAll(raw.events), [raw.events])
  const columns = useMemo(() => selectCollisionColumns(session), [session])
  const rows = useMemo(() => selectCollisionRows(session), [session])
  const visibleRows = rows.slice(0, MAX_VISIBLE_ROWS)
  const hiddenCount = rows.length - visibleRows.length
  const hasData = visibleRows.length > 0 && columns.length > 0
  /** Same signal ConnectionBadge/StatusBar read, plus proof at least one event has folded. */
  const connected = status === 'open' && raw.events.length > 0

  return (
    <section className="flex h-full flex-col rounded-lg border border-void-line bg-void-raised p-4">
      <h2 className="text-xs font-semibold uppercase tracking-widest text-neon-magenta">
        Collisions
      </h2>

      {!hasData && !connected ? (
        <p className="mt-2 text-sm text-slate-500">Waiting for the stream…</p>
      ) : !hasData ? (
        <p className="mt-2 text-sm text-slate-300" role="status">
          No collisions — no two branches touch the same file.
        </p>
      ) : (
        <div className="mt-2 flex-1 overflow-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr>
                <th className="sticky top-0 z-10 bg-void-raised px-2 py-1 font-medium text-slate-400">
                  File
                </th>
                {columns.map((branch) => (
                  <th
                    key={branch}
                    scope="col"
                    title={branch}
                    className="sticky top-0 z-10 min-w-10 truncate bg-void-raised px-2 py-1 text-center font-medium text-slate-400"
                  >
                    {branch}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => (
                <tr key={row.path} data-collided={row.collided}>
                  <td
                    title={row.path}
                    className={`max-w-0 truncate px-2 py-1 font-mono ${
                      row.collided ? 'glow-magenta text-neon-magenta' : 'text-slate-300'
                    }`}
                  >
                    {row.path}
                  </td>
                  {columns.map((branch) => (
                    <td
                      key={branch}
                      className={`px-2 py-1 text-center ${row.collided ? 'glow-magenta' : ''}`}
                    >
                      {row.branches.includes(branch) ? (
                        <span
                          aria-label={`${branch} touches ${row.path}`}
                          className={row.collided ? 'text-neon-magenta' : 'text-neon-cyan'}
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
            <p className="mt-1 text-[10px] text-slate-600">
              +{hiddenCount} more file{hiddenCount === 1 ? '' : 's'} touched, not shown
            </p>
          ) : null}
        </div>
      )}
    </section>
  )
}
