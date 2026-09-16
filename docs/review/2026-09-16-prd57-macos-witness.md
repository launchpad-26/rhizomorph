# prd-57 — the macOS process leg, witnessed

**Tree:** `prd57-w2-macos-leg`, stacked on `prd57-w2-process-witness`
**Date:** 2026-09-16
**Ruling:** prd-57 ruling 10 — the process collector does not merge until each platform leg has a capture and a verification pass citing its artifact. This is the macOS pass. It does not speak for Linux or Windows; `docs/review/2026-09-16-prd57-windows-witness.md` is that record.

## Who ran it, on what

| | |
|---|---|
| **Run by** | Claude Opus 5, in session, at the operator's direction |
| **Operator present** | Ciaran — the machine and the captured agent sessions are theirs |
| **Requested by** | Lachlan Kelliher, who set the brief and holds the landing |
| **Machine** | macOS 26.6.2 (build 25G83), **arm64 — Apple silicon**, Mac mini |
| **Node** | 22.22.2, the version `.nvmrc` pins |
| **Harness** | Claude Code 2.1.270, desktop app — **three** live sessions in three different directories at capture time, **four** by the final live run |

Naming the person and the machine is prd-57 ruling 10's own addition to prd-25 ruling 5's cite-the-artifact form. It is kept because Actions has run nothing on this repository since 2026-09-12, so there is no workflow leg to cite in its place. **Nothing here was witnessed on an Intel Mac**, and that is a real gap — see the last section.

## The artifact

Three files under `packages/server/src/collectors/process/fixtures/`, all taken within the same second:

| file | command | what it is |
|---|---|---|
| `macos-ps.txt` | `ps -axww -o pid=,ppid=,lstart=,time=,rss=,comm=` | the spine — every numeric field, plus argv[0] exactly |
| `macos-ps-args.txt` | `ps -axww -o pid=,command=` | argv[1..], and nothing else |
| `macos-lsof-cwd.txt` | `lsof -d cwd -Fpn` | every process's working directory |

Seven rows of 487, and the selection is **stated in each file's header** rather than called a sample: three are the live Claude Code sessions, four are system processes that each break a parser written the obvious way.

**Sanitised before commit**, per `AGENTS.md`: the home directory, the OS username, the machine name, the rhizomorph checkout path and every session UUID were substituted, and each file's header records what was substituted for what *without naming the values it replaced* — writing the real home into the record would be the same disclosure the substitution exists to prevent. The absence is asserted by a test in `read-table-macos.test.ts` rather than trusted to the procedure.

## What the capture found that documentation would not have

Each of these produces a parser that looks right and is wrong. The first is the important one.

1. **`ps -o command=` is argv joined by spaces, and it quotes nothing.** argv[0] of a real Claude Code session on macOS is
   `…/Library/Application Support/Claude/claude-code/<v>/claude.app/Contents/MacOS/claude` — **it contains a space.** Split on whitespace, argv[0] reads as `…/Library/Application`, whose basename is `Application`, which is in no roster.
   The fix is that the spine reads **`comm=`**, the kernel's own executable path, which is argv[0] exactly. Measured on this machine: `command` starts with `comm` for **463 of 463** pids present in both reads.
2. **`lstart` is five whitespace-separated tokens in the *middle* of the row** — `Sun Sep 13 12:41:26 2026`. Splitting from the left mis-reads `time`, `rss` and `comm` into *plausible* values rather than failing. The leg anchors on the date's own shape, which is the same defence `/proc/<pid>/stat`'s unescaped `comm` needs on Linux.
3. **`comm` itself can contain spaces and parentheses.** `Core Audio Driver (MSTeamsAudioDevice.driver)` is a real captured row whose entire command line is that name.
4. **`time=` minutes are not bounded at 60.** The capture carries `404:34.97` — four hundred and four *minutes*. A parser that read a three-digit leading field as hours would report 404 hours of CPU for WindowServer.
5. **`rss=` is kilobytes**, not bytes and not pages.

