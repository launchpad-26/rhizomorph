import { useEffect, useMemo, useState } from 'react'
import { selectConnection } from '@rhizomorph/core'
import { useMode } from '../app/ModeContext.js'
import { navigate } from '../app/router.js'
import { useStream } from '../app/StreamContext.js'
import { copyToClipboard, type CopyText } from '../drawer/AttachButton.js'
import { formatWallClock } from '../replay/format.js'
import { buildLinks, portFrom, tally, type ChainLink, type LinkState } from './links.js'
import { fetchDoctor, fetchMeta, isRenderableTs, UNAVAILABLE, type DoctorFact, type FetchLike, type MetaFacts } from './meta.js'

/**
 * THE CONNECT PAGE — THE HANDSHAKE CHECKLIST (prd19 rulings 3, 5 and 7, wave
 * 3, #258). `/connect`, the fourth nav hand, now that wave 2's fence
 * (#252's placeholder) has a page to hold.
 *
 * One row per link in the chain, each rendering exactly one of VERIFIED /
 * BROKEN / UNPROVEN. The derivation is all in `links.ts` — this file is the
 * page: three inputs wired in, seven rows rendered out, and one action.
 *
 * **The three inputs, and why each is here.**
 *
 * 1. **The SSE fold** (`useStream()`). `selectConnection` over the same fold
 *    every other surface reads, so a row flips to VERIFIED the instant the
 *    event that proves it arrives — no refresh, no refetch, no polling for
 *    the facts that matter most. That is prd19's own success criterion
 *    ("watch a row flip to VERIFIED live"), and it is a property of reading
 *    the stream rather than of anything this page does cleverly.
 * 2. **`/api/meta`** (#255) — the rung, each collector's `reason`/`remedy`,
 *    the connection facts, the session id, the boot facts.
 * 3. **`GET /api/doctor`** (#253) — the filesystem facts state cannot know:
 *    the slug directory, version drift, the lane manifest.
 *
 * **Ruling 7: this page mutates nothing.** Two GETs and a clipboard write.
 * Every remedy is a string you copy and run yourself, with the port taken
 * from `location` and the same-process SCAR warning verbatim beside it —
 * confirmation comes only from watching a row change, never from this page
 * having done something. `replay/mutating-calls-law.test.ts` already polices
 * that across all of `packages/web/src`, and `index.test.tsx` restates it
 * for this directory.
 *
 * **The hue laws (`theme/theme.css`) decide the palette, and the design is
 * otherwise the implementer's** (this issue's own DoD). Verified wears the
 * green family, broken wears the one red the instrument has, and — the rule
 * that actually needed care — **unproven wears the ice ramp, never amber**:
 * a link that has simply not proved itself yet is nothing-to-say, and
 * waiting is not an alarm.
 */

export interface ConnectPageProps {
  /** Test seam for the two GETs. */
  fetchImpl?: FetchLike
  /** Test seam for the clipboard — the same shape the drawer's `AttachButton` uses. */
  onCopy?: CopyText
  /** Test clock, for the uninstrumented row's first-export grace window. */
  now?: number
  /**
   * How often the two GETs are re-read. The stream carries every flow fact
   * live on its own; this interval only refreshes what a GET can answer —
   * doctor's filesystem facts and meta's capabilities — so a slug directory
   * created, or a collector that recovered, shows up without a reload.
   * `GET /api/doctor` single-flights and caches for 3s behind exactly this
   * (`api/doctor.ts`'s `PROBE_CACHE_TTL_MS`). `0` disables the interval; a
   * test pins its own facts instead of racing a timer.
   */
  refreshMs?: number
  /** Test seam for `window.location` — the port every command interpolates. */
  location?: { port: string; protocol: string }
}

const STATE_WORD: Record<LinkState, string> = {
  verified: 'VERIFIED',
  broken: 'BROKEN',
  unproven: 'UNPROVEN',
}

/**
 * Colour is never the sole carrier (law 9a's own condition): every state has
 * a glyph and a word as well as a hue, so the checklist survives greyscale,
 * colour-blindness and a photographed screen.
 */
