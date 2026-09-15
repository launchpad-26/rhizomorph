# Capturing a process table

**Windows: captured 2026-09-16 — `windows-cim.json`. macOS: still owed.**

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
# argv for every process this user can see
ps -axo pid=,ppid=,lstart=,time=,rss=,command= > macos-ps.txt

# the working directory of ONE known agent process, by pid
lsof -a -p <pid> -d cwd -Fn > macos-lsof-cwd.txt
```

Run both **while a real Claude Code session is running**, and note its pid in
the header block below. `lsof` is the only way macOS exposes another process's
cwd — it wraps libproc, which has no shell equivalent — so a capture without it
cannot answer the placement half.

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
Windows is in `docs/review/2026-09-16-prd57-windows-witness.md`.

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
