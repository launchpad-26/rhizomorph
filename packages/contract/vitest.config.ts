import { defineConfig } from 'vitest/config'

// jsdom, deliberately: the load-bearing property of a contract test is that
// the REAL client reads the REAL served page for its capability token — which
// means a document must exist for `readCapabilityToken` to query. The server
// side runs fine under jsdom; the client side cannot run under node. This
// asymmetry is exactly why neither existing package could host these tests
// (prd-24 ruling 1's first rejected alternative).
export default defineConfig({
  test: {
    environment: 'jsdom',
    name: { label: 'contract', color: 'magenta' },
  },
})
