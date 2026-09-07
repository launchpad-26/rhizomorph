# Beacon lapse interval — why BEACON_LAPSE_MS is 180000 ms

**Value:** `BEACON_LAPSE_MS = 180000` (`packages/core/src/selectors/lapse.ts`). prd-27 ruling 6 and the 2026-08-24 amendment: *the mechanism is ruled, the number is measured.*

## What it guards

A hook beacon is an occurrence, not a heartbeat, so its silence means nothing
until something says how long silence is allowed to run. This constant is that
statement — and it is deliberately not one rule for all three kinds, because
the three kinds are contradicted by different facts.

A `working` or `stopped` declaration is contradicted by **age alone**. An
instrumented harness fires `UserPromptSubmit` at every prompt and `PostToolUse`
at every tool result, so a lane that is genuinely working keeps speaking; the
measurement below is what bounds "keeps". A `waiting` declaration is
contradicted only by **work after it** (`lastWorkTs > declared.at`). A lane
that is genuinely waiting on a human emits no beacon and does no work for
however long the human takes, and lapsing it on age would be #133's false
summons run backwards — the instrument deciding a raised hand had expired. So
the only thing that retires a `waiting` declaration is the lane visibly going
back to work without saying so.

Presence is the caller's, not this constant's: the fleet asks only about
`present` lanes, so a lane whose worktree is gone has not lapsed, it has
finished.

## The measurement

| | |
|---|---|
| machine | Apple Silicon Mac mini, 8 GB (the operator's box) |
| Claude Code | `2.1.261 (Claude Code)` for session 1; the CLI self-updated between sessions, so sessions 2 and 3 ran on `2.1.263 (Claude Code)` |
| hooks | printed by `rhizomorph env 2-core --hooks claude` at `f479a9a`, installed as `.claude/settings.local.json` in a throwaway repo against a throwaway `RHIZOMORPH_DATA_DIR` |
| sessions | 3, on 2026-09-07, five turns each (the prompts, verbatim, below) |
| total beacons | 77 (60 `working`, 2 `waiting`, 15 `stopped`) |

The five prompts, in order, the same in all three sessions:

1. `create five files a.txt through e.txt, each containing its own name, one file per tool call`
2. `without using any tools, write about 900 words on the history of terminal multiplexers`
3. `read a.txt and e.txt, then explain in three paragraphs what a hook is; no other tools`
4. `without tools, list 40 English words that contain a double letter, one per line, then summarise the pattern`
5. `append the current date to each of the five files, one at a time`

Turn 2 is the turn this interval is really about: one beacon at the prompt and
nothing until `Stop`, because a no-tool generation gives the harness no hook to
fire in between. Manual-approval mode was selected on the pane before any
prompt, so `Notification` could fire at all; every permission dialog was
accepted immediately.

A **turn** runs from a `UserPromptSubmit` line to the next `Stop` line; an
**intra-turn gap** is the interval between two consecutive lines inside one
turn, **excluding any gap whose first line is a `Notification`** — that gap
measures a human's latency to a dialog, which is exactly the declared `waiting`
case and is unbounded by design.

### Per turn

| session | turn | length | beacons | longest intra-turn gap |
|---|---|---|---|---|
| 1 | 1 | 52s | 8 | 10s (`UserPromptSubmit` → `Notification`) |
| 1 | 2 | 57s | 2 | 57s (`UserPromptSubmit` → `Stop`) |
| 1 | 3 | 21s | 4 | 16s (`PostToolUse` → `Stop`) |
| 1 | 4 | 26s | 2 | 26s (`UserPromptSubmit` → `Stop`) |
| 1 | 5 | 35s | 7 | 13s (`UserPromptSubmit` → `PostToolUse`) |
| 2 | 1 | 105s | 14 | 17s (`PostToolUse` → `Notification`) |
| 2 | 2 | 34s | 2 | 34s (`UserPromptSubmit` → `Stop`) |
| 2 | 3 | 19s | 4 | 14s (`PostToolUse` → `Stop`) |
| 2 | 4 | 24s | 2 | 24s (`UserPromptSubmit` → `Stop`) |
| 2 | 5 | 32s | 7 | 9s (`UserPromptSubmit` → `PostToolUse`) |
| 3 | 1 | 16s | 7 | 6s (`UserPromptSubmit` → `PostToolUse`) |
| 3 | 2 | 52s | 2 | 52s (`UserPromptSubmit` → `Stop`) |
| 3 | 3 | 20s | 4 | 16s (`PostToolUse` → `Stop`) |
| 3 | 4 | 22s | 2 | 22s (`UserPromptSubmit` → `Stop`) |
| 3 | 5 | 44s | 10 | 12s (`UserPromptSubmit` → `PostToolUse`) |

60 gaps counted. Longest intra-turn gap overall: **57 s** (session 1, turn 2,
between `UserPromptSubmit` and `Stop`). Median: 5 s.

The shape the table shows is the one the constant has to survive: the median
gap is five seconds and the tail is a no-tool generation an order of magnitude
longer than it. Sizing the lapse off the median would doubt a healthy lane
mid-paragraph; the tail is what the margin below is for.

## The derivation

`max(3 × 57 000, 2 × TURN_SETTLE_MS = 150 000)` = 171 000, rounded up to the
minute → **180 000 ms**.

The 3× margin covers a turn nearly twice as slow as the slowest one measured
before the declaration is doubted. The floor ties the lapse to the transcript
organ's own settle window (`TURN_SETTLE_MS = 75 000`,
`packages/server/src/collectors/sessionlog/lane-state.ts`) so a beacon is never
doubted sooner than the organ doubts a turn — here the measurement carried the
value above the floor on its own, which is the direction the rule allows: the
measurement can raise the interval, never lower it.

