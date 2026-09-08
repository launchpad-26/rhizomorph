import { type KeyboardEvent, useCallback, useEffect, useState } from 'react'
import {
  type TranscriptBlock,
  type TranscriptEntry,
  type TranscriptRole,
  transcriptUrl,
} from '../../drawer/useTranscript.js'
import { capabilityRead } from '../../recordings/capabilityRead.js'
import type { FetchLike } from '../../replay/api.js'
import { type TraceDiff as Diff, type DiffRow, diffSteps } from './diff.js'
import { type Step, toSteps } from './steps.js'

/**
 * TRACE (prd53 S3, #327): an arm's steps against its parent's from the fork
 * forward, each row `same` / `diverged` / `added` / `absent`. The parent is
 * READ, never copied — both transcripts arrive through `GET /api/transcript/:lane
 * ?offset=…` and nothing here persists a line of either (the law beside this
 * file checks that). Alignment is by content (`diff.ts`), because the arm's
 * session is a path-rewritten copy and byte offsets do not carry across it.
 *
 * The instrument's span furniture (`web/src/trace/`) is span-typed — it
 * renders OTEL spans folded from `SessionState` — and a transcript step is not
 * a span, so this surface draws its own rows in the instrument's register
 * rather than forcing steps through a component built for another shape.
 * (The design spec's S3 line said "reuses the trace furniture"; it now says
 * this, in the same change.)
 */

export interface TraceDiffProps {
  parentLane: string
  laneHandle: string
  /** What to call the arm in the header, e.g. "arm 2 · run 1". */
  armLabel?: string
  /** A failed arm (ruling 7) has no trace and says so — its failure, verbatim. */
  failed?: string | null
  /** Test-only escape hatch for the two reads this surface makes. */
  fetchImpl?: FetchLike
  /** Told each time a diff is computed — what the frame's divergence position reads (prd53 ruling 8). */
  onDiff?: (summary: { rows: number; diverged: number; added: number; absent: number }) => void
}

type Side =
  | { status: 'loading' }
  | { status: 'ready'; steps: Step[] }
  | { status: 'unavailable'; reason: string }
  | { status: 'error'; message: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

const ROLES: readonly TranscriptRole[] = ['user', 'assistant', 'subagent', 'system']

function parseBlock(value: unknown): TranscriptBlock | null {
  if (!isRecord(value)) return null
  if (value.kind === 'text' && typeof value.text === 'string') return { kind: 'text', text: value.text }
  if (value.kind === 'tool_use') {
    return { kind: 'tool_use', name: typeof value.name === 'string' ? value.name : 'tool', hint: typeof value.hint === 'string' ? value.hint : '' }
  }
  if (value.kind === 'tool_result') {
    return {
      kind: 'tool_result',
      text: typeof value.text === 'string' ? value.text : '',
      dropped: typeof value.dropped === 'number' ? Math.max(0, value.dropped) : 0,
    }
  }
  return null
}

function parseEntries(value: unknown): TranscriptEntry[] {
  if (!Array.isArray(value)) return []
  const entries: TranscriptEntry[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const role = ROLES.includes(item.role as TranscriptRole) ? (item.role as TranscriptRole) : 'system'
    const blocks = Array.isArray(item.blocks) ? item.blocks.map(parseBlock).filter((block): block is TranscriptBlock => block !== null) : []
    entries.push(typeof item.ts === 'string' ? { ts: item.ts, role, blocks } : { role, blocks })
  }
  return entries
}

/** Reads a whole transcript from byte 0 — the request carries `offset=`, and the response is never stored. */
async function readTranscript(lane: string, fetchImpl: FetchLike): Promise<Side> {
  try {
    const response = await fetchImpl(transcriptUrl(lane, 0))
    if (!response.ok) return { status: 'error', message: `the transcript route answered ${response.status}` }
    const body: unknown = await response.json()
    if (!isRecord(body)) return { status: 'error', message: 'the transcript route answered something other than a transcript' }
    if (body.available === false) {
      return { status: 'unavailable', reason: typeof body.reason === 'string' ? body.reason : 'no transcript is available' }
    }
    return { status: 'ready', steps: toSteps(parseEntries(body.entries)) }
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : String(err) }
  }
}

