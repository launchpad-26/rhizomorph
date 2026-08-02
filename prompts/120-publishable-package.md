## Direction (prd8 rulings 4 + 5 — make the package publishable)

Today `npm publish` would ship the whole working tree — `.claude/`,
`.swarm/`, `prompts/`, `docs/research/`, the conductor's scripts — to the
public registry, and the manifest says `private: true`, `version 0.0.0`,
no `license`. Fix all of it, and **prove** it by inspecting what `npm
pack` actually produces.

**1. Remove the upstream-owned paths from the tree** (prd8 ruling 4).
Investigation established that exactly these were first authored
upstream, are unreferenced by the app, and are course tooling rather than
product:

- `.claude/skills/tmux-driver/SKILL.md`
- `.claude/skills/workmux/SKILL.md`
- `.agent/skills` (and the `.agent` scaffolding if nothing else uses it)

Delete them from the repo. If anything in the repo references them,
report it rather than silently rewiring.

**2. Manifest**: drop `private: true`; set `version` to `0.1.0`;
`license: "MIT"`; add `description`, `keywords`, `repository`, `homepage`,
`bugs`, `engines` (node >= 22, which `doctor` already requires), and
`bin` pointing at the CLI. Author: Lachlan Kelliher.

**3. An allowlist, not a blocklist**: a `files` field naming only what a
user needs — the built server, the built web assets, the CLI, README and
LICENSE. Workspaces make this fiddly; whatever shape it takes, the test
is what ends up inside the tarball.

**4. Prove it.** Run `npm pack --dry-run` (or pack and list the tarball)
and put the **full file list** in your report. It must contain no
`.claude/`, no `.swarm/`, no `prompts/`, no `docs/research/`, no
`scratchpad/`, no test files, and no source maps you did not intend. It
must contain everything needed to run — verify by installing the packed
tarball into a temp directory and running the CLI from it against this
repo. That last step is the whole point: a package that installs and
runs from the tarball, not from the source tree.

**5. Guard it**: add a CI step (or a test) that fails if the packed file
list gains anything outside the allowlist. A packaging mistake is
invisible until a stranger installs it.

## Fence (may touch ONLY)

- `package.json`, `packages/*/package.json`
- `.npmignore` (if you choose that route), `.gitignore` (only if needed)
- `.claude/skills/tmux-driver/**`, `.claude/skills/workmux/**`, `.agent/**` (deletions)
- `.github/workflows/**` (the packaging guard)
- `packages/server/src/cli/**` (ONLY if `bin` wiring demands it)

Do NOT touch README/docs — #121 owns them.

## Blocked by

#119 (the rename settles the package name first). **Model:** sonnet.
**Wave:** 2.

## Definition of done

- Full `npm pack` file list in your report, with the tarball size.
- A tarball install in a temp dir runs the CLI against this repo — say
  the commands and what you saw.
- The packaging guard fails when given an extra file (prove it).
- Root `npm test` + `npm run typecheck` green; 3x4 load runs 12/12.

## RULES

- Work ONLY in this worktree. Never run git elsewhere. **Never run
  `npm publish`** — publishing is the operator's act, not yours.
- **Committing your work is REQUIRED — commit in increments.** Never
  push, never merge.
- `BLOCKED: <need>` if stuck.