const STATE_GLYPH: Record<LinkState, string> = { verified: '✓', broken: '✕', unproven: '·' }

const STATE_CLASS: Record<LinkState, string> = {
  verified: 'text-working',
  broken: 'text-broken',
  // The ice ramp, deliberately: an unproven link is nothing-to-say, and
  // amber in this instrument means a human is blocked.
  unproven: 'text-ice-400',
}

/** The left rule beside each row — the same three-state reading at a glance, in the dark. */
const STATE_EDGE: Record<LinkState, string> = {
  verified: 'border-working/60',
  broken: 'border-broken/70',
  unproven: 'border-ice-800',
}

const DOCTOR_CLASS: Record<DoctorFact['status'], string> = {
  ok: 'text-ice-300',
  // The muted end of the amber family: a doctor warning is a degraded
  // optional capability, never the incandescent "a human must act now".
  warn: 'text-waiting-benign',
  fail: 'text-broken',
}

export function ConnectPage({ fetchImpl, onCopy = copyToClipboard, now, refreshMs = 5000, location }: ConnectPageProps = {}) {
  const { state, status, provenance, source } = useStream()
  const mode = useMode()
  const [meta, setMeta] = useState<MetaFacts | null>(null)
  const [doctor, setDoctor] = useState<DoctorFact[] | null>(null)

  useEffect(() => {
    let live = true
    const read = () => {
      void fetchMeta(fetchImpl).then((facts) => {
        if (live) setMeta(facts)
      })
      void fetchDoctor(fetchImpl).then((checks) => {
        if (live) setDoctor(checks)
      })
    }

    read()
    if (refreshMs <= 0) {
      return () => {
        live = false
      }
    }
    const timer = setInterval(read, refreshMs)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [fetchImpl, refreshMs])

  const flow = useMemo(() => selectConnection(state.session), [state.session])
  const port = portFrom(location ?? (typeof window === 'undefined' ? { port: '', protocol: 'http:' } : window.location))
  const isLive = mode === 'live' && source === 'live'

  const links = buildLinks({
    flow,
    refusals: state.session.refusals,
    stream: { status, eventCount: state.session.eventCount, provenance, live: isLive },
    meta,
    doctor,
    port,
    // Wall-clock is the honest reading for the first-export grace window: the
    // question it answers is "how long has this agent had to export?", which
    // is elapsed real time, not a scrub position.
    now: now ?? Date.now(),
  })
  const counts = tally(links)

  return (
    <div data-testid="connect-page" className="flex h-screen flex-col bg-ice-1000 font-sans text-ice-300">
      <header className="flex shrink-0 items-center gap-4 border-b border-ice-850 bg-ice-950 px-4 py-3">
        <button
          type="button"
          data-testid="connect-back"
          onClick={() => navigate('/')}
          className="shrink-0 rounded border border-ice-800 px-2 py-1 text-[10px] uppercase tracking-wider text-ice-400 hover:border-ice-600 hover:text-ice-100"
        >
          ← balcony
        </button>
        <h1 className="text-sm text-ice-100">Connect</h1>
        <span className="text-[11px] text-ice-400">
          every link in the chain, and the fact that proves it — this page reads, and never writes
        </span>
        <span data-testid="connect-tally" className="figures ml-auto text-[11px] text-ice-400">
          <span className="text-working">{counts.verified} verified</span>
          {' · '}
          <span className={counts.broken > 0 ? 'text-broken' : undefined}>{counts.broken} broken</span>
          {' · '}
          {counts.unproven} unproven
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        <Provenance meta={meta} provenance={provenance} isLive={isLive} port={port} />

        <ul data-testid="connect-links" className="mt-4 flex flex-col gap-2">
          {links.map((link) => (
            <LinkRow key={link.id} link={link} onCopy={onCopy} />
          ))}
        </ul>

        <DoctorPanel checks={doctor} />
      </div>
    </div>
  )
}

/**
 * The instrument's own identity line, and — when the fold driving this page
 * is a recording or a fixture — the loudest thing on the page. Ruling 6: a
 * fixture must never pass as live data, and on the one surface whose entire
 * subject is whether data is real, that has to be said before any row is
 * read rather than inferred from the first row's state.
 */
function Provenance({ meta, provenance, isLive, port }: { meta: MetaFacts | null; provenance: string; isLive: boolean; port: string }) {
  const boot = meta?.boot
  return (
    <section data-testid="connect-provenance" className="rounded border border-ice-850 bg-ice-950 px-3 py-2 text-[11px]">
      {!isLive && (
        <p data-testid="connect-not-live" className="mb-1.5 text-notice">
          this checklist is reading {provenance} — not the live log. Nothing below is proof about this instrument's own
          wiring until you return to live.
        </p>
      )}
      <dl className="flex flex-wrap gap-x-6 gap-y-1 text-ice-400">
        <Fact label="rung" value={meta?.rung ?? null} testId="connect-rung" />
        <Fact label="instance" value={meta?.sessionId ?? null} testId="connect-instance" />
        <Fact label="repo" value={meta?.repoPath ?? null} testId="connect-repo" />
        <Fact label="port" value={port} testId="connect-port" />
        <Fact label="source" value={provenance} testId="connect-source" />
        <Fact
          label="boot"
          value={boot === null || boot === undefined ? null : `${boot.lastBootReason} · resumed ${boot.resumedCount}× · ${Math.round(boot.resumeWindowMs / 60_000)}m window`}
          testId="connect-boot"
        />
      </dl>
    </section>
  )
}

/** One `label: value` pair, where a value this page could not read says so in one word rather than reading as zero. */
function Fact({ label, value, testId }: { label: string; value: string | null; testId: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="uppercase tracking-wider text-ice-400">{label}</dt>
      <dd data-testid={testId} className={value === null ? 'text-ice-400 italic' : 'figures text-ice-200'}>
        {value ?? UNAVAILABLE}
      </dd>
    </div>
  )
}

function LinkRow({ link, onCopy }: { link: ChainLink; onCopy: CopyText }) {
  return (
    <li
      data-testid={`connect-link-${link.id}`}
      className={`rounded border border-ice-850 border-l-2 bg-ice-950 px-3 py-2 ${STATE_EDGE[link.state]}`}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span
          data-testid={`connect-state-${link.id}`}
          className={`figures shrink-0 text-[10px] font-semibold uppercase tracking-[0.18em] ${STATE_CLASS[link.state]}`}
        >
          <span aria-hidden="true">{STATE_GLYPH[link.state]}</span> {STATE_WORD[link.state]}
        </span>
        <span className="text-[12px] text-ice-100">{link.label}</span>
        <span className="text-[11px] text-ice-400">{link.question}</span>
      </div>

      {link.fact !== null && (
        <p data-testid={`connect-fact-${link.id}`} className="mt-1 text-[11px] text-ice-200">
          {link.fact}
          <Stamp ts={link.ts} kind={link.tsKind} />
        </p>
      )}

      {link.reason !== null && (
        <p data-testid={`connect-reason-${link.id}`} className="mt-1 text-[11px] text-broken">
          {link.reason}
        </p>
      )}

      {link.command !== null && <CommandBlock id={link.id} command={link.command} warning={link.warning} onCopy={onCopy} />}

      {link.notes.length > 0 && (
        <ul data-testid={`connect-notes-${link.id}`} className="mt-1 flex flex-col gap-0.5 text-[10px] leading-snug text-ice-400">
          {link.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
    </li>
  )
}

/**
 * A VERIFIED row's timestamp, and **what kind of timestamp it is** — the
 * proving record's own moment, or "as of" this render where the proof is the
 * present moment rather than a stored fact (an open socket, a fresh doctor
 * probe). Ruling 3 wants every VERIFIED dated; saying which of the two it is
 * keeps that from being a fabricated event time.
 */
function Stamp({ ts, kind }: { ts: number | null; kind: ChainLink['tsKind'] }) {
  if (ts === null || kind === null) return null
  // The other end of the same guard `meta.ts` applies at the parse boundary,
  // for the timestamps that never pass through it. The envelope's own
  // `timestampSchema` (`z.number().int().nonnegative()`) tops out at
  // `Number.MAX_SAFE_INTEGER`, ~9.007e15, while a `Date` refuses anything
  // past ±8.64e15 — so a `ts` in that gap validates, folds, and would throw a
  // `RangeError` out of `toISOString` mid-render, blanking a route that has
  // no ErrorBoundary above it.
  if (!isRenderableTs(ts)) {
    return <span className="figures ml-2 text-ice-400 italic">{UNAVAILABLE}</span>
  }
  return (
    <time dateTime={new Date(ts).toISOString()} className="figures ml-2 text-ice-400">
      {kind === 'render' ? `as of ${formatWallClock(ts)}` : formatWallClock(ts)}
    </time>
  )
}

/**
 * The page's one action, and the drawer's own precedent (`AttachButton`):
 * **what it copied is always shown, whether the copy worked or not.** A
 * clipboard write fails in plenty of ordinary places — no permission, no
 * secure context — and the useful failure mode is the command sitting there,
 * selectable, rather than a toast that leaves the operator with nothing to
 * paste.
 */
function CommandBlock({ id, command, warning, onCopy }: { id: string; command: string; warning: string | null; onCopy: CopyText }) {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle')

  // A different command must not inherit the last one's "copied".
  useEffect(() => setCopied('idle'), [command])

  return (
    <div className="mt-1.5">
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid={`connect-copy-${id}`}
          onClick={() => {
            void onCopy(command).then(
              () => setCopied('copied'),
              () => setCopied('failed'),
            )
          }}
          className="rounded border border-ice-700 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-ice-100 hover:border-ice-500 hover:bg-ice-900"
        >
          Copy
        </button>
        {copied !== 'idle' && (
          <span role="status" className={`figures text-[10px] ${copied === 'copied' ? 'text-notice' : 'text-ice-400'}`}>
            {copied === 'copied' ? 'copied to clipboard' : 'clipboard unavailable — copy it by hand'}
          </span>
        )}
      </div>
      <code
        data-testid={`connect-command-${id}`}
        className="mt-1.5 block overflow-x-auto whitespace-pre rounded bg-ice-1000 px-2 py-1 font-mono text-[11px] text-ice-200"
      >
        {command}
      </code>
      {warning !== null && (
        <p data-testid={`connect-warning-${id}`} className="mt-1 text-[10px] leading-snug text-waiting-benign">
          {warning}
        </p>
      )}
    </div>
  )
}

/**
 * Doctor's whole answer, verbatim and unranked, under the rows it already
 * fed. The rows above quote the checks they actually depend on; this panel
 * exists so the ones no row consumes — version drift, the node version, the
 * session boundary — are still readable by a stranger with no terminal,
 * which is the whole reason ruling 5 put the check functions behind a GET.
 */
function DoctorPanel({ checks }: { checks: DoctorFact[] | null }) {
  return (
    <section data-testid="connect-doctor" className="mt-5">
      <h2 className="text-[10px] uppercase tracking-[0.18em] text-ice-400">
        facts the fold cannot know — <span className="font-mono normal-case tracking-normal">GET /api/doctor</span>
      </h2>
      {checks === null ? (
        <p data-testid="connect-doctor-unavailable" className="mt-1 text-[11px] italic text-ice-400">
          {UNAVAILABLE} — this server did not answer the doctor route
        </p>
      ) : (
        <ul className="mt-1 flex flex-col gap-1 text-[11px]">
          {checks.map((check) => (
            <li key={check.id} data-testid={`connect-doctor-${check.id}`} className="flex gap-2">
              <span className={`figures w-10 shrink-0 uppercase tracking-wider ${DOCTOR_CLASS[check.status]}`}>{check.status}</span>
              <span className="w-36 shrink-0 font-mono text-ice-300">{check.id}</span>
              <span className="text-ice-400">
                {check.message}
                {check.assumed && <em className="ml-1 text-ice-400">(assumed, not measured)</em>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export default ConnectPage
