# Cross-host transcript resume — dialect verification spike

**VERDICT: GO**

All four questions were answered by real runs on 2026-08-14. Copying a Claude
Code transcript into another cwd's slug directory and resuming it there works —
same host and **across hosts** (Windows-origin transcripts with `C:\...` `cwd`
fields resumed cleanly on Linux, at 2 KB and at 23 MB with 1294 tool-use blocks
and 542 absolute Windows paths in their tool results). The resume **appends in
place** and
**preserves the sessionId**, and OTLP telemetry books under that same preserved
sessionId. The suspected failure point (Windows `cwd` fields) is not a failure
point.

- Environment: Claude Code `2.1.232`, Linux (WSL2), rhizomorph server live on
  `127.0.0.1:4321`, server session `1786665720450`.
- Every claim below is [Ran] — command and raw output are reproduced verbatim.
- Child `claude` invocations were run with the parent session's harness vars
  (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_MESSAGING_*`,
  `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_ENTRYPOINT`) unset via `env -u`, so
  each was a genuinely fresh CLI process rather than a nested child.

---

## Q1 — same-host migrate + resume

**Verdict: GO — the marker came back.**

Setup, and the source session in `~/spike-resume-a`:

```console
$ mkdir -p ~/spike-resume-a ~/spike-resume-b
$ ls -d ~/.claude/projects/-home-operator-spike-resume-a ~/.claude/projects/-home-operator-spike-resume-b
ls: cannot access '/home/operator/.claude/projects/-home-operator-spike-resume-a': No such file or directory
ls: cannot access '/home/operator/.claude/projects/-home-operator-spike-resume-b': No such file or directory
```

Both slug dirs were absent beforehand — nothing pre-existing was at risk.

```console
$ cd ~/spike-resume-a
$ claude -p "Remember this marker phrase and repeat it when asked: XYZZY-5943"
XYZZY-5943 — got it, I'll repeat it whenever you ask.
=== EXIT=0 ===
```

The transcript it created:

```console
$ ls -la ~/.claude/projects/-home-operator-spike-resume-a/
total 60
drwxr-xr-x   3 operator operator  4096 Aug 14 13:06 .
drwxr-xr-x 263 operator operator 28672 Aug 14 13:06 ..
-rw-------   1 operator operator 19713 Aug 14 13:06 edf0eb2b-9c37-4d15-8f06-99e9306cdac6.jsonl
drwxr-xr-x   2 operator operator  4096 Aug 14 13:06 memory
```

Copied into `b`'s slug dir (guarded against clobbering a pre-existing target):

```console
$ mkdir -p ~/.claude/projects/-home-operator-spike-resume-b
$ if [ -e "$DST" ]; then echo "STOP: target exists: $DST"; exit 1; fi
$ cp ~/.claude/projects/-home-operator-spike-resume-a/edf0eb2b-9c37-4d15-8f06-99e9306cdac6.jsonl \
     ~/.claude/projects/-home-operator-spike-resume-b/edf0eb2b-9c37-4d15-8f06-99e9306cdac6.jsonl

$ grep -o '"cwd":"[^"]*"' "$DST" | sort -u
"cwd":"/home/operator/spike-resume-a"
```

Note the copy's `cwd` fields still point at `spike-resume-a` — stale relative to
where it is about to be resumed. That does not matter:

```console
$ cd ~/spike-resume-b
$ claude --resume edf0eb2b-9c37-4d15-8f06-99e9306cdac6 -p "what was the marker phrase?"
XYZZY-5943
=== EXIT=0 ===
```

### Control: is the slug directory actually load-bearing?

`--resume <id>` could plausibly search all of `~/.claude/projects/`, in which
case the copy would have been irrelevant and Q1 would prove nothing. It does
not. From a third cwd with no copy present — while the id existed in *both*
`a`'s and `b`'s slug dirs:

```console
$ mkdir -p ~/spike-resume-c && cd ~/spike-resume-c
$ claude --resume edf0eb2b-9c37-4d15-8f06-99e9306cdac6 -p "what was the marker phrase?"
No conversation found with session ID: edf0eb2b-9c37-4d15-8f06-99e9306cdac6
=== EXIT=1 ===
$ ls -d ~/.claude/projects/-home-operator-spike-resume-c
ls: cannot access '...-spike-resume-c': No such file or directory
```

**Resume lookup is strictly scoped to the slug directory of the current working
directory.** The copy is what made Q1 work, and placing the file is the entire
migration mechanism. A failed lookup creates no slug dir.

---

## Q2 — cross-host (Windows transcript on Linux)

**Verdict: GO — Windows-origin transcripts resume on Linux, small (2 KB) and
large (23 MB) alike. The `C:\...` `cwd` fields are not a failure point, and
neither are absolute Windows paths inside tool results.**

Candidate selection from
`/mnt/c/Users/operator/.claude/projects/C--Users-operator-agenticlaunchpad/`:

```console
$ ls -lS .../C--Users-operator-agenticlaunchpad/*.jsonl | tail -3
-rwxrwxrwx 1 operator operator 2090 2026-07-30 .../200fb100-b3e2-4828-a3a6-01333a255127.jsonl
-rwxrwxrwx 1 operator operator 1971 2026-07-30 .../01441073-3a1d-4dfb-89dc-a1692eaf9cad.jsonl
-rwxrwxrwx 1 operator operator  278 2026-08-11 .../a3a4ee6a-40bf-4b8c-9901-03b60831e0e2.jsonl
```

The brief said to take the smallest. The literal smallest (`a3a4ee6a`, 278 B,
dated 2026-08-11 rather than 08-14) turned out to be **degenerate** — metadata
only, zero conversation turns:

```console
$ cat .../a3a4ee6a-40bf-4b8c-9901-03b60831e0e2.jsonl
{"type":"ai-title","aiTitle":"Review rhizomorph repo and check admin privileges ⑂","sessionId":"a3a4ee6a-..."}
{"type":"agent-name","agentName":"Review rhizomorph repo and check admin privileges ⑂","sessionId":"a3a4ee6a-..."}
```

Resuming that would have conflated "cross-host failed" with "there was no
conversation to resume", so **both** were tested: the literal smallest, and the
smallest with real turns (`200fb100`, 2090 B — the one-turn `BARE-TEST-OK`
session, `cwd` = `C:\Users\operator\agenticlaunchpad`).

Both copied into `b`'s slug dir; neither target pre-existed.

```console
$ cd ~/spike-resume-b
$ claude --resume 200fb100-b3e2-4828-a3a6-01333a255127 -p "summarize our conversation in one line"
BARE-TEST-OK
=== EXIT=0 ===

$ claude --resume a3a4ee6a-40bf-4b8c-9901-03b60831e0e2 -p "summarize our conversation in one line"
No conversation found with session ID: a3a4ee6a-40bf-4b8c-9901-03b60831e0e2
=== EXIT=1 ===
```

The `200fb100` reply reproduces content that exists only in the Windows-authored
turns, so prior context was genuinely loaded. The `a3a4ee6a` failure is a
**content** failure (a transcript with no conversation turns is not resumable),
not a cross-host one — the same message the Q1 control produced.

After the resume, Windows history and Linux continuation coexist in one file
under one sessionId:

```console
$ python3 - <<'PY'   # type | cwd | content
queue-operation | None                          | None
queue-operation | None                          | None
user            | C:\Users\operator\agenticlaunchpad | Respond with exactly: BARE-TEST-OK
assistant       | C:\Users\operator\agenticlaunchpad | [{'type': 'text', 'text': 'Invalid API key · Fix external API key'}]
last-prompt     | None                          | None
queue-operation | None                          | None
queue-operation | None                          | None
user            | /home/operator/spike-resume-b  | summarize our conversation in one line
attachment      | /home/operator/spike-resume-b  | None
attachment      | /home/operator/spike-resume-b  | None
attachment      | /home/operator/spike-resume-b  | None
assistant       | /home/operator/spike-resume-b  | [{'type': 'text', 'text': 'BARE-TEST-OK'}]
last-prompt     | None                          | None
mode            | None                          | None
PY

$ grep -o '"cwd":"[^"]*"' .../200fb100-....jsonl | sort | uniq -c
      5 "cwd":"/home/operator/spike-resume-b"
      2 "cwd":"C:\\Users\\operator\\agenticlaunchpad"
$ grep -o '"sessionId":"[^"]*"' .../200fb100-....jsonl | sort | uniq -c
     14 "sessionId":"200fb100-b3e2-4828-a3a6-01333a255127"
```

**Historical `cwd` values are never rewritten**, new lines carry the live `cwd`,
and the CLI does not care that the two disagree or that one is a Windows path.
No path rewriting is required by a migration.

The Windows source was read-only throughout — mtime and size unchanged:

```console
$ ls -l --time-style=full-iso .../200fb100-b3e2-4828-a3a6-01333a255127.jsonl
-rwxrwxrwx 1 operator operator 2090 2026-07-30 10:15:38.672816800 +1200 .../200fb100-....jsonl
```

### Q2b — a large transcript with Windows paths in tool results

The first pass of this note flagged its own biggest gap: the tested transcripts
were tiny, and the likeliest place for a latent problem was a **large** one
carrying absolute Windows paths inside tool *results* — paths that do not exist
on the target host. That gap is now closed by a run.

Specimen: the largest transcript in the Windows project dir, 23 MB / 6133 lines,
authored entirely on Windows.

```console
$ ls -lS .../C--Users-operator-agenticlaunchpad/*.jsonl | head -1
-rwxrwxrwx 1 operator operator 23818029 2026-08-03 11:06:22 .../b1bc51ab-0d2a-4d53-bc3a-b92b9de4ef10.jsonl

$ wc -l < .../b1bc51ab-....jsonl
6133
$ grep -o '"cwd":"[^"]*"' .../b1bc51ab-....jsonl | sort | uniq -c
   3922 "cwd":"C:\\Users\\operator\\agenticlaunchpad"
$ grep -c '"tool_use"' .../b1bc51ab-....jsonl ; grep -c '"tool_result"' .../b1bc51ab-....jsonl
1294
684
```

It contains the hazard in quantity — **233** Windows paths inside `tool_result`
content and **309** inside the top-level `toolUseResult` records, including
`filePath` values naming files that are absent on this Linux host:

```console
$ python3 ...   # Windows paths inside tool_result CONTENT: 233
    C:\Users\operator\nextjs-project
    C:\Users\operator\.claude\skills\swarm-conduct\scripts\board.sh
    C:\Users\operator\.claude\skills\swarm-conduct\SKILL.md
    C:\Users\operator\AppData\Local\Temp\claude\C--Users-operator-agenticlaunchpad\

                # Windows paths inside toolUseResult: 309
    C:\Users\operator\agenticlaunchpad\AGENTS.md
    C:\Users\operator\agenticlaunchpad\learner-context.md
    C:\Users\operator\agenticlaunchpad\JOURNAL.md
```

Copied by the same guarded method as above (target checked for existence
first), then resumed:

```console
$ cd ~/spike-resume-b
$ claude --resume b1bc51ab-0d2a-4d53-bc3a-b92b9de4ef10 -p "In one line: what was this session about?"
Conducting a swarm of coding agents to take the Observatory from a half-landed prd3 through five more prds — palette, camera, cord-cut, procedural form, beautification — and out the other side as `rhizomorph`, a publishable open-source package awaiting only your npm token and a tag.
=== EXIT=0 ===
```

**GO.** The answer reconstructs specifics that exist only deep inside the
migrated history (prd3's half-landed state, the five follow-on prds by name, the
rename to `rhizomorph`), so the full transcript was genuinely loaded, not just
its tail. No error, no warning about the dead paths, no size complaint.

Same append-in-place, same preserved identity as the small cases:

```console
$ stat -c '%s' .../-home-operator-spike-resume-b/b1bc51ab-....jsonl
23828389                                    # source was 23818029 — appended in place
$ grep -o '"sessionId":"[^"]*"' .../b1bc51ab-....jsonl | sort -u
"sessionId":"b1bc51ab-0d2a-4d53-bc3a-b92b9de4ef10"
$ grep -o '"cwd":"[^"]*"' .../b1bc51ab-....jsonl | sort | uniq -c
      9 "cwd":"/home/operator/spike-resume-b"
   3922 "cwd":"C:\\Users\\operator\\agenticlaunchpad"
```

The 23 MB source was not modified — byte-identical after the run:

```console
$ sha256sum .../C--Users-operator-agenticlaunchpad/b1bc51ab-....jsonl | cut -c1-16
2ca56cdbf42c4e46                            # unchanged
$ stat -c '%s %y' .../b1bc51ab-....jsonl
23818029 2026-08-03 11:06:22.802849700 +1200
```

**One new behaviour, and it is a graceful one.** The appended lines include a
replayed notification for a background task left in flight on the origin host:

```
<task-notification>
<task-id>bsb67osa5</task-id>
<tool-use-id>toolu_01BdsQZojC8i4u7j1arsxpnU</tool-use-id>
<status>stopped</status>
<summary>No completion record was found for this background shell command from the previous session. It may have been stopped (via the UI, Monitor timeout, or agent teardown — these leave no transcript marker), or it may have been running when the previous Claude Code process exited. Check the output file for partial results before assuming it completed.</summary>
</task-notification>
```

In-flight background task state does **not** migrate, but the CLI reconciles it
explicitly and marks it `stopped` rather than hanging or erroring. A migration
should expect this line and treat it as informational. Note the task's output
file, which the summary tells the reader to check, lives on the *origin* host.

---

## Q3 — identity: append or fork?

**Verdict: APPEND in place, same sessionId. No fork, and the source file is not
touched.**

```console
$ # b BEFORE the Q1 resume
-rw------- 1 operator operator 19713 2026-08-14 13:06:53 edf0eb2b-....jsonl

$ # b AFTER the Q1 resume
-rw------- 1 operator operator 22121 2026-08-14 13:07:06 edf0eb2b-....jsonl
drwxr-xr-x 2 operator operator  4096 2026-08-14 13:07:04 memory

$ # a, same moment — untouched, original size and mtime
-rw------- 1 operator operator 19713 2026-08-14 13:06:39 edf0eb2b-....jsonl
```

The copied file grew (19713 → 22121); no new session file appeared; `a`'s
original neither grew nor changed mtime. A second resume turn (the Q4 run) grew
the same file again to 24382 B, confirming it.

Every line in the file — original and appended — carries one id:

```console
$ grep -o '"sessionId":"[^"]*"' .../-home-operator-spike-resume-b/edf0eb2b-....jsonl | sort | uniq -c
     15 "sessionId":"edf0eb2b-9c37-4d15-8f06-99e9306cdac6"

$ # appended lines: type | sessionId | cwd
user      | edf0eb2b-9c37-4d15-8f06-99e9306cdac6 | /home/operator/spike-resume-b | what was the marker phrase?
assistant | edf0eb2b-9c37-4d15-8f06-99e9306cdac6 | /home/operator/spike-resume-b | [{'type': 'text', 'text': 'XYZZY-5943'}]
```

A fresh turn after migration carries the **original** sessionId. Migration
preserves session identity; it does not mint a new one.

A side effect worth recording: resuming creates an empty `memory/` subdirectory
in the slug dir if one is absent.

---

## Q4 — telemetry wiring

**Verdict: GO — the otel count rises, and telemetry books under the *preserved*
sessionId from Q3.**

Baseline:

```console
$ curl -s 127.0.0.1:4321/api/meta | python3 -c "import json,sys; m=json.load(sys.stdin); print(m['connection']['otel'])"
{'source': 'otel', 'firstEventTs': 1786666137439, 'lastEventTs': 1786666139100, 'count': 6}
```

Env block (read-only use of the operator's checkout; no git commands were run
there):

```console
$ cd ~/rhizomorph && node packages/server/bin/rhizomorph.mjs env spike-resume --role worker --port 4321
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_LOGS_EXPORTER=otlp
export OTEL_TRACES_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4321
export OTEL_METRIC_EXPORT_INTERVAL=5000
export OTEL_LOGS_EXPORT_INTERVAL=2000
export OTEL_TRACES_EXPORT_INTERVAL=1000
export OTEL_RESOURCE_ATTRIBUTES=lane=spike-resume,role=worker,instance=1786665720450
```

Q1's resume repeated with that env exported:

```console
$ eval "$(cd ~/rhizomorph && node packages/server/bin/rhizomorph.mjs env spike-resume --role worker --port 4321)"
$ cd ~/spike-resume-b
$ claude --resume edf0eb2b-9c37-4d15-8f06-99e9306cdac6 -p "repeat the marker phrase once more"
XYZZY-5943
=== EXIT=0 ===
```

After:

```console
$ curl -s 127.0.0.1:4321/api/meta | ... ['connection']['otel']
{
  "source": "otel",
  "firstEventTs": 1786666137439,
  "lastEventTs": 1786669778656,
  "count": 14
}
```

**Count 6 → 14, `lastEventTs` advanced.** The migrated, resumed session is fully
instrumented.

Which sessionId does it book under? The events themselves:

```console
$ curl -s 127.0.0.1:4321/api/sessions/1786665720450/events   # 968 events, 8 matching spike-resume
{
  "id": "otel-000017",
  "ts": 1786669778655,
  "source": "otel",
  "type": "llm.cost",
  "payload": {
    "lane": "spike-resume",
    "sessionId": "edf0eb2b-9c37-4d15-8f06-99e9306cdac6",
    "worktreePath": null,
    "branch": null,
    "thread": "main",
    "role": "worker",
    "model": "claude-opus-5",
    "costUsd": 0.012960999999999999,
    "authoritative": true
  }
}
```

Also booked: four `llm.usage` events (input 2, output 10, cacheRead 24942,
cacheCreation 23) and one `agent.activeTime` (2.088 s), all carrying the same
`lane` and `sessionId`.

**The telemetry sessionId is exactly Q3's answer** —
`edf0eb2b-9c37-4d15-8f06-99e9306cdac6`, the id the transcript had before it was
moved. The migrated session keeps one identity end to end: transcript filename,
in-file `sessionId`, and telemetry attribution all agree.

Two distinct identities are in play here and should not be confused
(`packages/server/src/api/otel.ts:8-27` documents this):

- `instance=1786665720450` in `OTEL_RESOURCE_ATTRIBUTES` is the **rhizomorph
  server session id** (`recorder.sessionId`), used only as the receiver's
  admission check — one repo, one Rhizomorph.
- `payload.sessionId` is the **Claude CLI's own** session id, emitted by the CLI
  and preserved across migration.

Lane attribution comes entirely from the `lane=` resource attribute supplied at
launch, so a migrated transcript can be re-attached to any lane by launching it
with the appropriate env block. Resume does not disturb telemetry identity.

---

## Files created under `~/.claude`

Create-only was honoured: nothing pre-existing was overwritten, modified, or
deleted. Every copy target was checked for existence first and both slug dirs
were confirmed absent before the spike began.

```
d  /home/operator/.claude/projects/-home-operator-spike-resume-a/
f  /home/operator/.claude/projects/-home-operator-spike-resume-a/edf0eb2b-9c37-4d15-8f06-99e9306cdac6.jsonl   (19713 B, written by the CLI)
d  /home/operator/.claude/projects/-home-operator-spike-resume-a/memory/                                       (empty, CLI side effect)
d  /home/operator/.claude/projects/-home-operator-spike-resume-b/
f  /home/operator/.claude/projects/-home-operator-spike-resume-b/edf0eb2b-9c37-4d15-8f06-99e9306cdac6.jsonl   (24382 B — Q1 copy + 2 appended turns)
f  /home/operator/.claude/projects/-home-operator-spike-resume-b/200fb100-b3e2-4828-a3a6-01333a255127.jsonl   (21682 B — Q2 Windows copy + 1 appended turn)
f  /home/operator/.claude/projects/-home-operator-spike-resume-b/a3a4ee6a-40bf-4b8c-9901-03b60831e0e2.jsonl   (  278 B — Q2 Windows copy, never resumed)
f  /home/operator/.claude/projects/-home-operator-spike-resume-b/b1bc51ab-0d2a-4d53-bc3a-b92b9de4ef10.jsonl   (23828389 B — Q2b large Windows copy + 1 appended turn)
d  /home/operator/.claude/projects/-home-operator-spike-resume-b/memory/                                       (empty, CLI side effect)
```

Note the last entry is 23 MB. If disk matters, it is the one to delete — it is a
copy, and its source is intact.

No slug dir was created for `~/spike-resume-c` — a failed resume lookup creates
nothing.

Source files read but never written, under
`/mnt/c/Users/operator/.claude/projects/C--Users-operator-agenticlaunchpad/`:
`200fb100-...`, `a3a4ee6a-...`, and `b1bc51ab-...` — all verified unchanged in
size and mtime after the runs, the last also by sha256.

## Cleanup

`~/spike-resume-a`, `~/spike-resume-b` and `~/spike-resume-c` were removed at
the end of the spike. (`~/spike-resume-b` was recreated for the Q2b run and
removed again afterwards; its slug dir under `~/.claude/projects/` persisted
throughout and is what the resume actually reads.) The copied transcripts under
`~/.claude/projects/` were left in place, as listed above.

## What this means for the migration design

1. The mechanism is **file placement**: put `<id>.jsonl` in
   `~/.claude/projects/<cwd-with-slashes-as-dashes>/` and `claude --resume <id>`
   from that cwd picks it up. Lookup is slug-scoped, not global.
2. **No transformation is needed**, and this is now tested at scale. Windows
   `cwd` values, mixed `cwd` values within one file, and absolute Windows paths
   embedded in tool results (including paths to files absent on the target host)
   are all tolerated. Do not rewrite paths — a rewriting pass would be work
   spent to fix a problem that does not exist, and would corrupt history.
3. **Identity survives**: the sessionId is preserved in the file and in
   telemetry. Resume appends; it never forks and never touches the source, so a
   migration can be a plain copy and the origin stays a valid rollback.
4. **The one real precondition** is that the transcript contains actual
   conversation turns. A metadata-only stub is rejected with
   `No conversation found with session ID: <id>` — the same error as a missing
   file, so callers cannot distinguish the two from the exit status alone.
   Validate before migrating rather than relying on the resume's error text.
5. Telemetry re-attachment is orthogonal to migration and controlled entirely by
   the launch env block, so a migrated session can be moved between lanes.
6. **In-flight background tasks do not migrate.** The CLI reconciles them on
   resume and marks them `stopped` with an explanatory notification, so this
   degrades gracefully — but any output file the notification points at stays on
   the origin host. Migrate quiesced sessions, or accept the loss knowingly.

## Caveats and limits of this evidence

- "Cross-host" here means a Windows-authored transcript resumed on Linux via a
  WSL2 mount, on one machine with one `~/.claude` config and one credential set.
  A genuinely different machine (different auth, different CLI version) was not
  tested.
- ~~Both transcripts tested were tiny (2–15 lines)...~~ **Closed** by Q2b: a
  23 MB / 6133-line Windows transcript, with 1294 tool-use blocks and 542
  absolute Windows paths across its tool results (many naming files absent on
  this host), resumed cleanly with full context. Size and dead paths in tool
  results are no longer open questions. What remains untested at scale is a
  transcript larger than ~24 MB, and one whose tool results carry Windows paths
  the *resumed* agent is then asked to act on — Q2b only asked it to summarize.
- CLI version `2.1.232`. This behaviour is undocumented and unversioned; per
  `CHANGELOG.md`'s semver policy the session-log format is explicitly free to
  change release to release. Treat this verdict as valid for a pinned CLI, and
  re-run this spike on upgrade.
