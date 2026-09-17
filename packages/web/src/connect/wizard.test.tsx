import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CloneFetchLike } from '../concierge/clone.js'
import type { InstrumentFetchLike } from '../concierge/instrument.js'
import { RETARGET_URL, type RetargetFetchLike } from '../concierge/retarget.js'
import { CAPABILITY_META_NAME } from '../recordings/capability.js'
import type { ChainLink, InstrumentableSession } from './links.js'
import { type FetchLike, type MetaFacts, REPO_SELECT_CAP, REPOS_URL } from './meta.js'
import { HARNESSES, SetupWizard, WIZARD_STEPS } from './wizard.js'

/**
 * THE SETUP WIZARD (prd-20 wave 4, #266) — repo → conductor → verify.
 *
 * Three properties are load-bearing enough to be laws rather than cases, and
 * each is tested through the real seam rather than around it:
 *
 * 1. **The declared harnesses are stated honestly.** The catalogue in
 *    `wizard.tsx` is a second statement of facts that live in the server's
 *    adapter registry, and the honesty law at the bottom of this file reads the
 *    REAL adapter sources and fails the moment the two disagree.
 * 2. **A repo that is not the watched one gets a command, never a button.** The
 *    launch route takes no repo; offering a button that silently started a
 *    conductor somewhere else is the most expensive lie this page could tell.
 * 3. **The verify step is the page's own rows.** Not a re-derivation — the same
 *    `ChainLink[]`, so a row here changes for exactly the reason the row below
 *    it does.
 */

afterEach(cleanup)

/** Stands in for what `server/static.ts` stamps into `index.html` on a real boot (ADR-0012). */
beforeAll(() => {
  const meta = document.createElement('meta')
  meta.setAttribute('name', CAPABILITY_META_NAME)
  meta.setAttribute('content', 'test-capability-token')
  document.head.appendChild(meta)
})

const WATCHED = '/home/x/repo'

const META: MetaFacts = {
  sessionId: 'sess-ours',
  repoPath: WATCHED,
  repoName: 'repo',
  rung: 'L2',
  collectors: [],
  connection: null,
  boot: null,
}

const REPOS_BODY = {
  available: true,
  known: {
    available: true,
    projects: [
      { slug: '-home-x-repo', path: WATCHED, resolved: true },
      { slug: '-home-x-other', path: '/home/x/other', resolved: true },
      { slug: '-home-x-ambiguous', path: null, resolved: false, reason: 'two entries encode to the same slug' },
    ],
  },
  scanned: { repos: [{ path: '/home/x/code/scanned' }, { path: WATCHED }], truncated: true, unreadable: ['/home/x/Desktop'] },
}

/** The route's own answer to a successful switch — spelled once, reused by every case below that needs one. */
const SWITCHED = {
  closed: { sessionId: '1000', filePath: '/data/repo-aaaa/session-1000.jsonl', eventCount: 12, closedAt: 5000, synced: true },
  opened: { sessionId: '5000', filePath: '/data/other-bbbb/session-5000.jsonl', startedAt: 5000 },
  from: { repoPath: '/home/x/repo', repoName: 'repo', repoSlug: 'repo-aaaa', sessionDir: '/data/repo-aaaa' },
  to: { repoPath: '/home/x/other', repoName: 'other', repoSlug: 'other-bbbb', sessionDir: '/data/other-bbbb' },
  telemetry: {
    previousInstance: '1000',
    instance: '5000',
    lanes: ['lane-a', 'lane-b'],
    reissue: ['rhizomorph env lane-a --port 4317', 'rhizomorph env lane-b --port 4317'],
    reissueTemplate: 'rhizomorph env <lane> --port 4317',
    lost: ['llm.cost', 'llm.usage (OTLP)', 'trace.span', 'active time'],
    stillWorking: ['git', 'tmux', 'workmux', 'sessionlog transcripts'],
    note: '2 lanes still export as instance 1000 and are now refused whole — re-issue the env above.',
  },
}

function reposFetch(body: unknown = REPOS_BODY, ok = true): FetchLike {
  return async (input) => {
    if (input === REPOS_URL) return { ok, json: async () => body }
    throw new Error(`unexpected fetch: ${input}`)
  }
}

/**
 * One row of each state, so the verify step has something with all three
 * readings in it.
 *
 * Written as literals rather than through `links.ts`'s own `verified`/`broken`/
 * `unproven` constructors, which are private to that module — the wizard
 * RECEIVES rows and never builds one, so a fixture that reaches for the
 * builders would be testing a coupling this component does not have. What it
 * needs is the shape, and the shape is `ChainLink`.
 */
function someLinks(): ChainLink[] {
  const base = (id: string, label: string) => ({
    id,
    label,
    question: `does ${label} hold?`,
    evidence: 'fold' as const,
    fact: null,
    ts: null,
    tsKind: null,
    reason: null,
    command: null,
    warning: null,
    notes: [],
  })
  return [
    { ...base('browser-server', 'browser ↔ server'), state: 'verified', fact: 'the stream is open', ts: 1000, tsKind: 'render' },
    {
      ...base('uninstrumented-conductor', 'conductor ↔ instrument'),
      state: 'broken',
      reason: 'a conductor is running unwired',
      command: 'eval "$(rhizomorph env conductor --port 4317)" && claude',
    },
    { ...base('repo-git', 'repo ↔ git'), state: 'unproven' },
  ]
}

/** One enumerated session, for the rows whose count the conductor step reads. */
function sessionFixture(sessionId: string): InstrumentableSession {
  return {
    sessionId,
    lane: 'lane-a',
    role: 'conductor',
    ageLabel: '12m00s ago',
    place: { branch: 'main', worktreeTail: 'repo' },
    resumeCommand: `eval "$(rhizomorph env lane-a --role conductor --port 4317)" && claude --resume ${sessionId}`,
    envCommand: 'rhizomorph env lane-a --role conductor --port 4317',
  }
}

interface RenderOptions {
  links?: ChainLink[]
  meta?: MetaFacts | null
  live?: boolean
  fetchImpl?: FetchLike
  instrumentFetchImpl?: InstrumentFetchLike
  cloneFetchImpl?: CloneFetchLike
  retargetFetchImpl?: RetargetFetchLike
  onRetargeted?: () => void
}

async function renderWizard(options: RenderOptions = {}) {
  const onCopy = vi.fn(async () => undefined)
  let result: ReturnType<typeof render> | undefined
  await act(async () => {
    result = render(
      <SetupWizard
        links={options.links ?? someLinks()}
        meta={options.meta === undefined ? META : options.meta}
        live={options.live ?? true}
        port="4317"
        fetchImpl={options.fetchImpl ?? reposFetch()}
        instrumentFetchImpl={options.instrumentFetchImpl}
        cloneFetchImpl={options.cloneFetchImpl}
        retargetFetchImpl={options.retargetFetchImpl}
        onRetargeted={options.onRetargeted}
        onCopy={onCopy}
      />,
    )
  })
  return { onCopy, rerender: result!.rerender }
}

/** A transport that answers a fixed retarget body — the shape every switch case below needs, once. */
function switching(body: unknown, status = 200): RetargetFetchLike {
  return async () => ({ ok: status < 300, status, json: async () => body })
}

function step(name: (typeof WIZARD_STEPS)[number]) {
  fireEvent.click(screen.getByTestId(`wizard-step-${name}`))
}

describe('the wizard walks enlist → connect', () => {
  it('opens on the enlist step and can reach every step it declares', async () => {
    await renderWizard()

    // The repo picker is still the first thing on the page — it moved INTO the
    // enlist step rather than away (prd-57 ruling 8's collapse).
    expect(screen.getByTestId('wizard-repo')).toBeTruthy()
    for (const name of WIZARD_STEPS) {
      step(name)
      expect(screen.getByTestId(`wizard-${name}`)).toBeTruthy()
    }
    // Every declared step really is reachable — a step in the list with no
    // panel behind it would have thrown above rather than passing quietly.
    // TWO since prd-57 ruling 8: the conductor step's requirement went away
    // with ruling 4, so it stopped being a step and became one of the things
    // the enlist step offers.
    expect(WIZARD_STEPS.length).toBe(2)
  })
})

