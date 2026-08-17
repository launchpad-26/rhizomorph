import type { FastifyInstance } from 'fastify'
import { CAPABILITY_TOKEN_HEADER } from './security.js'

/**
 * A fixed capability token for tests whose helper mints the app inline (e.g.
 * `makeApp().inject(...)`), where there is no built-app reference to read the
 * per-boot token from. Pass it into `buildApp`'s `ctx.capabilityToken` and to
 * {@link capabilityHeaders} both, so the header matches what the gate expects.
 */
export const TEST_CAPABILITY_TOKEN = 'rhizomorph-test-capability-token'

/**
 * The capability header a `gated-read`/`gated-mutation` route requires
 * (prd-29 / ADR-0024), for tests that `app.inject` against `buildApp`. Give it
 * the built app to read the per-boot token off it, or a token string directly
 * (for the inline-`makeApp` case, with {@link TEST_CAPABILITY_TOKEN}). A test
 * that means to probe the refusal simply omits the header.
 */
export function capabilityHeaders(appOrToken: FastifyInstance | string): Record<string, string> {
  const token = typeof appOrToken === 'string' ? appOrToken : appOrToken.capabilityToken
  return { [CAPABILITY_TOKEN_HEADER]: token }
}
