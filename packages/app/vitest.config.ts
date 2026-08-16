import { defineConfig } from 'vitest/config'

// node, deliberately: nothing in this package renders. The shell's own code is
// process supervision, path resolution and state derivation — the SPA is the
// only thing that draws, and it ships unmodified from `packages/web`
// (prd-34 ruling 1). A jsdom environment here would be a standing invitation
// to grow a second UI inside the shell; `src/host/no-fork-law.test.ts` says
// out loud that there isn't one.
export default defineConfig({
  test: {
    environment: 'node',
    name: { label: 'app', color: 'cyan' },
  },
})
