/**
 * `rhizomorph lab <subcommand>` — prd12 ruling 1's second, explicitly-invoked
 * hand. This module holds only the namespace's own index help text; parsing
 * for each subcommand lives in its own module (`lab-checkpoint.ts`,
 * `lab-fork.ts`, `lab-compare.ts`), and execution stays in `cli/index.ts` —
 * the one importer the lab namespace law (`lab/namespace-law.test.ts`)
 * allows into `server/src/lab/`.
 */

/** `rhizomorph lab`'s own usage table — the namespace's index. */
export function labHelpText(): string {
  return `rhizomorph lab <subcommand> [options]

The laboratory — prd12 ruling 1's second, explicitly-invoked hand. No
observer code path (collector, server, UI) may reach it; every write it
makes is confined to refs/rhizomorph/ and artifacts outside the watched
repo, and it never runs without this command.

Subcommands:
  checkpoint <lane>       Capture a live workspace + session snapshot
  fork <lane>             Restore n arms from one of that lane's checkpoints
  compare <fork-id>       Table of a fork's arms: treatment, gate, cost, duration, commits

Run 'rhizomorph lab checkpoint --help', 'rhizomorph lab fork --help' or
'rhizomorph lab compare --help' for a subcommand's own options.
`
}
