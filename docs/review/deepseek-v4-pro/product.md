# Product / docs / vision review

**Verdict (3 bullets):**
- A genuine instrument solving a real, sharp problem — observability for an agent swarm across git worktrees — built by someone who actually runs this workflow daily. The code proves the docs aren't lying.
- The 47KB README is a firehose. It's a magnificent trust document, a full dashboard manual, an architecture overview, and a keyboard reference all crammed into one file. This is a symptom of the docs being *better than the information architecture they sit in*.
- Scope discipline is real: every module I checked exists, is tested, and is fenced. But the roadmap-to-code status tags have rotted (prd14 says "not yet landed" — it landed).

---

## 1. Vision coherence

**The user and problem are real.** `docs/vision.md:11` nails it: *"What doesn't exist is the balcony — the place you watch the whole orchestra from."* Lachlan runs multi-worktree agent swarms. The conductor (workmux) exists. The individual terminals (tmux panes) exist. What's missing is the single pane of glass that says "4 lanes producing, 1 frozen, 2 about to collide on `packages/core/src/reduce.ts`" without ssh-ing into 7 panes. This is not a synthetic problem.

**Strongest part of the value proposition:** The trust model. The three-hand constitution (observer/recorder/laboratory) with *enforcing tests*, not promises, is the right answer for a tool that reads your `~/.claude/projects` and your git state. `packages/web/src/drawer/readonly.test.ts:1` greps its own source for HTTP verbs beyond GET; `packages/server/src/lab/namespace-law.test.ts:1` proves the lab's write surface is confined to `refs/rhizomorph/`. This is the kind of guarantee that turns "should I run this?" into "yes."

**Weakest part:** The solo-operator assumption. The vision gestures at a "forest" (multiplayer instrument, `docs/roadmap.md:82`) but the whole product is architected around one person watching one machine. The `--extra-sessions` flag for a conductor on another filesystem is clever but doesn't change the fact that this is a single-observer tool. The collision matrix loses half its power without "your lane and my lane just diverged." The vision doesn't acknowledge this as a deliberate trade-off; it feels like an unexamined wall.

---

## 2. PRD structure — signal or ceremony?

18 PRDs looks like process theatre, but spot-checking 4 against actual code:

| PRD | Claim | Landed? | Evidence |
|-----|-------|---------|----------|
| **prd1** — money layer | OTel receiver, sessionlog collector, cost selectors, spend ticker | **Landed** | `packages/server/src/collectors/otel/` (parse-metrics, parse-traces, parse-logs, attribution), `packages/server/src/collectors/sessionlog/` (collector, turn-grammar, lane-state). Full OTLP/HTTP JSON receiver with lane attribution in `attribution.ts`. |
| **prd12** — laboratory | Checkpoint/fork engine, namespace-law test, constitutional amendment | **Landed** | `packages/server/src/lab/` — checkpoint, fork, restore, compare, git, paths, namespace-law test. `packages/core/src/events/lab.ts` — `fork.checkpoint` and `fork.dispatched` event schemas with the `refs/rhizomorph/` regex enforced at the Zod layer. |
| **prd14** — experiment console | Lab UI tab, branching layout, comparison surface, estimate-and-confirm | **Landed** (roadmap says "not yet landed" — **doc rot**) | `packages/web/src/lab/LabPage.tsx` — renders checkpoints table, LaunchPanel, BranchingDiagram (SVG trunk+fork+arms), ComparisonSurface. `packages/web/src/lab/launch/LaunchPanel.tsx`, `packages/web/src/lab/compare/ComparisonSurface.tsx`, `packages/web/src/lab/branching/geometry.ts`. The branching layout grammar (prd14 ruling 1) is implemented. |
| **prd17** — complete record | `upcast()` chokepoint, lenient parse, golden era corpus, durability | **Partially** | `packages/core/src/events/upcast.ts` — the identity chokepoint with observer seam. `packages/core/src/eras/` — corpus fold tests. But prd17's ruling 1 event families (summons, gate, operator ack/verdict) are **not landed**; the roadmap honestly tags them "ruled but not yet landed." |

**Verdict: Signal, with ceremony at the edges.** The PRDs are real design documents that drove real code. The ceremony is in the self-referential language ("the operator made it, citing the scale of the innovation") and the roadmap's habit of declaring every PRD "superseded by what actually shipped" — a tic that undermines the document you're reading. The doc-rot on prd14's status is the most concrete symptom: the roadmap is a snapshot, not a living index.

