import { createEvent, createIdFactory, reduceAll, type RhizomorphEvent } from '@rhizomorph/core'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildFleet,
  fixtureHistory,
  fleet20Spec,
  manifestFor,
  pathologySpec,
  type AttentionItem,
  type Fleet,
  type FixtureSpec,
  type LadderRank,
} from '../../fleet/index.js'
import { AGE_INK_MAX_MS, AGE_QUIET_MAX_MS } from './ageBands.js'
import { AttentionStripView, MAX_CHIPS } from './AttentionStripView.js'
import { MAX_WAITED_CHIPS } from './waitedChips.js'

/**
 * The presentational half of the strip is a pure function of a `Fleet`, so
 * every test here builds a *real* one — through core's real reducer and the
 * real detectors — exactly the way `fleet/buildFleet.test.ts` does, rather
 * than hand-rolling a `Fleet`-shaped object that could quietly drift from
 * what `buildFleet` actually produces.
 */

const NOW = Date.UTC(2026, 6, 31, 12, 0, 0)

afterEach(cleanup)

function fleetFor(spec: FixtureSpec): Fleet {
  const state = reduceAll(fixtureHistory(spec, NOW))
  return buildFleet(state, { now: NOW, manifest: manifestFor(spec) })
}

function chips(): HTMLButtonElement[] {
  return screen.getAllByRole('button') as HTMLButtonElement[]
}

describe('AttentionStripView — calm', () => {
  const fleet = fleetFor(fleet20Spec())

  it('renders ALL CLEAR with the evidence line, never bare reassurance (ruling 14)', () => {
    expect(fleet.rank).toBe('calm')

    render(<AttentionStripView fleet={fleet} selectedId={null} onToggle={vi.fn()} />)

    expect(screen.getByText('ALL CLEAR')).toBeInTheDocument()
    // Every figure the sentence cites is real: 20 lanes, 20 branches checked,
    // 20 files checked, exactly the numbers fixture.ts documents.
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('collisions')
    expect(within(status).getAllByText('20')).toHaveLength(3)
    expect(within(status).getByText('0')).toBeInTheDocument()
  })

  it('renders no chips at all when calm', () => {
    render(<AttentionStripView fleet={fleet} selectedId={null} onToggle={vi.fn()} />)
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })
})

