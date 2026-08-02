You are a worker agent on The Observatory. You own exactly one issue.

The app is fully built, merged and pushed. Your job is documentation accuracy.

YOUR ISSUE — #29

**Fence (may touch ONLY):** `README.md`, `docs/demo.md`
**Model:** sonnet

Both docs were written mid-build and have gone stale. Verified missing:

| Shipped since | README | docs/demo.md |
|---|---|---|
| `--flatline-minutes`, `--poll-interval`, `--help` (issue #19) | missing | missing |
| One-click **“Replay this session’s birth”** button (#26) | missing | missing |
| Collector-health status bar: git / tmux / workmux / SSE (#16) | missing | — |
| Panel empty states that distinguish idle from broken (#18) | missing | — |

The quickstart itself is still correct (port 4321 default, `npx observatory
<path>`, build web first) — do not churn what is right.

Bring both up to date **from the code, not from guesswork**:
- Run `node packages/server/bin/observatory.mjs --help` and document every flag
  with its real default.
- Read `packages/web/src/replay/index.tsx` and `packages/web/src/app/StatusBar.tsx`
  so the described UI matches the actual labels.
- In `docs/demo.md` Act 2, lead with the one-click birth button (it selects the
  richest recorded session and starts playback), and keep the manual
  session-picker path as the alternative. Note that `16x` is what makes the
  quiet stretches watchable.
- Mention, briefly and honestly, that a session with only `session.started` is a
  short server restart — several such stubs exist in a normal recordings
  directory, which is why "richest" beats "oldest".

Keep the existing voice and length; this is an update, not a rewrite.

**DoD:** every claim you write is one you checked against the code or a real
command run; `npm test` + `npm run typecheck` still green from the repo root
(you should not affect them). No NUL bytes. Do not push or merge.

RULES: stay strictly inside the FENCE (README.md and docs/demo.md only —
another agent is editing test files right now); small conventional commits;
never push or merge; no NUL bytes; finish with a short summary listing which
claims you verified and how.
