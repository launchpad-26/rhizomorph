# Security review

**Reviewer:** Fable seat 3 of 5 — security
**Date:** 2026-08-06
**Scope:** subprocess execution, server binding/CORS, path handling, XSS surface, secrets, dependency tree, SECURITY.md claims

---

## Overall verdict: MODERATE risk — one real gap, otherwise a genuinely careful codebase

The subprocess layer, static-file serving, CORS posture, and dependency surface are all done correctly. The one substantive finding is that SECURITY.md's claim "the laboratory is reachable only from your own command line, never from the server or the UI" is **false** — the server exposes a mutating lab-launch route with no auth beyond a CSRF-style check any non-browser caller trivially passes.

---

## HIGH — unauthenticated agent-launch route contradicts SECURITY.md

`packages/server/src/api/lab.ts:532-547` (route def), `:301-310` / `:446-505` (`launchExperiment`)

`POST /api/lab/launch` runs `runCli(['lab','fork', lane, '--path', repoPath, '--at', checkpointId, '--arms','1','--launch'])` in-process. This creates a real git worktree, a real branch, and (via `--launch`) hands off to `workmux add`, spawning a live tmux pane and agent that spends real money — per the code's own comments, "arms already dispatched already spent real money."

Compare `packages/server/src/api/label.ts:38`, which requires `preHandler: requireCapabilityToken(...)`. `registerLabRoutes` (lab.ts:507-547) has **no such preHandler on any route**, including this POST.

It only inherits the app-wide `mutation-guard.ts` Host/Origin check, which explicitly **allows requests with no `Origin` header at all** (mutation-guard.ts:143-146, documented as intentional for non-browser callers like `rhizomorph rotate`).

Net effect — any other local process (a script, another app, malware) can run:

```
curl -XPOST -H 'Content-Type: application/json' \
  http://127.0.0.1:<port>/api/lab/launch \
  -d '{"lane":"main","checkpointId":"<id>","arms":[{"model":"x","brief":"..."}]}'
```

and trigger a real agent dispatch with an attacker-chosen prompt. No token, no browser needed.

`/api/rotate` (api/rotate.ts) has the same gap, at lower impact — it just ends/starts a recording.

**Fix:** add `preHandler: requireCapabilityToken(ctx.capabilityToken ?? '')` to `/api/lab/launch` and `/api/rotate`, matching `/api/label`'s pattern. `api/security.ts`'s own doc comment already says this is planned as a "follow-up" — it just hasn't landed. Also correct or scope SECURITY.md's "never from the server or the UI" line.

## LOW — path-prefix bypass (CWE-22, narrow)

`packages/server/src/server/static.ts:29-34`

`requested.startsWith(root)` has no trailing-separator/equality guard. `path.resolve(root, '../dist-evil/x')` produces a string that legitimately starts with `root` even though it's a sibling directory, not a child of it.

Only exploitable if a directory sharing `root`'s name as a literal prefix exists on disk — narrow in practice, but a one-line fix:

```ts
requested === root || requested.startsWith(root + path.sep)
```

---

## Done correctly (verified, not assumed)

- **Subprocess execution** — every collector (`git`, `tmux`, `workmux`, judge's `merge-tree`) shells via `execFile` with an argv array (`server/exec.ts:9-19`, `shell` never set). No shell-string injection anywhere found. Branch names used as bare positional git args (`judge/mergetree.ts:72`) can't carry an injected flag because git itself rejects refs starting with `-` (verified live: `git branch -- -evilbranch` → "not a valid branch name"). Paths given to git go through `cwd` options or `-C <path>` (`tmux/worktree.ts:9`), which consumes the value regardless of a leading dash.
- **Binding / CORS / rebinding** — binds `127.0.0.1` only, confirmed in `cli/run.ts:160`, `cli/replay.ts:180`, `cli/doctor.ts:359`. No `Access-Control-Allow-Origin` sent anywhere, so a foreign page can't read cross-origin GET responses even though it can send the request. `mutation-guard.ts` (registered globally, `build-app.ts:69`) validates `Host` against loopback (defeats DNS rebinding — a browser can't forge `Host`) and `Origin` when present, on every POST/PUT/PATCH/DELETE, before body parsing. This is real, working CSRF/rebinding defense — the gap is only that two specific mutating routes haven't yet added the second layer (capability token) that would close the no-Origin case.
- **Path traversal on session IDs** — `api/label.ts` and `api/transcript.ts` both have explicit regression tests for `sessionId: '../../../../etc/passwd'` (label.test.ts:111, transcript.test.ts:601+), and IDs are matched against on-disk basenames rather than joined into a path. Traversal via that vector is closed.
- **XSS** — no `dangerouslySetInnerHTML` / `innerHTML` / `document.write` writing dynamic content anywhere in `packages/web/src`; no markdown-rendering library in the dependency tree. Repo/agent-derived text renders through React's default escaping.
- **Secrets / exfiltration** — no `fetch` / `http(s).request` / `axios` anywhere in `packages/server/src`. Nothing is sent off-machine, matching SECURITY.md's claim. The recorder does persist a copy of session events (including agent tool output) into the repo's own session directory — if an agent's transcript already contained a secret, this durably duplicates it, but that's inherent to the feature (recording what happened) and no worse than the source Claude Code log already on disk.
- **Dependencies** — `npm audit` → 0 vulnerabilities at every severity. Root `package.json`'s only production dependency is `fastify@5.10.0` — a deliberately minimal footprint.