## Known limits

- "Configured" is read off the fold — *some* lane in this session has been
  declared for — because that is the only configured-ness the reducer can know
  without a new state slice. A beacon directory holding only foreign kinds
  (prd-17's decision vocabulary, say) reads as **never-declared** for every
  lane, not as configured-but-silent.
- Measured on one machine class, with one harness, on prompts chosen to bracket
  the tool-dense and no-tool extremes. A slower host, a larger context, or a
  longer no-tool generation raises the longest gap — **re-measure and
  re-derive; do not tune the constant to taste.** A test in
  `packages/server/src/collectors/beacon/collector.test.ts` reads the value out
  of this note's own text, so the code and this page cannot drift apart in
  either direction.
- The CLI updated itself between session 1 and session 2. Both versions are
  named above rather than one of them being presented as the version; the
  longest gap came from session 1, on the older of the two.

## Raw capture

Every line the hooks wrote, verbatim. These carry only `v`, `at`, `writer`,
`kind`, `lane` and `detail` — no field a hook can populate holds a path, a
hostname or a person's name — and the lane (`2-core`) is synthetic by
construction. Audited before committing with a grep for `/Users/`, `/home/`,
`C:\`, the temp roots used, and this machine's `hostname`: zero matches.

```jsonl
{"v":1,"at":1788730432000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: UserPromptSubmit"}
{"v":1,"at":1788730442000,"writer":"claude-hook","kind":"waiting","lane":"2-core","detail":"hook: Notification"}
{"v":1,"at":1788730474000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: PostToolUse"}
{"v":1,"at":1788730476000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: PostToolUse"}
{"v":1,"at":1788730478000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: PostToolUse"}
{"v":1,"at":1788730480000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: PostToolUse"}
{"v":1,"at":1788730482000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: PostToolUse"}
{"v":1,"at":1788730484000,"writer":"claude-hook","kind":"stopped","lane":"2-core","detail":"hook: Stop"}
{"v":1,"at":1788730493000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: UserPromptSubmit"}
{"v":1,"at":1788730550000,"writer":"claude-hook","kind":"stopped","lane":"2-core","detail":"hook: Stop"}
{"v":1,"at":1788730559000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: UserPromptSubmit"}
{"v":1,"at":1788730564000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: PostToolUse"}
{"v":1,"at":1788730564000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: PostToolUse"}
{"v":1,"at":1788730580000,"writer":"claude-hook","kind":"stopped","lane":"2-core","detail":"hook: Stop"}
{"v":1,"at":1788730589000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: UserPromptSubmit"}
{"v":1,"at":1788730615000,"writer":"claude-hook","kind":"stopped","lane":"2-core","detail":"hook: Stop"}
{"v":1,"at":1788730623000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: UserPromptSubmit"}
{"v":1,"at":1788730636000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: PostToolUse"}
{"v":1,"at":1788730641000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: PostToolUse"}
{"v":1,"at":1788730646000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: PostToolUse"}
{"v":1,"at":1788730651000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: PostToolUse"}
{"v":1,"at":1788730656000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: PostToolUse"}
{"v":1,"at":1788730658000,"writer":"claude-hook","kind":"stopped","lane":"2-core","detail":"hook: Stop"}
{"v":1,"at":1788730790000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: UserPromptSubmit"}
{"v":1,"at":1788730797000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: PostToolUse"}
{"v":1,"at":1788730797000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: PostToolUse"}
{"v":1,"at":1788730798000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: PostToolUse"}
{"v":1,"at":1788730799000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: PostToolUse"}
{"v":1,"at":1788730799000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: PostToolUse"}
{"v":1,"at":1788730816000,"writer":"claude-hook","kind":"waiting","lane":"2-core","detail":"hook: Notification"}
{"v":1,"at":1788730866000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: PostToolUse"}
{"v":1,"at":1788730872000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: PostToolUse"}
{"v":1,"at":1788730877000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: PostToolUse"}
{"v":1,"at":1788730882000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: PostToolUse"}
{"v":1,"at":1788730888000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: PostToolUse"}
{"v":1,"at":1788730893000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: PostToolUse"}
{"v":1,"at":1788730895000,"writer":"claude-hook","kind":"stopped","lane":"2-core","detail":"hook: Stop"}
{"v":1,"at":1788730900000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: UserPromptSubmit"}
{"v":1,"at":1788730934000,"writer":"claude-hook","kind":"stopped","lane":"2-core","detail":"hook: Stop"}
{"v":1,"at":1788730938000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: UserPromptSubmit"}
{"v":1,"at":1788730942000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: PostToolUse"}
{"v":1,"at":1788730943000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: PostToolUse"}
{"v":1,"at":1788730957000,"writer":"claude-hook","kind":"stopped","lane":"2-core","detail":"hook: Stop"}
{"v":1,"at":1788730962000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: UserPromptSubmit"}
{"v":1,"at":1788730986000,"writer":"claude-hook","kind":"stopped","lane":"2-core","detail":"hook: Stop"}
{"v":1,"at":1788730991000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: UserPromptSubmit"}
{"v":1,"at":1788731000000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: PostToolUse"}
{"v":1,"at":1788731005000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: PostToolUse"}
{"v":1,"at":1788731010000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: PostToolUse"}
{"v":1,"at":1788731015000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: PostToolUse"}
{"v":1,"at":1788731020000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: PostToolUse"}
{"v":1,"at":1788731023000,"writer":"claude-hook","kind":"stopped","lane":"2-core","detail":"hook: Stop"}
{"v":1,"at":1788731075000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: UserPromptSubmit"}
{"v":1,"at":1788731081000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: PostToolUse"}
{"v":1,"at":1788731083000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: PostToolUse"}
{"v":1,"at":1788731085000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: PostToolUse"}
{"v":1,"at":1788731087000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: PostToolUse"}
{"v":1,"at":1788731089000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: PostToolUse"}
{"v":1,"at":1788731091000,"writer":"claude-hook","kind":"stopped","lane":"2-core","detail":"hook: Stop"}
{"v":1,"at":1788731093000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: UserPromptSubmit"}
{"v":1,"at":1788731145000,"writer":"claude-hook","kind":"stopped","lane":"2-core","detail":"hook: Stop"}
{"v":1,"at":1788731150000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: UserPromptSubmit"}
{"v":1,"at":1788731154000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: PostToolUse"}
{"v":1,"at":1788731154000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: PostToolUse"}
{"v":1,"at":1788731170000,"writer":"claude-hook","kind":"stopped","lane":"2-core","detail":"hook: Stop"}
{"v":1,"at":1788731173000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: UserPromptSubmit"}
{"v":1,"at":1788731195000,"writer":"claude-hook","kind":"stopped","lane":"2-core","detail":"hook: Stop"}
{"v":1,"at":1788731200000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: UserPromptSubmit"}
{"v":1,"at":1788731212000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: PostToolUse"}
{"v":1,"at":1788731214000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: PostToolUse"}
{"v":1,"at":1788731220000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: PostToolUse"}
{"v":1,"at":1788731222000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: PostToolUse"}
{"v":1,"at":1788731228000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: PostToolUse"}
{"v":1,"at":1788731231000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: PostToolUse"}
{"v":1,"at":1788731236000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: PostToolUse"}
{"v":1,"at":1788731241000,"writer":"claude-hook","kind":"working","lane":"2-core","detail":"hook: PostToolUse"}
{"v":1,"at":1788731244000,"writer":"claude-hook","kind":"stopped","lane":"2-core","detail":"hook: Stop"}
```

## How the sessions were actually driven

Same launcher constraint the beacon fixture capture records
(`packages/server/src/collectors/beacon/fixtures/CAPTURE.md`): a `claude`
spawned directly by a build lane cannot use the operator's login, so all three
sessions ran inside a tmux session the operator had started from their own
terminal, driven from outside with `send-keys` and read with `capture-pane`.
One detail differs from that recipe and is worth carrying forward: the key
name for shift-tab is **`BTab`**, not `S-Tab` — `S-Tab` is accepted by
`send-keys` and silently does nothing, leaving auto mode on, which is exactly
the failure `CAPTURE.md` warns about. The mode line was read off the pane
before any prompt in every session.

Between session 1 and session 2 the five scratch files still held session 1's
appended dates, and turn 1 of session 2 stopped to ask which of three ways to
handle that — visible in the capture as the 17s `PostToolUse` → `Notification`
gap and the 105s turn. The files were removed before session 3, which is why
its turn 1 is the shortest of the three. Neither affects the derivation: the
gap that sets `G` is a no-tool generation in session 1.
