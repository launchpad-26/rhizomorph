import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { selectConnection } from '@rhizomorph/core'
import { useMode } from '../app/ModeContext.js'
import { navigate } from '../app/router.js'
import { useStream } from '../app/StreamContext.js'
import type { InstrumentFetchLike, InstrumentOutcome } from '../concierge/instrument.js'
import { InstrumentButton } from '../concierge/InstrumentButton.js'
import { copyToClipboard, type CopyText } from '../drawer/AttachButton.js'
import { formatWallClock } from '../replay/format.js'
import { buildLinks, portFrom, SAME_PROCESS_WARNING, tally, type ChainLink, type InstrumentableSession, type LinkState } from './links.js'
import {
  fetchDoctor,
  fetchMeta,
  fetchSessionPreview,
  isRenderableTs,
  UNAVAILABLE,
  type DoctorFact,
  type DoctorReading,
  type FetchLike,
  type MetaFacts,
  type SessionPreview,
} from './meta.js'
import { SampleFleetControl, sampleUninstrumented } from './sample.js'

/**
 * THE CONNECT PAGE — THE HANDSHAKE CHECKLIST (prd19 rulings 3, 5 and 7, wave
 * 3, #258). `/connect`, the fourth nav hand, now that wave 2's fence
 * (#252's placeholder) has a page to hold.
 *
 * `SampleFleetControl` (`sample.tsx`), mounted in the header below, turns
 * ruling 6's synthetic fleet into a button instead of a keyboard secret
 * (wave 3, #259).
 *
 * One row per link in the chain, each rendering exactly one of VERIFIED /
 * BROKEN / UNPROVEN. The derivation is all in `links.ts` — this file is the
 * page: three inputs wired in, seven rows rendered out, and — under the last
 * of them — the enumeration wave 7 added (#520).
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
 * **Ruling 7: this page mutates nothing.** Three GETs and a clipboard write —
 * `/api/meta`, `/api/doctor`, and one preview per enumerated session (#516).
 * Every remedy is a string you copy and run yourself, with the port taken
 * from `location` and the same-process SCAR warning verbatim beside it —
 * confirmation comes only from watching a row change, never from this page
 * having done something. `replay/mutating-calls-law.test.ts` already polices
 * that across all of `packages/web/src`, and `index.test.tsx` restates it
 * for this directory.
 *
 * **The one act on this page is a component, not a request** (prd-20 w7,
 * #520). `../concierge/InstrumentButton.js` relaunches a conductor on a
 * session it names, and the whole of that act — the confirmation, the wire,
 * the write — lives in `concierge/` behind its own two laws. Nothing changes
 * here: this file still builds no request of its own, and the copyable command
 * stays visible beside the button rather than behind it, because prd-20
 * ruling 3 is explicit that the page never claims to attach to a running
 * process. The button is a convenience over the command, never a replacement
 * for it.
 *
 * **The hue laws (`theme/theme.css`) decide the palette, and the design is
 * otherwise the implementer's** (this issue's own DoD). Verified wears the
 * green family, broken wears the one red the instrument has, and — the rule
 * that actually needed care — **unproven wears the ice ramp, never amber**:
 * a link that has simply not proved itself yet is nothing-to-say, and
 * waiting is not an alarm.
 */

