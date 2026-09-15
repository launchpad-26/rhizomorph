# Board archive cadence — what comes off, what goes on, and when

`#505` archived the board from 259 items down to 16 (later regroomed further —
see the measurement below). This note is the part of that issue's Definition of
done that a one-off prune cannot satisfy on its own: a cadence, so the count
does not silently climb back to 259. Without one, it will — the board carried
no removal rule before this note, and drifted for the length of this repo's
history before anyone counted.

**Corrected 2026-09-15, after verification.** The first draft of this note had
a wrong headline cost figure and conflated two different board-reading
operations that this repo's own tooling keeps separate. Both are fixed below;
the six findings that drove the correction are listed in full in the message of
the commit that added this note — the last entry in
`git log --follow docs/design-notes/board-archive-cadence.md`.

## The cost this cadence exists to hold down

`gh api rate_limit` reports GraphQL usage as `used=0`, `remaining=5000/5000`
**unconditionally** on this account — it does not reflect real traffic.
Reproduced here, 2026-09-15, before touching anything else this session:

```
$ gh api rate_limit --jq '.resources.graphql'
{"limit":5000,"remaining":5000,"reset":1789438390,"used":0}
$ gh api graphql -f query='{rateLimit{limit cost remaining used resetAt}}'
{"data":{"rateLimit":{"limit":5000,"cost":1,"remaining":4893,"used":107,...}}}
```

Same moment, two answers: `0` used from the endpoint, `107` from the field.
The working counter is the field, not the endpoint:

```
gh api graphql -f query='{rateLimit{limit cost remaining used resetAt}}'
```

Name `gh api rate_limit` explicitly as the one that lies — that is what stops
the next person trusting it.

### The measurement method, corrected

The first draft of this note subtracted 1 from every before/after delta, on
the theory that the `{rateLimit{...}}` probe itself has a cost. **That is
false, and it was checked, not assumed:**

```
CONTROL A — five consecutive bare probes, nothing else run between them:
$ for i in 1 2 3 4 5; do gh api graphql -f query='{rateLimit{used}}' --jq '.data.rateLimit.used'; done
218 218 218 218 218

CONTROL B — probe, then a real query, then probe again:
before=218 -> gh api graphql -f query='{viewer{login}}' -> after=219   (delta 1)
```

A query that asks for nothing but `{rateLimit}` fields is not charged at all.
The delta a caller sees IS the cost of whatever ran in between — no
correction needed. The subtraction in the first draft turned a correct raw
reading into a wrong corrected one.

**A sharper method, where it applies:** `rateLimit.cost` is returned by the
query itself (see the `"cost":1` above) and is immune to concurrent spend on
this shared account — which is real, not theoretical: `used` moved from 107 to
several hundred over the course of this session from other lanes' traffic.
Differencing before/after readings assumes nothing else spends in between, and
that assumption is false on this account. Where a single query can be run in
isolation (below), its own `cost` field is used directly rather than a delta.
For a black-box multi-call script like `issues.sh`, a tight before/after delta
around the whole invocation is still the practical method — it is just no
longer adjusted by a point that was never spent.

### Two operations, not one — this repo's own tooling already keeps them apart

`scripts/dev/issues.sh` reads the board through two genuinely different code
paths, and they have different costs and different levers. Conflating them was
the second thing wrong with the first draft.

**`cmd_list`** (`issues.sh list`, and `show`, which calls it) — a hand-written
GraphQL query hardcoded to `items(first: 100, after: $after)`, paginated by
walking `hasNextPage`, plus one `gh issue list` call for the reconciliation
footer. Measured today, board at 37 items (30 open, 7 Done):

```
raw delta around the whole `issues.sh list` call, three runs, no probe cost involved:
run 1: before=219 after=222  delta=3
run 2: before=222 after=225  delta=3
run 3: before=225 after=228  delta=3

decomposed by measuring each half in isolation:
  the exact board GraphQL query alone (first:100, one page): delta = 2
  `gh issue list --json number,title,milestone`, alone, at --limit 1000/100/20: delta = 1 every time
  2 + 1 = 3, matching the whole-call delta exactly
```