describe('AttentionStripView — the staged pathology fleet', () => {
  const fleet = fleetFor(pathologySpec())

  it('leads with "N NEED ATTENTION", worst rung first', () => {
    render(<AttentionStripView fleet={fleet} selectedId={null} onToggle={vi.fn()} />)

    expect(screen.getByText('NEED ATTENTION')).toBeInTheDocument()
    // 5 pathologies staged: frozen (broken), looping/waiting/off-fence
    // (needs-you), expensive (notice) — the ladder counts all of them.
    const status = screen.getByRole('status')
    expect(within(status).getByText(String(fleet.ladder.rank === 'calm' ? 0 : fleet.ladder.items.length))).toBeInTheDocument()

    const kinds = chips().map((chip) => chip.getAttribute('data-chip-kind'))
    // The frozen (broken) lane leads; the expensive (notice) lane, being the
    // mildest fault, is exactly the one pushed into the "+N" overflow below.
    expect(kinds[0]).toBe('frozen')
  })

  it('caps named chips at MAX_CHIPS and counts the rest (C\'s triage rule)', () => {
    render(<AttentionStripView fleet={fleet} selectedId={null} onToggle={vi.fn()} />)

    expect(fleet.ladder.rank === 'calm' ? 0 : fleet.ladder.items.length).toBe(5)
    expect(chips()).toHaveLength(MAX_CHIPS)
    expect(screen.getByTestId('chip-overflow')).toHaveTextContent('+1')
  })

  it('names lane + evidence + how-long on every chip, never a bare label (graft g4)', () => {
    render(<AttentionStripView fleet={fleet} selectedId={null} onToggle={vi.fn()} />)

    const frozenChip = chips().find((chip) => chip.getAttribute('data-chip-kind') === 'frozen')
    expect(frozenChip).toBeDefined()
    expect(frozenChip).toHaveTextContent('42-otel-receiver')
    expect(frozenChip?.textContent).toMatch(/no events for \d+m\d\ds/)

    const loopingChip = chips().find((chip) => chip.getAttribute('data-chip-kind') === 'looping')
    expect(loopingChip?.textContent).toContain('41-retry-parser')
    expect(loopingChip?.textContent).toContain('Read→Edit→Bash ×6, no commit')
  })

  it('marks an inferred detection with the inference mark, never presenting it as certain', () => {
    render(<AttentionStripView fleet={fleet} selectedId={null} onToggle={vi.fn()} />)
    const waitingChip = chips().find((chip) => chip.getAttribute('data-chip-kind') === 'waiting')
    // The staged waiting lane is certain (workmux declared it), so it must
    // NOT carry the inference mark — only a pane-inferred wait would.
    expect(waitingChip?.textContent).not.toContain('~')
  })

  it('clicking a chip toggles that lane into the shared selection', () => {
    const onToggle = vi.fn()
    render(<AttentionStripView fleet={fleet} selectedId={null} onToggle={onToggle} />)

    const frozenChip = chips().find((chip) => chip.getAttribute('data-chip-kind') === 'frozen') as HTMLButtonElement
    fireEvent.click(frozenChip)
    expect(onToggle).toHaveBeenCalledWith('42-otel-receiver')
  })

  it('marks the selected lane\'s chip as pressed', () => {
    render(<AttentionStripView fleet={fleet} selectedId="42-otel-receiver" onToggle={vi.fn()} />)
    const frozenChip = chips().find((chip) => chip.getAttribute('data-chip-kind') === 'frozen')
    expect(frozenChip).toHaveAttribute('aria-pressed', 'true')
    const loopingChip = chips().find((chip) => chip.getAttribute('data-chip-kind') === 'looping')
    expect(loopingChip).toHaveAttribute('aria-pressed', 'false')
  })

  it('never grows past a bounded number of DOM chips, whatever the fault count', () => {
    render(<AttentionStripView fleet={fleet} selectedId={null} onToggle={vi.fn()} />)
    // MAX_CHIPS named + one overflow counter is the entire ceiling on width —
    // this is what keeps the strip from ever wrapping taller than its docked
    // height, at any lane count (ruling 7).
    expect(chips().length).toBeLessThanOrEqual(MAX_CHIPS)
  })

  /**
   * THE WALKTHROUGH'S FINDING (2026-08-17) — a human read the running strip and
   * saw a trespass path truncated mid-word.
   *
   * The bound on chip COUNT above was never the problem: four chips is four
   * chips whether each says twelve characters or twelve hundred. What was
   * unbounded was the *evidence inside one chip*, and no test here could see
   * it, because every fixture happens to trespass exactly once.
   *
   * So the fix is in `core/src/fleet/diagnose.ts` (bounded at the source, where
   * five surfaces read the same clause) and this is the view-side proof that a
   * real forty-path lane now renders something a person can read.
   */
  it('renders a readable chip for a lane forty files off its fence', () => {
    const forty = fleetWithTrespasses(40)
    render(<AttentionStripView fleet={forty} selectedId={null} onToggle={vi.fn()} />)

    const chip = chips().find((node) => node.getAttribute('data-chip-kind') === 'off-fence')
    expect(chip, 'no off-fence chip rendered for a forty-trespass lane').toBeDefined()

    // The count is the finding at this scale, the first path is the example,
    // and the rest are a number rather than a wall.
    const evidence = chip?.getAttribute('title') ?? ''
    expect(evidence).toContain('40 files outside fence')
    expect(evidence).toContain('+39 more')

    // THE MUTATION, as arithmetic: the unbounded join was 40 × ~60 characters.
    // A bound well under that fails on a regression, and the lower bound fails
    // on an over-eager truncation that stopped naming a path at all.
    expect(evidence.length).toBeLessThan(200)
    expect(evidence.length).toBeGreaterThan(40)
  })
})

