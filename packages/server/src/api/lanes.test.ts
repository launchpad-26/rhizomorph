import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sessionFilePath } from '../log/session-log.js'
import { buildApp } from '../server/build-app.js'
import { SessionRecorder } from '../server/recorder.js'
import { readLanesManifest } from './lanes.js'

describe('GET /api/lanes', () => {
  let repoPath: string
  let sessionDir: string

  beforeEach(async () => {
    repoPath = await mkdtemp(path.join(tmpdir(), 'observatory-lanes-repo-'))
    sessionDir = await mkdtemp(path.join(tmpdir(), 'observatory-lanes-session-'))
  })

  afterEach(async () => {
    await Promise.all([
      rm(repoPath, { recursive: true, force: true }),
      rm(sessionDir, { recursive: true, force: true }),
    ])
  })

  function makeApp() {
    const recorder = new SessionRecorder('1000', sessionFilePath(sessionDir, '1000'))
    return buildApp({ repoPath, repoName: 'repo', sessionDir, recorder })
  }

  async function writeManifest(content: string): Promise<void> {
    await mkdir(path.join(repoPath, '.swarm'), { recursive: true })
    await writeFile(path.join(repoPath, '.swarm', 'lanes.json'), content)
  }

  it('serves a valid manifest', async () => {
    await writeManifest(
      JSON.stringify({
        version: 1,
        lanes: [
          {
            handle: '77-attention-strip',
            branch: '77-attention-strip',
            fence: ['packages/web/src/panels/attention/**'],
            issue: '77',
            model: 'sonnet',
            dispatchedAt: '2026-07-31T20:30:00Z',
          },
        ],
      }),
    )

    const response = await makeApp().inject({ method: 'GET', url: '/api/lanes' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      available: true,
      version: 1,
      lanes: [
        {
          handle: '77-attention-strip',
          branch: '77-attention-strip',
          fence: ['packages/web/src/panels/attention/**'],
          issue: '77',
          model: 'sonnet',
          dispatchedAt: '2026-07-31T20:30:00Z',
        },
      ],
    })
  })

  it('serves a valid manifest with only the required fields', async () => {
    await writeManifest(
      JSON.stringify({
        version: 1,
        lanes: [{ handle: 'a', branch: 'a', fence: ['packages/a/**'] }],
      }),
    )

    const response = await makeApp().inject({ method: 'GET', url: '/api/lanes' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      available: true,
      version: 1,
      lanes: [{ handle: 'a', branch: 'a', fence: ['packages/a/**'] }],
    })
  })

  it('reports available: false with an honest reason when the file is absent', async () => {
    const response = await makeApp().inject({ method: 'GET', url: '/api/lanes' })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.available).toBe(false)
    expect(body.reason).toContain('.swarm/lanes.json')
  })

  it('reports available: false with the parse detail when the file is not valid JSON', async () => {
    await writeManifest('{ not valid json')

    const response = await makeApp().inject({ method: 'GET', url: '/api/lanes' })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.available).toBe(false)
    expect(body.reason).toContain('not valid JSON')
  })

  it('reports available: false with the schema detail when the file does not match the shape', async () => {
    await writeManifest(JSON.stringify({ version: 1, lanes: [{ handle: 'a' }] }))

    const response = await makeApp().inject({ method: 'GET', url: '/api/lanes' })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.available).toBe(false)
    expect(body.reason).toContain('schema')
  })

  it('never serves a silent empty list for a malformed file', async () => {
    await writeManifest('not json at all')

    const response = await makeApp().inject({ method: 'GET', url: '/api/lanes' })

    const body = response.json()
    expect(body).not.toEqual({ available: true, version: 1, lanes: [] })
    expect(body.available).toBe(false)
  })

  it('re-reads the file on every request rather than caching', async () => {
    await writeManifest(JSON.stringify({ version: 1, lanes: [] }))
    const app = makeApp()

    const first = await app.inject({ method: 'GET', url: '/api/lanes' })
    expect(first.json()).toEqual({ available: true, version: 1, lanes: [] })

    await writeManifest(
      JSON.stringify({ version: 1, lanes: [{ handle: 'b', branch: 'b', fence: ['packages/b/**'] }] }),
    )

    const second = await app.inject({ method: 'GET', url: '/api/lanes' })
    expect(second.json()).toEqual({
      available: true,
      version: 1,
      lanes: [{ handle: 'b', branch: 'b', fence: ['packages/b/**'] }],
    })
  })
})

describe('readLanesManifest', () => {
  let repoPath: string

  beforeEach(async () => {
    repoPath = await mkdtemp(path.join(tmpdir(), 'observatory-lanes-pure-'))
  })

  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true })
  })

  it('rejects a lane missing a required field', async () => {
    await mkdir(path.join(repoPath, '.swarm'), { recursive: true })
    await writeFile(
      path.join(repoPath, '.swarm', 'lanes.json'),
      JSON.stringify({ version: 1, lanes: [{ handle: 'a', branch: 'a' }] }),
    )

    const result = await readLanesManifest(repoPath)

    expect(result.available).toBe(false)
  })

  it('rejects a manifest with no version', async () => {
    await mkdir(path.join(repoPath, '.swarm'), { recursive: true })
    await writeFile(path.join(repoPath, '.swarm', 'lanes.json'), JSON.stringify({ lanes: [] }))

    const result = await readLanesManifest(repoPath)

    expect(result.available).toBe(false)
  })
})
