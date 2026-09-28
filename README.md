# Mastermind-triad

A self-growing self-healing evolving intelligence, in the pursuit of artificial consciousness. No more superficial intelligence.

## Live Build Runtime

An application under this runtime is never "finished, packaged, shipped." It stays connected to a layer that knows how it is built, what is running, what depends on what, what constrains it, and what happens when something changes — for as long as it operates.

| Package | What it is |
| --- | --- |
| [`@lbr/runtime-core`](packages/runtime-core) | The substrate: seven-domain project graph, intent objects, impact resolution, the authority gate, isolated mirrors, validation, progressive deployment with lineage, and cost attribution. |
| [`@lbr/adapter-typescript`](packages/adapter-typescript) | The first domain adapter — builds the graph from a real TypeScript source tree. |
| [`@lbr/adapter-policy`](packages/adapter-policy) | Declared policy — the domain that cannot be read off a repository, because it is decisions rather than facts. |
| [`@lbr/executor-local`](packages/executor-local) | A real `MirrorExecutor`: materializes an isolated workspace and runs actual build and test commands in it, optionally confined to Linux namespaces with no network egress. |
| [`@lbr/evaluator-claude`](packages/evaluator-claude) | A `BehavioralEvaluator` — judges whether a change met the success condition its intent declared, and says `unclear` when the evidence doesn't reach the claim. |
| [`@lbr/proposer-claude`](packages/proposer-claude) | A `ChangeProposer` — writes the actual code for one step, and decomposes an application description into an ordered sequence of individually validated steps. |
| [`@lbr/app-target-node`](packages/app-target-node) | What "an application" means for one stack, so the runtime can construct one from nothing. |
| [`@lbr/cli`](packages/cli) | The `lbr` command line: `ingest`, `impact`, `validate`, `run`, `build`. |

```bash
npm install
npm test

# what would a change to this file touch?
npx tsx packages/cli/src/cli.ts impact packages/runtime-core src/graph/graph.ts

# actually do it: isolated mirror, real build, only the tests this change implicates
npx tsx packages/cli/src/cli.ts validate packages/runtime-core src/impact/resolve.ts

# apply a real change — mirror only, never the working tree
npx tsx packages/cli/src/cli.ts run packages/runtime-core \
  --goal "..." --target src/impact/resolve.ts --proposal change.json --apply

# build an application that did not exist, one validated step at a time
npx tsx packages/cli/src/cli.ts build --goal "a note taker with tags and search" --out ./notes
```

The runtime analyzes and validates its own codebase. That is also how several defects were found that a hand-built fixture was too clean to expose — see [the adapter's README](packages/adapter-typescript/README.md#what-running-it-on-real-code-found) and [the executor's](packages/executor-local/README.md#one-thing-running-it-taught).

### The loop is closed

`run` and `build` are what make the rest of the substrate more than scaffolding. A proposal is applied **inside the mirror only**, the mirror is then **re-ingested** to produce the after-graph, and behavioral validation finally has two different graphs to compare. The proposer never declares its own deltas — if it supplied both sides, scope adherence would be marking its own homework.

`build` constructs an application from a natural-language goal: scaffold, then each step of the plan through the full loop — impact walk, authority gate, isolated mirror, real compile, the tests the change implicates *and* the tests the step itself added, scope analysis, promotion, lineage. A step that does not validate stops the run; the app keeps whatever last passed. The result is a project that compiles, passes its tests, and runs, with one lineage record per step showing how it was constructed.