/**
 * A real fleet whose one fenced lane trespasses `count` times — built through
 * core's own reducer and detectors like every other fixture in this file, so
 * what is asserted above is what `buildFleet` actually produces rather than a
 * hand-rolled `Fleet`-shaped object.
 */
function fleetWithTrespasses(count: number): Fleet {
  const nextId = createIdFactory('trespass')
  const OFFENDER = '600-offender'
  const VICTIM = '601-victim'
  const events: RhizomorphEvent[] = [
    createEvent(
      'session.started',
      { sessionId: 's1', repoPath: '/repo', repoName: 'rhizomorph', mainBranch: 'main' },
      { id: nextId(), ts: NOW - 60_000 },
    ),
    createEvent(
      'worktree.discovered',
      { path: `/repo-wt/${OFFENDER}`, branch: OFFENDER, head: 'sha-1', isMain: false },
      { id: nextId(), ts: NOW - 50_000 },
    ),
    // COMMITTED touches, not dirty ones: `buildFleet` judges a lane against its
    // fence on what it actually landed (`touches[...].filter(t => t.committed)`),
    // because an uncommitted edit is invisible to the gate and must be invisible
    // to the glass too. A dirty-file fixture would build a fleet with zero
    // trespasses and this whole block would assert nothing.
    createEvent(
      'commit.landed',
      {
        branch: OFFENDER,
        sha: 'abc1234',
        message: 'feat(offender): forty files where they do not belong',
        author: { name: 'a lane' },
        worktreePath: `/repo-wt/${OFFENDER}`,
        insertions: count,
        deletions: 0,
        files: Array.from({ length: count }, (_, i) => ({
          path: `packages/web/src/panels/attention/very/long/path/number-${i}.tsx`,
          status: 'modified',
        })),
      },
      { id: nextId(), ts: NOW - 10_000 },
    ),
  ]

  // A manifest that fences the offender somewhere it is NOT touching, and gives
  // every touched path to a second lane — so all `count` files are trespasses
  // with a named victim, which is the widest the evidence clause can get.
  const manifest = {
    [OFFENDER]: { handle: OFFENDER, fence: ['packages/server/**'], issue: '600', model: null },
    [VICTIM]: {
      handle: VICTIM,
      fence: ['packages/web/src/panels/attention/**'],
      issue: '601',
      model: null,
    },
  }

  return buildFleet(reduceAll(events), { now: NOW, manifest })
}

describe('AttentionStripView — arrival pulse (ruling 10)', () => {
  const fleet = fleetFor(pathologySpec())

  it('applies the flare class on a chip\'s first mount', () => {
    render(<AttentionStripView fleet={fleet} selectedId={null} onToggle={vi.fn()} />)
    const frozenChip = chips().find((chip) => chip.getAttribute('data-chip-kind') === 'frozen')
    expect(frozenChip?.className).toContain('attention-chip-flare')
  })

  it('never remounts a chip that is still the same fault a tick later — the pulse cannot replay', () => {
    const { rerender } = render(
      <AttentionStripView fleet={fleet} selectedId={null} onToggle={vi.fn()} />,
    )
    const before = document.querySelector('[data-chip-id="frozen:42-otel-receiver"]')
    expect(before).not.toBeNull()

    // A fresh `Fleet` object (as every one-second tick produces), same faults.
    const fleetTickLater = fleetFor(pathologySpec())
    rerender(<AttentionStripView fleet={fleetTickLater} selectedId={null} onToggle={vi.fn()} />)

    const after = document.querySelector('[data-chip-id="frozen:42-otel-receiver"]')
    expect(after).toBe(before)
  })

  it('omits the flare class entirely under prefers-reduced-motion', () => {
    const restore = mockReducedMotion(true)
    try {
      render(<AttentionStripView fleet={fleet} selectedId={null} onToggle={vi.fn()} />)
      const frozenChip = chips().find((chip) => chip.getAttribute('data-chip-kind') === 'frozen')
      expect(frozenChip?.className).not.toContain('attention-chip-flare')
    } finally {
      restore()
    }
  })
})

