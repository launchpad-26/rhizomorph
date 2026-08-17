import '@testing-library/jest-dom/vitest'
import { beforeEach } from 'vitest'

/**
 * jsdom's own default window is 1024×768 — narrower than the window floor
 * #549 introduces (S5, prd-32 ruling 10: ~1100×700 minimum). Every existing
 * suite renders `App`/`Shell`/a page expecting its real content, not the
 * below-floor honest panel, so the default here is pinned above the floor
 * (matching the ~1440×900 primary target) rather than each of dozens of
 * unrelated suites needing to know the floor exists. `WindowFloor.test.tsx`
 * and any other suite that cares shrinks the window itself, per test.
 */
beforeEach(() => {
  window.innerWidth = 1440
  window.innerHeight = 900
})