**`issues.sh list` costs 3 points, not 2.** The earlier draft's "2" came from
subtracting a probe cost that the controls above show is not real.

**`fetch_board`** (`ensure_board`, called by `orphans`, every `set_select`
write, and `batch`) — `gh project item-list --limit "$BOARD_LIMIT"`, a
built-in `gh` command with a much heavier per-item query (every field, every
option, per item) than `cmd_list`'s hand-written one. Measured today, same
37-item board:

```
$ gh project item-list 19 --owner launchpad-26 --limit 1000 --format json   -> delta 102, 37 items returned
$ gh project item-list 19 --owner launchpad-26 --limit  100 --format json   -> delta 102, 37 items returned
$ gh project item-list 19 --owner launchpad-26 --limit   20 --format json   -> delta  22, 20 items returned (truncated)
```

This is the operation this issue's own history is actually about. The
`~384`-point figure in the issue body and the `~215`-point figure in an
earlier comment are `fetch_board`-shaped calls (`orphans`/`set_select`/`batch`
territory), not `cmd_list` — and `837e9ab9` (the commit that made `issues.sh`
read the board once per run rather than once per write) independently
recorded this same operation at **305 points for 248 items**, which is within
measurement noise of
`3 × 102 = 306`. That is not a coincidence: `gh`'s own page size caps at 100
regardless of `--limit` above it, so cost here is **pages × per-page-cost**,
`pages = ceil(items / min(--limit, 100))`, same mechanism as `cmd_list`, just
with a per-page cost roughly 50x heavier because of what the built-in query
asks for per item.

**So "cost tracks page size, not item count" — the earlier draft's headline —
is false as a general claim, and it was checkably false from the two data
points already in hand:** both 11 items and 37 items sit inside `cmd_list`'s
single hardcoded `first: 100` page, which is exactly the regime where item
count *cannot* show up in the number. At the 259 items this issue started
from, `cmd_list`'s board query would need 3 pages (`ceil(259/100)`), roughly
tripling its cost — the prune has simply not been observed doing that yet,
because the board has stayed under 100 the whole time since. For
`fetch_board`, item count showed up immediately, because 259/37/11 items
straddle the 100-item page boundary in different ways depending on what
`BOARD_LIMIT` and the live count happen to be.

### The two operations have different levers, and only one has `BOARD_LIMIT`'s name on it

The earlier draft treated `BOARD_LIMIT` and `cmd_list`'s hardcoded `100` as one
knob. They are not, and mixing them up parked a decision on the wrong lever:

- **`cmd_list`'s cost is insensitive to `BOARD_LIMIT`.** `BOARD_LIMIT` reaches
  `cmd_list` only as `ISSUE_LIMIT`, the cap on the reconciliation's `gh issue
  list` call — and that call costs `1` at `--limit 1000`, `100`, or `20` alike
  (measured above). Lowering `BOARD_LIMIT` changes `cmd_list`'s total cost by
  zero. The only real lever for this path is the literal `100` inside
  `items(first: 100, after: $after)` in the Python embedded in `cmd_list`.
- **`fetch_board`'s cost genuinely tracks `BOARD_LIMIT`.** Measured above:
  dropping the effective page size from 100 to 20 cut this call's cost from
  102 to 22. So lowering `BOARD_LIMIT` *is* a real lever here — but only down
  to whatever margin still safely exceeds the live item count, because
  `fetch_board` is the one that dies loudly rather than truncating (`#420`)
  the moment `--limit` is at or below the actual count. A `BOARD_LIMIT` low
  enough to save real points is also low enough to need re-raising the next
  time the board legitimately grows past it — which is a maintenance cost the
  first draft's framing did not weigh at all.

This commit does not change `BOARD_LIMIT` or the `100` in `cmd_list` — the
issue's final regroom narrowed scope to the cadence and the measurement, not
either lever — but the two are now named correctly, as separate decisions with
separate tradeoffs, rather than one.

### What this means for the cadence's cost case