## The open question, answered: `lsof` and ownership

This is what the brief said nobody in the project could answer, so it is recorded as commands and exit codes rather than as a conclusion.

```
$ lsof -a -p 5001 -d cwd -Fn ; echo "exit=$?"      # a process I own
p5001
fcwd
n/home/operator/Desktop/RetroNZ                      # (the real path, redacted as everywhere else)
exit=0

$ lsof -a -p 1 -d cwd -Fn ; echo "exit=$?"         # root's launchd
exit=1
                                                    # stdout EMPTY, and stderr EMPTY too
```

No `sudo`, no prompt, no diagnostic. **`lsof` answers for every process the reader owns and declines silently for anyone else's.** Four of the seven captured rows are root-owned and are absent from `macos-lsof-cwd.txt` for exactly that reason; across the whole live table, 306 of 474 rows had a readable cwd.

**So macOS behaves like Linux, not like Windows.** An agent process is always the reader's own user — the probe's fourth law — so this leg identifies *and* places. `doctor-row.ts` therefore gives macOS Linux's states (`partial` until an actor is seen, `provided` after) and not the fourth, structural state Windows needed. Had `lsof` come back the other way, macOS would have joined Windows there with a structural reason, and the file would say so instead.

## The defect the live run was for — demonstrated, not argued

The Windows record left this instruction for whoever built macOS: *a capture proves the format; it does not prove the match, because a capture is bytes and matching is behaviour.*

So the leg CAPTURE.md's **first** recipe would have produced was built as well, and run against the same live machine in the same session:

```
parsed 482 rows — the PARSE succeeds, which is the trap
rows whose argv[0] matches /claude/i (the assertion Windows shipped): 17
   argv[0]=/Applications/Claude.app/Contents/Helpers/disclaimer
   argv[0]=/Applications/Claude.app/Contents/MacOS/Claude
   argv[0]=/Applications/Claude.app/Contents/Frameworks/Electron
   …

agents the collector actually MATCHES: 0
```

**Zero of four.** And worse than Windows in a way worth naming: the `/claude/i` assertion that let Windows ship blind does not merely fail to catch this — it returns **17 hits**, none of which is an agent. They are `Claude.app` Electron helpers. On this platform that assertion is green in both directions at once, so a fixture test written to the Windows shape would have been *more* confident while being *equally* wrong.

The real leg was written from the captured bytes before any of this was run, so the live run confirmed a fix rather than finding one. That ordering is luck plus the Windows record, not a reason to drop the second half of the rule — and it is why the naive leg was built and run anyway, so the claim is a measurement instead of a story.

## Verification, the real leg

```
platform : darwin
node     : v22.22.2
repoPath : /repo

tick     : 267ms over 474 rows
tick x5  : median 89ms (min 82, max 94)

agents matched (anywhere on this machine): 4
  pid=5001  dialect=claude started=2026-09-15T00:32:30.000Z cpu=1455820ms rss=106MB parent=null
      cwd=/home/operator/Desktop/RetroNZ
      argv[0]=/home/operator/Library/Application Support/Claude/…/MacOS/claude
  pid=5090  dialect=claude started=2026-09-15T23:35:35.000Z cpu=34860ms   rss=70MB  parent=null
      cwd=/repo
  pid=6132  dialect=claude started=2026-09-15T23:35:59.000Z cpu=42160ms   rss=176MB parent=null
      cwd=/home/operator/Library/Application Support/Claude/scratch-workspaces/<uuid>/…
  pid=86476 dialect=claude started=2026-09-15T23:53:47.000Z cpu=11140ms   rss=186MB parent=null
      cwd=/repo

agents placed inside /repo: 2
  process.seen pid=5090  placement=rooted worktree=/repo
  process.seen pid=86476 placement=rooted worktree=/repo

rows with a readable cwd: 306 of 474
```

Four real agents identified through the collector's own `poll` — not a regex over the capture — with real start times, real CPU, real memory and **a real working directory on every one**. Two of them were running inside the watched repo and reached `process.seen` with `placement: 'rooted'`; the other two were elsewhere on the same machine and were seen and dropped, which is wave 2 watching one repo.

