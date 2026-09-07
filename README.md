# Mastermind-triad

A self-growing self-healing evolving intelligence, in the pursuit of artificial consciousness. No more superficial intelligence.

## Live Build Runtime

An application under this runtime is never "finished, packaged, shipped." It stays connected to a layer that knows how it is built, what is running, what depends on what, what constrains it, and what happens when something changes — for as long as it operates.

| Package | What it is |
| --- | --- |
| [`@lbr/runtime-core`](packages/runtime-core) | The substrate: seven-domain project graph, intent objects, impact resolution, the authority gate, isolated mirrors, validation, progressive deployment with lineage, and cost attribution. |
| [`@lbr/adapter-typescript`](packages/adapter-typescript) | The first domain adapter — builds the graph from a real TypeScript source tree, plus an `lbr` CLI. |

```bash
npm install
npm test

# ask the runtime what a change to its own source would touch
npx tsx packages/adapter-typescript/src/cli.ts impact packages/runtime-core src/graph/graph.ts
```

The runtime analyzes its own codebase, which is also how three defects in the impact engine were found — see [the adapter's README](packages/adapter-typescript/README.md#what-running-it-on-real-code-found).
