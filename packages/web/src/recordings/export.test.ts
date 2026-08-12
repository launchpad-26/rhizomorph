import { describe, expect, it, vi } from 'vitest'
import { createEvent } from '@rhizomorph/core'
import { exportRecording, type DownloadEnv } from './export.js'
import type { FetchLike } from '../replay/api.js'

const EVENTS = [
  createEvent('session.started', { sessionId: '1000', repoPath: '/repo', repoName: 'demo' }, { id: 'e1', ts: 1000 }),
]

function fetchImplFor(repoName: string): FetchLike {
  return (async (url: string) => {
    if (url === '/api/meta') {
      return { ok: true, status: 200, json: async () => ({ repoName }) } as Response
    }
    if (url.startsWith('/api/sessions/')) {
      return { ok: true, status: 200, json: async () => ({ events: EVENTS }) } as Response
    }
    throw new Error(`unexpected url: ${url}`)
  }) as FetchLike
}

function fakeDownloadEnv() {
  const anchor = { href: '', download: '', click: vi.fn() }
  const env: DownloadEnv = {
    createObjectURL: vi.fn(() => 'blob:fake-url'),
    revokeObjectURL: vi.fn(),
    createAnchor: vi.fn(() => anchor),
    appendAnchor: vi.fn(),
    removeAnchor: vi.fn(),
  }
  return { env, anchor }
}

describe('exportRecording', () => {
  it('builds the portable record from the session\'s own events, reading nothing but GETs', async () => {
    const { env } = fakeDownloadEnv()
    const fetchImpl = vi.fn(fetchImplFor('demo'))

    const outcome = await exportRecording('1000', fetchImpl, env)

    expect(outcome.fileName).toBe('demo-1000.rhizorecord.json')
    expect(outcome.record.manifest.repoSlug).toBe('demo')
    expect(outcome.record.manifest.eventCount).toBe(1)
    expect(outcome.record.body).toHaveLength(1)
    expect(outcome.record.body[0]?.line).toContain('session.started')
  })

  it('triggers exactly one download, with the record as its content', async () => {
    const { env, anchor } = fakeDownloadEnv()
    await exportRecording('1000', fetchImplFor('demo'), env)

    expect(env.createAnchor).toHaveBeenCalledTimes(1)
    expect(anchor.click).toHaveBeenCalledTimes(1)
    expect(anchor.download).toBe('demo-1000.rhizorecord.json')
    expect(env.revokeObjectURL).toHaveBeenCalledWith('blob:fake-url')
  })

  it('falls back to a generic repo name rather than failing the export', async () => {
    const { env } = fakeDownloadEnv()
    const fetchImpl: FetchLike = (async (url: string) => {
      if (url === '/api/meta') return { ok: true, status: 200, json: async () => ({}) } as Response
      return { ok: true, status: 200, json: async () => ({ events: EVENTS }) } as Response
    }) as FetchLike

    const outcome = await exportRecording('1000', fetchImpl, env)
    expect(outcome.fileName).toBe('repo-1000.rhizorecord.json')
  })

  /**
   * #292, on the browser's own export path. This one does NOT go through the
   * CLI's `parseJsonl`: `fetchSessionEvents` reads the API's JSON with
   * `parseEventLenient` (`replay/api.ts`), a different reader, and hands the
   * result to the same `buildRecord`. A pre-change session replayed in a tab
   * and downloaded must strip the captured line exactly as the CLI does —
   * otherwise the leak just moves to the button.
   */
  it('strips a legacy pane.activity `preview` out of the downloaded record', async () => {
    const { env } = fakeDownloadEnv()
    const legacy = {
      v: 1,
      id: 'e2',
      ts: 2000,
      source: 'tmux',
      type: 'pane.activity',
      payload: { paneId: '%1', contentHash: 'h1', lines: 42, preview: 'sk-live-SENTINEL-9f2a' },
    }
    const fetchImpl: FetchLike = (async (url: string) => {
      if (url === '/api/meta') {
        return { ok: true, status: 200, json: async () => ({ repoName: 'demo' }) } as Response
      }
      return { ok: true, status: 200, json: async () => ({ events: [...EVENTS, legacy] }) } as Response
    }) as FetchLike

    const outcome = await exportRecording('1000', fetchImpl, env)

    // Stripped, not dropped — both lines are still in the record.
    expect(outcome.record.manifest.eventCount).toBe(2)
    const serialized = JSON.stringify(outcome.record)
    expect(serialized).not.toContain('sk-live-SENTINEL-9f2a')
    expect(serialized).not.toContain('preview')
    expect(outcome.record.body[1]?.line).toContain('"contentHash":"h1"')
  })

  it('throws rather than silently exporting nothing when /api/meta refuses', async () => {
    const { env } = fakeDownloadEnv()
    const fetchImpl = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as FetchLike

    await expect(exportRecording('1000', fetchImpl, env)).rejects.toThrow('/api/meta responded 500')
  })
})