describe('step 1 — the repo', () => {
  it('names the repo this instrument is watching, before any list', async () => {
    await renderWizard()

    expect(screen.getByTestId('wizard-watched').textContent).toBe(WATCHED)
  })

  it('offers the repos discovery found, merged by path so a repo known twice is one option', async () => {
    await renderWizard()

    await waitFor(() => expect(screen.getByTestId('wizard-repo-select')).toBeTruthy())
    const options = [...screen.getByTestId('wizard-repo-select').querySelectorAll('option')].map(
      (option) => option.getAttribute('value'),
    )
    // The watched repo is in `known` AND in `scanned`; it appears once.
    expect(options).toEqual([WATCHED, '/home/x/other', '/home/x/code/scanned'])
  })

  it('says which repo is watched now and how each of the others was found', async () => {
    await renderWizard()

    await waitFor(() => expect(screen.getByTestId('wizard-repo-select')).toBeTruthy())
    const labels = [...screen.getByTestId('wizard-repo-select').querySelectorAll('option')].map(
      (option) => option.textContent,
    )
    expect(labels[0]).toContain('watched now')
    expect(labels[1]).toContain('claude has history here')
    expect(labels[2]).toContain('found by scanning')
  })

  /**
   * The limits are the point. A picker that showed a short list with no note
   * would be saying "these are your repos" while meaning "these are some of
   * them", on the page whose whole subject is whether this instrument tells the
   * truth.
   */
  it('says what the discovery could NOT see — a truncated scan, an unreadable directory, an unresolvable slug', async () => {
    await renderWizard()

    await waitFor(() => expect(screen.getByTestId('wizard-repos-limits')).toBeTruthy())
    const limits = screen.getByTestId('wizard-repos-limits').textContent ?? ''
    expect(limits).toContain('visit budget')
    expect(limits).toContain('/home/x/Desktop')
    // The unresolved slug and its reason survive the fold — inside the
    // <details>, still in the document, still named.
    expect(limits).toContain('-home-x-ambiguous')
    expect(limits).toContain('two entries encode to the same slug')
    // And the fold's own sentence carries the count.
    expect(limits).toContain('1 more place this instrument could not resolve')
  })

  it('folds a crowd of dead worktree-lane slugs into ONE counted line — 289 sentences was the finding', async () => {
    const lanes = Array.from({ length: 12 }, (_, i) => ({
      slug: `-home-x-repo--worktrees-${i}-lane`,
      path: null,
      resolved: false,
      reason: 'no directory under /home/x matches the next part of the slug',
    }))
    await renderWizard({
      fetchImpl: reposFetch({
        ...REPOS_BODY,
        known: { available: true, projects: [...REPOS_BODY.known.projects, ...lanes] },
      }),
    })

    await waitFor(() => expect(screen.getByTestId('wizard-repos-unresolved')).toBeTruthy())
    const fold = screen.getByTestId('wizard-repos-worktree-fold').textContent ?? ''
    expect(fold).toContain('12 of these are worktree-lane slugs')
    // Grouped means grouped: no lane slug gets its own sentence...
    const items = [...screen.getByTestId('wizard-repos-unresolved').querySelectorAll('li')]
    expect(items.filter((li) => (li.textContent ?? '').includes('--worktrees-'))).toHaveLength(1)
    // ...while the non-worktree straggler keeps its own named reason.
    expect(screen.getByTestId('wizard-repos-unresolved').textContent).toContain('-home-x-ambiguous')
    // Collapsed by default — a fact available on demand, not a wall.
    expect(screen.getByTestId('wizard-repos-unresolved').hasAttribute('open')).toBe(false)
  })

  it('names the places Claude has history that are not repos, instead of offering them as repos', async () => {
    await renderWizard({
      fetchImpl: reposFetch({
        ...REPOS_BODY,
        known: {
          available: true,
          projects: [...REPOS_BODY.known.projects, { slug: '-home-x', path: '/home/x', resolved: true, repoRoot: null }],
        },
      }),
    })

    await waitFor(() => expect(screen.getByTestId('wizard-repos-nonrepos')).toBeTruthy())
    expect(screen.getByTestId('wizard-repos-nonrepos').textContent).toContain('/home/x')
    // And it is NOT in the picker.
    const options = [...screen.getByTestId('wizard-repo-select').querySelectorAll('option')].map((option) =>
      option.getAttribute('value'),
    )
    expect(options).not.toContain('/home/x')
  })

  it('says how many repos the cap cut, and that the clone box reaches them', async () => {
    const many = Array.from({ length: REPO_SELECT_CAP + 3 }, (_, i) => ({
      slug: `-home-x-r${i}`,
      path: `/home/x/r${i}`,
      resolved: true,
      repoRoot: `/home/x/r${i}`,
    }))
    await renderWizard({
      fetchImpl: reposFetch({ ...REPOS_BODY, known: { available: true, projects: many } }),
    })

    await waitFor(() => expect(screen.getByTestId('wizard-repos-limits')).toBeTruthy())
    const limits = screen.getByTestId('wizard-repos-limits').textContent ?? ''
    expect(limits).toContain(`the picker caps at ${REPO_SELECT_CAP}`)
    expect(limits).toContain('clone box below reaches any of them')
  })

  it("shows a replay server's own refusal as a sentence, never as an empty list", async () => {
    await renderWizard({
      fetchImpl: reposFetch({ available: false, reason: 'not applicable — this server is replaying a session record' }),
    })

    await waitFor(() =>
      expect(screen.getByTestId('wizard-repos-unavailable').textContent).toContain('replaying a session record'),
    )
  })

  it('says so when the route could not be read at all, and still offers the watched repo', async () => {
    await renderWizard({ fetchImpl: reposFetch(null, false) })

    await waitFor(() => expect(screen.getByTestId('wizard-repos-absent')).toBeTruthy())
    const options = [...screen.getByTestId('wizard-repo-select').querySelectorAll('option')].map(
      (option) => option.getAttribute('value'),
    )
    expect(options).toEqual([WATCHED])
  })

  it('reads the repo route exactly once — this list is a filesystem walk, never a poll', async () => {
    const fetchImpl = vi.fn(reposFetch())
    await renderWizard({ fetchImpl })

    await waitFor(() => expect(screen.getByTestId('wizard-repo-select')).toBeTruthy())
    step('enlist')
    step('enlist')

    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe('step 1 — cloning one', () => {
  /** A 200 carrying the route's real NDJSON body. */
  function cloning(lines: readonly unknown[]): CloneFetchLike {
    const body = lines.map((line) => JSON.stringify(line)).join('\n')
    return async () => ({ ok: true, status: 200, json: async () => JSON.parse(body) as unknown, text: async () => body })
  }

  it('will not clone with an empty box, and clones what was typed', async () => {
    const cloneFetchImpl = vi.fn(cloning([{ type: 'done', path: '/home/x/.rhizomorph/clones/repo' }]))
    await renderWizard({ cloneFetchImpl })

    expect(screen.getByTestId<HTMLButtonElement>('wizard-clone').disabled).toBe(true)

    fireEvent.change(screen.getByTestId('wizard-clone-url'), { target: { value: ' https://host/o/r.git ' } })
    expect(screen.getByTestId<HTMLButtonElement>('wizard-clone').disabled).toBe(false)
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-clone'))
    })

    // Trimmed, because a pasted URL routinely carries whitespace and the route
    // refuses one that contains any.
    expect(cloneFetchImpl.mock.calls[0]?.[1].body).toBe(JSON.stringify({ url: 'https://host/o/r.git' }))
  })

  it('reports where it landed, and says plainly that the watched repo did not change', async () => {
    await renderWizard({ cloneFetchImpl: cloning([{ type: 'done', path: '/home/x/.rhizomorph/clones/repo' }]) })

    fireEvent.change(screen.getByTestId('wizard-clone-url'), { target: { value: 'https://host/o/r.git' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-clone'))
    })

    const result = screen.getByTestId('wizard-clone-result').textContent ?? ''
    expect(result).toContain('/home/x/.rhizomorph/clones/repo')
    expect(result).toContain(`still watching ${WATCHED}`)
  })

  it("shows git's own account when the clone failed, rather than a status", async () => {
    await renderWizard({
      cloneFetchImpl: cloning([
        { type: 'progress', line: 'Cloning into repo...' },
        { type: 'error', message: 'git exited with code 128' },
      ]),
    })

    fireEvent.change(screen.getByTestId('wizard-clone-url'), { target: { value: 'https://host/o/r.git' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-clone'))
    })

    expect(screen.getByTestId('wizard-clone-result').textContent).toContain('git exited with code 128')
    expect(screen.getByTestId('wizard-clone-progress').textContent).toContain('Cloning into repo...')
  })

  it('shows a refusal as its own sentence, and clones nothing', async () => {
    const cloneFetchImpl = vi.fn<CloneFetchLike>(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: '"url" must not embed a credential' }),
      text: async () => '',
    }))
    await renderWizard({ cloneFetchImpl })

    fireEvent.change(screen.getByTestId('wizard-clone-url'), { target: { value: 'https://tok@host/o/r.git' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-clone'))
    })

    expect(screen.getByTestId('wizard-clone-error').textContent).toContain('must not embed a credential')
  })

  /** Ruling 6's law, applied to an act: a fixture may show this surface and must never be handed it. */
  it('withholds the clone entirely while a fixture is driving the page', async () => {
    await renderWizard({ live: false })

    fireEvent.change(screen.getByTestId('wizard-clone-url'), { target: { value: 'https://host/o/r.git' } })
    expect(screen.getByTestId<HTMLButtonElement>('wizard-clone').disabled).toBe(true)
    expect(screen.getByTestId('wizard-clone-fixture')).toBeTruthy()
  })
})

describe('step 2 — the conductor', () => {
  const LAUNCHED_IN_TMUX = {
    harness: 'claude',
    mode: 'launch',
    migration: null,
    kind: 'launched',
    via: 'tmux',
    pid: 4242,
    window: 'main:3',
  }

  function answering(payload: unknown, status = 200): InstrumentFetchLike {
    return async () => ({ ok: status >= 200 && status < 300, status, json: async () => payload })
  }

  /**
   * TWO CLICKS, because there are two (prd-14 ruling 4; ledger #2). The first
   * arms and spends nothing; the second is the only one that reaches the app's
   * fourth mutating call. Every test below that wants an outcome goes through
   * this, so a launch that ever became reachable in one click would fail the
   * arming tests rather than quietly changing what these ones exercise.
   */
  async function launch() {
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-launch'))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-launch-confirm'))
    })
  }

  /**
   * **THE FIRST CLICK SPENDS NOTHING** — the finding itself. This step reaches
   * the same mutating call `InstrumentButton` does, over a process that costs
   * real money, and it used to reach it on a single unarmed click while
   * `concierge/instrument.ts`'s own module doc claimed the act sat behind a
   * confirmation. Asserting the panel appeared is not enough: what makes this
   * a test of the BAR rather than of a panel is `not.toHaveBeenCalled()`.
   */
  it('arms before it spends — the first click starts nothing at all', async () => {
    const instrumentFetchImpl = vi.fn(answering(LAUNCHED_IN_TMUX))
    await renderWizard({ instrumentFetchImpl })
    step('enlist')

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-launch'))
    })

    expect(instrumentFetchImpl).not.toHaveBeenCalled()
    expect(screen.queryByTestId('wizard-launch-result')).toBeNull()
    // What it costs, and what it does NOT stop, said before the money is spent.
    const armed = screen.getByTestId('wizard-launch-confirm-dialog').textContent ?? ''
    expect(armed).toContain('spends real money')
    expect(armed).toContain('Nothing here stops a process you already have running')
  })

  it('cancelling an armed launch spends nothing and puts the button back', async () => {
    const instrumentFetchImpl = vi.fn(answering(LAUNCHED_IN_TMUX))
    await renderWizard({ instrumentFetchImpl })
    step('enlist')

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-launch'))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-launch-cancel'))
    })

    expect(instrumentFetchImpl).not.toHaveBeenCalled()
    expect(screen.queryByTestId('wizard-launch-confirm-dialog')).toBeNull()
    expect(screen.getByTestId('wizard-launch')).toBeTruthy()
  })

  it('lists every harness the registry knows, implemented and merely named alike', async () => {
    await renderWizard()
    step('enlist')

    const options = [...screen.getByTestId('wizard-harness-select').querySelectorAll('option')].map(
      (option) => option.getAttribute('value'),
    )
    expect(options).toEqual(HARNESSES.map((harness) => harness.id))
    // Named, not ranked (ADR-0010): the order is the registry's own alphabetical one.
    expect(options).toEqual([...options].sort())
  })

  it('states what a declared harness would take, and offers no way to start it', async () => {
    await renderWizard()
    step('enlist')
    fireEvent.change(screen.getByTestId('wizard-harness-select'), { target: { value: 'pi' } })

    const declared = screen.getByTestId('wizard-harness-declared').textContent ?? ''
    expect(declared).toContain('a captured pi launch under a real env/argv recipe')
    expect(declared).not.toContain('coming soon')
    expect(screen.getByTestId<HTMLButtonElement>('wizard-launch').disabled).toBe(true)
  })

  /**
   * **IMPLEMENTED IS NOT INSTRUMENTED** (ledger #4), per harness, through the
   * real picker rather than by reading the catalogue back.
   *
   * codex detects, launches and has a continuity story — and its adapter
   * declares telemetry ABSENT with two named blockers, so every affordance
   * that framed a launch as instrumenting was making a promise the registry
   * itself refuses. What is asserted here is what an operator standing in front
   * of the step actually reads: the button's own verb, the confirmation's, and
   * the reason in the registry's own words.
   */
  it('frames a claude launch as instrumented, because its adapter proves telemetry', async () => {
    await renderWizard()
    step('enlist')

    expect(screen.getByTestId('wizard-harness-telemetry').textContent).toContain('telemetry: proven for Claude Code')
    expect(screen.getByTestId('wizard-launch').textContent).toBe('start it instrumented')

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-launch'))
    })
    expect(screen.queryByTestId('wizard-launch-uninstrumented')).toBeNull()
  })

  it('refuses to frame a codex launch as instrumenting, and says the registry’s own reason', async () => {
    await renderWizard()
    step('enlist')
    fireEvent.change(screen.getByTestId('wizard-harness-select'), { target: { value: 'codex' } })

    const telemetry = screen.getByTestId('wizard-harness-telemetry').textContent ?? ''
    expect(telemetry).toContain('telemetry: absent for Codex CLI')
    expect(telemetry).toContain('the rows in step 3 will not flip for it')
    // The registry's own words, not a softer version this page invented.
    expect(telemetry).toContain('exports into a 404')
    expect(telemetry).toContain('what it would take: both halves')
    // The verb the harness has actually earned — the finding itself.
    expect(screen.getByTestId('wizard-launch').textContent).not.toContain('start it instrumented')
    expect(screen.getByTestId('wizard-launch').textContent).toContain('launches uninstrumented')

    // …and said AGAIN in the panel that spends, where the operator is at the
    // moment the money goes rather than a minute earlier at the picker.
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-launch'))
    })
    const armed = screen.getByTestId('wizard-launch-uninstrumented').textContent ?? ''
    expect(armed).toContain('It will not be instrumented')
    expect(armed).toContain('spends money this instrument cannot see')
  })

  /**
   * The SERVER's own claim about the launch that actually happened, which the
   * browser used to drop at `instrument.ts`'s destructure. It outranks the
   * catalogue's restatement of the same adapter fact, so a launch whose answer
   * says telemetry is absent must not close with "watch the rows change".
   */
  it('reports the answer’s own telemetry fact after the launch, not step 3’s promise', async () => {
    await renderWizard({
      instrumentFetchImpl: answering({
        ...LAUNCHED_IN_TMUX,
        telemetry: { level: 'absent', reason: 'codex exports into a 404', remedy: 'a bare-path OTLP route' },
      }),
    })
    step('enlist')
    await launch()

    const said = screen.getByTestId('wizard-launch-telemetry').textContent ?? ''
    expect(said).toContain('will not flip for what was just started')
    expect(said).toContain('codex exports into a 404')
    expect(said).toContain('a bare-path OTLP route')
    expect(said).not.toContain('watch the rows change')
  })

  it('says step 3 settles it when the answer proves telemetry', async () => {
    await renderWizard({ instrumentFetchImpl: answering({ ...LAUNCHED_IN_TMUX, telemetry: { level: 'provided' } }) })
    step('enlist')
    await launch()

    expect(screen.getByTestId('wizard-launch-telemetry').textContent).toContain('watch the rows change')
  })

  /** An answer that said nothing is reported as itself — never read as proof either way. */
  it('says the answer was silent about telemetry rather than assuming it', async () => {
    await renderWizard({ instrumentFetchImpl: answering(LAUNCHED_IN_TMUX) })
    step('enlist')
    await launch()

    expect(screen.getByTestId('wizard-launch-telemetry').textContent).toContain('said nothing about whether telemetry')
  })

  it("reads the conductor's status off the fold's own rows, and says whose fact it is", async () => {
    await renderWizard()
    step('enlist')

    const status = screen.getByTestId('wizard-conductor-status').textContent ?? ''
    expect(status).toContain('uninstrumented')
    // The caveat is not a footnote: the event log never attributes a session
    // to a harness, so a status rendered under a harness picker has to say
    // which question it is actually answering.
    expect(status).toContain('never to a harness')
  })

  it.each([
    ['verified', undefined, 'the fold has seen none'],
    ['unproven', undefined, 'nothing is proven either way'],
    ['broken', 2, 'names 2 sessions'],
    ['broken', 1, 'names 1 session running'],
    // A broken row with no enumeration is a shape `links.ts` does not
    // produce; the point of this row is that the fallback does not invent
    // "0 sessions running uninstrumented" for it, which would contradict the
    // finding the row exists to report.
    ['broken', undefined, 'a conductor is running uninstrumented'],
  ] as const)('says a %s row with %s sessions as itself', async (state, count, sentence) => {
    const links = someLinks().map((link) =>
      link.id === 'uninstrumented-conductor'
        ? {
            ...link,
            state,
            ...(count === undefined
              ? {}
              : { sessions: Array.from({ length: count }, (_, index) => sessionFixture(`sess-${index}`)) }),
          }
        : link,
    )
    await renderWizard({ links })
    step('enlist')

    expect(screen.getByTestId('wizard-conductor-status').textContent).toContain(sentence)
  })

  it('starts the chosen harness in the chosen mode, and never sends a session id for one', async () => {
    const instrumentFetchImpl = vi.fn(answering(LAUNCHED_IN_TMUX))
    await renderWizard({ instrumentFetchImpl })
    step('enlist')

    fireEvent.click(screen.getByTestId('wizard-mode-continue'))
    await launch()

    expect(instrumentFetchImpl.mock.calls[0]?.[1].body).toBe(JSON.stringify({ harness: 'claude', mode: 'continue' }))
  })

  it('says WHERE a tmux launch landed — a window to attach to, not merely a pid', async () => {
    await renderWizard({ instrumentFetchImpl: answering(LAUNCHED_IN_TMUX) })
    step('enlist')
    await launch()

    const result = screen.getByTestId('wizard-launch-result').textContent ?? ''
    expect(result).toContain('main:3')
    expect(result).toContain('tmux attach -t main:3')
  })

  it('names the no-TTY gap for a detached launch rather than calling it a success', async () => {
    await renderWizard({
      instrumentFetchImpl: answering({ ...LAUNCHED_IN_TMUX, via: 'detached', window: undefined }),
    })
    step('enlist')
    await launch()

    const result = screen.getByTestId('wizard-launch-result').textContent ?? ''
    expect(result).toContain('no tmux window')
    expect(result).toContain('may exit on its own')
  })

  /** #532 itself: the answer that used to be reported as a launch. */
  it('reports a process that started and died as the failure it is', async () => {
    await renderWizard({
      instrumentFetchImpl: answering({
        harness: 'claude',
        mode: 'launch',
        migration: { kind: 'not-needed', at: '/home/u/.claude/projects/-repo/s.jsonl' },
        kind: 'died',
        via: 'detached',
        message: 'the process started and then exited with code 1 straight away',
      }),
    })
    step('enlist')
    await launch()

    expect(screen.getByTestId('wizard-launch-result').textContent).toContain('exited with code 1 straight away')
  })

  it('shows a refusal as its own sentence', async () => {
    await renderWizard({
      instrumentFetchImpl: answering({ error: 'Claude Code cannot be launched on this machine' }, 409),
    })
    step('enlist')
    await launch()

    expect(screen.getByTestId('wizard-launch-error').textContent).toContain('cannot be launched on this machine')
  })

  it('withholds the launch entirely while a fixture is driving the page', async () => {
    await renderWizard({ live: false })
    step('enlist')

    expect(screen.getByTestId<HTMLButtonElement>('wizard-launch').disabled).toBe(true)
    expect(screen.getByTestId('wizard-launch-fixture')).toBeTruthy()
  })

  /**
   * THE HOLE #352 IS ABOUT — the identical shape #216's review found on the
   * switch (PR #345), left on the launch. `live` gated the arm button
   * (`disabled={!canAct}`, and `canAct` includes `live`) but the confirm
   * button carried no such guard, and the two clicks are separated in time:
   * arm while live, let the page move onto a fixture before the second click
   * lands, and the launch fired anyway — while the panel beside it was
   * already saying "nothing here will start a process". `confirmLaunch` now
   * re-checks `live` itself and the confirm button carries `disabled={!live}`,
   * so a `live` drop between the two clicks withholds the SECOND one too, not
   * just the first.
   *
   * WHAT THIS TEST PROVES, AND WHAT IT DOES NOT. The `not.toHaveBeenCalled()`
   * below is carried entirely by the button's `disabled={!live}`: React
   * delivers no click from a disabled form control, so `fireEvent.click` never
   * reaches `confirmLaunch` and the `if (!live) return` guard inside it is not
   * exercised here — the same caveat #345's equivalent retarget test carries.
   * A mutation that removes that guard and keeps only `disabled` leaves this
   * test green. The guard is kept anyway, on the same refuse-before-the-wire
   * posture `concierge/retarget.ts` takes rather than trusting its caller, but
   * this test is not the evidence for it, and a later reader must not read it
   * as such.
   */
  it('a live drop between arm and confirm withholds the launch, not just the arm button', async () => {
    const instrumentFetchImpl = vi.fn(answering(LAUNCHED_IN_TMUX))
    const { rerender } = await renderWizard({ instrumentFetchImpl })
    step('enlist')

    // Arm while live — the same first click every other case in this
    // describe block starts from.
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-launch'))
    })
    expect(screen.getByTestId('wizard-launch-confirm-dialog')).toBeTruthy()

    // The page moves onto a fixture between the two clicks, with the confirm
    // dialog still open and armed.
    await act(async () => {
      rerender(
        <SetupWizard
          links={someLinks()}
          meta={META}
          live={false}
          port="4317"
          fetchImpl={reposFetch()}
          instrumentFetchImpl={instrumentFetchImpl}
          onCopy={async () => undefined}
        />,
      )
    })

    expect(screen.getByTestId<HTMLButtonElement>('wizard-launch-confirm').disabled).toBe(true)

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-launch-confirm'))
    })
    expect(instrumentFetchImpl).not.toHaveBeenCalled()
  })

  /**
   * THE HOLE #379 IS ABOUT — one of the other two conjuncts `canAct` gates the
   * arm button on (`live && isWatched && facts?.status === 'implemented'`),
   * left unguarded by #352's fix. The harness picker renders outside the
   * confirming block, so it stays interactive while this dialog is open: arm
   * with an implemented harness, change the picker to a declared one, and the
   * launch used to fire anyway — while `wizard-harness-declared` said this
   * instrument could not start it.
   *
   * `isWatched` is the sibling conjunct and is deliberately NOT exercised
   * here — EXECUTED, not reasoned: arm on the conductor step (isWatched
   * true), navigate to the repo step (`launch` state lives in `SetupWizard`
   * and survives the trip; `ConductorStep` and its dialog unmount), choose a
   * different repo there (`chooseRepo('/home/x/other')`), and return to the
   * conductor step. `wizard-launch-confirm-dialog` and `wizard-launch-confirm`
   * are gone from the DOM entirely — not present-and-disabled, ABSENT — and
   * `wizard-not-watched` renders in their place. `isWatched` is read directly
   * in `ConductorStep`'s `!isWatched ? ... : ...`, so the render that sees it
   * false swaps to the other branch outright; there is no render where the
   * button exists merely carrying the guard. That holds for any path that
   * flips `isWatched`, not only this one — `ConductorStep` re-renders off
   * whatever `isWatched` its props carry and picks its branch fresh every
   * time, so there is no way to reach a click on this button while `isWatched`
   * is false. No test is written for that conjunct, because there is no
   * button, disabled or not, for one to click — the code carries the
   * re-check anyway, as insurance against this render structure changing.
   *
   * WHAT THIS TEST PROVES, AND WHAT IT DOES NOT — same shape as #352's
   * sibling test above. `.disabled` is what a mutation removing
   * `facts?.status !== 'implemented'` from the button's `disabled` expression
   * reddens. `fireEvent.click` never reaches a disabled control, so
   * `not.toHaveBeenCalled()` alone would still pass even with the harness
   * check removed from `confirmLaunch` itself — the button-level guard covers
   * for it. Both guards are kept regardless, on the same refuse-before-the-
   * wire posture the rest of this file takes.
   */
  it('changing the harness to a declared one after arming withholds the launch, not just the arm button', async () => {
    const instrumentFetchImpl = vi.fn(answering(LAUNCHED_IN_TMUX))
    await renderWizard({ instrumentFetchImpl })
    step('enlist')

    // Arm with an implemented harness — the default picker value ('claude').
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-launch'))
    })
    expect(screen.getByTestId('wizard-launch-confirm-dialog')).toBeTruthy()

    // The picker sits outside the confirming block and stays interactive
    // while the dialog is open — changing it to a declared harness with the
    // dialog still armed is exactly #379's repro.
    fireEvent.change(screen.getByTestId('wizard-harness-select'), { target: { value: 'openclaw' } })

    expect(screen.getByTestId<HTMLButtonElement>('wizard-launch-confirm').disabled).toBe(true)

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-launch-confirm'))
    })
    expect(instrumentFetchImpl).not.toHaveBeenCalled()
  })

  /**
   * TWO CLICKS, for the switch too (#216) — the identical bar `launch()`
   * already holds the fourth mutating call to. Every test below that wants an
   * outcome goes through this, so a switch that ever became reachable in one
   * click would fail the arming test rather than quietly changing what these
   * ones exercise.
   */
  async function armAndConfirmRetarget() {
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-retarget'))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-retarget-confirm'))
    })
  }

  function chooseRepo(path: string) {
    fireEvent.change(screen.getByTestId('wizard-repo-select'), { target: { value: path } })
  }

  /**
   * THE HONESTY THIS WIZARD TURNS ON. The launch route takes no repo — it uses
   * the one this server was started in — so a repo that is not the watched one
   * gets the switch instead of a launch button, never a silent one-click start
   * somewhere else.
   */
  it('offers the switch and the command, never the launch button, for a repo this instrument is not watching', async () => {
    const instrumentFetchImpl = vi.fn(answering(LAUNCHED_IN_TMUX))
    const retargetFetchImpl = vi.fn(switching(SWITCHED))
    await renderWizard({ instrumentFetchImpl, retargetFetchImpl })

    await waitFor(() => expect(screen.getByTestId('wizard-repo-select')).toBeTruthy())
    chooseRepo('/home/x/other')
    step('enlist')

    expect(screen.queryByTestId('wizard-launch')).toBeNull()
    expect(screen.getByTestId<HTMLButtonElement>('wizard-retarget').disabled).toBe(false)
    expect(screen.getByTestId('connect-command-wizard-start-there').textContent).toBe(
      'npm start -- /home/x/other --port 4317',
    )
    const withheld = screen.getByTestId('wizard-not-watched').textContent ?? ''
    expect(withheld).toContain('/home/x/other')
    expect(withheld).not.toContain('not built')
    expect(withheld).not.toContain('cannot retarget')
    expect(instrumentFetchImpl).not.toHaveBeenCalled()
    expect(retargetFetchImpl).not.toHaveBeenCalled()
  })

  /** THE FIRST CLICK SPENDS NOTHING, for the switch too — the same finding `launch()`'s own arming test makes. */
  it('arms before it switches', async () => {
    const retargetFetchImpl = vi.fn(switching(SWITCHED))
    await renderWizard({ retargetFetchImpl })

    await waitFor(() => expect(screen.getByTestId('wizard-repo-select')).toBeTruthy())
    chooseRepo('/home/x/other')
    step('enlist')

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-retarget'))
    })
    expect(retargetFetchImpl).not.toHaveBeenCalled()
    // The arming panel STATES what the switch costs; it never COMPUTES a
    // number to say it with — no digit anywhere in it.
    const dialog = screen.getByTestId('wizard-retarget-confirm-dialog').textContent ?? ''
    expect(dialog).toContain('/home/x/other')
    expect(dialog).toContain('/home/x/repo')
    expect(dialog).toContain('recording')
    expect(dialog).toContain('re-issued')
    expect(dialog).not.toMatch(/\d/)

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-retarget-cancel'))
    })
    expect(screen.queryByTestId('wizard-retarget-confirm-dialog')).toBeNull()
    expect(screen.getByTestId('wizard-retarget')).toBeTruthy()
    expect(retargetFetchImpl).not.toHaveBeenCalled()
  })

  it('the confirm click sends the selected repo to the route, once', async () => {
    const retargetFetchImpl = vi.fn(switching(SWITCHED))
    await renderWizard({ retargetFetchImpl })

    await waitFor(() => expect(screen.getByTestId('wizard-repo-select')).toBeTruthy())
    chooseRepo('/home/x/other')
    step('enlist')
    await armAndConfirmRetarget()

    expect(retargetFetchImpl).toHaveBeenCalledTimes(1)
    expect(retargetFetchImpl).toHaveBeenCalledWith(
      RETARGET_URL,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ path: '/home/x/other' }) }),
    )
  })

  it('a switch renders the route’s own figures', async () => {
    const retargetFetchImpl = vi.fn(switching(SWITCHED))
    const onRetargeted = vi.fn()
    await renderWizard({ retargetFetchImpl, onRetargeted })

    await waitFor(() => expect(screen.getByTestId('wizard-repo-select')).toBeTruthy())
    chooseRepo('/home/x/other')
    step('enlist')
    await armAndConfirmRetarget()

    const result = screen.getByTestId('wizard-retarget-result').textContent ?? ''
    expect(result).toContain('1000')
    expect(result).toContain('5000')
    expect(result).toContain('/home/x/other')
    expect(screen.getByTestId('wizard-retarget-telemetry').textContent).toBe(SWITCHED.telemetry.note)
    expect(screen.getByTestId('connect-command-wizard-retarget-reissue').textContent).toBe(
      SWITCHED.telemetry.reissue.join('\n'),
    )
    const lost = screen.getByTestId('wizard-retarget-lost').textContent ?? ''
    expect(lost).toContain('llm.cost')
    expect(lost).toContain('trace.span')
    expect(screen.getByTestId('wizard-retarget-still-working').textContent).toContain('git')
    expect(onRetargeted).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('wizard-retarget-refused')).toBeNull()
    expect(screen.queryByTestId('wizard-retarget-error')).toBeNull()
  })

  /** The wizard's later steps read against the new target — the DoD's own sentence, proven here at the seam that holds it. */
  it('the journey continues in the new repo', async () => {
    const retargetFetchImpl = vi.fn(switching(SWITCHED))
    const { rerender } = await renderWizard({ retargetFetchImpl })

    await waitFor(() => expect(screen.getByTestId('wizard-repo-select')).toBeTruthy())
    chooseRepo('/home/x/other')
    step('enlist')
    await armAndConfirmRetarget()

    await act(async () => {
      rerender(
        <SetupWizard
          links={someLinks()}
          meta={{ ...META, repoPath: '/home/x/other', repoName: 'other' }}
          live={true}
          port="4317"
          fetchImpl={reposFetch()}
          retargetFetchImpl={retargetFetchImpl}
          onCopy={async () => undefined}
        />,
      )
    })

    expect(screen.getByTestId('wizard-launch')).toBeTruthy()
    expect(screen.queryByTestId('wizard-not-watched')).toBeNull()
    expect(screen.getByTestId('wizard-retarget-result')).toBeTruthy()

    step('enlist')
    expect(screen.getByTestId('wizard-watched').textContent).toBe('/home/x/other')
  })

  it('a refusal is itself', async () => {
    const onRetargeted = vi.fn()
    const retargetFetchImpl = vi.fn(
      switching({ code: 'writer-alive', error: 'another rhizomorph (pid 42) is already watching it' }, 409),
    )
    await renderWizard({ retargetFetchImpl, onRetargeted })

    await waitFor(() => expect(screen.getByTestId('wizard-repo-select')).toBeTruthy())
    chooseRepo('/home/x/other')
    step('enlist')
    await armAndConfirmRetarget()

    const refused = screen.getByTestId('wizard-retarget-refused')
    expect(refused.getAttribute('role')).toBe('status')
    expect(refused.textContent).toContain('writer-alive')
    expect(refused.textContent).toContain('another rhizomorph (pid 42) is already watching it')
    expect(refused.textContent).toContain('/home/x/repo')
    expect(onRetargeted).not.toHaveBeenCalled()
    expect(screen.queryByTestId('wizard-retarget-result')).toBeNull()
    expect(screen.queryByTestId('wizard-retarget-error')).toBeNull()
    expect(screen.getByTestId('connect-command-wizard-start-there')).toBeTruthy()
  })

  it('a failure is itself', async () => {
    const onRetargeted = vi.fn()
    const retargetFetchImpl = vi.fn(switching({ error: 'missing or invalid x-rhizomorph-capability header' }, 401))
    await renderWizard({ retargetFetchImpl, onRetargeted })

    await waitFor(() => expect(screen.getByTestId('wizard-repo-select')).toBeTruthy())
    chooseRepo('/home/x/other')
    step('enlist')
    await armAndConfirmRetarget()

    expect(screen.getByTestId('wizard-retarget-error').textContent).toMatch(/reload this page/i)
    expect(screen.queryByTestId('wizard-retarget-refused')).toBeNull()
    expect(screen.queryByTestId('wizard-retarget-result')).toBeNull()
    expect(onRetargeted).not.toHaveBeenCalled()
  })

  it('a fixture withholds the switch entirely while it is driving the page', async () => {
    await renderWizard({ live: false })

    await waitFor(() => expect(screen.getByTestId('wizard-repo-select')).toBeTruthy())
    chooseRepo('/home/x/other')
    step('enlist')

    expect(screen.getByTestId<HTMLButtonElement>('wizard-retarget').disabled).toBe(true)
    expect(screen.getByTestId('wizard-retarget-fixture')).toBeTruthy()
    expect(screen.getByTestId('connect-command-wizard-start-there')).toBeTruthy()
  })

  /**
   * THE HOLE #216'S REVIEW FOUND. `live` gated the arm button
   * (`disabled={!live}`) but the confirm button carried no such guard, and the
   * two clicks are separated in time: arm while live, let the page move onto a
   * fixture before the second click lands, and the switch fired anyway — while
   * the panel beside it was already saying "nothing here will switch
   * anything". `confirmRetarget` now re-checks `live` itself and the confirm
   * button carries the same `disabled={!live}` the arm button always had, so
   * a `live` drop between the two clicks withholds the SECOND one too, not
   * just the first.
   *
   * WHAT THIS TEST PROVES, AND WHAT IT DOES NOT. The `not.toHaveBeenCalled()`
   * below is carried entirely by the button's `disabled={!live}`: React
   * delivers no click from a disabled form control, so `fireEvent.click` never
   * reaches `confirmRetarget` and the `!live` arm inside it is not exercised
   * here. Certified rather than assumed — removing that arm and keeping only
   * the `disabled` leaves this test GREEN, caught 0/2 runs
   * (`certify-mutation.sh`, review of #345). The act guard is kept anyway,
   * because the dialog is reachable by state rather than only by that one
   * button and `concierge/retarget.ts` takes the same refuse-before-the-wire
   * posture rather than trusting its caller — but this test is not the
   * evidence for it, and a later reader must not read it as such.
   */
  it('a live drop between arm and confirm withholds the switch, not just the arm button', async () => {
    const retargetFetchImpl = vi.fn(switching(SWITCHED))
    const { rerender } = await renderWizard({ retargetFetchImpl })

    await waitFor(() => expect(screen.getByTestId('wizard-repo-select')).toBeTruthy())
    chooseRepo('/home/x/other')
    step('enlist')

    // Arm while live — the same first click every other case in this
    // describe block starts from.
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-retarget'))
    })
    expect(screen.getByTestId('wizard-retarget-confirm-dialog')).toBeTruthy()

    // The page moves onto a fixture between the two clicks, with the confirm
    // dialog still open and armed.
    await act(async () => {
      rerender(
        <SetupWizard
          links={someLinks()}
          meta={META}
          live={false}
          port="4317"
          fetchImpl={reposFetch()}
          retargetFetchImpl={retargetFetchImpl}
          onCopy={async () => undefined}
        />,
      )
    })

    expect(screen.getByTestId<HTMLButtonElement>('wizard-retarget-confirm').disabled).toBe(true)

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-retarget-confirm'))
    })
    expect(retargetFetchImpl).not.toHaveBeenCalled()
  })

  /** Repetition — a second switch replaces the first answer, rather than the two piling up. */
  it('repetition — a second switch replaces the first answer', async () => {
    const SWITCHED_AGAIN = {
      ...SWITCHED,
      to: { ...SWITCHED.to, repoPath: '/home/x/code/scanned', repoName: 'scanned' },
      opened: { ...SWITCHED.opened, sessionId: '6000' },
    }
    const retargetFetchImpl = vi.fn<RetargetFetchLike>()
    retargetFetchImpl.mockImplementationOnce(switching(SWITCHED))
    retargetFetchImpl.mockImplementationOnce(switching(SWITCHED_AGAIN))
    const onRetargeted = vi.fn()
    const { rerender } = await renderWizard({ retargetFetchImpl, onRetargeted })

    await waitFor(() => expect(screen.getByTestId('wizard-repo-select')).toBeTruthy())
    chooseRepo('/home/x/other')
    step('enlist')
    await armAndConfirmRetarget()

    await act(async () => {
      rerender(
        <SetupWizard
          links={someLinks()}
          meta={{ ...META, repoPath: '/home/x/other', repoName: 'other' }}
          live={true}
          port="4317"
          fetchImpl={reposFetch()}
          retargetFetchImpl={retargetFetchImpl}
          onRetargeted={onRetargeted}
          onCopy={async () => undefined}
        />,
      )
    })

    step('enlist')
    await waitFor(() => expect(screen.getByTestId('wizard-repo-select')).toBeTruthy())
    chooseRepo('/home/x/code/scanned')
    step('enlist')
    await armAndConfirmRetarget()

    expect(retargetFetchImpl).toHaveBeenCalledTimes(2)
    expect(retargetFetchImpl.mock.calls[1]?.[1].body).toBe(JSON.stringify({ path: '/home/x/code/scanned' }))
    expect(document.querySelectorAll('[data-testid="wizard-retarget-result"]')).toHaveLength(1)
    const result = screen.getByTestId('wizard-retarget-result').textContent ?? ''
    expect(result).toContain('6000')
    expect(result).not.toContain('5000')
    expect(onRetargeted).toHaveBeenCalledTimes(2)
  })

  it('copies that command through the page’s own clipboard seam', async () => {
    const { onCopy } = await renderWizard()

    await waitFor(() => expect(screen.getByTestId('wizard-repo-select')).toBeTruthy())
    chooseRepo('/home/x/other')
    step('enlist')
    await act(async () => {
      fireEvent.click(screen.getByTestId('connect-copy-wizard-start-there'))
    })

    expect(onCopy).toHaveBeenCalledWith('npm start -- /home/x/other --port 4317')
  })

  it('a freshly cloned repo can be switched to, and is therefore one this instrument is not watching', async () => {
    await renderWizard({
      cloneFetchImpl: async () => {
        const body = JSON.stringify({ type: 'done', path: '/home/x/.rhizomorph/clones/repo' })
        return { ok: true, status: 200, json: async () => JSON.parse(body) as unknown, text: async () => body }
      },
    })

    fireEvent.change(screen.getByTestId('wizard-clone-url'), { target: { value: 'https://host/o/r.git' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-clone'))
    })
    step('enlist')

    expect(screen.queryByTestId('wizard-launch')).toBeNull()
    expect(screen.getByTestId('wizard-retarget')).toBeTruthy()
    expect(screen.getByTestId('connect-command-wizard-start-there').textContent).toBe(
      'npm start -- /home/x/.rhizomorph/clones/repo --port 4317',
    )
  })
})

