# Capturing a process table

**Windows: captured 2026-09-16 — `windows-cim.json`.**
**macOS: captured 2026-09-16 — `macos-ps.txt`, `macos-ps-args.txt`, `macos-lsof-cwd.txt`.**

prd-57 ruling 2 says a platform leg lands *behind* a real capture and never from
a man page. This file is both the recipe and the record of what each capture
taught, because in the Windows case that turned out to be the whole argument for
the rule.

`AGENTS.md` makes a capture the main source of a personal path reaching a
tracked file, so **sanitising is a step in this recipe and not an afterthought**
— see the last section, and read it before you run anything.

## What a capture is for

The Linux leg is built and tested against a fabricated `procRoot`
(`read-table.test.ts`), which is enough because `/proc` is a documented,
stable, plain-text interface and this repo runs on it daily.

macOS and Windows are different in kind. Neither has `/proc`; both need a
subprocess whose output format nobody in this repo has seen. A leg written from
documentation would be testing our reading of the documentation. So: capture
the real bytes, commit them, and write the parser against the file.

## What to capture, per platform

### macOS

```sh
# the SPINE: every numeric field, plus argv[0] exactly
ps -axww -o pid=,ppid=,lstart=,time=,rss=,comm=  > macos-ps.txt

# argv[1..], and nothing else
ps -axww -o pid=,command=                        > macos-ps-args.txt

# every process's working directory, in one call
lsof -d cwd -Fpn                                 > macos-lsof-cwd.txt
```

Run all three **while at least two real Claude Code sessions are running in
different directories**, and note their pids in the header block below. `lsof`
is the only way macOS exposes another process's cwd — it wraps libproc, which
has no shell equivalent — so a capture without it cannot answer the placement
half.

**The recipe above is corrected, and the correction IS the macOS finding.** Its
first draft read `-o …,command=` in one call and `lsof -a -p <pid> -d cwd -Fn`
per process. Both were wrong, and neither is the kind of wrong a parse failure
would have shown:

- **`command=` cannot be the spine.** `ps` joins argv with spaces and quotes
  nothing, and argv[0] of a real Claude Code session on macOS *contains a
  space* — `…/Library/Application Support/Claude/…/claude`. Split on
  whitespace, argv[0] reads as `…/Library/Application`, basename `Application`,
  which is in no roster. `comm=` is the kernel's own executable path and is
  argv[0] exactly, so the spine reads that and `command=` supplies only
  argv[1..]. Measured on the capture machine: `command` starts with `comm` for
  463 of the 463 pids present in both reads.
- **`lsof` per pid cannot be a tick.** The leg needs a cwd for every row it
  returns; the per-pid form would be one exec per process, 487 of them on the
  capture machine. One `lsof -d cwd -Fpn` answers for all of them in ~280 ms.
  `-Fn` and `-Fpn` are byte-identical here; `p` is declared rather than relied
  on as lsof's incidental default.
- **`-ww`** because `ps` truncates to the terminal width when stdout is a tty
  and does not when it is a pipe. Without it the leg and a human running the
  same command by hand see different bytes.

### What the macOS capture taught, and none of it is in the documentation

Same shape as the Windows list below — each of these produces a parser that
looks right and is wrong:

1. **`ps -o command=` is argv joined by spaces, and it does not quote.** The
   defect above, and the macOS twin of Windows' `.exe` basename. It is worse
   than the Windows one in a specific way: Windows quotes, so a quoted-run
   splitter recovers argv[0]; `ps` gives you nothing to un-quote, and **no
   parser can recover argv[1..] faithfully** — an argument containing a space
   is indistinguishable from two arguments. Only argv[0] is exact, and only
   from `comm`.
2. **`lstart` is FIVE whitespace-separated tokens in the MIDDLE of the row** —
   `Sun Sep 13 12:41:26 2026`. Splitting the line from the left mis-reads
   `time`, `rss` and `comm`, and mis-reads them into plausible values rather
   than failing. The leg anchors on the date's own shape, which is the same
   defence `/proc/<pid>/stat`'s unescaped `comm` needs on Linux.
3. **`comm` itself can contain spaces and parentheses.** `Core Audio Driver
   (MSTeamsAudioDevice.driver)` is a real captured row whose entire command
   line is that name.
4. **`time=` minutes are not bounded at 60.** The capture carries `404:34.97` —
   four hundred and four MINUTES. A parser that read a three-digit leading
   field as hours would report 404 hours of CPU for WindowServer.
5. **`rss=` is kilobytes**, not bytes and not pages.
6. **`lsof` answers for a process you OWN and declines silently for one you do
   not.** Exit 1, empty stdout, *empty stderr* — no sudo prompt and no
   diagnostic. This was the open question nobody in the project could answer,
   and it is why macOS gets Linux's `doctor` states rather than Windows'
   structural gap: an agent is always the reader's own user. Four of the seven
   captured rows are root-owned and absent from `macos-lsof-cwd.txt` for
   exactly that reason.