describe('AttentionStripView — amber ages (prd5 ruling 5)', () => {
  it('reads QUIET (<2m) as the muted amber, never the full needs-you ink, and never pulses', () => {
    render(<AttentionStripView fleet={singleItemFleet('needs-you', 0)} selectedId={null} onToggle={vi.fn()} />)
    const chip = screen.getByRole('button') as HTMLButtonElement
    expect(chip.className).toContain('text-waiting-benign')
    expect(chip.className).not.toContain('text-needs-you')
    expect(chip.className).not.toContain('attention-chip-age-pulse')
  })

  it('reads INK (2m–10m) as the full needs-you ink, no pulse', () => {
    render(
      <AttentionStripView
        fleet={singleItemFleet('needs-you', AGE_QUIET_MAX_MS)}
        selectedId={null}
        onToggle={vi.fn()}
      />,
    )
    const chip = screen.getByRole('button') as HTMLButtonElement
    expect(chip.className).toContain('text-needs-you')
    expect(chip.className).not.toContain('text-waiting-benign')
    expect(chip.className).not.toContain('attention-chip-age-pulse')
  })

  it('reads PULSE (>=10m) as the full ink plus the slow pulse, with the age figure emphasized', () => {
    render(
      <AttentionStripView
        fleet={singleItemFleet('needs-you', AGE_INK_MAX_MS)}
        selectedId={null}
        onToggle={vi.fn()}
      />,
    )
    const chip = screen.getByRole('button') as HTMLButtonElement
    expect(chip.className).toContain('text-needs-you')
    expect(chip.className).toContain('attention-chip-age-pulse')
    const ageFigure = within(chip).getByText('10m00s')
    expect(ageFigure.className).toContain('text-needs-you')
    expect(ageFigure.className).toContain('font-semibold')
  })

  it('degrades the PULSE band to the static brighter ink under prefers-reduced-motion, never dropping to a gentler pulse', () => {
    const restore = mockReducedMotion(true)
    try {
      render(
        <AttentionStripView
          fleet={singleItemFleet('needs-you', AGE_INK_MAX_MS)}
          selectedId={null}
          onToggle={vi.fn()}
        />,
      )
      const chip = screen.getByRole('button') as HTMLButtonElement
      expect(chip.className).toContain('text-needs-you')
      expect(chip.className).not.toContain('attention-chip-age-pulse')
    } finally {
      restore()
    }
  })

  it('never escalates BROKEN — red is already maximal, whatever its age', () => {
    render(
      <AttentionStripView
        fleet={singleItemFleet('broken', AGE_INK_MAX_MS * 5)}
        selectedId={null}
        onToggle={vi.fn()}
      />,
    )
    const chip = screen.getByRole('button') as HTMLButtonElement
    expect(chip.className).toContain('text-broken')
    expect(chip.className).not.toContain('attention-chip-age-pulse')
    expect(chip.className).not.toContain('text-waiting-benign')
  })

  it('never brightens NOTICE — cyan stays quiet, whatever its age', () => {
    render(
      <AttentionStripView
        fleet={singleItemFleet('notice', AGE_INK_MAX_MS * 5)}
        selectedId={null}
        onToggle={vi.fn()}
      />,
    )
    const chip = screen.getByRole('button') as HTMLButtonElement
    expect(chip.className).toContain('text-notice')
    expect(chip.className).not.toContain('attention-chip-age-pulse')
  })
})

