# Working in this repo

## Issues and the project board

Use `scripts/dev/issues.sh` rather than raw `gh` calls — the board carries two
fields that are easy to get wrong by hand.

```
scripts/dev/issues.sh list                    # open issues: WHEN / TYPE / STATUS
scripts/dev/issues.sh when   <n> now|soon|later
scripts/dev/issues.sh type   <n> bug|feature|task
scripts/dev/issues.sh status <n> backlog|ready|in-progress|in-review|done
scripts/dev/issues.sh show   <n>
scripts/dev/issues.sh close  <n> "reason"     # a reason is required
scripts/dev/issues.sh orphans                 # open issues missing from the board
scripts/dev/issues.sh ids                     # field/option ids, for debugging
```

Three things the script exists to hide, each of which cost a wrong guess once:

- **Timeline is a multi-select**, so its value goes through
  `multiSelectOptionIds` (a list). Sending the single-select shape fails with
  `argumentNotAccepted`.
- **`gh project item-list --format json` never returns multi-select values** —
  only `status`. Reading Timeline requires GraphQL.
- **Issue type (Bug/Feature/Task) is an org-level type, not a label.** It is set
  through the `updateIssue` mutation; `gh issue edit` will not do it.

### What the fields mean

`Status` is where the work **is** (Backlog → Ready → In progress → In review →
Done). `Timeline` is when it should **happen**:

- **Now** — actively costing time or trust.
- **Soon** — real, evidenced pain that is not bleeding today.
- **Later** — correctly parked: gated on a ruling, large, or needs a human act.

Both are needed. Status alone collapses "do this next" and "correctly parked"
into one Backlog column; Timeline alone says nothing about what is in flight.

### Closing an issue

Always close with a reason — the script enforces it. State what fixed it (with
the commit), or what supersedes it. An issue closed silently is a fact nobody
can recover later.

## Before you push

CI runs `test`, `typecheck`, `lint`, a packaging guard, and a boot smoke across
ubuntu + macOS. The macOS leg is the one that carries signal for path-shape bugs
— `os.tmpdir()` is a symlink there (`/var` → `/private/var`) and is not on Linux,
so a raw-vs-canonical path comparison passes vacuously on ubuntu and fails only
on macOS.

If the `Test` step fails, **every later step on that leg is skipped** — typecheck,
lint, packaging and boot smoke silently do not run. A red leg is therefore worth
more than one failing test; check `gh run list --branch main` before assuming a
gate has been enforcing anything.

## Reviews

`docs/review/` holds multi-strategy code reviews with a consolidated work list in
its `README.md`. They are dated artefacts describing the tree at a specific
commit — read them for findings, not as current state.