**What the macOS capture did NOT cover, stated rather than left to assume:**
neither macOS install shape on the capture machine puts an interpreter at
argv[0]. The desktop app and the native CLI both give a real executable whose
basename is `claude`, so `matchesAgentCommand`'s interpreter arm
(`node /path/to/claude`) is exercised by a synthetic case in
`read-table-macos.test.ts` and by nothing real.

### Windows (native)

```powershell
Get-CimInstance Win32_Process |
  Select-Object ProcessId, ParentProcessId, CreationDate, CommandLine, `
                WorkingSetSize, UserModeTime, KernelModeTime |
  ConvertTo-Json -Depth 3 > windows-cim.json
```

**The recipe above is corrected.** Its first draft omitted `UserModeTime` and
`KernelModeTime`, and the leg cannot report CPU without them — found by running
it, which is the point.

### What the Windows capture taught, and none of it is in the documentation

Recorded here because each one would have produced a plausible, broken parser:

1. **`CreationDate` serialises as `"\/Date(1788956011002)\/"`** — .NET's own
   JSON date form, not ISO 8601. The number is epoch milliseconds. A parser
   written against the documentation produces `NaN`, and that value is half of
   an actor's identity.
2. **`CommandLine` is `null` for a process this user may not read.** Two of the
   five captured rows are system processes with no command line at all. A parser
   assuming a string throws on the first tick of any real machine.
3. **`CommandLine` is one STRING, not an argv array** — unlike `/proc`'s
   NUL-separated `cmdline` — so it has to be split, and the executable path
   routinely contains spaces.
4. **The basename carries `.exe`.** This one was not caught by the capture: the
   fixture tests passed while the leg matched **zero** of three real agents,
   because they asserted the PARSE and not the MATCH. `AGENT_COMMANDS` holds
   `claude`; a Windows basename is `claude.exe`. Only running the leg against a
   live table found it.

**So the rule needs a second half.** A capture proves the format. It does not
prove the match, because a capture is bytes and matching is behaviour. Run the
leg against the live machine as well, and record what it found — which for
Windows is in `docs/review/2026-09-16-prd57-windows-witness.md` and for macOS
in `docs/review/2026-09-16-prd57-macos-witness.md`.

**macOS measured the cost of ignoring that second half, on purpose.** The leg
that CAPTURE.md's first recipe would have produced was built and run against
the live machine beside the real one: it parsed 482 rows, 17 of them had an
`argv[0]` matching `/claude/i` — the exact assertion the Windows fixture tests
shipped, and it was *green* — and the collector matched **zero** of the four
running agents. The 17 were `Claude.app` Electron helpers, which are not agents
at all. A regex over `argv[0]` is not merely weaker than asserting the match;
on this platform it is green in both directions at once.

**`Win32_Process` does not expose a working directory**, which the capture
confirmed by inspection of the live class rather than by repeating the claim.
That is not an oversight in the recipe above: Windows does not publish another
process's cwd without native calls into the target. So the Windows leg matches
argv and declares placement a capability it lacks, and the capture was still
worth taking — the shapes of `CreationDate` and `CommandLine` are three of the
four findings above, and none of them is in the documentation.

### Both: one hook fire, timed

prd-57 ruling 6 invokes `rhizomorph hook` from the harness's own hook entries,
and wave 0 has two open questions only a capture can answer:

```sh
# from inside a real session, with the hook configured
/usr/bin/time -f '%e' rhizomorph hook < one-captured-hook-payload.json
```

Record **the elapsed time** (the runner's cold start against the harness's hook
timeout is unmeasured on every platform) and **the parent pid the runner
observed** versus the agent's actual pid — ruling 3's declared join assumes they
match, and whether they do differs by harness and OS. If they do not match on a
platform, that platform's join is inferred and says so.

## Sanitising, before the commit and not after

A capture emits your home directory, your username and your machine name by
construction. `no-personal-paths-law.test.ts` refuses all three in a tracked
file, and `AGENTS.md` records two ways this has gone wrong before:

- **A path and its encoding are one edit.** If a fixture carries both a path and
  a slug derived from it, changing one leaves a test that passes while no longer
  testing the encoding. Re-derive the second rather than retyping it.
- **Substitute after the capture and before the commit**, move the test's
  expected values in the same edit, and re-run the suite to prove the fixture
  still exercises what it claims. A capture whose test still expects the old
  bytes has stopped being evidence.

Use the conventions the sibling fixture sets already use: `/repo`,
`/repo-wt/<lane>`, `/home/operator`, `HOST-REDACTED`. Those exist so this
directory can ban `/home/` outright rather than keep an allowlist of approved
home directories.

## The header every capture file carries

```
# captured: <YYYY-MM-DD> by <name>
# machine:  <os> <version>, <arch>
# harness:  <e.g. Claude Code 2.1.222>, session pid <n>
# command:  <the exact command from this file>
# sanitised: <what was substituted for what>
```

Who ran it and on what is not ceremony here. prd-57 ruling 10 will not let the
process collector reach `main` until each leg has a verification pass citing its
artifact, and with GitHub Actions retired there is no workflow leg to cite — so
the artifact and its header ARE the evidence.
