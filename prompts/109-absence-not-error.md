## What was found (conductor browser verification of #107)

Opening the MAIN drawer on an uninstrumented conductor logs browser
console errors:

```
console.error: Failed to load resource: the server responded with a
status of 404 (Not Found)      (x2 — the poll repeats it)
```

The drawer itself is CORRECT — it renders the law-12 gap voice ("CONDUCTOR
NOT INSTRUMENTED — nothing in this session's event log was recorded
against role: conductor … run: `rhizomorph --extra-sessions
<dir>:conductor`"). The defect is the transport: an expected, honest,
well-understood state is being reported as an HTTP error, so a clean
production app spews red into the console on a normal screen.

The codebase already has the right convention — `/api/lanes` answers
**200** with `{available: false, reason: "…"}` for exactly this shape of
absence (`packages/server/src/api/lanes.ts`). `/api/transcript/:id`
answers **404**. Verified live just now:

```
transcript/main -> 404
lanes           -> 200
```

## Direction

Make expected absence a 200 across the API:

- `/api/transcript/:id` returns **200** `{available: false, reason}` when
  the identity is known but has no readable session (uninstrumented
  conductor, lane with no session log yet). Keep the reason text exactly
  as it is — the gap voice is already right.
- Keep **404** for a genuinely unknown identifier (a lane that does not
  exist at all) — that IS a client error and should stay loud.
- Client (`drawer/useTranscript.ts`, `drawer/Conversation.tsx`) reads the
  new shape; the gap voice must render identically to today (screenshot
  parity — do not restyle it).
- Pin the distinction in tests: known-but-empty → 200 + reason; unknown
  identifier → 404. Note the convention in a comment citing lanes.ts so
  the next endpoint copies the right one.

## Fence (may touch ONLY)

- `packages/server/src/api/transcript.ts`, `transcript.test.ts`
- `packages/web/src/drawer/useTranscript.ts`
- `packages/web/src/drawer/Conversation.tsx`, `Conversation.test.tsx`
- `packages/web/src/drawer/Transcript.tsx`, `Transcript.test.tsx` (only if it consumes the same hook)

## Blocked by

Nothing (#107 landed). **Model:** sonnet. **Wave:** follow-up (polish).

## Definition of done

- Zero console errors when the MAIN drawer opens against an
  uninstrumented conductor (say how you checked).
- Root `npm test` + `npm run typecheck` green.
- Load evidence: 3 batches x 4 concurrent runs (`npm test --
  --maxWorkers=5`), 12/12 green; out-of-fence failures verbatim.

## RULES

- Work ONLY in this worktree. Never run git in any other worktree or the
  main checkout.
- **Committing your work is REQUIRED.** Never push, never merge.
- Build for a stranger's machine. `BLOCKED: <need>` if stuck.
