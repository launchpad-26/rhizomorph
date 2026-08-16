import { describe, expect, it } from 'vitest'
import { failurePage, restartHint } from './failure-page.js'
import type { ServerStatus } from './supervisor.js'

const FAILED: ServerStatus = {
  phase: 'failed',
  url: null,
  detail: 'the server exited with code 1 before the shell asked it to',
  outputTail: ['port 4321 is already in use — pass a different one with --port <n>'],
}

describe('the honest failure page (D43)', () => {
  const page = failurePage({ status: FAILED, at: '2026-08-16T09:30:00.000Z', repoPath: '/home/dev/project' })

  it('names what died', () => {
    expect(page).toContain('the server exited with code 1 before the shell asked it to')
  })

  it('names when', () => {
    expect(page).toContain('2026-08-16T09:30:00.000Z')
  })

  it('names how to restart it, with the repo it was watching', () => {
    expect(page).toContain('npx rhizomorph /home/dev/project')
  })

  it('shows what the server printed, so the terminal is not the only place the truth lives', () => {
    expect(page).toContain('port 4321 is already in use')
  })

  it('says the shell is still running — the failure is loud, not fatal', () => {
    expect(page).toContain('still running')
  })

  it('names the absence when there was no output at all, rather than rendering an empty box', () => {
    const silent = failurePage({
      status: { ...FAILED, outputTail: [] },
      at: '2026-08-16T09:30:00.000Z',
      repoPath: null,
    })
    expect(silent).toContain('printed nothing')
    expect(silent).toContain('npx rhizomorph<')
  })

  it('says something even when the server failed without a reason', () => {
    const page = failurePage({ status: { ...FAILED, detail: null }, at: 'now', repoPath: null })
    expect(page).toContain('stopped without saying why')
  })
})

describe('the page cannot be mistaken for the instrument', () => {
  const page = failurePage({ status: FAILED, at: 'now', repoPath: '/repo' })

  it('renders no fleet, no lane, no ladder word and no number that could read as telemetry', () => {
    expect(page).not.toMatch(/ALL CLEAR|NEEDS YOU|BROKEN|NOTICE/)
    expect(page).not.toMatch(/lane|worktree|\$\d/i)
  })

  it('runs no script and fetches nothing — it is the one page that cannot itself fail', () => {
    expect(page).not.toContain('<script')
    expect(page).not.toContain('fetch(')
  })
})

describe('escaping', () => {
  it('escapes server output rather than letting it become markup', () => {
    const page = failurePage({
      status: { ...FAILED, detail: '<img src=x onerror=alert(1)>', outputTail: ['</dd><script>bad()</script>'] },
      at: 'now',
      repoPath: null,
    })
    expect(page).not.toContain('<img')
    expect(page).not.toContain('<script>bad()')
    expect(page).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })
})

describe('the restart hint', () => {
  it('names the repo when there is one, and stays a bare command when there is not', () => {
    expect(restartHint('/repo')).toBe('npx rhizomorph /repo')
    expect(restartHint(null)).toBe('npx rhizomorph')
  })
})
