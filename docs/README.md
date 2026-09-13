# The documentation tree

One map over everything under `docs/`. If you are looking for something and do
not know where it lives, it is on this page.

This index is **held by a law** — `packages/server/src/docs-index-law.test.ts`
fails the build when a tracked document or a whole directory is missing a row, or
when a row points at something that no longer exists. So a gap here is a red
test, not a thing you find out the hard way.

**Where a new decision goes is not this page's business.** That routing lives in
[CONTRIBUTING.md](../CONTRIBUTING.md#docs) and [AGENTS.md](../AGENTS.md), and
restating it here would only give it a second copy to go stale. This page says
what exists and when to reach for it.

## Start here

| Document | What it is, and when you want it |
|---|---|
| [user-guide/](user-guide/getting-started.md) | How to actually use the instrument — getting started, watching a fleet, replay, sessions, the lab, the desktop shell, troubleshooting. Seven pages. Start here if you want to run it rather than change it. |
| [architecture.md](architecture.md) | The running narrative of how the system got here, prd0 onward. **Read its opening banner first:** the narrative stops at prd-17 and the ADR log is the register of record past that point. |
| [adr/](adr/README.md) | Architecture decision records — 50 of them, append-only, numbered, never edited once accepted. Structure, contracts, formats, and where authority lives. This is the register of record for anything structural. |
| [prds/](prds/README.md) | Product requirement documents and their rulings: 12 live, 41 shipped under `done/`, 2 under `parked/`. Ruling numbers are cited from code and tests and are never renumbered. |

## The rest of the tree

| Document | What it is, and when you want it |
|---|---|
| [design-notes/](design-notes/) | The reasoning behind one value, formula or visual form — why a constant is what it is. Cited directly from the code comment that needs it. 27 notes. |
| [design/](design/) | The charter and the UI-era design record, plus dated glance artefacts. Broader than a design note and narrower than a PRD. |
| [research/](research/) | Dated spikes and measurements, 37 of them. **Read them for findings, not as current state** — each records a tree at the moment it was written. Note there is a second, smaller research tree at [../research/](../research/) holding the spikes that shipped with their own throwaway rigs. |
| [review/](review/README.md) | Multi-strategy code reviews and audits, one directory per review seat, with a consolidated work list in its own README. Dated artefacts, same reading rule as `research/`. |
| [screenshots/](screenshots/) | What the app actually looks like. Every PNG carries a manifest binding it to the tree it depicts, and a law bounds how far the tree may move before it is restaged. |
| [metamorphosis/](metamorphosis/system-design.md) | The system design for the metamorphosis work. |
| [record-format.md](record-format.md) | The portable session record — what is in one, and what a reader may rely on. |
| [telemetry.md](telemetry.md) | What the instrument collects, from where, and what it does not. |
| [roadmap.md](roadmap.md) | What shipped, PRD by PRD, and the candidates nobody has claimed. Re-cut as each PRD lands. |
| [operational-targets.md](operational-targets.md) | The numbers the instrument is held to when it runs. |
| [team-server-runbook.md](team-server-runbook.md) | Standing up and operating the team server. |
| [demo.md](demo.md) | The demo script — what to show, in what order, and what each moment is meant to prove. |
| [vision.md](vision.md) | The unstructured one. Explicitly a dreaming document: nothing in it is a commitment. |
| [vision-the-lab.md](vision-the-lab.md) | The same, narrowed to the laboratory. |
| [follow-up-292.md](follow-up-292.md) | A standing follow-up record kept outside any one PRD. |

## Reading rules worth knowing before you trust a page

- **A dated artefact records a tree, not the present.** Everything under
  `research/` and `review/`, and anything opening with a `**Tree:**` pin, is a
  record of the repo at one commit. Read it for what was found, never as current
  state.
- **An ADR is never edited once accepted.** A changed mind gets a new record that
  supersedes the old one, so the log reads as a history rather than a position.
- **Last-modified date is not evidence of currency.** The
  [2026-09-14 audit](review/2026-09-14-documentation-audit.md) found the largest
  document in this tree roughly 39 milestones behind in substance and touched
  three days earlier by a mechanical citation update. If you need a claim to be
  true, find the law that holds it.