---

## 3. README at 47KB — strength or symptom?

**Both, and mostly a symptom of misplaced content.**

The first ~300 lines (install, trust, support matrix, "what the observer does not do") are exemplary. The trust section (`README.md:65-177`) should be the model for every tool that reads your shell sessions.

The remaining ~490 lines are a **full dashboard manual** that belongs in `docs/user-guide/`. The scene description, the palette table, the cord-cut animation, the keyboard reference, the camera controls, the germinating seeds — none of this is needed to decide whether to install. It's reference material.

The actual `docs/user-guide/` exists (getting-started, watching, replay, sessions, the-lab, troubleshooting) but it's thin compared to what the README carries. The fix isn't cutting the README — it's moving the dashboard reference to `docs/user-guide/dashboard.md` and leaving a one-paragraph summary with a link.

---

## 4. Scope creep audit

| Feature | Status | Verdict |
|---------|--------|---------|
| **judge** | Landed: `packages/server/src/judge/` — mergetree speculative conflict detection, symbol-overlap analysis | **Justified.** It's the collision matrix from prd0, made real. Read-only git plumbing. No model calls. Feeds the attention strip. |
| **eras** | Landed: `packages/core/src/eras/` — golden corpus, byte-identical CI fold | **Justified.** This is the event-sourcing integrity check. Without it, "replay works" is a claim, not a guarantee. |
| **lab** | Fully landed in both server and web | **Justified, brilliantly scoped.** Opt-in, explicitly invoked, write-fenced to `refs/rhizomorph/`, never runs from a background poll. This is how you add a write hand to a read-only tool without betraying the promise. |
| **telemetry** | Landed: OTLP receiver, Claude Code native export, cost selectors | **Core, not creep.** The money layer (prd1) was the first thing built. The tool's value collapses without it. |
| **pricing** | Landed: vendored Langfuse pricing table (`prd9`) | **Minimal and honest.** A single SHA-pinned JSON file. The README says "dollars are notional" on subscription plans. No pricing API, no billing integration. |
| **forest (multiplayer)** | Mentioned in roadmap as future, zero code | **Speculative but honestly labeled.** Listed under "unclaimed candidates," not promised. |
| **dispatch-policy optimization** | Standing research question, zero code | **Speculative.** Contextual bandit over model×effort per issue class. The roadmap says "the optimizer never lives in the Rhizomorph" — correct instinct, but the research question existing at all is a distraction for a read-only observability tool. |
| **catch-up brief, task graphs** | Not built, listed as cohort-inheritable | **Fine.** Honestly marked as not-yet. The cohort framing is aspirational but costs nothing in code. |

---

## 5. Roadmap realism

**Single highest-leverage next thing: ship to npm.** The install story is `git clone → npm install → npm run build → npm start`. That's four commands for a tool whose README sells "one command, zero config." prd15's last wave (publish) is gated on `#177` (history-vs-fresh-tree for unscrubbed OTel fixture identifiers). Resolve that decision, publish, and the tool's reach expands by an order of magnitude. The code quality and test density (227 test files) make it ready.

**What to cut:**
1. **prd17's unlanded event families** (summons raised/cleared, operator ack/verdict/note). These are recording the operator's own decisions. The recorder hand already captures what happened; capturing "a human clicked approve" is a nice-to-have that adds schema surface without changing what the dashboard shows. Defer to prd18 or later.
2. **The "forest" multiplayer vision.** It's a different product. The solo balcony is coherent and complete. Multiplayer requires auth, identity, shared state, conflict resolution — it's not a "merge later, not a rewrite" as prd11 claims (`docs/roadmap.md:82`). Cut it from the roadmap entirely; it's distracting.
3. **Dispatch-policy optimization as a standing item.** A read-only observability instrument should not carry a research question about a bandit optimizer. That's conductor territory. Move it to a separate doc or kill it.

**What to double down on:** the `doctor` command (`README.md:53-60`). It's the best onboarding affordance in the tool and it's buried mid-README. Make it the first thing the README tells you to run. `npm start -- doctor <path>` tells you exactly what's missing and exactly how to fix it — that's the real "one command."