/** The sibling case the issue names, pinned in the file rather than trusted (#216). */
describe('the wizard no longer says the switch is unbuilt', () => {
  it('never spells the old refusal, in prose or in a doc comment', () => {
    const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'wizard.tsx'), 'utf8')
    expect(source).not.toMatch(/not built|open question/)
  })
})

describe('step 3 — verify', () => {
  it('shows the page’s OWN rows, one line each, in the page’s own order', async () => {
    const links = someLinks()
    await renderWizard({ links })
    step('connect')

    for (const link of links) {
      expect(screen.getByTestId(`wizard-verify-${link.id}`).textContent).toContain(link.label)
    }
  })

  it('reads each row’s state from the row itself — the three readings, not a fourth', async () => {
    await renderWizard()
    step('connect')

    expect(screen.getByTestId('wizard-verify-browser-server').textContent).toContain('VERIFIED')
    expect(screen.getByTestId('wizard-verify-uninstrumented-conductor').textContent).toContain('BROKEN')
    expect(screen.getByTestId('wizard-verify-repo-git').textContent).toContain('UNPROVEN')
  })

  /**
   * The claim this step makes is that it is showing the page's rows LIVE, and
   * the only way to prove that is to change the rows and re-render without
   * touching the wizard's own state: a step that had copied them at mount would
   * still show the old readings.
   */
  it('changes when the rows change, because they are the same rows', async () => {
    const links = someLinks()
    const { rerender } = renderWizardRaw(links)
    fireEvent.click(screen.getByTestId('wizard-step-connect'))
    expect(screen.getByTestId('wizard-verify-repo-git').textContent).toContain('UNPROVEN')

    const flipped = links.map((link) =>
      link.id === 'repo-git' ? { ...link, state: 'verified' as const, fact: 'a commit arrived' } : link,
    )
    act(() => {
      rerender(
        <SetupWizard
          links={flipped}
          meta={META}
          live={true}
          port="4317"
          fetchImpl={reposFetch()}
          onCopy={async () => undefined}
        />,
      )
    })

    expect(screen.getByTestId('wizard-verify-repo-git').textContent).toContain('VERIFIED')
  })

  function renderWizardRaw(links: ChainLink[]) {
    return render(
      <SetupWizard
        links={links}
        meta={META}
        live={true}
        port="4317"
        fetchImpl={reposFetch()}
        onCopy={async () => undefined}
      />,
    )
  }
})

