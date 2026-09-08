# 0042. The server validates a comparison artifact with its own copy of the parser, not a shared schema

- **Status:** accepted
- **Date:** 2026-09-08

## Context and Problem Statement

ADR-0041 makes the server the storage boundary for a shape the web already
defines and parses (`packages/web/src/lab/compare/artifact.ts`). The server
must validate what it stores and refuse an unknown version by name; the web
must parse what comes back. One shape, two packages. Where does the
definition live?

## Considered Options

- **A — Import the web module from the server.** One copy, in `packages/web`.
- **B — Move the shape to `packages/core` as a zod schema**, import it from
  both.
- **C — A second copy in `packages/server/src/comparisons/artifact.ts`,**
  a plain-TS port with identical messages.

## Decision Outcome

Chosen: **C**.

**A lost** because `packages/web` is a Vite/React package whose modules the
server has no business resolving; `packages/contract` exists precisely so the
two packages meet only through `buildApp` and real HTTP shapes, never by one
importing the other's source.

**B lost** for now, on a specific reading of ADR-0003. `core` is the home of
shapes both sides must *agree on to interpret the same bytes*: the event
vocabulary, the record protocol. A comparison artifact is not folded and not
carried by the record (ADR-0041); its shape is a contract between one route
and one surface. Moving it would also not reduce the copy count this wave:
the web parser sits inside a live fence (#220) and cannot be re-pointed
until wave 2, so B would leave two copies until then in any case. It is the
right move the day a third consumer appears or a `version: 2` is written —
and that day it is a new record, superseding this one.

**C wins by cost.** The parser is ~70 lines with no dependency (the server
has no zod), and the one thing that must stay identical — the refusal
sentence `unsupported comparison artifact version: N` — is a string.

## Consequences

- Good: no new dependency, no cross-package import, the fence stays where
  the issue drew it.
- Bad: two parsers of one shape. A version bump lands in two files, and
  drift between them is a defect no law currently catches. The test that
  asserts the refusal string exactly, on each side, is the only tripwire.
- Neutral: `parseComparisonInput` is exported on the server side (the save
  route validates a bare input) and private on the web side.
