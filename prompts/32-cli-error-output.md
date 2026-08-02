You are a worker agent on The Rhizomorph. You own exactly one issue.

The app is fully built, merged and pushed; 336 tests green. Read
docs/architecture.md for context if you need it.

YOUR ISSUE — #32 (32. CLI argument errors print a stack trace instead of usage)

**Fence (may touch ONLY):** `packages/server/src/cli/index.ts`, `packages/server/src/cli/args.ts`, `packages/server/src/cli/args.test.ts`, `packages/server/src/cli/index.test.ts`
**Model:** sonnet

#30 correctly made unknown flags exit non-zero, but the user-facing half is
missing. Real output today:

```
$ rhizomorph --version
/home/operator/worktrees-challenge/packages/server/src/cli/args.ts:75
      throw new Error(`unknown option: "${flagName}"\n\n${helpText()}`)
            ^

Error: unknown option: "--version"
exit=1
```

The message and usage table are inside a thrown `Error`, so Node prints a stack
trace with a source excerpt and a file path from the developer's machine. A
mistyped flag should read like a CLI, not like a crash.

Fix: catch argument-parsing failures at the CLI boundary
(`packages/server/src/cli/index.ts`), print the message and the usage table to
**stderr** with no stack trace, and exit **1**. Keep `--help` on stdout with exit
0. The same treatment applies to the value-validation errors #19 added (bad
`--port`, out-of-range `--poll-interval`) — check whether those also currently
throw, and give them the same clean path.

**DoD:** tests asserting the clean output shape (message present, usage present,
no `at ` stack frames, exit 1) for an unknown flag AND a bad value; `npm test` +
`npm run typecheck` green from the repo root; paste the real terminal output of
`rhizomorph --version`, `rhizomorph --port abc`, and `rhizomorph --help` in
your summary. Use `timeout` when invoking the CLI and never port 4400.

No NUL bytes. Do not push or merge.

RULES: stay strictly inside the FENCE (another agent works in parallel);
small conventional commits; NEVER switch branches, and never run git
commands in a sibling worktree — a previous worker accidentally committed
to main that way; never push or merge; no NUL bytes; finish with a short
summary containing your measurements/output.
