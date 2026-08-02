## Direction (prd8 rulings 3, 6, 7 — documentation for a stranger who is deciding whether to trust this)

The current README is written for someone who already knows the project.
Rewrite it for someone who has just found it and is deciding, in ninety
seconds, whether to run it on the machine where their AI agents work.

**The README must answer, in this order:**

1. **What is it** — one sentence, then one screenshot. A read-only
   instrument you point at a repo full of git worktrees; it shows what a
   swarm of coding agents is doing, live, and can replay the session.
2. **Install and run** — `npx rhizomorph <path-to-repo>` first, clone-and-run
   second. Exact commands, verified by running them.
3. **What it reads and where it listens** (ruling 6 — this is a trust
   document, not a footnote). Plainly: it reads git/tmux/workmux state
   and `~/.claude/projects` session logs — *your agent conversations* —
   it serves them on `127.0.0.1` only, and it sends nothing anywhere.
   Nothing leaves the machine. Say it in the user's language, not ours.
4. **Support matrix, honest** (ruling 7): Linux CI-verified on every
   push; WSL is the daily development platform; **macOS unverified —
   say so plainly** (see the history around issue #74 before writing a
   word about macOS). Node >= 22.
5. **What it does not do** — it never writes to your repo, never runs
   git commands that mutate, never executes an agent action. Read-only
   is the product's spine; say it.
6. **Maintenance posture** (ruling 3), verbatim in spirit: released
   as-is, issues welcome, no promise of response times.
7. Then the deeper material: the scene's visual grammar, replay, the
   drawer, the keyboard map, and links to `docs/`.

**Also in this issue:**

- `CONTRIBUTING.md` — how to run the tests, the gate standard this
  project holds itself to (bounded 4x load runs), and the fact that laws
  live in tests and may be strengthened but not weakened.
- `SECURITY.md` — how to report something privately; state the read-only,
  localhost-only posture again.
- **Fix the stale docs**: `docs/architecture.md` still documents the
  done-mark as "a hue-only knot / knotMark" — #117 replaced it with the
  fold (four-clause law), and #118 changed the mass to grow with
  accumulated work. Bring the decision log current for both.
- Regenerate `docs/screenshots/**` from the live app under the new name.

Load `frontend-design` and `emil-design-eng` for the README's shape —
a README is an interface. Look at it rendered on GitHub if you can
(`gh markdown` preview or just judge the raw structure); say what you did.

## Fence (may touch ONLY)

- `README.md`, `CONTRIBUTING.md` (new), `SECURITY.md` (new)
- `docs/**` (including `docs/screenshots/**`)

Do NOT touch `package.json` or `.github/**` — #120 owns those.

## Blocked by

#119 (name), and read #120's report before finalising install commands.
**Model:** sonnet. **Wave:** 2.

## Definition of done

- Every command in the README run by you, with what you saw in the report.
- No personal paths anywhere; no unverified platform claims.
- Screenshots regenerated and committed.
- Root `npm test` + `npm run typecheck` green (docs-only, but prove the
  tree is unbroken).

## RULES

- Work ONLY in this worktree. Never run git elsewhere.
- **Committing your work is REQUIRED.** Never push, never merge.
- `BLOCKED: <need>` if stuck.
