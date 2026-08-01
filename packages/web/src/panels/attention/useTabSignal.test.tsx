import { reduceAll } from '@observatory/core'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildFleet,
  fixtureHistory,
  fleet20Spec,
  manifestFor,
  pathologySpec,
  type Fleet,
  type FixtureSpec,
} from '../../fleet/index.js'
import { useTabSignal } from './useTabSignal.js'

const NOW = Date.UTC(2026, 6, 31, 12, 0, 0)
const ICON_SELECTOR = 'link[rel="icon"]'

function fleetFor(spec: FixtureSpec): Fleet {
  const state = reduceAll(fixtureHistory(spec, NOW))
  return buildFleet(state, { now: NOW, manifest: manifestFor(spec) })
}

function Harness({ fleet }: { fleet: Fleet }) {
  useTabSignal(fleet)
  return null
}

beforeEach(() => {
  document.title = 'Observatory Test'
  document.querySelectorAll(ICON_SELECTOR).forEach((el) => el.remove())
})

afterEach(cleanup)

describe('useTabSignal', () => {
  const calm = fleetFor(fleet20Spec())
  const staged = fleetFor(pathologySpec())

  it('leaves the tab untouched while calm', () => {
    expect(calm.rank).toBe('calm')

    render(<Harness fleet={calm} />)

    expect(document.title).toBe('Observatory Test')
    expect(document.querySelector(ICON_SELECTOR)).toBeNull()
  })

  it('flips the title to "● N need you" at NEEDS-YOU and above, counting only the summons', () => {
    expect(staged.rank).toBe('broken')

    render(<Harness fleet={staged} />)

    // frozen (broken) + looping/waiting/off-fence (needs-you) = 4; the
    // expensive (notice) lane is a heads-up, not a summons, so it is not
    // counted in "need you".
    expect(document.title).toBe('● 4 need you')
  })

  it('takes the favicon to the worst rung\'s hue', () => {
    render(<Harness fleet={staged} />)

    const link = document.querySelector(ICON_SELECTOR)
    expect(link).not.toBeNull()
    expect(link?.getAttribute('href')).toContain('data:image/svg+xml')
  })

  it('restores the exact original title and favicon once the fleet returns to calm', () => {
    const { rerender } = render(<Harness fleet={staged} />)
    expect(document.title).toBe('● 4 need you')
    expect(document.querySelector(ICON_SELECTOR)).not.toBeNull()

    rerender(<Harness fleet={calm} />)

    expect(document.title).toBe('Observatory Test')
    expect(document.querySelector(ICON_SELECTOR)).toBeNull()
  })
})
