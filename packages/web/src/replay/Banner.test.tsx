import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEvent, createIdFactory } from '@rhizomorph/core'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ModeProvider, useReplay } from '../app/ModeContext.js'
import { ReplayBanner } from './Banner.js'
import type { FetchLike } from './api.js'

afterEach(cleanup)

const nextId = createIdFactory('evt')

function sessionEvents() {
  return [
    createEvent(
      'session.started',
      { sessionId: 's1', repoPath: '/repo', repoName: 'rhizomorph', mainBranch: 'main' },
      { id: nextId(), ts: 1_000 },
    ),
    createEvent(
      'worktree.discovered',
      { path: '/repo', branch: 'main', head: 'sha-0', isMain: true },
      { id: nextId(), ts: 4_000 },
    ),
  ]
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response
}

/** Entries the way a NEWER instrument would serve them — prd17 ruling 1's own families. */
const FUTURE_ENTRIES = [
  { id: 'evt-future-1', ts: 2_000, source: 'system', type: 'summons.raised', payload: { lane: 'a' } },
  { id: 'evt-future-2', ts: 3_000, source: 'system', type: 'operator.ack', payload: { at: 12 } },
]

function makeFetch(extra: readonly unknown[] = []): FetchLike {
  return (async (url: string | URL | Request) => {
    const href = String(url)
    if (href === '/api/sessions') {
      return jsonResponse({
        sessions: [{ id: 's1', fileName: 'session-1000.jsonl', startedAt: 1_000, sizeBytes: 100 }],
      })
    }
    if (href === '/api/sessions/s1/events') {
      return jsonResponse({ events: [...sessionEvents(), ...extra] })
    }
    throw new Error(`unexpected fetch: ${href}`)
  }) as unknown as FetchLike
}

/** Drives session selection the same way the real replay controls do. */
function ReplayDriver() {
  const { sessions, selectSession } = useReplay()
  return <button onClick={() => selectSession(sessions[0]?.id ?? null)}>select session</button>
}

async function renderBanner(extra: readonly unknown[] = []) {
  await act(async () => {
    render(
      <ModeProvider fetchImpl={makeFetch(extra)}>
        <ReplayBanner />
        <ReplayDriver />
      </ModeProvider>,
    )
  })
  await act(async () => {
    fireEvent.click(screen.getByText('select session'))
  })
}

const WEB_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('ReplayBanner', () => {
  it('states the past directly rather than through color', async () => {
    await renderBanner()
    expect(screen.getByText('Replay')).toBeInTheDocument()
    expect(screen.getByText(/viewing a recorded past/i)).toBeInTheDocument()
  })

  it('shows the timestamp being viewed, as an absolute wall clock', async () => {
    await renderBanner()
    // Playback starts at the session's first event, ts 1000ms.
    expect(screen.getByTitle('timestamp being viewed')).toHaveTextContent('1970-01-01 00:00:01')
  })

  it('shows session identity — repo and recording file', async () => {
    await renderBanner()
    const identity = screen.getByTitle('session identity')
    expect(identity).toHaveTextContent('rhizomorph')
    expect(identity).toHaveTextContent('session-1000.jsonl')
  })

  it('exits to live cleanly on click', async () => {
    await renderBanner()
    expect(screen.getByText('rhizomorph')).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Exit to live' }))
    })

    expect(screen.queryByTitle('session identity')).not.toBeInTheDocument()
  })

  it('never reaches for a ladder hue — the mode shift is chrome, not a status', async () => {
    await renderBanner()
    const banner = screen.getByRole('status')
    // Law 9: none of the four alarm-ladder colour tokens may appear anywhere
    // in the banner's tree — a mode is not a status.
    for (const ladderHue of ['calm', 'notice', 'needs-you', 'broken']) {
      expect(banner.innerHTML).not.toContain(`-${ladderHue}`)
    }
  })
})

/**
 * prd17 ruling 3, item 1 — the replay banner's share of the voice. A recording
 * carrying events from an era this bundle was not taught must SAY SO, where
 * "what am I looking at" is already the question. Never a silently shorter
 * history.
 */