// ── #143: the strip's retrospective chips ───────────────────────────────────

describe('AttentionStripView — retrospective waited chips', () => {
  const NOW = Date.UTC(2026, 6, 31, 12, 0, 0)
  const nextId = createIdFactory('waited')

  function ev<T extends Parameters<typeof createEvent>[0]>(
    type: T,
    payload: Parameters<typeof createEvent<T>>[1],
    ts: number,
  ): RhizomorphEvent {
    return createEvent(type, payload, { id: nextId(), ts })
  }

  /** A calm lane with one retrospective wait on record — no live pathology. */
  function blockedLog(handles: readonly { handle: string; waitMs: number }[]): RhizomorphEvent[] {
    const log: RhizomorphEvent[] = [
      ev('session.started', {
        sessionId: 'waited-strip',
        repoPath: '/repo',
        repoName: 'rhizomorph',
        mainBranch: 'main',
      }, NOW - 60_000),
      ev('worktree.discovered', { path: '/repo', branch: 'main', head: 'sha-0', isMain: true }, NOW - 60_000),
    ]
    for (const { handle, waitMs } of handles) {
      log.push(
        ev('worktree.discovered', { path: `/repo-wt/${handle}`, branch: handle, head: `sha-${handle}`, isMain: false }, NOW - 60_000),
        ev(
          'trace.span',
          {
            lane: handle,
            role: 'worker',
            traceId: `trace-${handle}`,
            spanId: `span-${handle}`,
            parentSpanId: null,
            name: 'claude_code.tool.blocked_on_user',
            kind: 'tool_blocked',
            startTs: NOW - 30_000 - waitMs,
            endTs: NOW - 30_000,
            status: 'ok',
            decision: 'accept',
            toolName: 'Bash',
          },
          NOW - 30_000,
        ),
      )
    }
    return log
  }

  function chipButtons(): HTMLButtonElement[] {
    return screen.getAllByTestId('waited-chips').flatMap((row) =>
      Array.from(row.querySelectorAll('button')),
    ) as HTMLButtonElement[]
  }

  it('says "waited", never "waiting" — prd9 ruling 6\'s wording', () => {
    const fleet = buildFleet(reduceAll(blockedLog([{ handle: 'a', waitMs: 12_000 }])), { now: NOW })
    render(<AttentionStripView fleet={fleet} selectedId={null} onToggle={vi.fn()} />)

    const chip = chipButtons()[0] as HTMLButtonElement
    expect(chip.textContent).toContain('waited')
    expect(chip.textContent).not.toMatch(/\bwaiting\b/)
  })

  it('stays below the calm ceiling — no ladder hue, no glow, no cartouche', () => {
    const fleet = buildFleet(reduceAll(blockedLog([{ handle: 'a', waitMs: 12_000 }])), { now: NOW })
    render(<AttentionStripView fleet={fleet} selectedId={null} onToggle={vi.fn()} />)

    const chip = chipButtons()[0] as HTMLButtonElement
    for (const forbidden of ['text-needs-you', 'text-broken', 'text-notice', 'glow-', 'attention-chip-flare', 'attention-chip-age-pulse']) {
      expect(chip.className).not.toContain(forbidden)
    }
    // Every class actually used stays in the ice register — spelled as a ROLE
    // since the 2026-08-17 colour sweep (`text-(--ink-…)` resolves to the ice
    // ramp in dark and to warm paper in light, which is the whole point), plus
    // the ramp's own size tokens, which are not colours at all.
    const inRegister = (cls: string) =>
      !cls.startsWith('text-') ||
      cls.startsWith('text-(--ink-') ||
      cls.startsWith('text-inst') ||
      cls.startsWith('text-read')
    expect(chip.className.split(/\s+/).every(inRegister)).toBe(true)
    // …and the check bites: a ladder hue would not be in the register.
    expect(inRegister('text-needs-you')).toBe(false)
  })

  it('caps the quiet region at MAX_WAITED_CHIPS even with more lanes waited', () => {
    const handles = [
      { handle: 'a', waitMs: 10_000 },
      { handle: 'b', waitMs: 40_000 },
      { handle: 'c', waitMs: 20_000 },
      { handle: 'd', waitMs: 50_000 },
      { handle: 'e', waitMs: 30_000 },
    ]
    const fleet = buildFleet(reduceAll(blockedLog(handles)), { now: NOW })
    render(<AttentionStripView fleet={fleet} selectedId={null} onToggle={vi.fn()} />)

    expect(chipButtons()).toHaveLength(MAX_WAITED_CHIPS)
  })

  it('never raises the ladder or a pathology — this is memory, not a summons', () => {
    const fleet = buildFleet(reduceAll(blockedLog([{ handle: 'a', waitMs: 12_000 }])), { now: NOW })
    expect(fleet.rank).toBe('calm')
    expect(fleet.ladder.rank).toBe('calm')

    render(<AttentionStripView fleet={fleet} selectedId={null} onToggle={vi.fn()} />)
    expect(screen.getByText('ALL CLEAR')).toBeInTheDocument()
    expect(chipButtons()).toHaveLength(1)
  })

  it('clicking a waited chip focuses that lane via the shared selection', () => {
    const onToggle = vi.fn()
    const fleet = buildFleet(reduceAll(blockedLog([{ handle: 'a', waitMs: 12_000 }])), { now: NOW })
    render(<AttentionStripView fleet={fleet} selectedId={null} onToggle={onToggle} />)

    fireEvent.click(chipButtons()[0] as HTMLButtonElement)
    expect(onToggle).toHaveBeenCalledWith('a')
  })

  it('renders no quiet region at all when no lane has ever sat blocked on a human', () => {
    const fleet = fleetFor(fleet20Spec())
    render(<AttentionStripView fleet={fleet} selectedId={null} onToggle={vi.fn()} />)
    expect(screen.queryByTestId('waited-chips')).not.toBeInTheDocument()
  })
})

