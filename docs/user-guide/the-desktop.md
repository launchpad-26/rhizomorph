# The desktop app

The same instrument, in its own window: the desktop shell spawns the existing
server, embeds the existing SPA, and adds nothing to either (prd-34 ruling 1).
Everything the other guide pages describe — [watching](watching.md),
[replay](replay.md), [sessions](sessions.md) — is exactly true inside it,
because it is exactly the same code. What this page covers is what the shell
adds around it: install, first run, the settings survey, and the window
itself.

## Install

Two roads:

**Packaged.** Download the installer for your platform and run it —
`packages/app/INSTALL.md` has the per-platform files and, importantly, the
exact security warning each platform will show you. These builds are
deliberately unsigned (prd-34 ruling 9: signing is ~$120/yr for a trust badge
the project buys at a real release, not at a merge), so SmartScreen and
Gatekeeper will warn. The warning is what *unsigned* looks like, not what
*dangerous* looks like; INSTALL.md quotes each one verbatim so you can compare
words.

**From a clone.** After the [getting started](getting-started.md) steps:

```sh
npm run start --workspace packages/app
```

builds the shell and opens the window on its own embedded server. Nothing
listens beyond `127.0.0.1`.

`[Ran]` on this machine (WSL2/WSLg): the window opens on the observatory with
the sample fleet dispatched — the screenshots in this guide's sibling pages
were taken through exactly this path.

## First run

A fresh profile opens on the **observatory** showing a synthetic fleet — real
event schema, sample lanes — with a **welcome card** floating bottom-right:
three sentences saying what the picture is, that it is a sample, and the one
next action (`connect your repo`). It steals no focus, `Esc` dismisses it
forever, and dismissal is an ordinary preference: the settings page surveys it
(`First-run welcome`), and *restore defaults · this machine* genuinely brings
it back.

The number keys swap what the instrument is looking at:

- **1** — live: whatever the server is actually watching
- **2** — the sample fleet (20 steady lanes; one latecomer joins ~6 s in, so
  you can watch a thread grow)
- **3** — staged pathologies: one of each fault the instrument knows how to
  draw

A fixture is never allowed to pass as telemetry — the provenance strip above
the scene names what is driving the picture at all times.

## Connecting your repo

`/connect` (or the welcome card's button) is the chain checklist: every link
between your repo and the picture, and the fact that proves each one — read
live from the instrument, never asserted. While a fixture is driving the
picture the page says so at the top and every row reads UNPROVEN, because
nothing folded from a sample is evidence about your wiring; **return to
live** and the rows fill in. The three-step wizard (repo → conductor →
verify) walks the setup: pick or clone a repo, relaunch the conductor
instrumented, then watch the checklist go green. Cloning uses your machine's
own git credentials — no account, no token, and a URL carrying one is refused
before it reaches the wire.

## Settings

`/settings` is a survey, not a control panel: every preference the instrument
can be told, its current value, its default, its scope — and, beneath each
group, in its own voice, **what it will not do yet**. Those "not yet" notes
are honest gaps, kept current; when the wiring lands, the note is removed the
same day.

The appearance group is the one you'll touch first:

- **Theme** — follow system, dark, light. The scene repaints in the other
  palette, not just the chrome.
- **Density** — comfortable or compact; compact tightens instrument rows,
  table cells and panel gutters, and never touches reading prose.
- **Motion** *(its own group)* — full, reduced, or still. This is a health
  control (ruling 5): it can go further than your OS asks, never less far.
  *Still* genuinely holds the canvas — the scene's pause button disables
  itself and reads "Motion stilled", so the chrome tells you who is holding
  the picture.
- **Scene quality** — calm, rich, maximum. Calm drops the atmosphere (bloom,
  grain, spores) for machines that can't hold the frame budget; the status
  vocabulary is never gated, at any level.

Scoped preferences say so (`THIS MACHINE` / `THIS REPO`), and each scope has
its own *restore defaults* — restoring the machine's does not touch the
repo's.

## The window

The floor is **1100×700** — the window cannot be dragged below it, and every
panel is designed to that floor rather than to a maximized monitor. The shell
puts an icon in your tray; closing to the tray is a preference in the
application group (surveyed like everything else, host-aware — it says when
the host cannot honour it). The window and taskbar carry the app icon from
`packages/app/build/icon.png`.

On WSL2 the shell re-launches itself once with the GPU environment the WSLg
seam needs (`GALLIUM_DRIVER`, the WSL library path) — if the scene ever comes
up software-rendered, see [troubleshooting](troubleshooting.md).

## Where things live

The shell's data is the server's data — recordings, preferences and logs live
in the instrument's own data directory, never inside the repo it watches.
Machine-scoped preferences live with the profile, repo-scoped ones are
bucketed under the watched repo's path, and a recording exported from
`/recordings` is the portable, hash-chained record described in
[sessions](sessions.md).