describe('ReplayBanner — the unknown-era voice', () => {
  it('says nothing about unknowns for a recording entirely from this era', async () => {
    await renderBanner()
    expect(screen.queryByTestId('replay-unknown-era')).not.toBeInTheDocument()
  })

  it('voices the honest gap, counting the events and naming their families', async () => {
    await renderBanner(FUTURE_ENTRIES)
    expect(screen.getByTestId('replay-unknown-era')).toHaveTextContent(
      '2 events from a newer era were preserved but not understood (operator.ack, summons.raised)',
    )
  })

  it('still replays everything it does understand — the gap is a caveat, not a refusal', async () => {
    await renderBanner(FUTURE_ENTRIES)
    expect(screen.getByTitle('session identity')).toHaveTextContent('rhizomorph')
    expect(screen.getByText(/viewing a recorded past/i)).toBeInTheDocument()
  })

  it('voices it in the ice register — a gap in our reading is not a summons off the fleet', async () => {
    await renderBanner(FUTURE_ENTRIES)
    const voice = screen.getByTestId('replay-unknown-era')
    for (const ladderHue of ['calm', 'notice', 'needs-you', 'broken']) {
      expect(voice.className).not.toContain(`-${ladderHue}`)
    }
  })

  it('drops the voice again on exit to live', async () => {
    await renderBanner(FUTURE_ENTRIES)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Exit to live' }))
    })
    expect(screen.queryByTestId('replay-unknown-era')).not.toBeInTheDocument()
  })
})

/**
 * ONE BANNER, AND IT IS THIS ONE (walkthrough, 2026-08-17).
 *
 * This component had existed, tested and fully token-lawful, since #83 — and
 * **nothing imported it**, because `app/Shell.tsx` defined a duplicate inline
 * stub that said "#83" and offered no way out of replay. Two implementations,
 * one rendered, and the rendered one was the placeholder.
 *
 * The walkthrough's finding was the duplication; the resolution is to mount the
 * component that was already finished and delete the stub, rather than the
 * other way round. Deleting *this* one would have kept a banner with no
 * timestamp, no session identity, no unknown-era voice and no `Exit to live`
 * control, and every test above would have gone with it.
 *
 * So the claim is checked at the level of the source text, the way the read-only
 * constitution is: exactly one file in the package draws a replay banner, and it
 * is this one.
 */
describe('the replay banner is drawn in exactly one place', () => {
  function sourceFiles(): { name: string; text: string }[] {
    const out: { name: string; text: string }[] = []
    const visit = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          visit(full)
          continue
        }
        if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue
        out.push({ name: path.relative(WEB_SRC, full), text: readFileSync(full, 'utf8') })
      }
    }
    visit(WEB_SRC)
    return out
  }

  it('marks the banner in one source file, and it is Banner.tsx', () => {
    const drawn = sourceFiles()
      .filter((file) => file.text.includes('data-panel="replay-banner"'))
      .map((file) => file.name)

    expect(drawn).toEqual([path.join('replay', 'Banner.tsx')])
  })

  it('is the component the shell actually mounts', () => {
    // The other half: one implementation is worth nothing if the shell renders
    // none of them. Before this commit `Shell.tsx` imported no banner at all.
    const shell = readFileSync(path.join(WEB_SRC, 'app', 'Shell.tsx'), 'utf8')
    expect(shell).toMatch(/import \{ ReplayBanner \} from '\.\.\/replay\/Banner\.js'/)
    expect(shell).toMatch(/<ReplayBanner \/>/)
    // …and defines no banner of its own any more.
    expect(shell).not.toMatch(/function ReplayBanner/)
  })

  it('the sweep bites — a second banner anywhere would be named', () => {
    // Without this, the assertion above passes identically against a typo'd
    // marker string that matches nothing at all.
    expect(sourceFiles().length).toBeGreaterThan(50)
    expect('data-panel="replay-banner"'.includes('replay-banner')).toBe(true)
  })
})
