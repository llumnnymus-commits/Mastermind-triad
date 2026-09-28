# @lbr/cli

The `lbr` command line — the runtime driven against a real project.

```bash
lbr ingest   <dir>                 # build the graph, report what is in it
lbr impact   <dir> <file>          # what a change to this file would touch
lbr validate <dir> <file>          # the whole loop, running the real build and tests
lbr run      <dir> --goal "..."    # apply a real change, in a mirror, and check what it did
lbr build         --goal "..."     # construct an application that did not exist
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

## `run` — the change is real, and only the mirror sees it

```bash
lbr run <dir> --goal "..." --target <file> --proposal change.json --apply
```

`validate` proves a mirror builds. `run` changes something in it. Ingest → intent → impact → authority gate → mirror → **apply → re-ingest** → mechanical validation → behavioral validation → lineage → cost.

Three properties are worth being specific about:

- **`--apply` is required.** Without it nothing is written anywhere, including the mirror. The default is to plan the change and stop.
- **The working tree is never modified.** Edits land in a mirror under `.lbr-mirrors/`, and the command says so: `APPLIED … the working tree is untouched`. `git status --porcelain` is empty after every run, including failing ones.
- **The after-graph is re-ingested, not self-reported.** The proposal never declares what it changed; the mirror is read back with the same adapter. That is what lets `scope adherence` catch a proposal that edited a file nothing predicted:

```
FAIL   scope adherence — 1 node(s) changed outside the impact set analyzed for intent x
```

`--proposal <file>` takes a `ChangeProposal` as JSON, which is deterministic and needs no credential. Without it the model-backed [`@lbr/proposer-claude`](../proposer-claude) writes the change. `--judge` adds the model-backed behavioral evaluator; without it the success condition is reported `inconclusive`, which never passes and is never laundered into one.

Lineage is written to `.lbr/lineage/<id>.json` and outlives the process, with the before-graph stored alongside it so `auditPrediction` can compare the prediction against what actually happened later.

## `build` — an application that did not exist

```bash
lbr build --goal "a note taker with tags and search" --out ./notes \
  [--plan plan.json] [--proposals ./proposals] [--app-target node-typescript]
```

Scaffolds the target, installs its dependencies, decomposes the goal into ordered steps, and drives each one through the `run` loop. A step is promoted into the app only after it validated in isolation; a step that fails stops the build, and the app keeps whatever last passed.

```
── step 1/2 · store ─────────────────
GOAL       add an in-memory note store with add and list
WHY        everything else needs somewhere to keep notes
  PASS         connect
  PASS         build 1.3s
  PASS         start 1.3s
  PASS         verify evidence:test:src_main_test 1.2s
  PASS         verify src/store.test.ts (added by this step)
PROMOTED   step 'store' is now part of the app
```

That last check exists because of a real gap. The verification plan is built from the graph as it was *before* the change, so a test the step creates cannot be in it — it did not exist when the plan was made. Without running the added tests separately, a step could add a test, never run it, and be promoted on the strength of the tests it happened not to touch. The new tests are visible in the after-graph, which is exactly what re-ingesting the mirror produces.

`--out` must be an empty directory: the scaffold writes by path, and running into an existing project would silently replace its `package.json`. An `--app-target` with no implementation fails before anything is written rather than leaving behind files nothing can compile.

Every command reads a real source tree through [`@lbr/adapter-typescript`](../adapter-typescript), and everything that runs or writes anything goes through [`@lbr/executor-local`](../executor-local) — whose README documents what that executor does and does not isolate. `--sandbox` adds Linux namespace confinement where the kernel allows it, and reports what it could not establish rather than implying isolation it does not have.
