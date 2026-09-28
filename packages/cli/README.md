# @lbr/cli

The `lbr` command line — the runtime driven against a real project.

```bash
lbr ingest   <dir>                 # build the graph, report what is in it
lbr impact   <dir> <file>          # what a change to this file would touch
lbr validate <dir> <file>          # the whole loop, running the real build and tests
```

## `impact` — the question the substrate exists for

```
$ lbr impact packages/runtime-core src/graph/graph.ts

CHANGING  src/graph/graph.ts
IMPACT    17 structural nodes · magnitude 0.955 · action 'code_change'

BREAKS IF THIS IS WRONG
   0.90  src/cost/attribution.ts
   0.90  src/impact/resolve.ts
   0.90  src/mirror/plan.ts
   0.81  src/deployment/lineage.ts
   …
```

For a leaf file it says so plainly, including when nothing would catch a regression:

```
BREAKS IF THIS IS WRONG
  nothing depends on this file
MUST PASS
  nothing — no test covers this file, so a failure here would be silent
```

`--action` re-classifies the same blast radius under a different operation: `--action data_delete` turns a routine verdict into one requiring approval, because risk has two inputs and the graph only supplies one of them.

## `validate` — actually do it

Resolves the impact, classifies authority, plans an isolated mirror, materializes it, and runs the real build plus **only the tests the change implicates**. Exits non-zero if mechanical validation fails, so it works as a gate.

`--node-modules <dir>` overrides where the mirror links dependencies from, for a project that resolves unusually.

Both commands read a real source tree through [`@lbr/adapter-typescript`](../adapter-typescript) and, for `validate`, run through [`@lbr/executor-local`](../executor-local) — whose README documents what that executor does and does not isolate.
