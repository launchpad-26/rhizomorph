# Product / docs / vision review

- **Verdict 1:** The core vision of a read-only "balcony" for agent swarms is highly coherent, but the product violates its own prime directive by adding active orchestration features (the Lab).
- **Verdict 2:** The 18-PRD documentation is intensely ceremonial but yields incredibly high-signal code; the specs are treated as literal law in the implementation.
- **Verdict 3:** The project suffers from extreme over-documentation. A 47KB README and a 146KB architecture doc point to a culture that over-explains instead of streamlining the onboarding experience.

### 1. Vision and User Problem
The vision is coherent: an event-sourced, read-only "balcony" observation instrument for a local coding swarm (`docs/vision.md:12`). There is a real user with a real problem: an operator managing multiple autonomous agents across tmux and git worktrees who needs to see state, prevent merge pain, and spot dead workers. 
* **Strongest part:** The non-intrusive, zero-config observation model that degrades gracefully and provides immediate visual feedback (the "collision matrix").
* **Weakest part:** The prerequisites are incredibly niche. It requires the user to already be operating a complex local agent swarm via `workmux`, `tmux`, and `git` worktrees. 

### 2. The 18-PRD Structure: Signal or Ceremony?
It is heavy ceremony, but undeniable signal. The codebase religiously cites PRD rulings in its comments (e.g., `prd12 ruling 4's floor`). Spot-checking claims reveals they landed exactly as prescribed:
- **prd1 (the money layer):** Landed. Native telemetry, OTel cost tracking, and spend selectors exist in `packages/core/src/selectors/spend.ts` and `packages/core/src/events/telemetry.ts`.
- **prd5 (finished application):** Landed. The Figma-consensus gestures and camera are fully implemented using `d3-zoom` in `packages/web/src/scene/camera.ts`.
- **prd12 & 14 (the lab):** Landed. The laboratory namespace, checkpointing, and launching are fully wired in `packages/server/src/api/lab.ts:252` (`POST /api/lab/launch`).
- **prd16 (session labeling):** Landed. The route explicitly implements operator session labels in `packages/server/src/api/label.ts:29`.

### 3. README Size (47KB): Strength or Symptom?
It is a symptom of an over-explaining doc culture. The README should serve as the hook, installation guide, and quickstart. Instead, it reads like an essay. Sections like "Architecture", "Telemetry (the money layer)", and "The build-day context" do not belong in the entry point. They should be moved to the `docs/user-guide/` or the already-massive `docs/architecture.md`. 

### 4. Scope Creep: Justified vs. Speculative
- **Judge:** *Justified.* Implementing the "collision matrix" to detect symbol overlap and speculative conflicts (`packages/core/src/events/judge.test.ts:7`) directly answers the vision's core value proposition.
- **Telemetry / Pricing:** *Justified.* Swarm cost visibility is a massive operational blind spot; calculating token spend per lane is essential for real users.
- **Eras:** *Speculative / Ceremony.* The "Golden era corpus law" (`packages/core/src/eras/eras.test.ts:10`) enforcing bit-for-bit backward compatibility of historical reducers is massive overkill for a localhost visualization tool. 
- **Lab:** *Severe scope creep.* The vision document makes an explicit, foundational promise: *"Not a conductor. It launches nothing, merges nothing, decides nothing — read-only"* (`docs/vision.md:20`). Yet, PRD12 and PRD14 introduce `rhizomorph lab launch` which provisions worktrees and launches workmux arms (`packages/server/src/cli/lab-fork.ts:51`). This actively breaks the product's foundational read-only constraint and dilutes its identity.

### 5. Roadmap Realism: Next Leverage and What to Cut
- **Highest-leverage next thing:** The unclaimed "catch-up brief" (`docs/roadmap.md:37`). A digest answering *"What did my swarm do while I was away?"* was cited as the strongest user-stated pain point. It requires zero mutation of repo state and leans perfectly into the product's read-only strengths.
- **What to cut:** Strip out the **Lab**. Revert to the pure observation instrument promised in the vision. Secondarily, cut the **Eras** snapshot-testing harness to unburden the test suite and accelerate feature development.
