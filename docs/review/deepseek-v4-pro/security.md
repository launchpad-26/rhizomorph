# Security review

**Overall risk: Medium.** The core defences (execFile+argv, path-traversal gates, React auto-escaping, loopback bind, mutation guard) are thorough and correctly applied. Two mutating HTTP routes lack the capability token that `/api/label` already enforces, and one of them contradicts SECURITY.md's claim that the laboratory is CLI-only. No remote-code-execution or data-exfiltration vector was found.

---

## Findings

**HIGH — api/lab.ts:451–478, api/rotate.ts:25 — Mutating routes lack capability token; SECURITY.md claim broken**

`POST /api/lab/launch` dispatches real `git worktree add`, `workmux add`, and `npm install` via `runCli(['lab', 'fork', ...])` — spending money and creating files outside the lab namespace (when `--launch` is passed, which this route always does). `POST /api/rotate` closes the live recording. Both are protected only by the mutation guard (Host/Origin/Content-Type), not by `requireCapabilityToken`. SECURITY.md states the laboratory is "reachable only from your own command line" — false.

- **Exploit path**: A local process (another user's script, a malicious npm postinstall) sends `POST /api/lab/launch` with no Origin header (bypassing the mutation guard's CSRF check) and a valid lane+checkpointId body. The server spawns worktrees and workmux processes against the watched repo.
- **Fix**: Apply `{ preHandler: requireCapabilityToken(ctx.capabilityToken ?? '') }` to both routes, matching `/api/label`'s pattern at `api/label.ts:38`. Update SECURITY.md line 9 to acknowledge the lab launch HTTP route exists but is capability-gated.

**MEDIUM — api/lab.ts:429 — `--launch` always appended to HTTP-initiated forks**

The `launchExperiment` function unconditionally pushes `'--launch'` into argv. A CLI invocation without `--launch` prints a warning that `workmux add` writes outside the lab's namespace ("authorise that yourself"). The HTTP route never gives the caller that choice — every POST is a launch.

- **Exploit path**: Any POST to `/api/lab/launch` (once the capability token gap above is closed: by a caller who has it) always creates real refs/heads branches via workmux, not just lab-namespaced worktrees.
- **Fix**: Either add a `launch?: boolean` field to `LaunchRequestBody` (default `false`, matching the CLI's safe default) or gate `--launch` behind the capability token and document honestly.

**LOW — lab/compare.ts:140 — Verify command split on whitespace**

`command.split(/\s+/)` splits `--verify` into a binary and flat args. A command needing quoted arguments (e.g. `bash -c "npm test && lint"`) would be mis-split. Mitigated because `execFile` receives the result as argv (no shell), and `--verify` is CLI-only. No known exploit path through the server.

---

## What is done correctly

- **Command injection**: `server/exec.ts:11` uses `execFile` with an argv array. Every collector (git, tmux, workmux, judge), every lab module (`lab/git.ts`, `lab/fork.ts`, `lab/restore.ts`), and the judge's merge-tree/symbol-extraction (`judge/mergetree.ts:72`, `judge/symbols.ts:95`) passes hardcoded string literals as argv elements. No shell string is ever assembled.
- **Path traversal**: `server/static.ts:29` checks `requested.startsWith(root)` after `path.resolve`. `log/transcript-attribution.ts:147` (`isSafeSessionId`) rejects any session id containing `/`, `\0`, or that `path.basename` would alter, and `candidateTranscriptPaths` at line 169 double-checks with `isPathContained`. `lab/paths.ts:100` (`assertInsideLabWorktrees`) resolves symlinks on both sides before comparing prefixes. The `extraSessionDirs` parsing at `sessionlog/collector.ts:262` does not build paths from untrusted input in a traversable way.
- **XSS**: Zero uses of `dangerouslySetInnerHTML` or `.innerHTML =` in `packages/web/src`. All content (transcript text, tool hints, labels, commit messages, branch names) is rendered as React JSX children, which auto-escapes. The transcript parser (`useTranscript.ts:92`) validates block shapes and discards unrecognised kinds.
- **Binding**: `cli/run.ts:124` binds `127.0.0.1` only — no `0.0.0.0`. No `Access-Control-Allow-Origin` header is ever set. The mutation guard (`mutation-guard.ts:137`) checks Host is loopback, Origin (if present) is loopback, and Content-Type is `application/json` on every POST/PUT/PATCH/DELETE before body parsing — defeating DNS rebinding and CSRF-style blind POSTs from a browser.
- **Secrets**: The capability token is minted per-process, held only in `app.capabilityToken`, never logged, and never echoed in error messages (`security.ts`). No API keys or credentials appear in the codebase.
- **SECURITY.md "read-only" claim**: Holds for all collectors and GET routes. The observer never runs a mutating git command, never sends keystrokes, never pushes.