`parent=null` on all four is correct and worth stating, because it looks like a miss. The OS parent of each session is a `Claude.app` helper, which is not itself a matched actor, and the collector records parentage **among actors only** — a shell, an editor or a launcher is a fact about the operator's machine that ADR-0052 does not license recording.

## The measured tick cost

| leg | tick | over | mechanism |
|---|---|---|---|
| Linux / WSL2 | **42 ms** median (37–45, five runs) | 63 processes | `/proc` read directly, no subprocess |
| **macOS (Apple silicon)** | **143 ms** median (123–189, eleven runs) | **453 processes** | three execs, issued together |
| Windows native | **1273 ms** | 216 processes | one `powershell -Command` |

Recorded in `docs/design-notes/collector-tick-budget.md`. The 89 ms median in the run above and the 143 ms in the table are the same leg on the same machine at different moments; the table's figure is the eleven-run one and is the one to quote.

**That note's own prediction was wrong and has been left in place rather than quietly replaced.** It said macOS would "sit nearer the Windows figure than the Linux one" because it spawns. It is nine times cheaper than Windows. Spawning is not what costs; *what* you spawn is.

## What this pass does NOT establish

- **Intel Macs.** Every figure and every byte here is Apple silicon. Nothing about this leg is obviously architecture-dependent — `ps` and `lsof` are the same base-system tools — but it is unwitnessed, and Rosetta's effect on `comm` for a translated process is unmeasured.
- **The interpreter arm, on real bytes.** `matchesAgentCommand` looks past argv[0] when argv[0] is `node`. Neither macOS install shape on this machine does that: the desktop app and the native CLI both put a real executable at argv[0]. So that arm is exercised by a synthetic case in `read-table-macos.test.ts` and by nothing captured. An npm-installed `claude` would be the shape that tests it, and this machine has none.
- **argv[1..] at all, faithfully.** `ps` destroyed the boundaries before this code sees anything: an argument containing a space is indistinguishable from two arguments, and there is no quoting to undo. Only argv[0] is exact. The live example is the `--settings {…}` JSON on every agent row. An agent launched as `node "/path with a space/claude.js"` would be missed — a miss, which leaves an actor unseen rather than inventing one.
- **`ps` answering while `lsof` does not.** Every row would come back with `cwd: null`, every actor would be unplaceable, and `doctor` would still report the leg as reading — which reads as "no agents in this repo" when the truth is "cannot place any agent". It is deliberately not collapsed into `null`, because the table genuinely was read and a `null` there would suppress `gone` for actors that really did exit. How often that happens is unmeasured and no state is invented for it.
- **Any figure on a machine with a different process count.** 453 processes on a busy laptop-class machine is one reading. Whether the leg degrades linearly past that is unmeasured, exactly as it is for Windows.
- **The hook-fire timing and parent-pid reliability** wave 0's open questions ask for. Those need `rhizomorph hook` to exist, which is wave 3.

## Ruling 10's condition, assessed

| leg | capture | verification pass |
|---|---|---|
| Linux / WSL2 | fabricated procfs + live WSL2 run | the Windows record, 2026-09-16 |
| Windows native | `windows-cim.json`, live run | the Windows record, 2026-09-16 |
| macOS | `macos-ps.txt` + two siblings, live run above | **this record** |

Three of three now have both. The operator's condition, as the Windows record quotes it from session on 2026-09-15 — *"Wave 2 does not merge until each platform leg has a capture under a `CAPTURE.md` and a verification pass citing its artifact"* — has a capture and a pass for every leg.

**That is a statement of what exists, not a merge recommendation, and this document does not make one.** The Windows record's first version concluded that its wave could merge and was rewritten for exactly that reason: a verification record arguing its own wave past a hold is the wrong instrument. Whether the condition is met, and whether anything else holds wave 2, is the operator's call. This document's job is to say what was witnessed.
