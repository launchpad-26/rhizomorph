# 0008. Localhost-only, single-origin server with token-gated mutation

- **Status:** accepted
- **Date:** 2026-08-06

## Context and Problem Statement

> **Reconstructed.** Written 2026-08-06. The bind was pinned 2026-07-31
> (`6b00777`); the mutation guard and capability token followed the adversarial
> audit, 2026-08-06 (`f46b148`, `2aff4ce`, `acea090`, `ab19d99`). The scope note
> below matters: **the SSE-vs-WebSocket transport choice is not part of this
> record**, because no deliberation of it survives — see Scope.

The instrument serves a web UI and an API on the developer's own machine, and
the data it serves is unusually sensitive: agent transcripts, session logs,
file paths, and whatever an agent happened to print.

A localhost server feels private but is not. Any page the user visits can issue
requests to `127.0.0.1`, and DNS rebinding can make the browser treat those
requests as same-origin.

## Considered Options

- **A — Bind all interfaces**, so the dashboard is reachable from another device.
- **B — Bind `127.0.0.1` only**, single origin (the server serves the built web
  app itself), no CORS.
- **C — B, and trust localhost for mutating routes** — anything that reached the
  socket is the user.
- **D — B, plus an explicit guard on mutating routes**: loopback `Host`,
  `Origin` when present, `Content-Type`, and a per-process capability token.

## Decision Outcome

Chosen: **D**.

**A was tried and reversed.** `6b00777` — *"pin listen host to 127.0.0.1"* — the
only commit in this set that undoes an earlier state rather than adding to one.

Single origin was chosen with it: the server serves the built web app statically,
so there is *"one origin, no CORS"* (`architecture.md:74`). Not sending CORS
headers means a foreign page cannot read a cross-origin response — a property
that comes free from the layout rather than from a header policy.

**C was rejected after the adversarial audit** (`fc992a2`) showed that "reached
the socket" and "is the user" are different claims on a shared machine. The
result was the mutation guard plus `requireCapabilityToken`, minted per process
and never logged.

## Scope — what this record does *not* decide

**The transport (SSE rather than WebSockets) is deliberately out of scope.** SSE
is simply stated in the pre-code architecture doc (`architecture.md:69`) with no
alternative on record; "WebSocket" appears in this repo only as a banned string
in `readonly.test.ts:69`. By this log's own test — no nameable rejected
alternative, no ADR — the transport is not a decision this record can honestly
claim to document.

## Consequences

**Good.** Verified working defences: loopback-only bind, no CORS headers
anywhere, `Host` validated against loopback on mutating methods (which defeats
DNS rebinding for those), a capability token minted per process and
length-checked before comparison, and `execFile` with argv arrays everywhere in
the observer.

**Bad — the guard was never finished.** `api/security.ts` calls `/api/label`
"the first" route to adopt the token; no other route ever adopted it. So
`POST /api/lab/launch` — which forks a worktree and dispatches a live agent —
and `/api/rotate` are unauthenticated (#234). The guard also deliberately permits
requests with no `Origin` header, for non-browser callers, so `curl` passes.

**Bad — the guard covers only mutating methods.** `mutation-guard.ts:136` returns
early for anything not POST/PUT/PATCH/DELETE, so **every GET is exempt from the
`Host` check** — including `/api/stream` and `/api/transcript/:lane`. The
comment defends this on the grounds that CORS blocks a cross-origin read, which
is exactly the assumption DNS rebinding invalidates (#235).

**Neutral.** Single-origin means the dashboard is unreachable from a phone or a
second machine by design. That has not yet been asked for.
