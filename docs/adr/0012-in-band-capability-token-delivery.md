# 0012. Deliver the capability token in-band, via a `<meta>` tag in `index.html`

- **Status:** accepted
- **Date:** 2026-08-08

## Context and Problem Statement

`requireCapabilityToken` (`api/security.ts`) has gated `POST /api/label` since
the 2026-08-06 audit (ADR-0008): a mutating request must carry
`x-rhizomorph-capability`, matching a value minted once per process
(`generateCapabilityToken`, `server/build-app.ts:67`) and held only in memory.

Nothing ever delivered that value to the browser. `GET /api/meta` doesn't
carry it, the header name appears nowhere under `packages/web/`, and
`recordings/label.ts` — the only caller — had no field to put it in even if it
had one. The result: `POST /api/label` 401ed on every boot, for every session,
unconditionally (#249). `api/security.ts`'s own prose named this as the
explicit follow-up, but no issue carried it and the feature shipped gated
regardless.

The token has to reach the same browser tab that will use it, without
becoming readable by a party ADR-0008's threat model does not trust: another
local process on the same machine, or (via DNS rebinding) a page that got the
browser to treat a foreign origin as loopback.

## Considered Options

- **A — Out-of-band delivery.** Print the token to the terminal at boot (the
  Jupyter/VNC pattern), and have the operator paste it into the dashboard
  once per boot.
- **B — In-band delivery.** Serve the token embedded in `index.html` itself,
  stamped in at serve time, and have the app's own JS read it off the page on
  load.
- **C — A pre-auth exchange.** Have the browser fetch the token from a new
  endpoint before its first mutating call.

## Decision Outcome

Chosen: **B**.

**A is rejected.** Not on security grounds — it would work — but because it
ships a control the shipped UI cannot use. The rename button has no field to
paste a token into; building one means a second feature (a token-entry
control, somewhere to hold the pasted value, a re-prompt every restart since
the token is minted fresh per boot) whose entire job is compensating for the
delivery mechanism. That is a worse shape for the exact same guarantee B
gives for free.

**C doesn't add an isolation boundary beyond what already exists.** The only
signal that distinguishes a legitimate browser tab from an attacking local
process at the HTTP layer is `Origin`/`Host` — the mutation guard
(`server/mutation-guard.ts`). Gating a token-issuing endpoint behind that same
guard is equivalent in every way that matters to gating the page itself
behind it, which is already how `GET /` works. C adds a network round trip
and a loading state for no marginal security.

So **B**: `server/static.ts` reads `index.html` at serve time and stamps
`<meta name="rhizomorph-capability" content="...">` into its `<head>` before
sending it — for the literal root and for every SPA-fallback path alike, so
any URL the client-side router owns still lands on a shell carrying the
token. `packages/web/src/recordings/capability.ts` is the one module that
reads it back, via `querySelector`, so every future mutating route
(`/api/rotate`, the laboratory's launch — #234) adopts the same read instead
of growing its own.

## Consequences

- **Good.** The browser has the token the instant it loads the dashboard — no
  extra request, no operator step, and it fails the same way the rest of the
  page would if the server were unreachable at all.
- **Good.** No new trust boundary was invented: `GET /` already only reaches
  whatever can address loopback and be served the app shell. The token is now
  exactly as available as the shell itself already was — nothing wider.
- **Bad, stated plainly rather than overclaimed.** In-band delivery *is*
  readable by the attacker ADR-0008's own threat model names as real: another
  local process on the same machine. Anything that can read the DOM of the
  dashboard's tab, or issue its own loopback `GET /`, gets the token exactly
  as the browser does. This closes the "no browser at all" gap — a caller
  with zero access to the page or a browser still cannot mutate anything —
  and it does no more than that. It was never going to: a value handed to a
  page over unauthenticated HTTP cannot be hidden from something that can
  already reach that page.
- **Bad — a known dev-mode gap, not closed by this record.** `npm run
  dev:web` runs vite's own dev server directly against
  `packages/web/index.html`; that file is served by vite's static middleware,
  never by `server/static.ts`, so no meta tag is ever injected there. Separately,
  `vite.config.ts` proxies nothing to a running server on another origin, so
  `POST /api/label` has no live route to reach under `dev:web` alone regardless
  of the token. Neither half of this is new — no wiring between the two dev
  servers existed before this change — and closing it (a vite plugin plus
  proxy config) is out of this record's scope. Exercising the mutation path
  in development means running the built server (`dev:server`, or a full
  `build` + `start`), not `dev:web` alone.
- **Neutral.** The token is now visible in "view source" on the dashboard's
  own tab — no different in kind from every other asset the server already
  serves, unauthenticated, to anything that can reach loopback.
