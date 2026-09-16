# prd-57 — the Windows process leg, witnessed

**Tree:** `prd57-w2-process-witness` at `a35dbf60` and its successors
**Date:** 2026-09-16
**Ruling:** prd-57 ruling 10 — the process collector does not merge until each platform leg has a capture and a verification pass citing its artifact. This is the Windows pass. **macOS is still owed and this record does not speak for it.**

## Who ran it, on what

| | |
|---|---|
| **Run by** | Claude Opus 5, in session, at the operator's direction |
| **Operator present** | Lachlan Kelliher — the machine is his, and the agents captured are his own running sessions |
| **Machine** | Windows 11 Home 10.0.26200, x64, native (not WSL) |
| **Node** | 22.23.1 (portable) |
| **Harness** | Claude Code, three live sessions at capture time |
| **Linux figures below** | the same physical machine's WSL2 Ubuntu, node 22.23.2 |

Naming the person and the machine is prd-57 ruling 10's own addition to prd-25 ruling 5's cite-the-artifact form. It is kept because Actions has run nothing on this repository since 2026-09-12, so there is no workflow leg to cite in its place.

## The artifact

`packages/server/src/collectors/process/fixtures/windows-cim.json` — five rows from `Get-CimInstance Win32_Process`, captured while three real Claude Code sessions were running. Three rows are those agents; two are system processes whose command line this user may not read.

**Sanitised before commit**, per `AGENTS.md`: the username, the machine name and the live session id were substituted, and the substitution is asserted by a test in `read-table-windows.test.ts` rather than trusted to the procedure.

## What the capture found that documentation would not have

Each of these would have produced a parser that looked right and was wrong:

1. **`CreationDate` is `"\/Date(1788956011002)\/"`** — .NET's JSON date form, not ISO 8601. A parser expecting ISO yields `NaN`, and start time is half of an actor's identity.
2. **`CommandLine` is `null`** for a process the caller may not read. Two of five rows. A parser assuming a string throws on the first tick of any real machine.
3. **`CommandLine` is one string, not an argv array.** Unlike `/proc`'s NUL-separated `cmdline`, so it must be split — and the executable path routinely contains spaces.
4. **`Win32_Process` has no working-directory property at all.** This confirms prd-57 ruling 2's claim by inspection of the live class rather than by repeating it: Windows will not give another process's cwd without native calls into the target.

## The defect only the LIVE run found, and it is the important one

With the capture parsed, every fixture test passed. **The first live run against the real process table matched zero of three agents.**

`AGENT_COMMANDS` holds `claude`. A Windows basename is `claude.exe`. The fixture tests asserted the **parse** — that `argv[0]` matched `/claude/i` — and never the **match**, so they were green while the leg was blind.

The probe half-anticipated this and the asymmetry is worth recording: `process-probe.ts`'s `AGENT_INTERPRETERS` already carries `node.exe` beside `node`, while its `AGENT_COMMANDS` carries no `.exe` variant. Windows was handled for the interpreter arm and not for the agent arm.

Fixed in the collector, not the probe: `process-probe.ts` carries no edit in this PRD (Success 3), and an executable suffix is a property of the platform rather than of the roster — a second list containing `claude.exe` would have to be kept in step with the first forever.

**The lesson for macOS, stated before that leg is written:** a capture proves the format; it does not prove the match, because a capture is bytes and matching is behaviour. The macOS pass owes a live run as well as a capture, and its fixture tests should assert `dialectOf` and not a regex over `argv[0]`.

## Verification, after the fix

```
tick: 1273ms over 216 identifiable rows
agents matched: 3
  pid=<a> dialect=claude started=2026-09-09T12:13:31.002Z cpu=18667750ms rss=711MB cwd=null parent=<p>
  pid=<b> dialect=claude started=2026-09-11T02:51:14.344Z cpu=7669125ms  rss=875MB cwd=null parent=<p>
  pid=<c> dialect=claude started=2026-09-14T09:35:28.695Z cpu=2410688ms  rss=427MB cwd=null parent=<p>
```

Three real agents identified, with real start times, real CPU and real memory. **`cwd=null` on every row** — the declared gap, observed rather than assumed.

## The measured tick cost

| leg | tick | over | mechanism |
|---|---|---|---|
| Linux / WSL2 | **42 ms** median (37–45, five runs) | 63 processes | `/proc` read directly, no subprocess |
| Windows native | **1273 ms** | 216 processes | one `powershell -Command` through ADR-0004's `Exec` |

Recorded in `docs/design-notes/collector-tick-budget.md`. The Windows leg spends about a quarter of `COLLECTOR_EXEC_TIMEOUT_MS` on every tick and is the largest single exec this instrument performs; nearly all of it is PowerShell's start-up rather than the query.

## What this pass does NOT establish

- **macOS.** No capture, no leg, no measurement. `doctor` reports it absent with the capture command as its remedy, and that is the whole of what is known.
- **That Windows emits events.** It does not, and that is correct for wave 2. The leg identifies agents and cannot place them; a lane is a place, so an actor with no placement reaches no lane. Placement on Windows arrives with prd-57 ruling 3's transcript and hook join, in wave 3. `doctor` reports `partial` with that reason rather than `provided` or `absent` — the fourth state, which the beacon organ's row never needed.
- **Any figure on a busier machine.** Both tick numbers are single-machine readings with their process counts stated beside them. Whether the Windows leg degrades linearly past 216 processes is unmeasured.
- **The hook-fire timing and parent-pid reliability** that wave 0's open questions ask for. Those need `rhizomorph hook` to exist, which is wave 3.

## Ruling 10's condition, assessed

| leg | capture | verification pass |
|---|---|---|
| Linux / WSL2 | fabricated procfs + live WSL2 run | this record |
| Windows native | `windows-cim.json`, live run above | this record |
| macOS | **none** | **none** |

**Two of three. This wave does not merge on this record.** The operator set the
condition in session on 2026-09-15, in these words: *"Wave 2 does not merge until
each platform leg has a capture under a `CAPTURE.md` and a verification pass
citing its artifact."* macOS has neither, so the wave stays held on macOS alone —
every other condition it was held for is now met.

Nothing here should be read as arguing the wave past that. Ruling 10 can be read
as permitting a witnessed-where-built landing with the unbuilt platform declaring
itself, and the leg does declare itself; but which reading governs is the
operator's call and not this record's, and the condition as actually stated is
the stricter one. This document's job is to say what was witnessed.