/**
 * THE HARNESS HONESTY LAW (prd-20 ruling 4, ADR-0010).
 *
 * `wizard.tsx`'s `HARNESSES` is a second statement of facts that live in
 * `server/src/concierge/harness/`, because `packages/web` cannot import
 * `@rhizomorph/server` and no route serves the registry. A second statement is
 * a drift risk, and drift here is not cosmetic: the whole point of listing a
 * declared harness is that the operator reads the REGISTRY's reason for it, not
 * a softer paraphrase a page invented.
 *
 * So this reads the real adapter sources and holds the catalogue to them,
 * exactly as this directory's own `#344 — the two numbers, held together` reads
 * a constant out of the server's source. Grep-style, no AST, and every floor is
 * derived from the parse rather than hardcoded — an empty read would otherwise
 * satisfy an equality of two empty sets.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url))
const HARNESS_DIR = path.resolve(HERE, '..', '..', '..', 'server', 'src', 'concierge', 'harness')
/**
 * The declared roster's data lives outside the concierge namespace so
 * `cli/doctor.ts` can import it in the shipped bundle rather than parse it off
 * disk — see `server/src/harness-roster.ts`. The adapters are still built from
 * it in `concierge/harness/not-implemented.ts`, so this law reads the same one
 * table it always did; only its address moved.
 */
