# Security and architecture review

**Reviewer:** `gpt-5.6-sol`, `xhigh` — security/architecture agent  
**Date:** 2026-08-06  
**Scope:** runtime boundaries, HTTP routes, authentication and authorisation, subprocess
execution, path safety, recording integrity, replay isolation, privacy, resilience, and
target architecture

## Verdict

The event-model core is coherent, privacy-conscious in several important places, and
unusually testable. The critical architectural flaw is that observation, telemetry
ingestion, recorder control, replay, and the privileged laboratory executor share one
loopback HTTP process.

Loopback is a useful exposure default, but it is not an authentication or confidentiality
boundary. The mismatch between the server's authority and its protections has created
high-confidence confidentiality, integrity, and command-execution failures. The current
HTTP service should not be described as a safely read-only observer.

## Critical findings

### Sensitive GET APIs are vulnerable to DNS rebinding

The mutation guard deliberately exempts GET from Host and Origin validation
(`packages/server/src/server/mutation-guard.ts:30-40,134-150`). Its regression test
explicitly accepts a GET carrying an attacker-controlled Host and Origin
(`packages/server/src/server/mutation-guard.test.ts:177-186`).

Unauthenticated reads include repository/session metadata, full recording events, live
SSE, and parsed transcripts:

- `packages/server/src/api/meta.ts:123-136`
- `packages/server/src/api/sessions.ts:12-37`
- `packages/server/src/api/stream.ts:144-160`
- `packages/server/src/api/transcript.ts:675-717`

A hostile hostname can serve a page and then rebind to `127.0.0.1`. The browser continues
to regard requests as same-origin with the hostile hostname, while the server accepts
that Host on GET. CORS is not a defence in this scenario.

Validate Host on every request and authenticate sensitive reads and SSE. Bootstrap the
browser using a one-time printed URL that establishes an `HttpOnly; SameSite=Strict`
session. Keep read, ingestion, and control authority separately scoped.

### Powerful mutation routes lack capability authorisation

A random capability is generated in `packages/server/src/api/security.ts:41-49` and
threaded through `packages/server/src/server/build-app.ts:64-72`, but only labeling uses
it (`packages/server/src/api/label.ts:35-39`).

Unauthorised routes include:

- Recording rotation: `packages/server/src/api/rotate.ts:24-55`.
- Laboratory launch: `packages/server/src/api/lab.ts:507-547`.

Lab launch can create worktrees, run lifecycle-capable `npm install`, invoke Workmux,
start agents, and incur model cost. Require a scoped control capability on every state
change. Prefer a separate opt-in control process or a mode-0600 Unix socket. Add arm and
cost caps, idempotency, audit records, and explicit confirmation semantics.

Origin checking must also match scheme, hostname, and port. The current hostname-only
logic accepts any loopback port as though it were the same origin.

### Lab model input reaches a shell-shaped command

The launch API accepts any string as `model` (`packages/server/src/api/lab.ts:258-290`).
`packages/server/src/lab/fork.ts:117-125` interpolates it unquoted into:

```text
bash scripts/lane-agent.sh ${model}
```

That value is supplied to Workmux's documented shell-shaped `-a` command. A model value
containing semicolons, command substitutions, quotes, whitespace, or newlines can become
shell syntax when Workmux executes it.

Pass executable/arguments as an argv vector if Workmux permits it. Otherwise enforce a
strict model allowlist and use proven POSIX quoting. Add adversarial tests. Authentication
is necessary but does not replace input validation.

### `rhizomorph env` produces unsafe text for `eval`

Shell, CMD, and PowerShell values are emitted without complete target-shell quoting in
`packages/server/src/cli/telemetry-env.ts:58-85`. Lane accepts any non-empty string, and
`scripts/lane-agent.sh:17-20` evaluates the generated output directly. The lane is based
on the current directory basename.

A worktree name containing shell metacharacters, or a hostile local server response, can
inject into the caller's shell. Prefer structured JSON/dotenv output consumed without
`eval`, or have the wrapper establish its environment directly. Apply narrow identifier
grammars and test shell metacharacters across every supported shell.

## Serious integrity findings

### Capability-protected labeling is broken in production

The web label request sends no capability (`packages/web/src/recordings/label.ts:69-83`),
while the server requires one. Tests hide the gap by reading `app.capabilityToken`
directly on the server or mocking a successful browser response. Implement one coherent
browser authentication contract and test the built client against the built server.

