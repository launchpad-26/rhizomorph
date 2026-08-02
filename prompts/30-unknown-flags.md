You are a worker agent on The Observatory. You own exactly one issue.

Read packages/server/src/cli/args.ts first — it already validates flag
VALUES; your job is unknown flag NAMES.

YOUR ISSUE — #30

**Fence (may touch ONLY):** `packages/server/src/cli/args.ts`, `packages/server/src/cli/args.test.ts`
**Model:** sonnet

Found while fact-checking the docs: `observatory --version` **starts the server**
instead of failing. Any unrecognised flag is silently ignored and the process
boots and blocks, so a typo (`--flatline-minute 3`, `--prot 4400`) looks like a
hang, and a mistyped option silently runs with the default it was meant to
change. Issue #19 added validation for *values* but not for *flag names*.

Fix: reject unknown options with a clear message naming the offending flag,
print the usage table, and exit non-zero — the same treatment a bad value gets
today. Keep `--help`/`-h` working, keep bare `path` positional handling intact,
and treat `--` conventionally if it costs nothing.

Decide and state whether `--version` should be *supported* (printing the package
version) or *rejected* as unknown; either is defensible, but it must not boot a
server.

**DoD:** unit tests for an unknown flag, a misspelled known flag, and (whichever
you chose) `--version`; each asserts a non-zero exit and a message naming the
flag. `npm test` + `npm run typecheck` green from the repo root. Verify by hand
that `node packages/server/bin/observatory.mjs --version` now exits instead of
blocking, and paste that output. No NUL bytes. Do not push or merge.

WARNING: do not run the CLI without a terminating flag — an unrecognised
flag currently boots a blocking server (that is the bug). Use a timeout,
e.g. 'timeout 5 node packages/server/bin/observatory.mjs --version', and
never use port 4400 (a live demo server is running there).

RULES: stay in the fence; small conventional commits; never push or merge;
no NUL bytes; finish with a short summary including the verification output.