const ROSTER_FILE = path.resolve(HERE, '..', '..', '..', 'server', 'src', 'harness-roster.ts')

/**
 * The concatenated single-quoted segments of one field's value, joined as the
 * source would.
 *
 * `\uXXXX` is unescaped as well as `\'`, and that is not hypothetical tidiness:
 * codex's telemetry reason writes its apostrophe as `’` in the adapter
 * source, so a comparison that left the escape as literal text would have
 * demanded the PAGE carry a backslash-u sequence into the operator's browser to
 * satisfy this law. The law reads TypeScript source, so it has to decode the
 * escapes TypeScript would.
 */
function joinedString(block: string): string {
  return [...block.matchAll(/'((?:[^'\\]|\\.)*)'/g)]
    .map((match) =>
      (match[1] ?? '')
        .replace(/\\u([0-9a-fA-F]{4})/g, (_whole, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
        .replace(/\\'/g, "'"),
    )
    .join('')
}

/** Every declared harness in the roster's own DECLARED_HARNESSES table: id → what it would take. */
function declaredInRegistry(): Map<string, { displayName: string; whatItWouldTake: string }> {
  const source = readFileSync(ROSTER_FILE, 'utf8')
  const table = /const DECLARED_HARNESSES: readonly DeclaredHarnessEntry\[\] = \[([\s\S]*?)\n\]/.exec(source)?.[1] ?? ''
  const out = new Map<string, { displayName: string; whatItWouldTake: string }>()
  for (const entry of table.split(/\n  \{\n/)) {
    const id = /id: '([a-z]+)'/.exec(entry)?.[1]
    const displayName = /displayName: '([^']*)'/.exec(entry)?.[1]
    const takes = /whatItWouldTake:([\s\S]*?),\n(?:  \},|\s*\})/.exec(entry)?.[1]
    if (id === undefined || displayName === undefined || takes === undefined) continue
    out.set(id, { displayName, whatItWouldTake: joinedString(takes) })
  }
  return out
}

