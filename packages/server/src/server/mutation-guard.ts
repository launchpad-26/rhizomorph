import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

/**
 * THE MUTATION GUARD — the audit's first control (2026-08-06, accepted):
 * *"Loopback-only is the right default, but localhost is not a trust
 * boundary against a malicious webpage (DNS rebinding, CSRF-style POSTs) or
 * another local process."*
 *
 * Binding to `127.0.0.1` only (`cli/index.ts`'s `app.listen({ host:
 * '127.0.0.1' })`) keeps the socket off the network, but any process on the
 * machine — including a browser tab that navigated to an ordinary internet
 * page — can still open a TCP connection to it. A page's own JavaScript
 * cannot read this server's *responses* across origins (the same-origin
 * policy still applies), but it can *send* a same-method, same-shape POST
 * blind, and a DNS-rebinding attacker can make a hostname it controls
 * resolve to `127.0.0.1` after the page has already loaded, so "the request
 * came from a page the browser thinks is same-origin with something" is not
 * a safe assumption either.
 *
 * `Origin`/`Host` close exactly that gap, because both are set by the
 * BROWSER from the page's own address, never by the page's script — a page
 * served from `https://evil.example` cannot make either header say
 * `127.0.0.1`, no matter what DNS answers for `evil.example` later. This is
 * therefore checked for every mutating request, applied once, here, at app
 * assembly, so every mutating route gets it for free rather than each
 * route's author needing to remember to add it — including `/api/rotate`
 * and the laboratory's routes, neither of which this issue's fence lets this
 * lane edit directly.
 *
 * **Read-only routes are deliberately exempt.** A `GET` cannot be this
 * attack's payload — nothing it does is undone by rejecting it, and the
 * observer's own promise (`SECURITY.md`) is that nothing it reads ever
 * leaves the machine, so a cross-origin `GET` reading local state back into
 * a page that already has the response would need a same-origin response
 * read, which the browser's own CORS enforcement already blocks (this
 * server sends no `Access-Control-Allow-Origin`). If this server ever binds
 * beyond loopback — a repo shared over a LAN, say — that assumption stops
 * holding and read routes need this same law; the fence below is written to
 * make that widening a one-line change (`MUTATING_METHODS` growing to
 * include `GET`), not a rewrite.
 *
 * Three checks, all before body parsing (`onRequest`, the earliest hook
 * Fastify offers), so a request this suspect never gets its body read at
 * all:
 *
 * 1. **`Host` is loopback.** Defeats DNS rebinding: the browser's `Host`
 *    header always reflects the URL's declared hostname, never the address
 *    it actually resolved to, so a rebound `evil.example` request still says
 *    `Host: evil.example` even once that name resolves to `127.0.0.1`.
 * 2. **`Origin`, if present, is loopback.** Defeats a cross-origin
 *    CSRF-style POST from any other page. Absent entirely (true of every
 *    non-browser client — `rhizomorph rotate`'s own request today never
 *    sends one) is allowed through this check; {@link CAPABILITY_TOKEN_HEADER}
 *    in `api/security.ts` is the control that closes THAT gap.
 * 3. **`Content-Type` is `application/json`, whenever a body is present.**
 *    Ingestion enforcement (the audit's third ask) — a request smuggling a
 *    body as `text/plain` or `multipart/form-data` to dodge the JSON body
 *    parser's own strictness is refused outright rather than silently
 *    accepted as an unparsed string.
 */

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/**
 * Methods this guard applies to. Every route this issue is scoped to
 * (`/api/label` today; `/api/rotate` and the laboratory's routes in their
 * own follow-ups) is a `POST`; `PUT`/`PATCH`/`DELETE` are included so a
 * future mutating route never has to remember to ask for this separately.
 */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * The hostname a `Host` header names, stripping an optional `:port` — bare
 * for an ordinary name or IPv4 literal (`127.0.0.1:4317` -> `127.0.0.1`),
 * bracket-stripped for a bracketed IPv6 literal (`[::1]:4317` -> `::1`), and
 * returned whole for a bare (unbracketed, portless) IPv6 literal, which the
 * `Host` header grammar never combines with a port.
 */
function hostnameFromHostHeader(host: string): string {
  const trimmed = host.trim()
  if (trimmed.startsWith('[')) {
    const closingBracket = trimmed.indexOf(']')
    return closingBracket === -1 ? trimmed : trimmed.slice(1, closingBracket)
  }
  const colonCount = trimmed.split(':').length - 1
  if (colonCount !== 1) return trimmed // 0 colons: bare name; >1: a bracket-less IPv6 literal
  const lastColon = trimmed.lastIndexOf(':')
  return trimmed.slice(0, lastColon)
}

/** The hostname an `Origin` header names, or `null` for a value that isn't a parseable origin at all (refused either way — an unparseable Origin is never loopback). */
function hostnameFromOrigin(origin: string): string | null {
  try {
    return new URL(origin).hostname
  } catch {
    return null
  }
}

/**
 * Exported for `api/doctor.ts` (prd-19 ruling 5, adversarial review item 1):
 * `GET /api/doctor` is a recon-grade disclosure (repo/home paths, versions,
 * tool presence, session facts) that would otherwise sit behind #235's known
 * gap — every `GET` is exempt from this module's own Host/Origin guard until
 * that issue widens `MUTATING_METHODS`. Rather than wait, that one route
 * opts itself into this exact predicate as a `preHandler`. This pre-answers
 * #235 for this route only; the global GET exemption stays #235's own work.
 */
export function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined) return false
  return LOOPBACK_HOSTNAMES.has(hostnameFromHostHeader(host).toLowerCase())
}

function isLoopbackOrigin(origin: string): boolean {
  const hostname = hostnameFromOrigin(origin)
  return hostname !== null && LOOPBACK_HOSTNAMES.has(hostname.toLowerCase())
}

/** True when the request declares a body at all — an empty `POST` (today's `/api/rotate`) has neither. */
function declaresBody(request: FastifyRequest): boolean {
  const contentLength = request.headers['content-length']
  if (typeof contentLength === 'string' && Number(contentLength) > 0) return true
  const transferEncoding = request.headers['transfer-encoding']
  return typeof transferEncoding === 'string' && transferEncoding.toLowerCase().includes('chunked')
}

function isJsonContentType(contentType: string | undefined): boolean {
  if (contentType === undefined) return false
  // Allows an optional `; charset=...` parameter — `application/json` is the
  // whole requirement, not the absence of one.
  return /^application\/json\s*(;.*)?$/i.test(contentType.trim())
}

async function refuse(reply: FastifyReply, code: number, error: string): Promise<void> {
  await reply.code(code).send({ error })
}

/**
 * Registers the guard as a global `onRequest` hook. One registration covers
 * every route in `app`, present and future — see this module's own doc for
 * why that is the point rather than an accident.
 */
export function registerMutationGuard(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    if (!MUTATING_METHODS.has(request.method)) return

    const host = request.headers.host
    if (!isLoopbackHost(host)) {
      return refuse(reply, 400, `refused: Host "${host ?? ''}" is not loopback — this instrument only accepts mutating requests addressed to 127.0.0.1/localhost`)
    }

    const origin = request.headers.origin
    if (typeof origin === 'string' && origin.length > 0 && !isLoopbackOrigin(origin)) {
      return refuse(reply, 403, `refused: cross-origin mutation — Origin "${origin}" is not this instrument's own loopback origin`)
    }

    if (declaresBody(request) && !isJsonContentType(request.headers['content-type'])) {
      return refuse(reply, 415, 'refused: mutating requests with a body must set Content-Type: application/json')
    }
  })
}
