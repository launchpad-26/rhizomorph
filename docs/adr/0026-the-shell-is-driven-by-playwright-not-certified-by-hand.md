# 0026 · The shell is driven by Playwright, not certified by hand

Date: 2026-08-21 · Status: accepted · Context: the professionalisation loop
(operator commission, 2026-08-21)

## Context

Every visual claim this repo has ever certified about the desktop shell was
certified by a human looking at a window, or by one of two hand-rolled
Chromium drivers that drive the SPA in a borrowed browser (`scene/parity/
capture.mjs`, `research/spikes/renderer/run.mjs`). The unit suites are
deliberately blind to pixels (jsdom, ADR-0021), the parity harness sees one
seeded frame, and nothing at all exercises the shell's own surface — the
tray, first-run, the GPU path, the window chrome. An iterative polish loop
needs to *look at every surface, repeatedly, identically* — and "identically"
is precisely what a hand on a mouse cannot give.

## Decision

`playwright` joins the root devDependencies (browser download skipped — the
`_electron` driver needs no browser, and the ms-playwright Chromium cache
already serves the parity harness). One harness, `scripts/dev/visit.mjs`,
launches **the built shell itself** via `_electron.launch` and gives a loop
four verbs: visit a route, exercise a surface (per-surface script files),
set the theme, take a screenshot. Console output and page errors are
collected, and a page error fails the visit — a broken surface must not read
as a quiet one.

Three seams make driving the real shell safe on this machine, and each is
named in the harness header: the GPU env is pre-applied with
`RHIZOMORPH_GPU_ENV_APPLIED=1` so the shell's zygote-fix self-re-exec never
detaches the driver; `XDG_CONFIG_HOME` points at scratch so a visit never
touches the operator's prefs and first-run stays first; headful always,
because headless on this box is SwiftShader and the scene refuses software
rasterisers by law.

## Alternatives rejected

- **Keep hand-rolled CDP.** Proven this week (node's built-in WebSocket),
  but it is a private dialect: no typed locators, no auto-waiting, nothing a
  future contributor can read as a standard. The operator named Playwright.
- **Drive the SPA in a bare Chromium** (the parity harness's route). Cheapest,
  and wrong for this purpose: it certifies a product with the shell cut off.
  The shell IS the product being professionalised.
- **playwright-core.** Saves nothing here (the full package skips browser
  downloads when told) and loses the CLI conveniences.

## Consequences

- A per-loop visual record (`scratchpad/loops/<n>/`) becomes the evidence
  channel for every appearance decision; before/after screenshots ride each
  loop's journal entry.
- The harness is dev tooling: it ships in `scripts/dev/`, is excluded from
  the app's own dependency closure, and CI does not run it (CI never launches
  Electron — `ELECTRON_SKIP_BINARY_DOWNLOAD=1` stands).
- The e2e layer this creates is deliberately thin — a looking-glass, not a
  test suite. Assertions stay in vitest; the harness proves appearance and
  interaction, and its scripts are disposable per loop.
