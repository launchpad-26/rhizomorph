# pi captures — provenance and recipe

Real captures from `pi 0.83.0` (`@earendil-works/pi-coding-agent`, resolved via
`readlink -f $(which pi)` to confirm the exact installed build), taken
2026-08-14 from inside this worktree, per prd-26 ruling 3
("verification-by-capture is the merge gate") and issue #324's Phase 1. Eight
real `pi -p` runs total, each a trivial one-line prompt against
`openrouter/anthropic/claude-haiku-4.5` (the operator's existing `openrouter`
auth, already configured on this machine — no new credentials created). No
pre-existing session history under `~/.pi/agent/sessions/` was read for
content — only that directory's structure (path-slug convention, filename
shape) was consulted beforehand, per the issue's instruction. Every real
capture in this directory was written to a **separate scratch session
directory** via `--session-dir`, not to `~/.pi/agent/sessions/` itself — a
deliberate choice, not the default flow: it keeps eight throwaway test
sessions out of the operator's real session store, and does not change the
file's own shape (`--session-dir` only changes *where* pi writes the same
JSONL, never *what* it writes — confirmed: every file matches
`docs/session-format.md`'s documented shape byte-for-byte in every field this
grammar reads).

## Establishing the absence of an OTLP surface, before assuming it

Before treating pi as "transcript-shaped, not OTLP-shaped" (the fence's own
hypothesis), it was checked directly, not just asserted:

- `pi --help` mentions OTLP/OpenTelemetry zero times (grep, exit clean).
- `docs/environment-variables.md` (the installed package's own bundled docs,
  not a website) lists every environment variable pi reads. `PI_TELEMETRY` is
  documented as installer/update analytics and provider-attribution headers
  only — *"Override install/update telemetry and provider attribution headers
  for OpenRouter, Cloudflare, and direct NVIDIA NIM requests... This does not
  disable update checks."* No `OTEL_*` variable appears anywhere in this file.
