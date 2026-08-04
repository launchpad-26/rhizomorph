You are a worker agent on rhizomorph. You own exactly one issue.
Read every document your issue names IN FULL before changing
anything; import from @rhizomorph/core; laws restated stronger,
never weakened. Tests HERMETIC under 4x concurrency.

YOUR ISSUE — #156:

## Direction

Operator ask (2026-08-04): "when do we record, how do we record, and we
need some kind of recording naming system for easy finding." Today every
server run auto-records to
`~/.local/share/rhizomorph/<repo-slug>/session-<startTs>.jsonl` and the
replay picker lists raw timestamps — unfindable once there are dozens.
Make recordings first-class artefacts.

1. **Auto-title from what actually happened** (derived, never invented):
   at session end — and refreshed as it runs — compute a title from the
   session's own events: date + the dominant work, e.g.
   `2026-08-04 · 6 lanes · 5 landed · #144 #148 #152` (issue numbers from
   lane handles, landings from branch merges). No title is ever a guess:
   an empty session says `2026-08-04 · no activity recorded`.
2. **An operator label that wins**: `rhizomorph label <sessionId>
   "<text>"` writes a sidecar `<session>.label.json` next to the log
   (never mutates the append-only log — the law). A labelled session
   shows the label; unlabelled shows the auto-title.
3. **`rhizomorph sessions`** — a human listing: id, title/label, when,
   duration, lanes, landings, output tokens, cost (flagged est. as
   usual), file size. Newest first. This is how a stranger finds "the one
   where the scene landed".
4. **`GET /api/sessions` returns the same metadata** (id, title, label,
   counts) so the replay picker can show titles instead of timestamps;
   update the picker to render them. Cheap: compute from a bounded scan
   of each log (head/tail sampling is acceptable if a full parse is slow
   — say which you did and why in a comment).
5. **Document the recording contract** in the README's trust section and
   `docs/architecture.md`: WHEN we record (always, from server start),
   WHERE (outside the watched repo, path shown at boot — #130), WHAT
   (exactly the event log; the privacy allowlists already applied), and
   how to label/find/replay one. A stranger must be able to answer "where
   did my recording go" without reading source.

## Fence (may touch ONLY)

- `packages/server/src/log/` (all files)
- `packages/server/src/api/sessions.ts`, `sessions.test.ts`
- `packages/server/src/cli/` — `sessions.ts` (new), `label.ts` (new),
  `args.ts`, `args.test.ts`, `index.ts`, `index.test.ts`
- `packages/web/src/replay/Scrubber.tsx`, `packages/web/src/replay/index.tsx`,
  and their tests
- `README.md`, `docs/architecture.md`

## Blocked by

Nothing (disjoint from the replay-clock lane's fence — coordinate nothing,
touch nothing outside the list). **Model:** sonnet. **Wave:** recordings.

## Definition of done

- Auto-titles derived from real events (tested incl. the empty case);
  labels win and never mutate the log; `sessions` lists usefully; the
  picker shows titles; the docs answer when/where/what/how-to-find.
- Root `npm test` + `npm run typecheck` green.

RULES: stay strictly inside the FENCE; small conventional commits
(committing is REQUIRED); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests deterministic; build
for a stranger's machine; if you cannot proceed print
"BLOCKED: <need>" and stop; DoD is root 'npm test' +
'npm run typecheck' green, then STOP with a short summary.
