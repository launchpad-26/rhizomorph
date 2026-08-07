import { randomBytes } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'

/**
 * THE CAPABILITY TOKEN — the audit's second control (2026-08-06, accepted),
 * on top of `server/mutation-guard.ts`'s Origin/Host law. Loopback is a
 * *default*, not a trust boundary: another local process on the same
 * machine, or a malicious page that got a browser to bind past loopback via
 * DNS rebinding, can still speak plain HTTP to `127.0.0.1`. The mutation
 * guard closes the browser-CSRF half of that (an attacker's page can send a
 * request, but never one with a matching `Origin`). This closes the other
 * half: a caller with no browser at all — another local process, or a
 * successful rebind that somehow forged a loopback `Origin` — still cannot
 * mutate anything without a value it has no way to have observed.
 *
 * **Minted once per process, at boot** (`buildApp` generates one if the
 * caller didn't supply one — see `server/build-app.ts`), held only in
 * memory, and required by every mutating route that opts in via
 * {@link requireCapabilityToken}. `/api/label` is the first
 * (`api/label.ts`); the recorder's own mutating route (`/api/rotate`) and
 * the laboratory's adopt the same header in a follow-up — this module is the
 * one place the check lives so every future mutating route reads it off the
 * same `ServerContext.capabilityToken` field rather than growing its own.
 *
 * **Never logged.** Nothing in this module calls `console.*`, nothing
 * writes it to a file, and nothing echoes it back in a response or an error
 * message — a token an attacker could read off a log line is not a secret.
 *
 * **Delivered in-band, in the page itself (#249).** The gap this module
 * used to name here — the dashboard had no channel to learn the token at
 * all, so `POST /api/label` 401ed on every boot — is closed: `server/
 * static.ts` stamps the token into `index.html`'s `<head>` at serve time,
 * and `packages/web/src/recordings/capability.ts` reads it back from there.
 * That is a different exposure than a log line, and the record says so
 * rather than overclaiming: anything that can read the DOM of the
 * dashboard's own tab, or make its own loopback `GET /`, gets the token —
 * this closes the "no browser at all" half of the threat model (another
 * local process with no access to the page or the browser), not the half
 * where an attacker already has some access to either.
 * `docs/adr/0012-in-band-capability-token-delivery.md` has the full
 * decision, the rejected alternative, and that consequence in detail.
 */

/**
 * The header a mutating request must carry. Namespaced under `x-rhizomorph-`
 * rather than a generic `authorization` or `x-api-key`, so it reads, in a
 * request log or a browser devtools panel, as this instrument's own concern
 * rather than something a generic auth middleware would try to interpret.
 */
export const CAPABILITY_TOKEN_HEADER = 'x-rhizomorph-capability'

/** Bytes of entropy in a minted token — 256 bits, the same order as a session id's own collision margin, encoded as 64 hex characters. */
const TOKEN_BYTES = 32

/** Mints one per-process capability token. Called at most once per boot — see `buildApp`. */
export function generateCapabilityToken(): string {
  return randomBytes(TOKEN_BYTES).toString('hex')
}

/**
 * A constant-time-ish equality check for two tokens of the same expected
 * shape. `===` on two hex strings of equal, fixed length does not exhibit
 * the length-revealing short-circuit that makes naive string comparison
 * unsafe for secrets of *varying* length — every token this module mints is
 * exactly {@link TOKEN_BYTES} bytes of hex — but a caller can still send a
 * shorter or longer string, so length is checked first rather than left to
 * fall out of the comparison.
 */
function tokensMatch(expected: string, provided: string): boolean {
  return expected.length === provided.length && expected === provided
}

/**
 * Fastify `preHandler` for one mutating route: the request must carry
 * {@link CAPABILITY_TOKEN_HEADER} matching `expectedToken` exactly, or it
 * never reaches the handler. Applied per-route (not globally in
 * `build-app.ts`) because adoption is deliberately incremental — a route
 * that hasn't adopted it yet must keep working exactly as it did before this
 * module existed, per this issue's own fence.
 *
 * Fastify lower-cases incoming header names, so `request.headers[...]` here
 * reads the header regardless of the case a caller sent it in.
 */
export function requireCapabilityToken(expectedToken: string) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const provided = request.headers[CAPABILITY_TOKEN_HEADER]
    if (typeof provided !== 'string' || !tokensMatch(expectedToken, provided)) {
      await reply.code(401).send({
        error: `missing or invalid ${CAPABILITY_TOKEN_HEADER} header — this route requires the per-process capability token`,
      })
    }
  }
}