### Replay mode still exposes mutable OTLP ingestion

Replay builds a context with `readOnly: true` (`packages/server/src/cli/replay.ts:166-176`),
but route registration remains unconditional and OTLP handlers do not check replay mode.
An unauthorised POST can alter the reconstructed replay state.

Register different route sets for live and replay. Use discriminated runtime context
types so ingestion and control routes cannot compile against `ReplayContext`.

### Portable export is not raw-line preserving

Documentation promises verbatim preservation, including unknown future events. Export
instead reads successfully parsed known events and serialises them again:

- `packages/server/src/cli/export-record.ts:134-137`
- `packages/server/src/log/session-log.ts:39-58`
- `packages/core/src/jsonl.ts:71-84`
- `packages/core/src/record/build.ts:47-52`

Unknown or malformed lines disappear; recognised lines can change whitespace, property
order, and extra fields. The resulting hash attests to a transformed subset, not the
original record. Build archival records from raw line bytes and test byte identity.

### Session locking is non-atomic

Lock claims use an overwriting `writeFile`; startup decides before later writing the
claim; heartbeat writes are not atomic; release unlinks without proving ownership; and
rotation opens the new recording before acquiring its lock.

Two simultaneous processes can both resume and append to the same recording. Use atomic
exclusive creation (`open(..., "wx")`) or an OS lock, include an owner nonce, replace
heartbeat content atomically, release only on nonce match, and acquire before append.
Exercise it with real concurrent-process tests.

### HTTP calls back into the CLI and monkeypatches global stderr

`packages/server/src/api/lab.ts:293-413` serialises Lab calls through a process-local
promise, replaces `process.stderr.write`, dynamically invokes the CLI, and parses
human-readable output with regular expressions. Unrelated server errors may be captured
or suppressed, and API compatibility depends on CLI prose.

Extract a typed `LabService` returning structured results. Make HTTP and CLI independent
adapters around it and use injected logging/output streams.

## Resilience, boundedness, and privacy

- Lab accepts an unbounded non-empty arm array. Recorder memory, SSE queues, OTLP error
  traffic, and session growth also lack effective quotas.
- Production subprocess calls do not supply timeouts. Collectors execute sequentially,
  and graceful shutdown waits indefinitely for the active poll.
- The recorder publishes events to memory/SSE before durable append succeeds, allowing
  live and replay state to diverge after I/O failure.
- Exportable events can include author email, commit subjects, absolute paths, tool
  paths, and terminal preview lines. “Hand this file to anyone” is too optimistic.
- Transcript scrubbing covers identity keys, common email, and home-path shapes but is
  not comprehensive credential or proprietary-content redaction.

Add bounded in-memory storage and client queues, rate limits, arm/field caps, subprocess
deadlines with abort propagation, append-before-publish semantics, and a share-safe
export profile that strips or hashes identity/path/preview fields by default.

## Recommended target architecture

1. **Observation plane:** authenticated reads and SSE.
2. **Ingestion plane:** separate ingest-only OTLP token.
3. **Control plane:** privileged operations over an opt-in authenticated service or
   mode-0600 Unix socket.
4. **Lab executor:** disabled by default and not implicitly hosted by the observer.
5. **Structural modes:** distinct live-observer, live-control, and replay contexts with
   route registration driven by capability.
6. **Typed services:** CLI and HTTP call domain services, never each other.
7. **Durable bounded state:** append before publish, atomic leases, disk pagination,
   bounded memory/SSE queues, quotas, and deadlines.
8. **Raw archival records:** preserve bytes; offer a separate share-safe transform.
9. **Route-security inventory:** every endpoint declares `read`, `ingest`, or `control`,
   its credential, and the runtime modes in which it exists.

## Strengths worth preserving

- Runtime Zod schemas and pure reducers provide a coherent event-sourced foundation.
- Trace attributes use a deliberate privacy allowlist.
- External processes normally use argv-form `execFile`, not a shell.
- The server binds explicitly to `127.0.0.1` and caps request bodies at 1 MiB.
- Transcript reads are bounded and path handling includes meaningful containment checks.
- Lab worktree paths are canonicalised and fenced.
- Recording creation applies restrictive modes and symlink protections.
- CI spans macOS/Linux, minimum/current Node, build, tests, types, lint, packaging, and
  boot checks.