/** The two adapters with their own module: id, display name, implementation status. */
function implementedInRegistry(): Map<string, { displayName: string; status: string }> {
  const out = new Map<string, { displayName: string; status: string }>()
  for (const file of ['claude.ts', 'codex.ts']) {
    const source = readFileSync(path.join(HARNESS_DIR, file), 'utf8')
    const id = /\bid: '([a-z]+)'/.exec(source)?.[1]
    const displayName = /displayName: '([^']*)'/.exec(source)?.[1]
    const status = /implementation: \{ status: '([a-z]+)'/.exec(source)?.[1]
    if (id === undefined || displayName === undefined || status === undefined) continue
    out.set(id, { displayName, status })
  }
  return out
}

/**
 * Each implemented adapter's `envRecipe().telemetry` — the SECOND claim the
 * picker makes about a harness (ledger #4), parsed out of the adapter source
 * the same grep-style way the first one is.
 *
 * Both shapes the field takes in the tree are handled: claude's one-liner
 * (`telemetry: { level: 'provided' },`) and codex's multi-line block with its
 * `reason` and `remedy`. A parser that only knew one would return nothing for
 * the other and make the comparison vacuous, which is what the floors below
 * are for.
 */
function telemetryInRegistry(): Map<string, { level: string; reason: string; remedy: string }> {
  const out = new Map<string, { level: string; reason: string; remedy: string }>()
  for (const file of ['claude.ts', 'codex.ts']) {
    const source = readFileSync(path.join(HARNESS_DIR, file), 'utf8')
    const id = /\bid: '([a-z]+)'/.exec(source)?.[1]
    if (id === undefined) continue
    const block = /\n {4}telemetry: \{\n([\s\S]*?)\n {4}\},/.exec(source)?.[1] ?? /\n {4}telemetry: \{([^\n]*)\},/.exec(source)?.[1]
    if (block === undefined) continue
    const level = /level: '([a-z]+)'/.exec(block)?.[1]
    if (level === undefined) continue
    const reason = /\breason:([\s\S]*?),\n {6}remedy:/.exec(block)?.[1]
    const remedy = /\bremedy:([\s\S]*)$/.exec(block)?.[1]
    out.set(id, {
      level,
      reason: reason === undefined ? '' : joinedString(reason),
      remedy: remedy === undefined ? '' : joinedString(remedy),
    })
  }
  return out
}