- `grep -ril 'otel\|opentelemetry\|otlp' dist/*.js` across the installed
  package's own compiled output (`dist/cli.js`, `dist/main.js`, etc.) returns
  **zero matches** in any file pi's own code ships. An `@opentelemetry/
  semantic-conventions` package *does* exist under `node_modules/`, but tracing
  it (`npm-shrinkwrap.json`) shows it is a transitive dependency of
  `@mistralai/mistralai` (the Mistral SDK, for users who configure that
  provider) — never imported by pi's own `dist/*.js`, confirmed by the same
  zero-match grep.
- **Executed, not just read**: a real session was run with
  `OTEL_RESOURCE_ATTRIBUTES="lane=lane-capture-324,role=worker,instance=rhizomorph-capture-324-instance"`
  set (`rhizomorph env`'s own real recipe, the same one that worked
  unmodified for codex — CAPTURE.md's Finding 2 in `../codex/fixtures/`). The
  resulting session JSONL was grepped for `lane`, `rhizomorph`, `otel` and
  `resource` — the **only** match across the whole file was the substring
  "rhizomorph" inside the worktree's own `cwd` path, not a resource attribute.
  The env var has **zero effect** on a pi session, confirmed by execution.

So: pi's entire evidence lives in the session JSONL. There is no OTLP export
to capture, and no config file or flag that turns one on.

## The eight runs

| run | prompt (trivial, one line) | outcome | fixture |
|---|---|---|---|
| turn-complete | `Reply with exactly: ok` | success, no tool call | `pi-0.83.0-turn-complete.jsonl` |
| tool-call | `Run the shell command: echo capture-324-tool-check — then reply with exactly: done` | success, one bash tool call | `pi-0.83.0-tool-call.jsonl` |
| tool-call-error | `Run the shell command: exit 7 — then reply with exactly: saw-the-failure` | the *tool* fails (`isError:true`); the *turn* still succeeds | `pi-0.83.0-tool-call-error.jsonl` |
| write-tool | `Write the exact text '...' to the file <path> using the write tool...` | success, confirms `write`'s `arguments.path` key | `pi-0.83.0-write-tool.jsonl` |
| edit-tool | `Using the edit tool, replace text X with Y in <path>...` | success, confirms `edit`'s `arguments.path` key too (same key as `write`) | not kept as its own fixture — same shape as write-tool, see Finding 6 |
| task-error | `Reply with exactly: ok`, `--model definitely-not-a-real-model-xyz` | **the failure/absence outcome** — a real API rejection | `pi-0.83.0-task-error.jsonl` |
| interrupted-early | same tool-call prompt, real `SIGINT` sent at 2.5s | **a stronger absence**: zero artifact at all | not kept as a fixture — there is no file; see Finding 4 |
| interrupted-mid-tool | `Run the shell command: sleep 15 && echo done-sleeping — then reply with exactly: done`, real `SIGINT` sent at 6s | a real, truncated transcript ending mid-tool-call | `pi-0.83.0-tail-pending-tool-interrupted.jsonl` |

Two more runs (the two-turn usage check and the `OTEL_RESOURCE_ATTRIBUTES`
check above) were executed but produced no distinct fixture worth shipping —
their content is a near-duplicate of `turn-complete`'s shape; their findings
are stated in prose below with the exact evidence, per the same precedent
codex's own CAPTURE.md sets for runs that didn't need a separate file.

## The capture recipe

Each run, from inside this worktree:

```
pi -p --provider openrouter --model anthropic/claude-haiku-4.5 \
  --no-context-files --no-skills --no-extensions --no-prompt-templates \
  --session-dir <scratch-dir> \
  "<one-line prompt>" </dev/null
```

`--no-context-files --no-skills --no-extensions --no-prompt-templates` is a
deliberate simplification, not a scrub-after-the-fact hack: it keeps this
repo's own (large) `AGENTS.md`/`CLAUDE.md` and this machine's skill catalog out
of the transcript in the first place, the same way choosing a trivial one-line
prompt does — neither changes any of the shapes this grammar or these
capabilities read (turn completion, tool-call pending/closing, usage/cost
location), and it means there was nothing repo-internal or skill-catalog-shaped
left to redact after the fact, unlike codex's capture, which had to redact
several KB of injected boilerplate per run (`../codex/fixtures/CAPTURE.md`'s
own Scrubbing section).

`</dev/null` matters and was learned the hard way: backgrounding
`pi -p ...` without redirecting stdin away from the inherited terminal causes
it to hang indefinitely (presumably a blocked read of piped stdin,
`docs/usage.md`: *"In print mode, pi also reads piped stdin and merges it into
the initial prompt"*) — the first two attempts at the incrementality proof
below timed out for exactly this reason before the fix was found.

Found under `<scratch-dir>/<timestamp>_<uuid>.jsonl` (`--session-dir` writes
flat, no `--<cwd-slug>--/` subdirectory the way the default
`~/.pi/agent/sessions/` location does — the one shape difference from the
default flow, confirmed by inspection, and irrelevant to every fact this
grammar/these capabilities read).

## Finding 1 — usage AND cost live on the assistant message's own line, per-turn, never cumulative

Every `assistant` message entry (`message.usage`) carries, together, on one
line:

```json
"usage": {
  "input": 1974, "output": 38, "cacheRead": 0, "cacheWrite": 0, "reasoning": 30,
  "totalTokens": 2012,
  "cost": { "input": 0.001974, "output": 0.00019, "cacheRead": 0, "cacheWrite": 0, "total": 0.002164 }
}
```

Two facts confirmed by execution, not assumed from `docs/session-format.md`
(whose own `Usage` interface doesn't even mention the real `reasoning` field —
a direct instance of ruling 3's whole point: *"a grammar written from
documentation validates our reading of the docs, not the tool"*):

1. **A real, authoritative dollar cost exists on every turn.** No harness in
   this repo has this — codex's own `CAPTURE.md`: *"No cost/dollar figure
   appears anywhere in any of the four [captures]"*; claude's own sessionlog
   organ is tokens-only, no dollars (`SESSIONLOG_CAPABILITIES`). This is the
   single most valuable fact this capture found — see `capabilities.ts`'s
   `cost` entry for why it is still declared `absent`.
2. **Usage is per-turn, never cumulative.** A real two-message session
   (`pi -p "Reply with exactly: one" "Reply with exactly: two"`, not kept as
   a fixture — see the runs table) showed the second turn's `input: 1986`,
   almost identical to the first turn's `input: 1974` (context growth, not
   summation) — were it cumulative, it would read ~3960. No field anywhere in
   any capture — not the session header, not any message entry — carries a
   running session total.

## Finding 2 — roles are directly distinguishable, and tool results are their own dedicated entry, not nested

Every `message` entry carries an explicit `role`: `user`, `assistant`, or
**`toolResult`** — pi's own dedicated entry type for a tool's answer, never
nested inside a `user`-role entry the way claude's `tool_result` content
blocks are. `toolResult` entries carry `toolCallId` (the join key back to the
`assistant` entry's `toolCall.id`), `toolName`, `content`, and `isError`.

## Finding 3 — a pending tool call is directly observed live, not inferred (the fact that makes a `TurnGrammar` honest here)

codex's own capture (`../codex/fixtures/CAPTURE.md`) could not register a
grammar because *"no capture ever shows a tool call written before its
result."* For pi, this was tested directly, by polling the growing session
file while a real `sleep`-based tool call ran:

```
pi -p ... "Run the shell command: sleep 3 && echo capture-324-slow-tool — then reply with exactly: done" </dev/null &
# poll the session file's line count every 0.1s while pi runs
```

Result, executed: the file held at **exactly 5 lines** — `session`,
`model_change`, `thinking_level_change`, the `user` message, and the
`assistant` message with `stopReason: "toolUse"` carrying the open `toolCall`
— for **19 consecutive poll ticks (≈1.9s)**, the entire span of the `sleep 3`,
before the `toolResult` line landed as line 6. The assistant entry at that
exact moment:

```json
{"message":{"role":"assistant","content":[{"type":"thinking","thinking":"..."},
  {"type":"toolCall","id":"toolu_bdrk_01H3NMYrsfGZJnpt3b19LMtG","name":"bash",
   "arguments":{"command":"sleep 3 && echo capture-324-slow-tool"}}],
  "stopReason":"toolUse", ...}}
```

This is a genuine, timed, executed proof that pi's session file is appended
to **entry by entry, as the turn progresses** — not written once at the end —
and that a live tailer polling it would see this exact pending-tool-call
shape. `pi-0.83.0-tail-pending-tool-interrupted.jsonl` (Finding 4) pins the
even stronger version: this same shape, captured not by polling but by a real
process kill, ending there **permanently**.

## Finding 4 — three distinct failure/absence shapes, all real

1. **A real API rejection** (`pi-0.83.0-task-error.jsonl`): `pi -p --model
   definitely-not-a-real-model-xyz "Reply with exactly: ok"` exits **1**,
   printing `400: {"message":"definitely-not-a-real-model-xyz is not a valid
   model ID","code":400}` to stdout. The session file is **not empty and not
   truncated**: it carries the full `session`/`model_change`/
   `thinking_level_change`/`user` bookkeeping, then one `assistant` entry with
   `content: []`, `stopReason: "error"`, `errorMessage` carrying the API's own
   text verbatim, and `usage`/`cost` all present but zeroed — a real,
   structured, one-line failure shape, distinct from both codex's (no
   assistant message at all on failure) and claude's grammar's own
   never-observed case.
2. **A SIGINT early enough leaves literally nothing on disk — not even the
   header.** `pi -p ... "Run the shell command: sleep 15 && ..." </dev/null &`
   followed by `kill -INT` at **2.5s** (well before the assistant's first
   response, per Finding 3's timing) exits **130**, and no `.jsonl` file ever
   appears in the session directory at all, then or later (checked again after
   the fact — no orphaned process, no delayed write). A stronger absence than
   the API-rejection case: this run is indistinguishable from "pi never ran"
   to anything reading the session directory alone.
3. **A SIGINT sent mid-tool-execution leaves a real, permanently truncated
   transcript** (`pi-0.83.0-tail-pending-tool-interrupted.jsonl`): the same
   `sleep 15` prompt, `kill -INT` at **6s** — well after Finding 3 showed the
   pending `toolCall` line lands (sub-second) but well before the 15s sleep
   would finish — exits **130**, and the session file is exactly 5 lines,
   ending on the assistant entry with `stopReason: "toolUse"`. Its `toolCall`
   (id `toolu_bdrk_01HXJgj9fHFxwoXcxSbBXo3i`, command `sleep 15 && echo
   done-sleeping`) never receives a `toolResult` — the tool call is abandoned
   forever, not just briefly pending. This is the real, executed capture of
   the shape `grammar.ts`'s pending-tool-call classification rests on: not a
   hand-truncated slice, a genuine interrupted process.

## Finding 4b — cache tokens were tested for, and never observed nonzero

A real four-turn session (`pi -p "Reply with exactly: one" "...two" "...three"
"...four"`, not kept as a fixture) was run specifically to check whether
`cacheRead`/`cacheWrite` ever go nonzero once there is repeated context to
cache. They did not, across all four turns
(`{cacheRead:0, cacheWrite:0}` on every one) — `openrouter/anthropic-claude-
haiku-4.5` never triggered caching in this setup. `grammar.ts`'s field mapping
(pi's `cacheWrite` → the shared `cacheCreation`) is therefore inferred from
the field's own name and `session-format.md`'s documented `Usage` interface,
not verified against a real nonzero value. `grammar.test.ts` pins the mapping
with a labelled synthetic line rather than silently leaving it
mutation-blind — a real captured fixture cannot catch a cacheRead/cacheWrite
swap when both are always zero.

## Finding 5 — `filePath` extraction: pi's file tools use `arguments.path`, never claude's `input.file_path`

Two real captures (`write`, kept as `pi-0.83.0-write-tool.jsonl`; `edit`, not
kept as a separate fixture — same shape) confirm both of pi's built-in
file-editing tools take their target file under the key **`path`**:

```json
{"type":"toolCall","id":"...","name":"write","arguments":{"path":"/repo-wt/pi-capture/scratch/pi-write-target.txt","content":"..."}}
{"type":"toolCall","id":"...","name":"edit","arguments":{"path":"/repo-wt/pi-capture/scratch/pi-write-target.txt","edits":[{"oldText":"...","newText":"..."}]}}
```

`read` is inferred to share this key (same built-in tool family, same CLI,
per `pi --help`'s `read, bash, edit, write` listing) but was **not**
independently captured — labelled as an assumption in `grammar.ts`'s own
comment, not asserted as verified.

## Finding 6 — the event schema itself, not data availability, blocks every `AdapterCapabilities` signal

Real, rich data exists for `telemetry`/`cost`/`activity` (Findings 1–3 above).
None of it can be declared `provided` — or even `partial` — because
`packages/core/src/events/common.ts`'s `EventSource` enum is closed to `git`,
`tmux`, `workmux`, `system`, `sessionlog`, `otel`, and `llm.usage`/`llm.cost`/
`tool.activity`'s envelopes are each closed to exactly `['sessionlog',
'otel']`. This is `packages/core/**` territory — out of this issue's fence —
so `capabilities.ts` declares every signal honestly `absent` and names the
exact schema gap as the remedy, rather than misattributing a pi-native event
under `source: 'sessionlog'` (which would misrepresent it as Claude Code's own
collector) or `source: 'otel'` (which would be false — pi has no OTLP export
at all). See `capabilities.ts`'s header comment for the full argument.

## Scrubbing

Real slices, mechanically redacted by a one-off script (not committed — the
recipe is restated here so it's re-derivable, matching precedent):

- The worktree's own absolute path (`<worktree-root>`) → `/repo-wt/
  pi-capture`, matching the session header's `cwd` field exactly.
- The scratch temp-file path used by the write/edit-tool captures → `/repo-wt/
  pi-capture/scratch/...`.
- A blanket backstop regex replaced any other real-home-directory occurrence
  with a `/repo-wt/`-shaped placeholder, matching the rest of this repo's own
  convention (never a `/home/`-shaped stand-in, which would itself look like
  the thing being redacted) — none were found beyond the two prefixes above,
  but the check runs regardless (`grammar.test.ts`'s fixture-hygiene law
  re-checks this structurally, the same way claude's and codex's fixture
  tests do, and now scans this very file too — see that law's own comment).
- The session header's own `id` (a UUID) → a single fixed placeholder
  (`00000000-0000-0000-0000-000000000000`) across every fixture, matching
  claude's and codex's precedent of normalizing session identifiers.
- Left byte-identical, as opaque correlation ids (same treatment as claude's
  `requestId`/`tool_use_id` and codex's `traceId`/`spanId`): every entry's own
  tree `id`/`parentId` (8-char hex), every `toolCall.id`/`toolCallId`
  (`toolu_bdrk_...`), every `responseId` (`gen-...`).
- No user email, no host name, no account id appears anywhere in a pi session
  file (unlike codex's OTLP resource attributes) — there was nothing of that
  kind to redact.
- `thinking`/`thinkingSignature` content was left verbatim: every capture used
  a trivial prompt, so the model's own reasoning text is short, generic, and
  carries no path or identity — unlike codex's multi-KB injected
  `base_instructions`, there was nothing here that needed trimming for size.

## Re-deriving

1. Confirm `pi --version` and `readlink -f $(which pi)` match this file's
   pinned version; re-derive against a newer one if not (the fixture names
   and this file's `pinned` string both move together).
2. Confirm the OTLP absence still holds: `pi --help | grep -i otel`,
   `grep -ril otel <pi's dist/>`, and the `OTEL_RESOURCE_ATTRIBUTES` run
   above — all three, not just the first.
3. Run each prompt in the runs table with
   `pi -p --provider openrouter --model anthropic/claude-haiku-4.5
   --no-context-files --no-skills --no-extensions --no-prompt-templates
   --session-dir <scratch> "<prompt>" </dev/null` from inside a worktree of
   this repo.
4. For the incrementality proof (Finding 3) and the interrupted captures
   (Finding 4): background the run with stdin redirected from `/dev/null`,
   poll the session file's line count on a short interval, and send `SIGINT`
   to the `pi` process at the timing named above.
5. Apply the redaction rules above (or an equivalent script) over every kept
   `.jsonl` file; re-run `grammar.test.ts`'s fixture-hygiene law to confirm no
   email, no `/home/`or `/Users/` path, and no NUL byte survived.
