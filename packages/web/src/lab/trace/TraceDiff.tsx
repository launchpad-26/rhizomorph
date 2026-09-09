import { type KeyboardEvent, useCallback, useEffect, useState } from 'react'
import type { TranscriptBlock, TranscriptEntry, TranscriptRole } from '../../drawer/useTranscript.js'
import { capabilityRead } from '../../recordings/capabilityRead.js'
import type { FetchLike } from '../../replay/api.js'
import { type TraceDiff as Diff, type DiffRow, diffSteps } from './diff.js'
import { type Step, toSteps } from './steps.js'

/**
 * TRACE (prd53 S3, #327; prd-55 ruling 6 / S3′, #384): an arm's steps against
 * its parent's from the fork forward, each row `same` / `diverged` / `added` /
 * `absent`. The parent is READ, never copied — nothing here persists a line
 * of either transcript (the law beside this file checks that). Alignment is
 * by content (`diff.ts`), because the arm's session is a path-rewritten copy
 * and byte offsets do not carry across it.
 *
 * **Both sides come from the lab's own record** — `GET /api/lab/transcript`
 * (`api/lab-transcript.ts`): the parent from its checkpoint's session file up
 * to the cut, digest-checked, named by the arm it was forked into
 * (`?lane=<parent>&arm=<handle>`); the arm from the session under its own
 * worktree, resolved from the dispatch record (`?lane=<handle>`). Never the
 * fleet's transcript tail (`api/transcript.ts`), which knows only lanes the
 * sessionlog collector attributed — this surface read it until prd-55 wave 3
 * and got NO SESSION LOG for a parent and 404 for an arm that never launched
 * (prd-55's Evidence). The law beside this file greps the whole of `lab/`
 * for that tail.
 *
 * **The whole span, in one ask.** The lab route serves a parent to its cut
 * and an arm to its end complete, however long, so nothing here pages: the
 * wave-3 review found this file reading the fleet tail's first 64 KiB page
 * at `offset=0` and following nothing, so a parent forked past its first
 * page diffed as entirely `same`. One request per side; no `offset`, no
 * `nextOffset`, no `eof`.
 *
 * **Not launched is a fact, not a gap.** An arm whose restored session holds
 * exactly the lines the restore copied has not begun; the route says so in
 * its own words (`launched: false`, `note`) and this surface shows them —
 * while still diffing, so the frame's divergence position reads a real
 * summary (every parent step past the fork `absent`) rather than nothing.
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

/**
 * The lab's own transcript route (prd-55 ruling 6). An arm is read by its
 * handle; its parent is read cut at that arm's checkpoint by naming the arm.
 * The web bundle does not depend on the server package, so the path is
 * restated here and proven against the real route by the contract test
 * (`packages/contract/src/lab-transcript.contract.test.ts`).
 */
export function labTranscriptUrl(lane: string, options: { arm?: string } = {}): string {
  const arm = options.arm === undefined ? '' : `&arm=${encodeURIComponent(options.arm)}`
  return `/api/lab/transcript?lane=${encodeURIComponent(lane)}${arm}`
}

/**
 * One side's reading, as the surface consumes it. `ready` carries the whole
 * span; `unavailable` is the route's own honest absence (a refused digest, a
 * session not on this machine, a lane the record never named — 200 or 404,
 * each with its reason); `error` is a transport or gate failure with what
 * the route answered.
 */
export type LabTranscriptReading =
  | {
      status: 'ready'
      side: 'parent' | 'arm'
      entries: TranscriptEntry[]
      /** An arm: true once its session has grown past the cut, false when it has not (`note` says so), null when the record cannot tell (`note` says why). A parent: null, no note. */
      launched: boolean | null
      note: string | null
    }
  | { status: 'unavailable'; reason: string }
  | { status: 'error'; message: string }

type Side =
  | { status: 'loading' }
  | { status: 'ready'; steps: Step[]; launched: boolean | null; note: string | null }
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

/**
 * One read of the lab route, whole, never stored. The default transport is
 * `capabilityRead` — the route is a gated read (prd-29 ruling 1) and the
 * token travels the one way every read's does.
 */
export async function readLabTranscript(
  lane: string,
  options: { arm?: string } = {},
  fetchImpl: FetchLike = capabilityRead,
): Promise<LabTranscriptReading> {
  try {
    const response = await fetchImpl(labTranscriptUrl(lane, options))
    const body: unknown = await response.json().catch(() => null)
    if (!isRecord(body)) {
      return {
        status: 'error',
        message: response.ok
          ? 'the lab transcript route answered something other than a transcript'
          : `the lab transcript route answered ${response.status}`,
      }
    }
    if (body.available === false) {
      // The route's own reason — 200 for a lane the record knows but cannot
      // vouch for, 404 for one it never named. Both are shown verbatim.
      return { status: 'unavailable', reason: typeof body.reason === 'string' ? body.reason : 'no transcript is available' }
    }
    if (!response.ok) {
      const detail = typeof body.error === 'string' ? ` — ${body.error}` : ''
      return { status: 'error', message: `the lab transcript route answered ${response.status}${detail}` }
    }
    return {
      status: 'ready',
      side: body.side === 'arm' ? 'arm' : 'parent',
      entries: parseEntries(body.entries),
      launched: typeof body.launched === 'boolean' ? body.launched : null,
      note: typeof body.note === 'string' ? body.note : null,
    }
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : String(err) }
  }
}

function toSide(reading: LabTranscriptReading): Side {
  if (reading.status !== 'ready') return reading
  return { status: 'ready', steps: toSteps(reading.entries), launched: reading.launched, note: reading.note }
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
    void readLabTranscript(parentLane, { arm: laneHandle }, impl).then((reading) => {
      if (live) setParent(toSide(reading))
    })
    void readLabTranscript(laneHandle, {}, impl).then((reading) => {
      if (live) setArm(toSide(reading))
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
  const notLaunched = arm.status === 'ready' && arm.launched === false

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
      data-state={
        diff === null ? (arm.status === 'ready' ? 'parent-unreadable' : arm.status) : notLaunched ? 'not-launched' : diff.rows.length === 0 ? 'empty' : 'ready'
      }
      className="flex flex-col gap-2 text-read-body text-(--ink-body)"
    >
      <header className="flex flex-wrap items-baseline gap-2">
        <span className="heading text-(--ink-primary)">Trace</span>
        <span className="text-(--ink-dim)">
          {label} against {parentLane}, from the fork forward — both read from the lab&apos;s own record, the parent to its cut, never copied
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

      {arm.status === 'ready' && arm.launched === false ? (
        <p role="status" data-testid="trace-not-launched" className="text-(--ink-dim)">
          {label} {arm.note ?? 'not launched'}
        </p>
      ) : null}
      {arm.status === 'ready' && arm.launched === null && arm.note !== null ? (
        <p role="status" data-testid="trace-launch-unknown" className="text-(--ink-dim)">
          {arm.note}
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
