# The lab's launch ceiling — arms × runs, configurable, and why that differs from the lock

prd-53 ruling 6. Two constants bound one dispatch of the laboratory, and they are
deliberately not the same kind of number:

- `LAUNCH_CEILING_LANES = 8` — the most **spending lanes** (arms × runs) one
  dispatch may create without the operator saying otherwise. Declared in
  `packages/server/src/lab/fork.ts` (the engine, which every dispatch passes
  through) and restated in `packages/server/src/api/lab.ts` (the launch route,
  which refuses before it spends) — two copies because the namespace law
  (`packages/server/src/lab/namespace-law.test.ts`) forbids the route from
  importing the engine, the same split `MODEL_GRAMMAR` already lives with. Both
  are literal-pinned in their own tests.
- `LAB_CLI_LOCK_CEILING_MS = 30_000` — how long a launch will wait for another
  launch's `runCli` call before refusing. **Fixed**, by prd-50 ruling 1
  (`lab-launch-ceilings.md`).

## Why one is configurable and the other is not

prd-50 fixed the lock ceiling because it bounds a **wait**: raising it hides
spend behind latency — a queue rebuilt under another name — and a queue is the
thing prd-12 ruling 3 says the laboratory must not have. The argument is about
the operator's attention, and attention does not scale with hardware.

The launch ceiling bounds **machine load**: worktrees restored, installs run,
agents live at once. That differs by an order of magnitude between a laptop
and a twenty-core box, and a single fixed number is wrong on both — too high
for one, an artificial stop for the other. So it takes an override. It answers
prd-50's own open question (*"whether the rest of the ceiling family follows"*)
for this member: **no** — and the distinction is wait versus load.

## What "configurable" means here, and what it does not

Not an environment variable and not a settings entry. The override is a
**declared act on the dispatch itself**:

- the CLI takes `--ceiling-override <n>`; the launch request carries
  `"ceilingOverride": n`;
- a dispatch above the ceiling **refuses**, and the refusal names **both** the
  number it hit and the override that would authorise exactly that many —
  the operator's next command is in the message, not in a document;
- an override that is still too low is refused the same way, naming the
  override as the ceiling it hit;
- when the override lets a dispatch through, it is **recorded on every
  `fork.dispatched` it produces** (`ceilingOverride` on the payload, optional
  and additive). A later reader of the log sees not just that twelve lanes
  were created but that someone said so.

This is the same posture as prd-41 ruling 4 — *"a ceiling that spends money is
declared"* — read for what the ceiling actually bounds now that an arm holds r
runs (prd-53 ruling 1): every run is a spending lane, so arms alone stopped
being the count the moment runs became real. `#322` moved the check to arms ×
runs with the fixed number; this note and prd-53 wave 2 make the number an
operator's to raise, by name, per dispatch.

## Where the checks live

- The **route** (`api/lab.ts`) checks the whole experiment — every arm it is
  about to dispatch times the runs each holds — before the first `runCli`
  call, so a refused launch spends nothing (prd-41 ruling 4's placement).
- The **engine** (`lab/fork.ts`) checks what it can see — the lanes of the one
  call it is making — before the checkpoint is even looked up, so the CLI path
  (`rhizomorph lab fork --arms 3 --runs 4`) is bounded too. Before this note
  the CLI had no ceiling at all.

## What is not decided here

The number eight is inherited from `lab-launch-ceilings.md`'s reasoning about
what an operator can still read on a confirmation and reason about paying for;
it has not been re-derived for runs. If real experiments show that eight lanes
is routinely overridden, the default is the thing to revisit, in a ruling —
not the override, which exists precisely so that the default need not be
guessed right.
