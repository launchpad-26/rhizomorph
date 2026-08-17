import { randomBytes, timingSafeEqual } from 'node:crypto'
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
 * A constant-time equality check for two tokens (prd-29 ruling 5). The old
 * `===` was priced (in this module's own doc) against three rare,
 * human-initiated mutations; prd-29 puts the same token on ten reads the
 * dashboard polls continuously, a different probe profile, so the comparison
 * moves to {@link timingSafeEqual}. It throws on unequal-length buffers, so
 * length is still checked first — that also refuses a shorter or longer
 * string before any byte comparison runs.
 */
function tokensMatch(expected: string, provided: string): boolean {
  const e = Buffer.from(expected)
  const p = Buffer.from(provided)
  return e.length === p.length && timingSafeEqual(e, p)
}

/**
 * Brands the `preHandler` {@link requireCapabilityToken} returns, so the
 * route-class law (prd-29 ruling 2, ADR-0024) can prove a `gated-*` row's
 * route actually carries THIS gate — by walking the real Fastify routing
 * table and reading the brand off the `preHandler` chain — rather than
 * matching on fragile function identity or trusting that any `preHandler` at
 * all is the capability gate.
 */
export const CAPABILITY_GATE: unique symbol = Symbol('rhizomorph.capabilityGate')

/**
 * Fastify `preHandler` for one gated route: the request must carry
 * {@link CAPABILITY_TOKEN_HEADER} matching `expectedToken` exactly, or it
 * never reaches the handler. Applied per-route (not globally in
 * `build-app.ts`) because a `read` route (`GET /*`, the tokenless bootstrap)
 * must keep working exactly as it did before this module existed — the
 * gate-presence law (ADR-0024) is what turns "forgot to apply it" from a
 * silent hole into a red build.
 *
 * The returned handler is branded with {@link CAPABILITY_GATE} so the law can
 * see it on the route's `preHandler` chain.
 *
 * Fastify lower-cases incoming header names, so `request.headers[...]` here
 * reads the header regardless of the case a caller sent it in.
 */
export function requireCapabilityToken(expectedToken: string) {
  const gate = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    // An EMPTY expected token refuses everything, instead of matching an empty
    // header and opening the route.
    //
    // `tokensMatch('', '')` is true — 0 === 0, and '' === ''. Every call site
    // spells `requireCapabilityToken(ctx.capabilityToken ?? '')`, so any path
    // leaving the token unset turns this gate into a no-op for a request
    // carrying an empty `x-rhizomorph-capability` header. Unreachable through
    // today's single production entry point, but #234 widens that fallback
    // from one route to three, and the fourth is where "unreachable" stops
    // being true.
    //
    // Enforced here rather than at each call site, for the reason this module
    // exists at all: a guarantee a caller can decline is not a guarantee.
    if (expectedToken === '') {
      await reply.code(401).send({
        error: `${CAPABILITY_TOKEN_HEADER} is not configured on this server — this route refuses rather than opening`,
      })
      return
    }
    const provided = request.headers[CAPABILITY_TOKEN_HEADER]
    if (typeof provided !== 'string' || !tokensMatch(expectedToken, provided)) {
      await reply.code(401).send({
        error: `missing or invalid ${CAPABILITY_TOKEN_HEADER} header — this route requires the per-process capability token`,
      })
    }
  }
  return Object.assign(gate, { [CAPABILITY_GATE]: true as const })
}