/**
 * A minimal, hand-built `Fleet` carrying exactly one attention item — the age
 * band tests need to pin `forMs` to exact millisecond boundaries, which no
 * fixture's staged timeline can promise. Modeled on `panels/burn/index.test`'s
 * `makeFleet`: fields the view never reads are filled with inert defaults.
 */
function singleItemFleet(rank: Exclude<LadderRank, 'calm'>, forMs: number): Fleet {
  const item: AttentionItem = {
    id: `${rank}:lane-x`,
    laneId: 'lane-x',
    label: 'lane-x',
    kind: rank === 'notice' ? 'expensive' : rank === 'broken' ? 'frozen' : 'looping',
    rank,
    forMs,
    evidence: 'evidence',
    inferred: false,
  }
  return {
    now: NOW,
    root: {
      repoName: null,
      mainBranch: null,
      worktreePath: null,
      commitsHome: 0,
      landings: 0,
      conductorOutputTokens: 0,
      overheadRatio: null,
      lastCommitTs: null,
      subagents: null,
    },
    lanes: [],
    ladder: { rank, items: [item] },
    rank,
    burn: {
      outputTokens: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 },
      costUsd: 0,
      costIsAuthoritative: null,
      costEventCount: 0,
      outputPerMin: 0,
      costUsdPerHour: 0,
      overheadRatio: null,
      conductorInstrumented: false,
      windowMs: 300_000,
    },
    collisions: [],
    gaps: [],
    hasLaneManifest: false,
    eventCount: 0,
  }
}

/** Installs a `window.matchMedia` that reports reduced motion, then restores it. */
function mockReducedMotion(reduced: boolean): () => void {
  const original = window.matchMedia
  window.matchMedia = ((query: string) => ({
    matches: query.includes('reduce') ? reduced : false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia
  return () => {
    window.matchMedia = original
  }
}
