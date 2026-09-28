# @lbr/adapter-typescript

Populates the `code` and `evidence` domains of a Live Build Runtime project graph from a real TypeScript source tree.

The graph is only as good as what fills it, and nothing fills itself. This is the first domain adapter: point it at a directory and it produces the nodes and edges for what is actually there.

## Use it

The `lbr` CLI lives in [`@lbr/cli`](../cli):

```bash
# what is in this tree?
npx tsx packages/cli/src/cli.ts ingest packages/runtime-core

# what breaks if I change this file?
npx tsx packages/cli/src/cli.ts impact packages/runtime-core src/graph/graph.ts
```

Output for a core file:

```
CHANGING  src/graph/graph.ts
IMPACT    17 structural nodes · magnitude 0.955 · action 'code_change'

BREAKS IF THIS IS WRONG
   0.90  src/impact/resolve.ts
   0.90  src/mirror/plan.ts
   0.81  src/policy/risk.ts
   …
```

and for a leaf:

```
CHANGING  src/demo.ts
BREAKS IF THIS IS WRONG
  nothing depends on this file
MUST PASS
  nothing — no test covers this file, so a failure here would be silent
```

`--action` changes the verdict without changing the graph: `impact <dir> <file> --action data_delete` classifies the same blast radius as a destructive operation.

## Three decisions

**Imports are parsed, not matched.** The TypeScript parser catches `export * from`, type-only imports, and dynamic `import()`; a regex catches the first form and misses the rest. Every missed edge is a node absent from a blast radius that a change will nonetheless break, and an adapter that under-reports is worse than no adapter — the runtime cannot distinguish a small blast radius from an incompletely observed one.

**A test is a proof obligation, not a dependent.** A test importing a module becomes `module --verified_by--> test`, not `test --depends_on--> module`. Modelled the other way, every test in the repository lands in the blast radius of every change: true, and useless.

**Unresolvable references are recorded, not invented.** A bare specifier like `zod` is outside the ingested tree, so it appears in `unresolved` rather than as a fabricated node. A graph that quietly invents what it cannot see is worse than one that admits the gap.

## What running it on real code found

The fixture graph was clean enough to hide three defects in the impact engine. Pointing the adapter at `runtime-core` itself surfaced all three within minutes:

1. **`depends_on` was weighted 1.0**, so dependency chains never decayed and every transitive dependent of a core module scored identically to a direct importer. Confidence stopped distinguishing anything at distance. Now 0.9, which yields a real gradient — 0.90 direct, 0.81 at two hops.
2. **The walk mixed directions**, stepping outbound to a shared dependency and then inbound again, which arrives at *siblings*. `index.ts` was reported in the blast radius of `demo.ts` — nothing imports `demo.ts`. Direction is now sticky.
3. **Verification attached to context nodes**, so changing a leaf file demanded every test in the repository. A test on a dependency cannot catch a regression in what depends on it; nothing flows that way.

None of these were visible on a hand-built fixture. All three are the kind of thing that makes an analysis tool quietly useless rather than obviously broken.
