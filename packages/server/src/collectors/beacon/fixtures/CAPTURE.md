# Beacon fixtures — provenance and recipe

`claude-hook.jsonl` pins the ADR-0036 v1 line contract the way every other
`CAPTURE.md` in this tree does: with a real capture, so the fixture witnesses
the emitter rather than only our reading of the contract. #217 shipped a
hand-written one because nothing existed yet to capture from —
`rhizomorph env <lane> --hooks claude` (#282) is the first emitter, and this
file replaces that hand-written fixture with a capture of it.

**Do not hand-write a single line of this file.** If the recipe below cannot be
completed — no TTY, or a hook that never fires — stop and report; do not
substitute.

## Recipe

1. A throwaway repo and a throwaway data root:

   ```sh
   SCRATCH=$(mktemp -d) && git -C "$SCRATCH" init -q && git -C "$SCRATCH" commit -q --allow-empty -m init
   DATA=$(mktemp -d)
   ```

2. From this repo, built (`npm run build`), boot a server against that data
   root, watching the scratch repo:

   ```sh
   RHIZOMORPH_DATA_DIR="$DATA" npm start --silent -- "$SCRATCH" --port 4399 &
   ```

   The same `RHIZOMORPH_DATA_DIR` must be exported in the shell that runs step
   3, so `env` resolves the same root the server did.

3. Print the hooks fragment and install it in the scratch repo's Claude Code
   settings:

   ```sh
   mkdir -p "$SCRATCH/.claude"
   RHIZOMORPH_DATA_DIR="$DATA" npm start --silent -- env 2-core --hooks claude --port 4399 > "$SCRATCH/.claude/settings.local.json"
   ```

   The lane handle is `2-core`, the synthetic handle the existing fixtures
   already use — chosen at print time, so nothing needs substituting later.

4. Drive one interactive session in `$SCRATCH` under tmux so every hook can
   fire:

   ```sh
   tmux new-session -d -s beacon-cap -c "$SCRATCH" 'claude'
   # wait for the prompt, then SELECT MANUAL APPROVAL before typing anything:
   tmux send-keys -t beacon-cap S-Tab   # cycle off the default auto-accept-edits mode
   tmux capture-pane -p -t beacon-cap   # confirm the mode line before continuing
   # Without this the Write below is auto-accepted, no permission dialog opens,
   # `Notification` never fires, and the capture is three kinds, not four.
   tmux send-keys -t beacon-cap 'create a file named hello.txt containing the word hi' Enter   # UserPromptSubmit -> working
   # the Write tool asks permission -> Notification -> waiting
   tmux capture-pane -p -t beacon-cap   # check the dialog's default before accepting
   tmux send-keys -t beacon-cap Enter                                                          # PostToolUse -> working
   # the turn ends -> Stop -> stopped
   tmux send-keys -t beacon-cap '/exit' Enter
   ```

5. Verify before copying:

   ```sh
   f="$DATA/$(ls "$DATA")/beacons/claude-hook.jsonl"
   grep -c '"kind":"waiting"' "$f"
   grep -c '"kind":"working"' "$f"
   grep -c '"kind":"stopped"' "$f"
   node -e "require('node:fs').readFileSync(process.argv[1],'utf8').split('\n').filter(Boolean).forEach(l=>JSON.parse(l))" "$f"
   grep -E '/Users/|/home/|C:\\\\' "$f"   # expect no match
   ```

6. Copy the whole file to
   `packages/server/src/collectors/beacon/fixtures/claude-hook.jsonl`, LF,
   newline-terminated (`.gitattributes` pins `fixtures/**` to `eol=lf`;
   `corpus-eol-law.test.ts` checks it).

7. Kill the server and tmux session; `rm -rf "$SCRATCH" "$DATA"`.

## What was captured

| | |
|---|---|
| date | 2026-09-05 |
| command that printed the hooks | `npm start --silent -- env 2-core --hooks claude --port 4399` |
| installed at | `$SCRATCH/.claude/settings.local.json` in a throwaway repo |
| typed | `create a file named hello.txt containing the word hi`, then accepted the `Write` permission prompt, then `/exit` |
| lines captured, by kind | 1 waiting / 2 working / 1 stopped |

The manual-approval permission mode (`shift+tab` to cycle past the default
auto-accept-edits mode) had to be selected before sending the prompt — under
the default auto mode, Claude Code never asks permission for a file write, so
`Notification` (`waiting`) never fires and the capture would have been three
lines short of the vocabulary, not four.

## Sanitising

Per `AGENTS.md`: a capture is not exempt, it is the main source. The lines this
emitter writes carry only `v`, `at`, `writer`, `kind`, `lane` and `detail` — no
field a hook can populate ever holds a path, a hostname or a real person's
name — so there is nothing to redact by construction. The lane is synthetic
(`2-core`) by construction too. The check in recipe step 5 was still run
against the captured file rather than assumed: every line parsed as JSON, and
a grep for `/Users/`, `/home/`, `C:\`, and this machine's `hostname` output
against the four captured lines returned zero matches.

## How the interactive session was actually launched

The build lane's own `claude` cannot use the operator's login — a `claude`
process spawned directly by a build lane fails with `OAuth session expired`,
because the CLI is authenticated only for processes started from the
operator's own terminal. Step 4's `tmux new-session` above is the recipe as
planned and holds for a human or for any lane that inherits a logged-in shell;
this capture instead drove `claude` inside a tmux session (`beacon-cap`) the
operator had started themselves from their terminal, sending it the same
prompt and accepting the same permission dialog via `tmux send-keys` from
outside. Only the launcher differs — the recipe, the prompt, and the four
hook events fired are exactly as written above.
