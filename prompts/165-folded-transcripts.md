You are a worker agent on rhizomorph. You own exactly one issue.
Read every document your issue names IN FULL before changing
anything; import from @rhizomorph/core; laws restated stronger,
never weakened. Tests HERMETIC under 4x concurrency.

You are working on the OBSERVER hand, which is read-only absolutely and
forever (prd12 ruling 1). Reading ~/.claude/projects is fine; writing there is
not.

YOUR ISSUE — #165:

## Direction

BUG, diagnosed by the conductor 2026-08-05 from the live instrument. **A lane's
conversation becomes unreadable the moment it lands and folds** — which is
exactly the moment you most want to review why the code exists. For a product
whose stated thesis is the causal record (prd11), this is the record going dark
at the finish line.

**Nothing is lost. This is an enumeration bug, not data loss.** Evidence, all
[Ran]:

- Lane 163's drawer says: `NO SESSION LOG for "163" (session 7ba53ac3-…) — the
  transcript is not on disk where the collector tails it (no worktree path was
  recorded for it)`.
- The transcript **is** on disk, complete and still being written:
  `~/.claude/projects/-home-operator-worktrees-challenge--worktrees-163/7ba53ac3-….jsonl`,
  8.99 MB.
- `collectors/sessionlog/collector.ts:71` tails
  `~/.claude/projects/<slug>/*.jsonl` **"for every worktree of the watched
  repo"** — it enumerates **live** worktrees. A folded lane has no worktree, so
  its slug is never computed and its transcript is never tailed.
- The observer already holds everything needed: the event log names lane 163's
  worktree path **461 times** and its session id **2,498 times**.
- `collectors/sessionlog/worktree-slug.ts` already contains the path→slug
  function.
- **164 lane transcript directories currently sit on disk**, invisible to the
  instrument the moment their lanes folded.

So the collector asks git *"what exists now"* when it should ask its own fold
*"what have I ever seen"*. The slug function exists, the data exists; only the
source of the list is wrong.

Fix direction:

1. **Derive the slug set from remembered worktrees, not only live ones.** A
   worktree the fold has ever seen keeps its slug in the tail set. Prefer
   reading this from state the observer already has over inventing a new event.
2. **Stay read-only.** This is the observer hand, not the lab — it reads
   `~/.claude/projects` and writes nothing there. The readonly law tests must
   stay green untouched.
3. **Degrade loudly, as today.** If a remembered transcript really is gone
   (user deleted it), the gap voice must still say so precisely rather than
   silently rendering an empty tab. Absence is still reported as absence.
4. **Bound the work.** 164 slugs is not 164 open file handles. Tail what is
   live; read folded transcripts on demand when their drawer is opened, and say
   in your summary which strategy you chose and why.

Laws that must survive, test-stated:

- The observer never writes outside its own data directory.
- A folded lane's conversation is readable; a genuinely missing one still
  produces the honest gap voice, not silence.

## Fence (may touch ONLY)

- `packages/server/src/collectors/sessionlog/` (all files)

If you find you need a route or selector change to read a folded lane on
demand, **stop and print `BLOCKED: <need>`** with the specific file — do not
widen your own fence. The conductor widens fences on the record.

## Blocked by

Nothing. **Model:** sonnet. **Wave:** the small defects.

## Definition of done

- A landed, folded lane's drawer shows its conversation.
- A genuinely absent transcript still renders the precise gap voice.
- Readonly law tests green untouched; root `npm test` + `npm run typecheck`
  green.
- Say which tailing strategy you chose, and what it costs at 164 slugs.

RULES: stay strictly inside the FENCE; small conventional commits
(committing is REQUIRED); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests deterministic; build
for a stranger's machine; if you cannot proceed print
"BLOCKED: <need>" and stop; DoD is root 'npm test' +
'npm run typecheck' green, then STOP with a short summary.
