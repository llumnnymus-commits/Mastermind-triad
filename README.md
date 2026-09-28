# Mastermind-triad

A self-growing self-healing evolving intelligence, in the pursuit of artificial consciousness. No more superficial intelligence.

## Live Build Runtime

An application under this runtime is never "finished, packaged, shipped." It stays connected to a layer that knows how it is built, what is running, what depends on what, what constrains it, and what happens when something changes — for as long as it operates.

| Package | What it is |
| --- | --- |
| [`@lbr/runtime-core`](packages/runtime-core) | The substrate: seven-domain project graph, intent objects, impact resolution, the authority gate, isolated mirrors, validation, progressive deployment with lineage, and cost attribution. |
| [`@lbr/adapter-typescript`](packages/adapter-typescript) | The first domain adapter — builds the graph from a real TypeScript source tree. |
| [`@lbr/executor-local`](packages/executor-local) | A real `MirrorExecutor`: materializes an isolated workspace and runs actual build and test commands in it. |
| [`@lbr/cli`](packages/cli) | The `lbr` command line: `ingest`, `impact`, `validate`. |

```bash
npm install
npm test

# what would a change to this file touch?
npx tsx packages/cli/src/cli.ts impact packages/runtime-core src/graph/graph.ts

# actually do it: isolated mirror, real build, only the tests this change implicates
npx tsx packages/cli/src/cli.ts validate packages/runtime-core src/impact/resolve.ts
```

The runtime analyzes and validates its own codebase. That is also how several defects were found that a hand-built fixture was too clean to expose — see [the adapter's README](packages/adapter-typescript/README.md#what-running-it-on-real-code-found) and [the executor's](packages/executor-local/README.md#one-thing-running-it-taught).