export interface ConnectPageProps {
  /** Test seam for the GETs this page reads. */
  fetchImpl?: FetchLike
  /**
   * Test seam for the one act on this page, handed straight to
   * `InstrumentButton` — deliberately a SECOND seam rather than a widening of
   * {@link fetchImpl}. The two have different types on purpose
   * (`InstrumentFetchLike` has nowhere to put a header beyond the two it
   * names), and a page that could serve its reads and its one write down the
   * same injected function is a page whose read seam can be handed a way to
   * mutate.
   */
  instrumentFetchImpl?: InstrumentFetchLike
  /** Test seam for the clipboard — the same shape the drawer's `AttachButton` uses. */
  onCopy?: CopyText
  /** Test clock, for the uninstrumented row's first-export grace window. */
  now?: number
  /**
   * How often the two GETs are re-read. The stream carries every flow fact
   * live on its own; this interval only refreshes what a GET can answer —
   * doctor's filesystem facts and meta's capabilities — so a slug directory
   * created, or a collector that recovered, shows up without a reload.
   *
   * **#344:** `GET /api/doctor` single-flights and caches for
   * `PROBE_CACHE_TTL_MS` (`api/doctor.ts`, 15s) — deliberately three times
   * `DEFAULT_REFRESH_MS`, not "behind" it as an earlier comment here claimed.
   * A cache hit never pushes out its own expiry, so an entry always expires
   * on the clock of the probe that created it; that makes it *this*
   * interval's job to stay under the TTL, never the other way round. At 5s
   * against 15s, a page polling alone reuses the last probe twice (no new
   * `tmux`/`workmux`/`claude --version` spawns) and pays for a fresh one on
   * the third. "Alone" is load-bearing: the cache is one per server, shared
   * by every caller, so a second tab or a `curl` opens the window on its own
   * clock and this page then hits on some other cadence. The guarantee that
   * survives any number of callers is the probe *rate* — at most one real
   * probe per TTL — which is the reason the single-flight exists. Push this
   * to or past the TTL — or drop the TTL to or below this — and every one of
   * this page's polls misses again, same as before #344.
   * `index.test.tsx`'s "#344 — the two numbers, held together" reads both
   * constants out of the source and fails if either moves alone. `0` disables
   * the interval; a test pins its own facts instead of racing a timer.
   */
  refreshMs?: number
  /** Test seam for `window.location` — the port every command interpolates. */
  location?: { port: string; protocol: string }
}

/**
 * Exported for the three-states law (#367): the law needs the exact set of
 * readings a state cell may hold, and a set typed out beside this map is a set
 * that can drift from it — the same reason `sample.tsx`'s `keyDoc()` derives
 * its copy from `STREAM_SOURCE_KEYS` instead of restating it.
 */
export const STATE_WORD: Record<LinkState, string> = {
  verified: 'VERIFIED',
  broken: 'BROKEN',
  unproven: 'UNPROVEN',
}

/**
 * Colour is never the sole carrier (law 9a's own condition): every state has
 * a glyph and a word as well as a hue, so the checklist survives greyscale,
 * colour-blindness and a photographed screen.
 *
 * Exported with `STATE_WORD`, and for the same reason: the cell renders the
 * pair, so the law can only be exact if it knows both.
 */
export const STATE_GLYPH: Record<LinkState, string> = { verified: '✓', broken: '✕', unproven: '·' }

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

/**
 * The interval this page actually ships with. Named and exported so the
 * relationship #344 is about — this value against `PROBE_CACHE_TTL_MS` — can
 * be asserted rather than described, and so a test can drive the shipped
 * default instead of a number it chose itself (which is how the old mismatch
 * survived: every test passed its own `refreshMs`).
 */
export const DEFAULT_REFRESH_MS = 5000

