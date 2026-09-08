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

/**
 * The cookie name the stream route's alternate credential rides in (prd-29
 * ruling 4). `EventSource` cannot set a custom header at all, so
 * `server/static.ts` sets this cookie — HttpOnly, SameSite=Strict — beside
 * the capability meta tag on every HTML response, and
 * {@link requireCapabilityToken}'s `allowCookie` option reads it back here.
 * Distinct from `server/static.ts`'s own `CAPABILITY_META_NAME`: that one is
 * deliberately JS-readable (the SPA's fetch calls read it to build the
 * header); this one is deliberately not.
 */
export const CAPABILITY_COOKIE_NAME = 'rhizomorph-capability-cookie'

/** Bytes of entropy in a minted token — 256 bits, the same order as a session id's own collision margin, encoded as 64 hex characters. */
const TOKEN_BYTES = 32

/** Mints one per-process capability token. Called at most once per boot — see `buildApp`. */
export function generateCapabilityToken(): string {
  return randomBytes(TOKEN_BYTES).toString('hex')
}

/**
 * A constant-time equality check for two tokens (prd-29 ruling 5). The old
 * `===` was priced (in this module's own doc) against three rare,
 * human-initiated mutations; prd-29 puts the same token on sixteen reads the
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
 * Builds the `Set-Cookie` value `server/static.ts` sends beside the
 * capability meta tag (prd-29 ruling 4). HttpOnly and SameSite=Strict are
 * the two properties the ruling names as non-negotiable — never readable
 * from JS, never sent cross-site. No `Secure`: this server binds
 * loopback-only and is reached over plain HTTP, and a `Secure` cookie would
 * silently never be sent at all over that.
 */
export function buildCapabilityCookie(token: string): string {
  return `${CAPABILITY_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`
}

/**
 * Reads {@link CAPABILITY_COOKIE_NAME} back out of a raw `Cookie` request
 * header. This app registers no cookie-parsing plugin — this is the one
 * place that understands the wire format, matching
 * {@link buildCapabilityCookie}.
 *
 * A malformed percent-encoding (`%` with no following hex pair) makes
 * `decodeURIComponent` throw `URIError`, uncaught — review of #93 found this
 * turns any request carrying such a cookie into a 500 rather than the clean
 * 401 every other bad credential gets. Not a bypass (the gate still refuses,
 * just noisily), but a caller cannot forge that shape by accident, and one
 * who can forge it deliberately gets a stack trace where a status code would
 * do — an unnecessary information leak this gate exists to not have. Caught
 * here and treated as "no cookie", the same as any other unparseable one.
 */
function readCapabilityCookie(cookieHeader: string | undefined): string | undefined {
  if (cookieHeader === undefined) return undefined
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() !== CAPABILITY_COOKIE_NAME) continue
    try {
      return decodeURIComponent(part.slice(eq + 1).trim())
    } catch {
      return undefined
    }
  }
  return undefined
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
 * Options for {@link requireCapabilityToken}.
 */
export interface CapabilityGateOptions {
  /**
   * Accept {@link CAPABILITY_COOKIE_NAME} as an alternate credential when no
   * (or no valid) header is present. Exists for exactly one caller today —
   * `api/stream.ts`'s `preHandler`, because `EventSource` cannot set a
   * header at all (prd-29 ruling 4) — and must never be passed at a
   * `gated-mutation` call site: every one of those omits it, so an ambient
   * cookie a browser attaches on its own is never a sufficient credential
   * for a mutation. That is enforced by omission, not a runtime check on the
   * route's method, which is why `security.test.ts` asserts the refusal
   * directly against the same default this gate gives every mutation,
   * rather than trusting the wiring.
   *
   * Default `false`.
   */
  allowCookie?: boolean
}

/**
 * Fastify `preHandler` for one gated route: the request must carry
 * {@link CAPABILITY_TOKEN_HEADER} matching `expectedToken` exactly — or,
 * only when `options.allowCookie` is set, {@link CAPABILITY_COOKIE_NAME}
 * matching it instead — or it never reaches the handler. Applied per-route
 * (not globally in `build-app.ts`) because a `read` route (`GET /*`, the
 * tokenless bootstrap) must keep working exactly as it did before this
 * module existed — the gate-presence law (ADR-0024) is what turns "forgot to
 * apply it" from a silent hole into a red build.
 *
 * The returned handler is branded with {@link CAPABILITY_GATE} so the law can
 * see it on the route's `preHandler` chain.
 *
 * Fastify lower-cases incoming header names, so `request.headers[...]` here
 * reads the header regardless of the case a caller sent it in.
 */
export function requireCapabilityToken(expectedToken: string, options: CapabilityGateOptions = {}) {
  const { allowCookie = false } = options
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
    const header = request.headers[CAPABILITY_TOKEN_HEADER]
    // A present header — even a wrong one — is never overridden by falling
    // through to the cookie: the header is the primary channel every
    // gated-mutation route relies on exclusively, and giving a wrong header
    // a second chance via the cookie would blur that priority for the one
    // route that has both available.
    const provided =
      typeof header === 'string' ? header : allowCookie ? readCapabilityCookie(request.headers.cookie) : undefined
    if (typeof provided !== 'string' || !tokensMatch(expectedToken, provided)) {
      await reply.code(401).send({
        error: allowCookie
          ? `missing or invalid ${CAPABILITY_TOKEN_HEADER} header or ${CAPABILITY_COOKIE_NAME} cookie — this route requires the per-process capability token`
          : `missing or invalid ${CAPABILITY_TOKEN_HEADER} header — this route requires the per-process capability token`,
      })
    }
  }
  return Object.assign(gate, { [CAPABILITY_GATE]: true as const })
}