describe('the harness picker states the registry’s own facts, never a softer version of them', () => {
  it('the registry is composed of exactly the three sources this law reads — a fourth would go unchecked', () => {
    const registry = readFileSync(path.join(HARNESS_DIR, 'registry.ts'), 'utf8')
    expect(registry).toContain('[claudeAdapter, codexAdapter, ...declaredAdapters]')
  })

  it('names exactly the harnesses the registry names, in the registry’s own alphabetical order', () => {
    const declared = declaredInRegistry()
    const implemented = implementedInRegistry()
    // Floors derived from the parse: a regex that silently matched nothing
    // would otherwise make every comparison below vacuous.
    expect(declared.size).toBe(3)
    expect(implemented.size).toBe(2)

    const registryIds = [...declared.keys(), ...implemented.keys()].sort()
    expect(HARNESSES.map((harness) => harness.id)).toEqual(registryIds)
  })

  it('spells each one the way the registry spells it, and claims the status the registry claims', () => {
    const declared = declaredInRegistry()
    const implemented = implementedInRegistry()

    for (const harness of HARNESSES) {
      const fromRegistry = implemented.get(harness.id) ?? declared.get(harness.id)
      expect(fromRegistry, `${harness.id} is in the picker and not in the registry`).toBeDefined()
      expect(harness.displayName).toBe(fromRegistry?.displayName)
      expect(harness.status).toBe(implemented.has(harness.id) ? 'implemented' : 'declared')
    }
  })

  it('quotes what it would take VERBATIM for every declared harness — never a paraphrase, never "coming soon"', () => {
    const declared = declaredInRegistry()

    for (const [id, facts] of declared) {
      const inPicker = HARNESSES.find((harness) => harness.id === id)
      expect(inPicker?.whatItWouldTake, `${id} is declared and the picker says nothing about it`).toBe(
        facts.whatItWouldTake,
      )
      expect(facts.whatItWouldTake.length).toBeGreaterThan(40)
      expect(inPicker?.whatItWouldTake?.toLowerCase()).not.toContain('coming soon')
    }
    // …and an implemented harness carries none, so the field is a statement
    // about a refusal rather than decoration every row wears.
    for (const harness of HARNESSES.filter((entry) => entry.status === 'implemented')) {
      expect(harness.whatItWouldTake).toBeUndefined()
    }
  })

  /**
   * **IMPLEMENTED IS NOT INSTRUMENTED** (ledger #4). The picker made one claim
   * per harness and the conductor step framed every launch as instrumenting on
   * the strength of it — so codex, fully implemented and declaring telemetry
   * ABSENT with two named blockers, was offered under "start it instrumented".
   * The level is now a second fact under the same law as the first, and its
   * reason and remedy are held verbatim for the same reason
   * `whatItWouldTake` is: a page that paraphrases a refusal has invented a
   * softer version of it.
   */
  it('carries each implemented harness’s telemetry level, and its reason VERBATIM', () => {
    const registry = telemetryInRegistry()
    expect(registry.size).toBe(2)
    // Not one level for both — a law that passed with the two agreeing would
    // prove nothing about the distinction it exists to hold.
    expect(new Set([...registry.values()].map((entry) => entry.level)).size).toBe(2)

    for (const [id, fromRegistry] of registry) {
      const inPicker = HARNESSES.find((harness) => harness.id === id)
      expect(inPicker?.telemetry?.level, `${id}'s telemetry level`).toBe(fromRegistry.level)
      if (fromRegistry.level === 'provided') {
        expect(inPicker?.telemetry?.reason).toBeUndefined()
        continue
      }
      expect(fromRegistry.reason.length).toBeGreaterThan(40)
      expect(fromRegistry.remedy.length).toBeGreaterThan(40)
      expect(inPicker?.telemetry?.reason).toBe(fromRegistry.reason)
      expect(inPicker?.telemetry?.remedy).toBe(fromRegistry.remedy)
    }

    // A declared harness carries no level: nothing launches it, so there is no
    // launch to be honest about.
    for (const harness of HARNESSES.filter((entry) => entry.status === 'declared')) {
      expect(harness.telemetry).toBeUndefined()
    }
  })

  it('the parsers actually parse — pinned against the shapes they run on', () => {
    expect(
      joinedString("whatItWouldTake:\n      'a capture: the name, ' +\n      'and the rest',"),
    ).toBe('a capture: the name, and the rest')
    expect(declaredInRegistry().get('shell')?.displayName).toBe('a bare shell')
    expect(implementedInRegistry().get('claude')?.status).toBe('implemented')
    // Both telemetry shapes, and the escape decoding that a literal comparison
    // would otherwise have pushed into the page.
    expect(telemetryInRegistry().get('claude')?.level).toBe('provided')
    expect(telemetryInRegistry().get('codex')?.level).toBe('absent')
    expect(telemetryInRegistry().get('codex')?.reason).toContain('api/otel.ts’s blockInstance')
    expect(joinedString("reason: 'it\\u2019s here',")).toBe('it’s here')
  })
})
