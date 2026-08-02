## Direction (prd8 ruling 2 — the rename)

The project is called **rhizomorph** from now on: in mycology, the
root-like cord of bundled hyphae that carries nutrients across distance
to the colony — which is exactly what this app draws. `observatory` was
already taken on npm; `rhizomorph` is verified free (registry 404).

Rename everywhere it is user-visible or machine-visible:

- **Package identity**: root and workspace `package.json` names, and the
  `bin` so the command is `rhizomorph`. (Do NOT change `private`,
  `version` or `license` — #120 owns publishability.)
- **The CLI**: the binary name, `--help` text, usage strings, the
  `doctor` output, the server's startup banner.
- **Strings the app shows the operator**, including the gap voices —
  e.g. `run: eval "$(observatory env <lane>)"` and
  `run: observatory --extra-sessions <dir>:conductor` must name the new
  command. Several of these are pinned by tests; update the tests with
  them (this is a rename, not a weakening — the assertion keeps its
  shape, the string changes).
- **Docs and prompts** in the repo that name the command.

Keep the word "Observatory" where it is the product's *title* rather
than its command, if you judge that reads better (the wordmark
`THE OBSERVATORY` in the UI is a design element, not an identifier) —
but say clearly in your report which you kept and why. One rule: nothing
a user types may still say `observatory`.

## Fence

Repo-wide — this is a rename and it must land alone (no other lane is
dispatched while it runs). Do NOT touch: `.claude/skills/**`,
`.agent/**`, `LICENSE`, `.swarm/**`.

## Blocked by

Nothing. **Model:** sonnet. **Wave:** 1 (alone).

## Definition of done

- `grep -rn "observatory" --include='*.ts' --include='*.tsx' --include='*.json' --include='*.md' .`
  returns only deliberate title/wordmark uses, and your report lists them.
- The CLI runs under the new name end to end: `npm start -- <repo> --port <n>`
  serves, and `doctor` passes. Say which commands you ran.
- Root `npm test` + `npm run typecheck` green.
- Load evidence: 3 batches × 4 concurrent runs (`npm test --
  --maxWorkers=5`), 12/12 green.

## RULES

- Work ONLY in this worktree. Never run git elsewhere.
- **Committing your work is REQUIRED — commit in increments.** Never
  push, never merge.
- Build for a stranger's machine. `BLOCKED: <need>` if stuck.