const KIND_WORD: Readonly<Record<DiffRow['kind'], string>> = {
  same: 'same',
  diverged: 'diverged',
  added: 'added',
  absent: 'absent',
}

export function TraceDiff({ parentLane, laneHandle, armLabel, failed = null, fetchImpl, onDiff }: TraceDiffProps) {
  const impl = fetchImpl ?? capabilityRead
  const [parent, setParent] = useState<Side>({ status: 'loading' })
  const [arm, setArm] = useState<Side>({ status: 'loading' })
  const [focus, setFocus] = useState<number>(0)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (failed !== null) return
    let live = true
    setParent({ status: 'loading' })
    setArm({ status: 'loading' })
    void readTranscript(parentLane, impl).then((side) => {
      if (live) setParent(side)
    })
    void readTranscript(laneHandle, impl).then((side) => {
      if (live) setArm(side)
    })
    return () => {
      live = false
    }
  }, [parentLane, laneHandle, impl, failed])

  const diff: Diff | null = parent.status === 'ready' && arm.status === 'ready' ? diffSteps(parent.steps, arm.steps) : null
  const diffKey = diff === null ? null : diff.rows.map((row) => row.kind[0]).join('')
  useEffect(() => {
    if (diff === null || onDiff === undefined) return
    const count = (kind: DiffRow['kind']) => diff.rows.filter((row) => row.kind === kind).length
    onDiff({ rows: diff.rows.length, diverged: count('diverged'), added: count('added'), absent: count('absent') })
    // Re-announce only when the classification changes, not on every render.
  }, [diffKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const rowCount = diff !== null ? diff.rows.length : arm.status === 'ready' ? arm.steps.length : 0

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (rowCount === 0) return
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setFocus((current) => Math.min(rowCount - 1, current + 1))
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        setFocus((current) => Math.max(0, current - 1))
      } else if (event.key === 'Enter') {
        event.preventDefault()
        setOpen(true)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        setOpen(false)
      }
    },
    [rowCount],
  )

  const label = armLabel ?? laneHandle

  if (failed !== null) {
    return (
      <section data-testid="trace-diff" data-state="failed-arm" className="text-read-body text-(--ink-body)">
        <p role="status" data-testid="trace-failed-arm" className="text-(--ink-dim)">
          {label} failed to dispatch — a failed arm has no trace, and says so: {failed}
        </p>
      </section>
    )
  }

  return (
    <section
      data-testid="trace-diff"
      data-state={diff === null ? (arm.status === 'ready' ? 'parent-unreadable' : arm.status) : diff.rows.length === 0 ? 'empty' : 'ready'}
      className="flex flex-col gap-2 text-read-body text-(--ink-body)"
    >
      <header className="flex flex-wrap items-baseline gap-2">
        <span className="heading text-(--ink-primary)">Trace</span>
        <span className="text-(--ink-dim)">
          {label} against {parentLane}, from the fork forward — the parent is read at its own transcript, never copied
        </span>
      </header>

      {parent.status === 'unavailable' || parent.status === 'error' ? (
        <p role="status" data-testid="trace-parent-unreadable" className="text-broken">
          the parent&apos;s transcript cannot be read — {parent.status === 'error' ? parent.message : parent.reason}
        </p>
      ) : null}
      {arm.status === 'unavailable' || arm.status === 'error' ? (
        <p role="status" data-testid="trace-arm-unreadable" className="text-(--ink-dim)">
          the arm&apos;s transcript cannot be read — {arm.status === 'error' ? arm.message : arm.reason}
        </p>
      ) : null}

      {arm.status === 'loading' || (parent.status === 'loading' && arm.status !== 'error' && arm.status !== 'unavailable') ? (
        <p data-testid="trace-loading" className="text-(--ink-dim)">
          reading both transcripts…
        </p>
      ) : null}

      {arm.status === 'ready' && arm.steps.length === 0 ? (
        <p data-testid="trace-empty" className="text-(--ink-dim)">
          no steps recorded — the arm has not begun
        </p>
      ) : null}

      {rowCount > 0 ? (
        <div role="listbox" aria-label="trace rows" tabIndex={0} onKeyDown={onKeyDown} className="focus-ring outline-none" data-testid="trace-rows">
          <table className="figures w-full border-collapse text-left">
            <thead>
              <tr className="border-(--line-strong) border-b text-(--ink-dim)">
                <th className="py-1 pr-2 font-normal">row</th>
                <th className="py-1 pr-2 font-normal">stands</th>
                <th className="py-1 pr-2 font-normal">arm</th>
                <th className="py-1 pr-2 font-normal">parent</th>
              </tr>
            </thead>
            <tbody>
              {diff !== null
                ? diff.rows.map((row) => (
                    <tr
                      key={row.index}
                      data-testid={`trace-row-${row.index}`}
                      data-kind={row.kind}
                      data-focused={row.index === focus}
                      className={`border-(--line-hair) border-b align-top ${row.index === focus ? 'bg-(--surface-raised)' : ''}`}
                    >
                      <td className="py-1 pr-2 text-(--ink-dim)">{row.index}</td>
                      <td className={`py-1 pr-2 ${row.kind === 'same' ? 'text-(--ink-dim)' : 'text-(--ink-primary)'}`}>{KIND_WORD[row.kind]}</td>
                      <td className="max-w-[24rem] truncate py-1 pr-2">{row.arm === null ? '—' : row.arm.text}</td>
                      <td className="max-w-[24rem] truncate py-1 pr-2 text-(--ink-dim)">{row.parent === null ? '—' : row.parent.text}</td>
                    </tr>
                  ))
                : arm.status === 'ready'
                  ? // The parent could not be read: the arm's own rows still render, unclassified — never as `absent`.
                    arm.steps.map((step) => (
                      <tr
                        key={step.index}
                        data-testid={`trace-row-${step.index}`}
                        data-kind="unclassified"
                        data-focused={step.index === focus}
                        className={`border-(--line-hair) border-b align-top ${step.index === focus ? 'bg-(--surface-raised)' : ''}`}
                      >
                        <td className="py-1 pr-2 text-(--ink-dim)">{step.index}</td>
                        <td className="py-1 pr-2 text-(--ink-dim)">—</td>
                        <td className="max-w-[24rem] truncate py-1 pr-2">{step.text}</td>
                        <td className="py-1 pr-2 text-(--ink-dim)">unreadable</td>
                      </tr>
                    ))
                  : null}
            </tbody>
          </table>
        </div>
      ) : null}

      {open && rowCount > 0 ? (
        <aside data-testid="trace-focus" className="border-(--line-strong) border bg-(--surface-panel) p-2">
          <p className="heading text-(--ink-dim)">step {focus} · Esc to go back</p>
          {diff !== null ? (
            <>
              <p className="mt-1 whitespace-pre-wrap text-(--ink-primary)">{diff.rows[focus]?.arm?.text ?? '— (the arm has no step here)'}</p>
              <p className="mt-1 whitespace-pre-wrap text-(--ink-dim)">{diff.rows[focus]?.parent?.text ?? '— (the parent has no step here)'}</p>
            </>
          ) : arm.status === 'ready' ? (
            <p className="mt-1 whitespace-pre-wrap text-(--ink-primary)">{arm.steps[focus]?.text}</p>
          ) : null}
        </aside>
      ) : null}
    </section>
  )
}
