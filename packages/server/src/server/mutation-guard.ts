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
 * cannot read this server's *responses* across origins for a genuinely
 * cross-origin call (the same-origin policy still applies), but DNS
 * rebinding defeats that entirely: an attacker makes a hostname it controls
 * (`evil.example`) resolve to `127.0.0.1` only *after* the page has already
 * loaded, so a `fetch()`/`EventSource` the page then opens against its own
 * hostname is, from the browser's point of view, a same-origin call — same-
 * origin policy never engages, and the page reads the full response. That is
 * exactly as true of a `GET` (`/api/stream`'s SSE, `/api/transcript/:lane`)
 * as it is of a mutating `POST`: "a cross-origin GET can't read the
 * response, CORS blocks it" — this file's own former reasoning for exempting
 * reads — is false in precisely the rebinding case it needs to defend
 * against, because rebinding is what makes the request look same-origin,
 * not cross-origin.
 *
 * `Host` closes that gap because it is set by the BROWSER from the page's
 * own address, never by the page's script — a page served from
 * `https://evil.example` cannot make it say `127.0.0.1`, no matter what DNS
 * answers for `evil.example` later. `Host` is therefore checked for every
 * request this server receives, read or write, applied once, here, at app
 * assembly, so every route — present and future — gets it for free rather
 * than each route's author needing to remember to add it, `/api/rotate` and
 * the laboratory's routes included.
 *
 * `Origin` stays scoped to mutating methods below: a genuinely cross-origin
 * `fetch`/`XHR` DOES carry an `Origin` header, so it adds CSRF coverage on
 * top of `Host` for state-changing requests — but the rebinding attack this
 * file is defending against produces a *same-origin* `GET`, and a
 * same-origin `GET` carries no `Origin` header at all, so `Origin` could
 * never have caught it regardless of method. `Host` is what has to run for
 * every method instead.
 *
 * Three checks, all before body parsing (`onRequest`, the earliest hook
 * Fastify offers), so a request this suspect never gets its body read at
 * all:
 *
 * 1. **`Host` is loopback — every method, including `GET`.** Defeats DNS
 *    rebinding: the browser's `Host` header always reflects the URL's
 *    declared hostname, never the address it actually resolved to, so a
 *    rebound `evil.example` request still says `Host: evil.example` even
 *    once that name resolves to `127.0.0.1`.
 * 2. **`Origin`, if present, is loopback — mutating methods only.** Defeats
 *    a cross-origin CSRF-style POST from any other page. Absent entirely
 *    (true of every non-browser client, `rhizomorph rotate` included) is
 *    allowed through this check, deliberately and permanently — this guard is
 *    not the control for a caller with no browser. `requireCapabilityToken`
 *    in `api/security.ts` is, and since #234 each of this server's seven
 *    GATED mutating routes requires it: `/api/label`, `/api/rotate`,
 *    `/api/retarget`, `/api/lab/launch`, `/api/operator/:act`, and the
 *    concierge's two granted powers `/api/concierge/clone` and
 *    `/api/concierge/launch` (prd-20 ruling 1 /
 *    ADR-0019 — the gate IS the grant there, which is why neither may ever
 *    be reachable from a collector or a poll). The other four mutating
 *    routes — the OTLP inbox's
 *    `/v1/metrics`, `/v1/logs`, `/v1/traces`, and the bare-path fallback
 *    `POST /` (ADR-0018) — are ungated by design (prd-23 ruling 6): an
 *    exporter has no channel to learn the token at all. A bare
 *    `curl` against a gated route still passes THIS hook and is then refused
 *    by that one, which is the intended division of labour rather than a
 *    hole; widening this hook to reject a missing `Origin` would break every
 *    legitimate non-browser caller and buy nothing an attacker could not
 *    forge, since a local process sets its own headers freely.
 * 3. **`Content-Type` is `application/json`, whenever a body is present —
 *    mutating methods only.** Ingestion enforcement (the audit's third ask)
 *    — a request smuggling a body as `text/plain` or `multipart/form-data`
 *    to dodge the JSON body parser's own strictness is refused outright
 *    rather than silently accepted as an unparsed string.
 */

/**
 * The spellings this instrument accepts as its own address. Deliberately NOT
 * here: `0.0.0.0` — dialling it does reach a `127.0.0.1`-bound socket, so
 * `curl http://0.0.0.0:PORT` worked for reads before #235 — but it is the
 * unspecified address (RFC 1122 §3.2.1.3 forbids it as a destination), the
 * dial-through is an OS convenience Linux/macOS grant and Windows refuses,
 * and current major browsers block or are removing `0.0.0.0` as a reachable
 * address. So the guard refuses it loudly (the 400 points at
 * `127.0.0.1`/`localhost`) rather than endorsing a non-portable spelling no
 * doc advertises. Same posture for the trailing-dot
 * `localhost.` and for a Host-less HTTP/1.0 request — see the CHANGELOG's
 * #235 entry and `docs/user-guide/troubleshooting.md` for the operator-facing
 * story.
 */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/**
 * Methods the `Origin` and `Content-Type` checks apply to — `Host` above
 * runs for every method regardless. This server has eleven mutating routes
 * today (prd-23 ruling 5's route-class law — `api/index.ts`'s `ROUTE_CLASSES`
 * is where all eleven are declared): seven gated (`/api/label`,
 * `/api/rotate`, `/api/retarget`, `/api/lab/launch`, `/api/operator/:act`,
 * `/api/concierge/clone`, `/api/concierge/launch`) and four ungated by
 * design (the OTLP inbox: `/v1/metrics`, `/v1/logs`, `/v1/traces`, and the
 * bare-path fallback `POST /`, ADR-0018) — every one of them a `POST`;
 * `PUT`/`PATCH`/`DELETE` are included so a future mutating route never has
 * to remember to ask for this separately.
 */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * The hostname a `Host` header names, stripping an optional `:port` — bare
 * for an ordinary name or IPv4 literal (`127.0.0.1:4317` -> `127.0.0.1`),
 * bracket-stripped for a bracketed IPv6 literal (`[::1]:4317` -> `::1`), and
 * returned whole for a bare (unbracketed, portless) IPv6 literal, which the
 * `Host` header grammar never combines with a port.
 *
 * A malformed value — a port that isn't digits, on either branch, like
 * `[::1]evil.example` or `localhost:evil` — is returned whole rather than
 * stripped, so it can never spell a loopback name: discarding the trailing
 * text of `[::1]evil.example` would read that header as `::1` and fail open.
 */
function hostnameFromHostHeader(host: string): string {
  const trimmed = host.trim()
  if (trimmed.startsWith('[')) {
    const closingBracket = trimmed.indexOf(']')
    if (closingBracket === -1) return trimmed
    const afterBracket = trimmed.slice(closingBracket + 1)
    if (!/^(:\d*)?$/.test(afterBracket)) return trimmed
    return trimmed.slice(1, closingBracket)
  }
  const colonCount = trimmed.split(':').length - 1
  if (colonCount !== 1) return trimmed // 0 colons: bare name; >1: a bracket-less IPv6 literal
  const lastColon = trimmed.lastIndexOf(':')
  if (!/^\d*$/.test(trimmed.slice(lastColon + 1))) return trimmed
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
 * `GET /api/doctor` used to opt itself into this exact predicate as its own
 * route-local `preHandler` (prd-19 ruling 5, adversarial review item 1), back
 * when every `GET` was exempt from this module's own Host/Origin guard. #235
 * closed that gap globally — this hook now runs before the
 * `MUTATING_METHODS` early-return below, for every method — and prd-23
 * ruling 5 retired the now-redundant route-local copy. Kept private: nothing
 * outside this module needs it anymore.
 */
function isLoopbackHost(host: string | undefined): boolean {
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
    const host = request.headers.host
    if (!isLoopbackHost(host)) {
      return refuse(reply, 400, `refused: Host "${host ?? ''}" is not loopback — this instrument only accepts requests addressed to 127.0.0.1/localhost`)
    }

    if (!MUTATING_METHODS.has(request.method)) return

    const origin = request.headers.origin
    if (typeof origin === 'string' && origin.length > 0 && !isLoopbackOrigin(origin)) {
      return refuse(reply, 403, `refused: cross-origin mutation — Origin "${origin}" is not this instrument's own loopback origin`)
    }

    if (declaresBody(request) && !isJsonContentType(request.headers['content-type'])) {
      return refuse(reply, 415, 'refused: mutating requests with a body must set Content-Type: application/json')
    }
  })
}