The prune from 259 to 16 items bought a real, roughly 3x reduction on
`fetch_board` — the operation `orphans`, every board write, and `batch` all
pay — tracking pages, not a vague sense of "fewer rows." It has bought nothing
yet on `cmd_list` (`list`/`show`), because both the before and after board
sizes measured so far sit inside one page of it; that changes the moment live
items again cross 100. **The cadence is worth having on both grounds**: it
keeps the heavier operation cheap continuously rather than in occasional
prune-shaped jumps, and it keeps the board legible, which was the harder
problem underneath 259 items regardless of what any single call cost.

Board state at measurement time, both ways:

```
$ gh api graphql -f query='{node(id:"PVT_kwDOEnEMsM4Bfk9Q"){... on ProjectV2{items(first:1){totalCount}}}}'
{"data":{"node":{"items":{"totalCount":37}}}}

$ gh project item-list 19 --owner launchpad-26 --format json --limit 200 | \
    python3 -c 'import json,sys; from collections import Counter; \
    d=json.load(sys.stdin); print(Counter(i.get("status","(none)") for i in d["items"]))'
Counter({'Backlog': 20, 'Ready': 6, 'In progress': 4, 'Done': 7})
```

`scripts/dev/issues.sh orphans` currently reports 3 open issues with neither a
board row nor a milestone (`#457`, `#396`, `#362`) — down from the 8 the
previous regroom recorded, because the `prd57 w1` issues it named have since
been boarded. Boarding these three is an operator act on board data, the same
class as the archive itself (see [Not this note's job](#not-this-notes-job)),
named here so it is not lost.

## The cadence

The board drifted to 259 for one reason: nothing ever took a Done item back
off it, and nothing ever refused to let boarding lag behind issue creation. A
cadence has to name both directions, or it repeats the exact drift this issue
was filed against.

### Off the board: Done items, archived on a trigger, not a schedule

**What:** `gh project item-delete <project> --owner <owner> --id <item-id>`
against every item whose `Status` is `Done`. This unlinks the board row only —
it never touches the issue, which stays closed, commented, and searchable by
number exactly as before. (`gh project item-archive` is the reversible
sibling, with `--undo` to relink; `item-delete` is what the prune this issue
used, and either is fine — reversibility is board-row-only either way, since
neither command can un-close an issue.)

**When:** a Done item earns its removal the moment it stops being useful to
see next to live work — which is roughly the moment it closes, not on a
calendar. So the trigger is **"a wave lands,"** not "every Monday": when a PR
merges and its issues close, whoever closes them removes their board rows in
the same sitting. `AGENTS.md`'s own [Closing an issue](../../AGENTS.md#closing-an-issue)
section requires a reason on every close but names no actor for it — this note
adds none either; it is simply whoever is at the keyboard closing the issue,
already running `scripts/dev/issues.sh close`, for whom unlinking the row is
one more `gh project item-delete` in the same breath. Keeping removal tied to
that act, rather than to a periodic sweep, avoids accumulating between sweeps
the way this board reached 259 in the first place — a periodic sweep is
exactly the "one-off tidy" shape that let it happen, because a sweep that is
anyone's job on a schedule is nobody's job the week the schedule slips.

**Why a trigger and not a count threshold:** a threshold ("archive once Done
exceeds N") still lets Done rows sit and accumulate up to N, and N is exactly
the kind of value that gets raised under pressure rather than enforced. Tying
removal to the act that already produces a Done item — closing — costs nothing
extra.

### Onto the board: every new issue, at filing, not at grooming

**What:** every issue gets a milestone and a board row at creation. `issues.sh
orphans` is the check, not the mechanism — it was built to catch exactly the
two ways an issue goes missing (no board row, no milestone), and it is meant to
report *nothing* in ordinary operation, not to be the queue that boarding
happens from.

**When:** at filing, by whoever files it — which for grooming is `issue-groom`
(this repo's skill for turning a PRD wave into dispatchable issues), and for
anything filed outside a wave is the filer directly. `orphans` becomes a
pre-dispatch and pre-wave-grooming check — run it before boarding a new wave
and before dispatching one — rather than a periodic catch-up sweep. A periodic
"check for orphans and board them" habit is a habit that lapses, and the eight
orphans this issue's own regrooming found were exactly that lapse, not a
one-time anomaly.

**Why filing time and not review time:** an issue with no board row is, by
construction, absent from every view of the board — there is no board query
that can show a row that does not exist. `AGENTS.md`'s own statement is a
related but narrower point, worth keeping distinct rather than merged with
this one: an **unassigned** in-progress issue "disappears from every
assignee-filtered view of the board" (`### What the fields mean`) — that is
about assignment on an issue already boarded, not about board membership. Both
failure modes make real work invisible to a filtered view; they are not the
same failure, and this cadence exists for the board-membership one. The cost
of either is paid every day the gap is open, not once at the end — so the
cheapest time to close it is the same moment it opens.

### Who runs `orphans` and the archive, and how often

Both directions are **operator acts on board data** — the same class as the
archive this issue's Definition of done turned on. A lane does not run either;
see [Not this note's job](#not-this-notes-job). In practice that puts both
checks at the two moments the operator is already touching the board:
**closing an issue** (Done side) and **boarding or dispatching a wave**
(orphan side) — not a separate calendar cadence to remember on top of those.

## Confirming `issues.sh` still dies loudly rather than truncating

This issue's sibling-case warning — do not narrow `fetch_board` to save
points, because the script is built to die rather than return a short list a
later `orphans` check would agree with — was checked by forcing the failure
rather than reading the code and assuming it still holds. `BOARD_LIMIT` was
lowered from `1000` to `5` (temporarily, on a local copy, never committed) and
both guarded reads were run against the current 37-item board / 30+ open
issues:

```
$ scripts/dev/issues.sh orphans > out 2> err; echo "exit=$?"
exit=1
out:  (0 lines — nothing printed before the die)
err:  error: board returned 5 items, at or above the --limit of 5; raise BOARD_LIMIT in scripts/dev/issues.sh
      error: could not read the board

$ scripts/dev/issues.sh list > out 2> err; echo "exit=$?"
exit=1
out:  30 lines — the FULL table (header + 29 open-issue rows), unchanged from a
      normal run. Only the trailing reconciliation footer ("N shown, N open...")
      is missing.
err:  error: gh issue list returned 5 issues, at or above the --limit of 5; raise BOARD_LIMIT in scripts/dev/issues.sh
```

**Both guards fire and both exit non-zero — the Definition of done's "dies
loudly rather than truncating" holds for both commands.** But `orphans` and
`list` do not fail the same way, and the earlier draft's "before either
command reports anything a reader could mistake for a complete answer" was
false for `list`: it prints what looks like a complete table to stdout before
the guard trips on the trailing reconciliation check, and a caller that
captures or checks stdout without also checking the exit code (or reading
stderr) would see 29 rows and no visible sign anything was wrong. The failure
is still loud in the one place that cannot be ignored — the exit status — but
it is not loud on stdout the way `orphans`'s is. That distinction belongs in
the record, not smoothed over it.

`BOARD_LIMIT` itself was restored to `1000` immediately after; nothing in
`scripts/dev/issues.sh`'s behavior is changed by this note — see the header
comment there for the pointer back to this file.

## Not this note's job

- **Boarding `#457`, `#396`, `#362`.** Same class as the archive: an operator
  act on board data. Named above so it is not lost, not performed here.
- **Lowering `BOARD_LIMIT` or the `100` in `cmd_list`.** Both are now real,
  separately-quantified levers (above), and each has its own tradeoff — a
  lower `BOARD_LIMIT` trades away the safety margin the die-loudly guard needs
  against ordinary board growth; a lower `cmd_list` page size trades nothing
  today (the board fits in one page) and would need re-raising the moment it
  does not. Changing either is a separate, later decision.
- **Automating either direction in `scripts/dev/issues.sh`.** This note
  documents who does what and when; it does not add an `archive` subcommand.
  If the operator wants one later, `gh project item-delete` for the Done side
  and `orphans` for the other are the two primitives it would wrap.
