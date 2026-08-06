# Product / docs / vision review

**Reviewer:** Fable seat 1 of 5 — product, docs, vision
**Date:** 2026-08-06
**Scope:** README.md, docs/vision.md, docs/roadmap.md, docs/prd0–17.md, docs/user-guide/, docs/decisions/, CHANGELOG.md, CONTRIBUTING.md, docs/demo.md

---

**Verdict**
- The core idea is genuinely good and the value prop is real for a narrow user; the execution discipline (tests-as-law, read-only enforcement, honest-gap voice) is unusually strong for a solo build.
- But this has become a documentation-industrial complex for a tool with one named user. 17 PRDs + a decisions log + an architecture doc + a roadmap that rewrites itself every entry is ceremony outrunning the userbase.
- README at 790 lines/47KB is a symptom, not a strength — nearly half of it (347 lines) is one "Dashboard" section that reads like internal design-rationale, not onboarding.

## 1. Vision & user

Real problem, narrow user: someone running a git-worktree multi-agent swarm (docs/vision.md:1) has no way to see "who's working, what's about to collide" (docs/prd0.md:6-8). Collision matrix + flatline detector (prd0.md:29-34) are the sharpest, most concrete value — they solve a failure mode the team had actually hit, not a hypothetical. That's the strongest part.

Weakest: the audience is currently one person (prd0.md:12 "Lachlan and anyone running..."; prd9.md:3 admits "the cohort will likely adopt" — future tense, unconfirmed). There is no evidence anyone besides the builder has run this. The "layman bar" (prd4 ruling 1, invoked constantly in docs/demo.md) is aspirational framing for a tool that has never been in front of a layman.

## 2. PRD structure: signal or ceremony?

Mixed, trending ceremony. Spot-checks:

- **prd8 packaging (files allowlist)** — landed, verified: root `package.json:31-36` has the exact files allowlist claimed.
- **prd9 trace era (Langfuse pricing table)** — landed: `packages/core/src/pricing/{default-model-prices.json,PROVENANCE.md,LICENSE}` exist as claimed.
- **prd12 laboratory (engine only, no UI)** — accurately scoped as engine-only at the time (prd12.md), and prd14 correctly identifies the gap ("#148 and #153 built an engine nothing can reach," prd14.md:12).
- **prd14 experiment console** — roadmap.md:95-104 says "wave plan not yet landed" (roadmap.md committed 2026-08-06 10:39), but `packages/web/src/lab/{LabPage.tsx,launch/,branching/,compare/}` (877 lines) were committed same day at 14:05 — i.e. the roadmap doc was already stale within hours of being written. At this doc-to-code velocity the roadmap is a snapshot, not a source of truth, and nobody should trust it without checking git.

The self-referential "ruling N, amended same session, operator challenged X and was right" style (prd14 ruling 2, prd13 ruling 13) is honest and well-tested, but it's a lot of prose to relitigate design decisions for a tool with no external users yet giving feedback. This is process theater dressed as rigor — good rigor, wrong audience size.

## 3. README: strength or symptom?

Symptom. Section sizes: Dashboard 347 lines, Trust 169, Install 72, Telemetry 32, Performance 23.

The Trust section (README.md:95-264) earns its length — it's the thing a stranger needs before running arbitrary code against their agent swarm, and it's well-argued (three-hands model, each with its own enforcing test). Keep that.

The 347-line "Dashboard" section is where it breaks down: palette rules, ribbon taper math, camera controls, keyboard reference — this is scene-implementation documentation, not README material. It belongs in `docs/architecture.md` or a new `docs/dashboard.md`, with the README linking out. A first-time cloner should not have to scroll past organic-contour design rationale to find the port flag.

## 4. Scope creep — justified vs speculative

- **Judge / mergetree** (`packages/server/src/judge/mergetree.ts`): justified — a read-only speculative-merge check with its own enforcing test, directly serving the collision-matrix promise from prd0. Not creep.
- **Lab** (fork/checkpoint/compare, prd12+prd14): the single biggest scope expansion beyond prd0's "read-only, always" v0. It's fenced well (separate namespace, separate tab, its own law tests) but it is a second product bolted onto the first — "watch my swarm" becomes "now also fork and A/B-test it." No evidence any user asked for this; it reads as the builder's own next-interesting-problem. Worth asking whether it should be a separate tool/repo before it doubles the surface area again.
- **Eras** (prd17 lenient-parse / era corpus): justified, minimal — forward-compat plumbing for a recording format, cheap insurance.
- **Telemetry/pricing**: justified — it's the "money layer," the second-most concrete value prop after collisions.
- **Pricing** vendored table: fine, small, pinned to a SHA, not scope creep.

Net: the lab is the one piece to flag as unearned given current adoption — not bad work, wrong sequencing.

## 5. Roadmap realism

Highest-leverage next thing: **get one real user who isn't the builder running this and report back.** prd9's own framing (cohort adoption) is still unconfirmed in the docs. Every other roadmap item (prd15 system-agnosticism, prd18 richer UI) compounds uncertainty on top of an unvalidated single-user product.

What to cut/pause: prd14's remaining lab waves (comparison surface, saved artifacts) and prd15's Windows/multi-orchestrator work. Both pre-pay for generality (many agents, many OSes) before the core "watch my swarm" loop has one outside validator. The npm-publish gate (roadmap.md:174-186, still open on #177) is the right instinct — don't let the lab or system-agnosticism work jump ahead of it either.