export function ConnectPage({
  fetchImpl,
  instrumentFetchImpl,
  onCopy = copyToClipboard,
  now,
  refreshMs = DEFAULT_REFRESH_MS,
  location,
}: ConnectPageProps = {}) {
  const { state, status, provenance, source } = useStream()
  const mode = useMode()
  const [meta, setMeta] = useState<MetaFacts | null>(null)
  // `absent` is the honest reading before the first GET resolves too: nothing
  // usable has arrived yet (#381).
  const [doctor, setDoctor] = useState<DoctorReading>({ kind: 'absent' })

  useEffect(() => {
    let live = true
    const read = () => {
      void fetchMeta(fetchImpl).then((facts) => {
        if (live) setMeta(facts)
      })
      void fetchDoctor(fetchImpl).then((reading) => {
        if (live) setDoctor(reading)
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

  // A FIXTURE SHOWS THE SURFACE; IT NEVER HANDS OVER THE ACT (#520). The
  // synthetic fleet is all-clear and `links.ts` clears the enumeration off a
  // fixture fold outright, so without this the sample page would render this
  // whole surface as empty space — the one thing a demonstration must not do.
  // `sample.tsx` supplies the sessions, and `live={false}` is what withholds
  // the button and the copyable command from them.
  const fixture = mode !== 'replay' && source !== 'live' ? sampleUninstrumented(port) : null

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
        <SampleFleetControl />
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
            <LinkRow key={link.id} link={link} onCopy={onCopy}>
              {link.id === 'uninstrumented-conductor' ? (
                <Instrumentable
                  sessions={link.sessions ?? []}
                  fixture={fixture}
                  fetchImpl={fetchImpl}
                  instrumentFetchImpl={instrumentFetchImpl}
                  onCopy={onCopy}
                />
              ) : null}
            </LinkRow>
          ))}
        </ul>

        <DoctorPanel reading={doctor} />
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

function LinkRow({ link, onCopy, children }: { link: ChainLink; onCopy: CopyText; children?: ReactNode }) {
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

      {children}
    </li>
  )
}

/**
 * WHICH ENUMERATION, IF ANY — the one place the fixture/live choice is made
 * (#520), so the panel below never has to ask what is driving the fold.
 *
 * A fixture wins whenever one is driving, and it is deliberately not merged
 * with the live list: `links.ts` guarantees the live list is EMPTY under a
 * fixture, so there is nothing to merge, and a component that could show both
 * at once is a component that could show a synthetic session as a real one.
 */
function Instrumentable({
  sessions,
  fixture,
  fetchImpl,
  instrumentFetchImpl,
  onCopy,
}: {
  sessions: readonly InstrumentableSession[]
  fixture: { sessions: InstrumentableSession[]; previews: Record<string, SessionPreview> } | null
  fetchImpl?: FetchLike
  instrumentFetchImpl?: InstrumentFetchLike
  onCopy: CopyText
}) {
  if (fixture !== null) {
    return <UninstrumentedSessions key="fixture" sessions={fixture.sessions} seeded={fixture.previews} live={false} onCopy={onCopy} />
  }
  if (sessions.length === 0) return null
  return (
    <UninstrumentedSessions
      key="live"
      sessions={sessions}
      live={true}
      fetchImpl={fetchImpl}
      instrumentFetchImpl={instrumentFetchImpl}
      onCopy={onCopy}
    />
  )
}

/** In an option label, and quoted: enough of a first message to recognise a conversation by. */
const PREVIEW_IN_OPTION = 48

/**
 * THE UNINSTRUMENTED SESSIONS, ENUMERATED (prd-20 w7, #520).
 *
 * The row above is unchanged and still carries the whole finding in one line.
 * This is what an operator does with it: pick the session that is theirs, read
 * enough of it to be sure, and then take one of the two paths — the button, or
 * the command.
 *
 * **Why a `<select>` and not a list of rows.** The fold can name a lot of
 * sessions at once (a 20-lane fleet with a broken dispatch names twenty), and
 * this row sits inside a checklist whose whole value is that seven rows fit on
 * one screen. A list would push the rows below it off the page in exactly the
 * incident where somebody is reading them. `replay/index.tsx` has the one
 * `<select>` precedent in this app and this follows it.
 *
 * **Previews are read lazily, per enumerated session** — never on the page's
 * poll. A session id is opaque; the first user message is the only thing that
 * answers "is this the conversation I am in?", and #516 built the route for
 * exactly this. A preview that fails to arrive costs nothing: the option keeps
 * its lane, role and age, and the panel says there is no preview rather than
 * blocking on one.
 *
 * **`live={false}` withholds the act, not the surface.** A fixture session may
 * be shown — that is what the sample fleet is for — but it must never be
 * handed to the instrument button (a real relaunch request for a session id
 * that exists only in a fixture) or to a copy button (`links.ts`'s own fixture
 * law: a synthetic lane's command must never be copyable).
 */
function UninstrumentedSessions({
  sessions,
  live,
  seeded,
  fetchImpl,
  instrumentFetchImpl,
  onCopy,
}: {
  sessions: readonly InstrumentableSession[]
  live: boolean
  seeded?: Record<string, SessionPreview>
  fetchImpl?: FetchLike
  instrumentFetchImpl?: InstrumentFetchLike
  onCopy: CopyText
}) {
  const [chosen, setChosen] = useState<string | null>(null)
  // `null` is a preview this page could not read; `undefined` is one that has
  // not answered yet, and the two say different things to a reader.
  const [previews, setPreviews] = useState<Record<string, SessionPreview | null>>({})
  const [outcomes, setOutcomes] = useState<Record<string, InstrumentOutcome>>({})

  // The dependency is the ids as a STRING, not the array: `buildLinks` returns
  // a fresh list every render, so an array dependency would re-read every
  // preview on every fold event — a poll by accident, over a route the page
  // deliberately does not poll. (A newline separator because a session id is a
  // filename-safe token wherever the server touches one; and if a malformed id
  // ever split in two, both halves would simply fail to read and show as no
  // preview, which is a label, not a fault.)
  const ids = sessions.map((session) => session.sessionId).join('\n')
  useEffect(() => {
    let alive = true
    if (live) {
      for (const sessionId of ids.split('\n').filter((id) => id.length > 0)) {
        void fetchSessionPreview(sessionId, fetchImpl).then((preview) => {
          if (alive) setPreviews((known) => ({ ...known, [sessionId]: preview }))
        })
      }
    }
    return () => {
      alive = false
    }
  }, [ids, live, fetchImpl])

  const current = sessions.find((session) => session.sessionId === chosen) ?? sessions[0]
  if (current === undefined) return null

  const previewOf = (sessionId: string): SessionPreview | null | undefined =>
    live ? previews[sessionId] : (seeded?.[sessionId] ?? null)
  const outcome = outcomes[current.sessionId]

  return (
    <div className="mt-2 rounded border border-ice-850 bg-ice-1000 px-2 py-2">
      <label className="flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-wider text-ice-400">
        <span>{sessions.length === 1 ? 'the session' : `${sessions.length} sessions`}</span>
        <select
          data-testid="connect-uninstrumented-select"
          value={current.sessionId}
          onChange={(event) => setChosen(event.target.value)}
          className="max-w-full rounded border border-ice-850 bg-ice-1000 px-2 py-1 font-sans text-[11px] normal-case tracking-normal text-ice-200"
        >
          {sessions.map((session) => (
            <option key={session.sessionId} value={session.sessionId}>
              {optionLabel(session, previewOf(session.sessionId))}
            </option>
          ))}
        </select>
      </label>

      <div data-testid="connect-uninstrumented-detail" className="mt-2 flex flex-col gap-1.5">
        <p data-testid={`connect-preview-${current.sessionId}`} className="text-[11px] leading-snug text-ice-200">
          {previewLine(previewOf(current.sessionId))}
        </p>
        <p className="figures text-[10px] text-ice-400">
          session {current.sessionId} · branch {current.place.branch ?? UNAVAILABLE} · worktree{' '}
          {current.place.worktreeTail ?? UNAVAILABLE} · {current.ageLabel}
        </p>

        {live ? (
          <>
            {/* Keyed by session so a result never outlives the selection that
                produced it: without it, instrumenting A and then choosing B
                would show B under A's outcome. */}
            <InstrumentButton
              key={current.sessionId}
              sessionId={current.sessionId}
              manualCommand={current.resumeCommand}
              onInstrumented={(result) => setOutcomes((seen) => ({ ...seen, [current.sessionId]: result }))}
              fetchImpl={instrumentFetchImpl}
              onCopy={onCopy}
              data-testid={`connect-instrument-${current.sessionId}`}
            />
            {outcome !== undefined && (
              <p
                role="status"
                data-testid={`connect-instrument-status-${current.sessionId}`}
                className={`text-[11px] leading-snug ${outcome.kind === 'instrumented' ? 'text-notice' : 'text-waiting-benign'}`}
              >
                {statusLine(outcome)}
              </p>
            )}
            {/* ALWAYS, EVEN BESIDE THE BUTTON (prd-20 ruling 3). This page
                never claims to attach to a running process, and this line is
                the path that needs nothing from this instrument at all — the
                one that still works when it cannot reach the transcript. */}
            <CommandBlock
              id={`resume-${current.sessionId}`}
              command={current.resumeCommand}
              warning={SAME_PROCESS_WARNING}
              onCopy={onCopy}
            />
            <p className="text-[10px] leading-snug text-ice-400">
              the env block on its own: <span className="font-mono text-ice-300">{current.envCommand}</span>
            </p>
          </>
        ) : (
          <p data-testid="connect-uninstrumented-fixture" className="text-[10px] leading-snug text-notice">
            these sessions are part of the sample fleet — they do not exist, so there is nothing here to instrument and
            no command worth copying. Return to live to act on a real one.
          </p>
        )}
      </div>
    </div>
  )
}

/** `<lane> · <role> · <age> · "<first words…>"` — everything needed to recognise one's own conversation in a list of opaque ids. */
function optionLabel(session: InstrumentableSession, preview: SessionPreview | null | undefined): string {
  const head = `${session.lane ?? '<lane>'} · ${session.role ?? 'unattributed'} · ${session.ageLabel}`
  if (preview === undefined) return `${head} · reading its first words…`
  const text = preview?.text ?? null
  return text === null ? `${head} · no preview` : `${head} · "${clip(text, PREVIEW_IN_OPTION)}"`
}

/** One line, whitespace flattened, cut to a length an option can actually show — the ellipsis is part of the budget, never added past it. */
function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/**
 * The preview, or WHICH nothing it is — the same three-way distinction the
 * doctor panel makes, for the same reason: "still reading", "the route says
 * there is nothing to read, and here is its own sentence", and "this page
 * could not read the route" send a reader to three different places.
 */
function previewLine(preview: SessionPreview | null | undefined): string {
  if (preview === undefined) return 'reading this session’s first words…'
  if (preview === null) return `${UNAVAILABLE} — no preview could be read for this session; nothing below depends on it`
  if (preview.text === null) {
    return preview.reason ?? 'the head of this transcript holds no user turn yet, so there are no first words to show'
  }
  return preview.dropped > 0 ? `“${preview.text}…” (+${preview.dropped} more characters)` : `“${preview.text}”`
}

/**
 * WHAT THE ACT ACTUALLY DID, in the operator's terms — and on success, the one
 * sentence the cross-host-resume spike (`research/2026-08-14-cross-host-
 * resume.md`) makes unavoidable: a resume PRESERVES the session id, so
 * telemetry books under the SAME session and this row clears itself as
 * evidence arrives. Nobody should be waiting for a new row to appear.
 */
function statusLine(outcome: InstrumentOutcome): string {
  if (outcome.kind === 'instrumented') {
    return 'instrumented — telemetry now flows under this same session; this row clears itself as evidence arrives (the old process keeps running until you end it)'
  }
  return `nothing was started, and nothing was copied — ${outcome.reason}. The command below is the way in: it needs nothing from this instrument.`
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
function DoctorPanel({ reading }: { reading: DoctorReading }) {
  return (
    <section data-testid="connect-doctor" className="mt-5">
      <h2 className="text-[10px] uppercase tracking-[0.18em] text-ice-400">
        facts the fold cannot know — <span className="font-mono normal-case tracking-normal">GET /api/doctor</span>
      </h2>
      {reading.kind !== 'checks' ? (
        // Which nothing happened, in the note itself (#381): the old copy had
        // one value for two facts and could only name both. Now the reader is
        // told whether to look at the route or at the payload.
        <p data-testid="connect-doctor-unavailable" className="mt-1 text-[11px] italic text-ice-400">
          {reading.kind === 'absent'
            ? `${UNAVAILABLE} — no usable answer from the doctor route: it may be down, erroring, or answering something other than JSON`
            : `${UNAVAILABLE} — the doctor route answered, but not one entry of its report was readable by this build of the page`}
        </p>
      ) : (
        <ul className="mt-1 flex flex-col gap-1 text-[11px]">
          {reading.checks.map((check) => (
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
