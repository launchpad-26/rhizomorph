## Direction (prd8 ruling 1 — release engineering, so a version means something)

A tool for real users needs releases a user can reason about.

- **`CHANGELOG.md`**, Keep a Changelog shape, starting at `0.1.0`. The
  first entry is not a dump of 320 commits — it is what the thing IS at
  first release, in a user's language: live view of a worktree swarm,
  replay, the lane drawer with the agent's own conversation, the scene,
  read-only and localhost-only.
- **Semver policy, written down**: what counts as breaking for this
  project (the CLI's flags and the shape of `.swarm/lanes.json` are the
  public contract; the scene's visual grammar is not). Put it in
  CONTRIBUTING or the changelog header, wherever it reads better.
- **A release workflow** (`.github/workflows/release.yml`): on a `v*`
  tag, run the full suite + typecheck + the packaging guard, then
  `npm publish --provenance --access public`. It must be gated on the
  tests passing, and it must NOT publish on push to main.
  **Do not add secrets** — leave a documented placeholder for
  `NPM_TOKEN` and say in your report exactly what the operator must do
  (create the token, add the repo secret). Publishing remains a human
  act with a human's credentials.
- **Version stamping**: `--version` on the CLI reports the package
  version, and there is a test that they cannot drift.

## Fence (may touch ONLY)

- `CHANGELOG.md` (new)
- `.github/workflows/release.yml` (new)
- `packages/server/src/cli/**` and its tests (the `--version` wiring only)
- `CONTRIBUTING.md` (the semver policy paragraph only — #121 wrote the file)

## Blocked by

#119, #120, #121. **Model:** sonnet. **Wave:** 3.

## Definition of done

- `--version` prints the package version, pinned by a test.
- The workflow is valid (`gh workflow view` or a lint) and cannot fire
  except on a tag; say how you verified without publishing anything.
- Your report tells the operator, in numbered steps, exactly what they
  must do by hand to make the first release happen.
- Root `npm test` + `npm run typecheck` green; 3x4 load runs 12/12.

## RULES

- Work ONLY in this worktree. Never run git elsewhere. **Never publish,
  never create tags, never add secrets.**
- **Committing your work is REQUIRED.** Never push, never merge.
- `BLOCKED: <need>` if stuck.
