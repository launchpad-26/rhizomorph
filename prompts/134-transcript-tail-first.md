You are a worker agent on rhizomorph (prd9: the trace era).
You own exactly one issue — a measured dogfooding fix.

FIRST read packages/server/src/api/transcript.ts and
packages/web/src/drawer/useTranscript.ts IN FULL before changing
anything; the pagination contract you are extending is subtle and
records-not-strings is law.

YOUR ISSUE — #134:

## Direction

Dogfooding-born (operator, 2026-08-03 ~21:40): the drawer's conversation
lags the live tmux pane by a large margin. Measured against lane
`132-trace-surfaces` mid-run:

- One `GET /api/transcript/132-trace-surfaces` (default `offset=0`)
  returned `nextOffset: 64775` of `size: 616506`, `eof: false`, 16
  entries — the endpoint pages FORWARD from byte 0, so a freshly-opened
  drawer must chase `nextOffset` ~10 times before it even reaches the
  present, and the catch-up cost grows with the session file all day.
- Source lag is NOT the story: the CLI's session file mtime tracked the
  pane within normal flush cadence.

Fix: **tail-first transcript serving + eager catch-up + upward history.**

1. `packages/server/src/api/transcript.ts`: support opening AT THE TAIL —
   e.g. `?tail=1` (or an equivalent negative/end-relative offset) returns
   the LAST page of entries plus the `offset` of that page's start, so a
   client can render the newest conversation immediately and page BACKWARD
   for history. Forward tailing from `nextOffset` stays exactly as today
   for the follow loop. Keep the records-not-strings contract and all
   existing truncation rules; read-only constitution untouched.
2. `packages/web/src/drawer/useTranscript.ts`: open with the tail page;
   follow forward from there on the existing cadence; when the reader
   scrolls to the top of what is loaded, fetch the previous page (simple
   "load earlier" affordance is acceptable if scroll-detection is fiddly —
   honest and small beats clever). If a catch-up loop remains anywhere, it
   must be an eager awaited burst, never one-page-per-poll-tick.
3. `Conversation.tsx`: render unchanged except the "load earlier"
   affordance and keeping scroll pinned to the bottom when following.
4. Tests: a large synthetic session file (multi-page) — opening shows the
   newest entries in ONE round trip; following picks up appended lines;
   paging backward returns contiguous earlier entries; `restarted`
   semantics preserved.

## Fence (may touch ONLY)

- `packages/server/src/api/transcript.ts`
- `packages/server/src/api/transcript.test.ts`
- `packages/web/src/drawer/useTranscript.ts`
- `packages/web/src/drawer/useTranscript.test.ts`
- `packages/web/src/drawer/Conversation.tsx`
- `packages/web/src/drawer/Conversation.test.tsx`

## Blocked by

#132 (drawer fence overlap — lands after it). **Model:** sonnet.
**Wave:** hygiene/dogfood; lands before the lane page so its conversation
column inherits the fix.

## Definition of done

- Fresh drawer open on a 600KB+ session shows the newest conversation in
  one round trip (test with a multi-page fixture).
- Forward follow and backward history both proven; no behavior change for
  small files; `drawer/readonly.test.ts` stays green.
- Root `npm test` + `npm run typecheck` green.

RULES: stay strictly inside the FENCE; small conventional commits
(committing is REQUIRED); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests deterministic; if you
cannot proceed print "BLOCKED: <need>" and stop; DoD is root
'npm test' + 'npm run typecheck' green, then STOP with a short summary.
